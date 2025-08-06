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
        // Webhook endpoint for deal updates
        this.app.post('/webhook/deal-update', this.handleDealUpdate.bind(this));

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

            // Filter out non-active or deleted deals
            if (!this.filterActiveDeals(dealData)) {
                console.log('🚫 Deal filtered out - not active or deleted');
                return res.json({ status: 'filtered', reason: 'not active or deleted' });
            }
            // Skip Agent Recruiting pipeline
            if (dealData.pipelineName === 'Agent Recruiting') {
                console.log('🚫 Deal filtered out - Agent Recruiting pipeline');
                return res.json({ status: 'filtered', reason: 'agent recruiting pipeline' });
            }

            // 🕵️‍♂️ Find or create Airtable record by FUB Deal ID
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

            // Get primary contact data
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

            // Spreadsheet lookup (stub for now)
            const spreadsheetData = await this.lookupOrCreateSpreadsheetRow(dealData.id, dealData);

            // Extract and log users list
            const usersList = this.extractUsers(dealData.users);
            console.log('👥 Users extracted from deal:', usersList.map(u => u.id));

            // Format Under Contract Date
            const formattedUCDate = await this.formatUCDate(dealData.pipelineName, spreadsheetData);

            // Determine which paths to execute
            const pathsToExecute = this.determinePaths(spreadsheetData, dealData, usersList);
            console.log('🛤️ Paths to execute:', pathsToExecute);

            // Execute each path sequentially
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
            res.status(500).json({ status: 'error', message: error.message });
        }
    }

    determinePaths(spreadsheetData, dealData, usersList) {
        const paths = [];

        // ISA assignment
        if (dealData.customISA && !spreadsheetData.isaFubContactIdFromAirtable) {
            paths.push('isa_path');
        }

        // Two-agent split
        const validUsers = usersList.filter(u => u.id);
        if (validUsers.length === 2) {
            paths.push('agent_different_path');
        }

        // Single-agent
        if (validUsers.length === 1) {
            paths.push('no_contact_path');
        }

        return paths;
    }

    async executePath(pathName, dealData, contactData, spreadsheetData, usersList, formattedUCDate, sharedRecord) {
        switch (pathName) {
            case 'isa_path':
                return this.executeISAPath(dealData, spreadsheetData, sharedRecord);
            case 'agent_different_path':
                return this.executeAgentDifferentPath(dealData, contactData, spreadsheetData, usersList, sharedRecord);
            case 'no_contact_path':
                return this.executeNoContactPath(dealData, contactData, spreadsheetData, formattedUCDate, sharedRecord);
            default:
                console.log(`⚠️ Unknown path: ${pathName}`);
                return sharedRecord;
        }
    }

    async executeISAPath(dealData, spreadsheetData, sharedRecord) {
        console.log('🎯 Executing ISA Path');
        const agentRecord = await this.findAirtableRecord('Agents', 'FUB User ID', dealData.customISA);
        if (!agentRecord) {
            console.log(`⚠️ ISA agent ID ${dealData.customISA} not found - skipping`);
            return sharedRecord;
        }
        // Use Airtable record ID for linked record
        await this.updateAirtableRecord('Transactions Log', sharedRecord.recordId, {
            'ISA FUB Contact ID': [agentRecord.id]
        });
        return sharedRecord;
    }
        }
        await this.updateAirtableRecord('Transactions Log', sharedRecord.recordId, {
            'ISA FUB Contact ID': agentRecord.fields['FUB Contact ID'],
        });
        return sharedRecord;
    }

    async executeAgentDifferentPath(dealData, contactData, spreadsheetData, usersList, sharedRecord) {
        console.log('🎯 Executing Agent Different Path');
        const ids = usersList.map(u => u.id);
        const primary = contactData.assignedTo;
        const coAgentId = ids.find(id => id !== primary);
        if (!coAgentId) {
            console.log('⚠️ Could not determine co-agent ID - skipping');
            return sharedRecord;
        }
        const coAgentRec = await this.findAirtableRecord('Agents', 'FUB User ID', coAgentId);
        const splitData = {
            'Primary Agent Deal %': 50,
            'Co-Agent Deal %': 50
        };
        if (coAgentRec) {
            // Use Airtable record ID for linked record
            splitData['Co-Agent FUB Contact ID'] = [coAgentRec.id];
        }
        await this.updateAirtableRecord('Transactions Log', sharedRecord.recordId, splitData);
        return sharedRecord;
    }
        }
        const coAgentRec = await this.findAirtableRecord('Agents', 'FUB User ID', coAgentId);
        const splitData = { 'Primary Agent Deal %': 50, 'Co-Agent Deal %': 50 };
        if (coAgentRec) splitData['Co-Agent FUB Contact ID'] = coAgentRec.fields['FUB Contact ID'];
        await this.updateAirtableRecord('Transactions Log', sharedRecord.recordId, splitData);
        return sharedRecord;
    }

    async executeNoContactPath(dealData, contactData, spreadsheetData, formattedUCDate, sharedRecord) {
        console.log('🎯 Executing No Contact Path');
        await this.updateAirtableRecord('Transactions Log', sharedRecord.recordId, {
            'FUB Contact ID': contactData.id,
            'Address / Client': dealData.name,
            'Stage': dealData.stageName,
            'Transaction Type': dealData.pipelineName,
            'Under Contract Date': formattedUCDate,
            'Closing Date': dealData.projectedCloseDate,
            'Sale Price': dealData.price,
            'Primary Agent Deal %': 100,
        });
        return sharedRecord;
    }

    // Utility methods

    async getDealData(id) {
        const resp = await axios.get(`${this.config.followUpBossApi}/deals/${id}`, {
            headers: {
                Authorization: `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}`,
                'Content-Type': 'application/json',
                'X-System': 'ManifestNetwork',
            },
        });
        return resp.data;
    }

    async getContactData(id) {
        const resp = await axios.get(`${this.config.followUpBossApi}/people/${id}`, {
            headers: {
                Authorization: `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}`,
                'Content-Type': 'application/json',
                'X-System': 'ManifestNetwork',
            },
        });
        return resp.data;
    }

    filterActiveDeals(dealData) {
        return dealData.status === 'Active' && !dealData.status.includes('Deleted');
    }

    getFirstPeopleId(people) {
        return Array.isArray(people) && people.length ? people[0].id : null;
    }

    extractUsers(users) {
        if (!Array.isArray(users)) return [];
        return users.map(u => ({ id: u.id, name: u.name }));
    }

    async formatUCDate(pipelineName, sheetData) {
        const map = {
            Listing: sheetData.customContractRatifiedDate,
            Landlord: sheetData.customApplicationAcceptedDate,
            Buyer: sheetData.customContractRatifiedDate,
            Tenant: sheetData.customApplicationAcceptedDate,
        };
        return map[pipelineName] || null;
    }

    async lookupOrCreateSpreadsheetRow(dealId, dealData) {
        console.log('📝 Bypassing Google Sheets for testing');
        const primaryUserId = Array.isArray(dealData.users) && dealData.users.length ? dealData.users[0].id : null;
        return {
            usersId: primaryUserId,
            isaFubContactIdFromAirtable: null,
            customContractRatifiedDate: null,
            customApplicationAcceptedDate: null,
        };
    }

    async findAirtableRecord(table, field, value) {
        try {
            const tableId = table === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
            const resp = await axios.get(`${this.config.airtableBaseUrl}/${tableId}`, {
                headers: { Authorization: `Bearer ${this.config.airtableToken}` },
                params: { filterByFormula: `{${field}} = "${value}"`, maxRecords: 1 },
            });
            return resp.data.records[0] || null;
        } catch (e) {
            console.error('❌ Airtable lookup error:', e.message);
            return null;
        }
    }

    async createAirtableRecord(table, data) {
        const fields = this.cleanAirtableData(data);
        const tableId = table === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
        const resp = await axios.post(
            `${this.config.airtableBaseUrl}/${tableId}`,
            { fields },
            { headers: { Authorization: `Bearer ${this.config.airtableToken}`, 'Content-Type': 'application/json' } }
        );
        return resp.data;
    }

    async updateAirtableRecord(table, id, data) {
        const fields = this.cleanAirtableData(data);
        const tableId = table === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
        const resp = await axios.patch(
            `${this.config.airtableBaseUrl}/${tableId}/${id}`,
            { fields },
            { headers: { Authorization: `Bearer ${this.config.airtableToken}`, 'Content-Type': 'application/json' } }
        );
        return resp.data;
    }

    cleanAirtableData(data) {
        const cleaned = {};
        const linked = ['Primary Agent FUB Contact ID', 'Co-Agent FUB Contact ID', 'ISA FUB Contact ID'];
        const dates = ['Under Contract Date', 'Closing Date', 'Contact Created Date', 'Appt Set Date',
            'Appt Scheduled For Date','Appt Held Date','Signed Date','Listing Live Date','Attorney Review Date','Under Contract Date'];
        const nums = ['FUB Deal ID','Sale Price','Primary Agent Deal %','Co-Agent Deal %'];
        Object.entries(data).forEach(([k,v]) => {
            if (v == null) return;
            if (linked.includes(k)) cleaned[k] = Array.isArray(v)?v:[v.toString()];
            else if (nums.includes(k)) cleaned[k] = typeof v==='number'?v:parseFloat(v);
            else if (dates.includes(k)) cleaned[k] = new Date(v).toISOString().split('T')[0];
            else cleaned[k] = v;
        });
        return cleaned;
    }

    start(port = process.env.PORT || 3000) {
        this.app.listen(port, () => console.log(`🚀 Server on port ${port}`));
    }
}

const config = {
    followUpBossApi: process.env.FUB_API_URL || 'https://api.followupboss.com/v1',
    followUpBossToken: process.env.FUB_TOKEN,
    airtableBaseUrl: 'https://api.airtable.com/v0/appKPBEXCsXAVEJRU',
    airtableToken: process.env.AIRTABLE_TOKEN,
    airtableAgentsTable: 'tbloJNfjbrodWRrCk',
    airtableTransactionsTable: 'tblQAs5EG3gU6TzT3',
    googleSheetId: '1d5F7tnLQC5Jt9nMHHEm0KG82VKMfR7bBK3mxla8G5V4'
};

const automation = new DealManagementAutomation(config);
module.exports = { DealManagementAutomation, config };

if (require.main === module) automation.start();
