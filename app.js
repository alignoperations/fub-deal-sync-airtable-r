require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

class DealManagementAutomation {
    constructor(config) {
        this.config = config;
        this.app = express();
        this.app.use(express.json());
        this.setupRoutes();
    }

    setupRoutes() {
        // Main webhook endpoint
        this.app.post('/webhook/deal-update', this.handleDealUpdate.bind(this));
        
        // Test endpoint for debugging Airtable
        this.app.post('/test/airtable', this.testAirtable.bind(this));
        
        // Test route to get table schema
        this.app.get('/test/schema', this.getTableSchema.bind(this));
        
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({ status: 'healthy', timestamp: new Date().toISOString() });
        });
    }

    async handleDealUpdate(req, res) {
        try {
            console.log('📥 Received webhook:', JSON.stringify(req.body, null, 2));
            const dealId = req.body.resourceIds[0];
            const dealData = await this.getDealData(dealId);
            console.log('📊 Deal data retrieved:', JSON.stringify(dealData, null, 2));

            // Step 1: Filter - Only Active and not Deleted
            if (!this.filterActiveDeals(dealData)) {
                console.log('🚫 Deal filtered out - not active or deleted');
                return res.json({ status: 'filtered', reason: 'not active or deleted' });
            }
            // Step 2: Filter - Skip if pipeline is "Agent Recruiting"
            if (dealData.pipelineName === 'Agent Recruiting') {
                console.log('🚫 Deal filtered out - Agent Recruiting pipeline');
                return res.json({ status: 'filtered', reason: 'agent recruiting pipeline' });
            }

            // STEP 3: Find or create the Airtable row by FUB Deal ID
            let sharedRecord = null;
            const existing = await this.findAirtableRecord(
                'Transactions Log',
                'FUB Deal ID',
                dealData.id
            );
            if (existing) {
                console.log(`🔍 Found existing record ${existing.id} by Deal ID`);
                sharedRecord = { recordId: existing.id, record: existing };
            } else {
                console.log(`➕ No record for Deal ${dealData.id}, creating stub`);
                const created = await this.createAirtableRecord(
                    'Transactions Log',
                    { 'FUB Deal ID': dealData.id }
                );
                sharedRecord = { recordId: created.id, record: created };
            }

            // Step 4: Get primary contact
            const primaryContactId = this.getFirstPeopleId(dealData.people);
            let contactData = { id: null, created: null, assignedTo: null, tags: [] };
            if (primaryContactId) {
                try {
                    contactData = await this.getContactData(primaryContactId);
                } catch (e) {
                    console.log('⚠️ Failed to get contact data:', e.message);
                }
            } else {
                console.log('⚠️ No people found on deal - using default contactData');
            }

            // Step 5: Lookup Spreadsheet Row (mock for now)
            const spreadsheetData = await this.lookupOrCreateSpreadsheetRow(dealData.id, dealData);

            // Step 6: Extract users list
            const usersList = this.extractUsers(dealData.users);
            console.log('👥 Users extracted from deal:', usersList.map(u=>u.id));

            // Step 7: Format UC Date
            const formattedUCDate = await this.formatUCDate(dealData.pipelineName, spreadsheetData);

            // Step 8: Determine paths to execute
            const pathsToExecute = this.determinePaths(spreadsheetData, dealData, usersList);
            console.log('🛤️ Paths to execute:', pathsToExecute);

            // Execute paths sequentially, updating sharedRecord
            for (const path of pathsToExecute) {
                const result = await this.executePath(
                    path,
                    dealData,
                    contactData,
                    spreadsheetData,
                    usersList,
                    formattedUCDate,
                    sharedRecord
                );
                if (result && result.recordId) {
                    sharedRecord = result;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            res.json({ 
                status: 'success', 
                dealId: dealData.id,
                pathsExecuted: pathsToExecute,
                airtableRecordId: sharedRecord?.recordId 
            });
        } catch (error) {
            console.error('❌ Error processing deal update:', error);
            res.status(500).json({ 
                status: 'error', 
                message: error.message 
            });
        }
    }

    determinePaths(spreadsheetData, dealData, usersList) {
        const paths = [];

        // ISA path
        if (dealData.customISA && !spreadsheetData.isaFubContactIdFromAirtable) {
            paths.push('isa_path');
        }

        // Agent different path (two users -> split)
        const validUsers = usersList.filter(u => u.id);
        if (validUsers.length === 2) {
            paths.push('agent_different_path');
        }

        // No-contact path (only one user)
        if (validUsers.length === 1) {
            paths.push('no_contact_path');
        }

        return paths;
    }

    async executeISAPath(dealData, spreadsheetData, sharedRecord) {
        console.log('🎯 Executing ISA Path');
        // Find ISA agent by FUB User ID
        const agentRecord = await this.findAirtableRecord(
            'Agents',
            'FUB User ID',
            dealData.customISA
        );
        if (!agentRecord) {
            console.log(`⚠️ ISA agent ID ${dealData.customISA} not found - skipping`);
            return sharedRecord;
        }
        const updateData = { 'ISA FUB Contact ID': agentRecord.fields['FUB Contact ID'] };
        await this.updateAirtableRecord('Transactions Log', sharedRecord.recordId, updateData);
        return sharedRecord;
    }

    async executeAgentDifferentPath(dealData, contactData, spreadsheetData, usersList, sharedRecord) {
        console.log('🎯 Executing Agent Different Path');
        // Determine co-agent by comparing user IDs against assignedTo
        const ids = usersList.map(u => u.id);
        const primary = contactData.assignedTo;
        const coAgentId = ids.find(id => id !== primary);
        if (!coAgentId) {
            console.log('⚠️ Could not determine co-agent ID - skipping');
            return sharedRecord;
        }
        // Lookup co-agent record
        const coAgentRec = await this.findAirtableRecord('Agents','FUB User ID',coAgentId);
        // Update split
        const splitData = {
            'Primary Agent Deal %': 50,
            'Co-Agent Deal %': 50
        };
        if (coAgentRec) {
            splitData['Co-Agent FUB Contact ID'] = coAgentRec.fields['FUB Contact ID'];
        }
        await this.updateAirtableRecord('Transactions Log', sharedRecord.recordId, splitData);
        return sharedRecord;
    }

    async executeNoContactPath(dealData, contactData, spreadsheetData, formattedUCDate, sharedRecord) {
        console.log('🎯 Executing No Contact Path');
        // Only one agent: assign 100%
        const updateData = {
            'FUB Contact ID': contactData.id,
            'Address / Client': dealData.name,
            'Stage': dealData.stageName,
            'Transaction Type': dealData.pipelineName,
            'Under Contract Date': formattedUCDate,
            'Closing Date': dealData.projectedCloseDate,
            'Sale Price': dealData.price,
            'Primary Agent Deal %': 100
        };
        await this.updateAirtableRecord('Transactions Log', sharedRecord.recordId, updateData);
        return sharedRecord;
    }

    // ... rest of methods unchanged (getDealData, getContactData, filters, lookups, cleanAirtableData, find/create/update Airtable, etc.)
}

// Configuration
const config = {
    followUpBossApi: process.env.FUB_API_URL || 'https://api.followupboss.com/v1',
    followUpBossToken: process.env.FUB_TOKEN,
    airtableBaseUrl: `https://api.airtable.com/v0/appKPBEXCsXAVEJRU`,
    airtableToken: process.env.AIRTABLE_TOKEN,
    airtableAgentsTable: 'tbloJNfjbrodWRrCk',
    airtableTransactionsTable: 'tblQAs5EG3gU6TzT3',
    googleSheetId: '1d5F7tnLQC5Jt9nMHHEm0KG82VKMfR7bBK3mxla8G5V4'
};

// Initialize and export
const automation = new DealManagementAutomation(config);
module.exports = { DealManagementAutomation, config };

// Start server if run directly
if (require.main === module) {
    automation.start();
}
