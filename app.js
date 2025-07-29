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
        
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({ status: 'healthy', timestamp: new Date().toISOString() });
        });
    }

    async handleDealUpdate(req, res) {
        try {
            console.log('📥 Received webhook:', JSON.stringify(req.body, null, 2));
            
            // Step 1: Webhook Trigger (extract resource ID from webhook)
            const dealId = req.body.resourceIds[0]; // Get first resource ID
            
            // Step 2: Get deal data from FollowUpBoss API
            const dealData = await this.getDealData(dealId);
            console.log('📊 Deal data retrieved:', JSON.stringify(dealData, null, 2));
            
            // Step 3: Filter - Only continue if Active and not Deleted
            if (!this.filterActiveDeals(dealData)) {
                console.log('🚫 Deal filtered out - not active or deleted');
                return res.json({ status: 'filtered', reason: 'not active or deleted' });
            }
            
            // Step 5: Filter - Skip if pipeline is "Agent Recruiting"
            if (dealData.pipelineName === 'Agent Recruiting') {
                console.log('🚫 Deal filtered out - Agent Recruiting pipeline');
                return res.json({ status: 'filtered', reason: 'agent recruiting pipeline' });
            }
            
            // Step 6: Get first People ID from the people array
            console.log('🔍 Checking people field:', dealData.people);
            console.log('🔍 Full dealData keys:', Object.keys(dealData));
            
            const primaryContactId = this.getFirstPeopleId(dealData.people);
            console.log('🎯 Primary contact ID extracted:', primaryContactId);
            
            // Get contact data only if we have a contact ID
            let contactData = null;
            if (primaryContactId) {
                try {
                    console.log('📞 Fetching contact data for ID:', primaryContactId);
                    contactData = await this.getContactData(primaryContactId);
                    console.log('✅ Contact data retrieved successfully');
                } catch (error) {
                    console.log('⚠️ Failed to get contact data:', error.message);
                    contactData = { id: primaryContactId, created: null, assignedTo: null, tags: [] };
                }
            } else {
                console.log('⚠️ No people found on deal - using deal data only');
                contactData = { id: null, created: null, assignedTo: null, tags: [] };
            }
            
            // Step 7: Lookup Spreadsheet Row (create if not found)
            const spreadsheetData = await this.lookupOrCreateSpreadsheetRow(dealData.id, dealData);
            
            // Step 8-9: Extract users list from deal data (not spreadsheet)
            const usersList = this.extractUsers(dealData.users);
            console.log('👥 Users extracted from deal:', usersList);
            
            // Step 10: Format UC Date
            const formattedUCDate = await this.formatUCDate(dealData.pipelineName, spreadsheetData);
            
            // Step 11: Path Logic - Determine which paths to execute
            const pathsToExecute = this.determinePaths(spreadsheetData, dealData, usersList);
            console.log('🛤️ Paths to execute:', pathsToExecute);
            
            // Execute each path
            for (const path of pathsToExecute) {
                await this.executePath(path, dealData, contactData, spreadsheetData, usersList, formattedUCDate);
            }
            
            res.json({ 
                status: 'success', 
                dealId: dealData.id,
                pathsExecuted: pathsToExecute 
            });
            
        } catch (error) {
            console.error('❌ Error processing deal update:', error);
            res.status(500).json({ 
                status: 'error', 
                message: error.message 
            });
        }
    }

    async getDealData(resourceIds) {
        const response = await axios.get(`${this.config.followUpBossApi}/deals/${resourceIds}`, {
            headers: {
                'Authorization': `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}`,
                'Content-Type': 'application/json',
                'X-System': 'ManifestNetwork'
            }
        });
        return response.data;
    }

    async getContactData(contactId) {
        const response = await axios.get(`${this.config.followUpBossApi}/people/${contactId}`, {
            headers: {
                'Authorization': `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}`,
                'Content-Type': 'application/json',
                'X-System': 'ManifestNetwork'
            }
        });
        return response.data;
    }

    filterActiveDeals(dealData) {
        return dealData.status === 'Active' && !dealData.status.includes('Deleted');
    }

    getFirstPeopleId(peopleData) {
        // FollowUpBoss uses 'people' array with objects containing 'id'
        if (Array.isArray(peopleData) && peopleData.length > 0) {
            return peopleData[0].id;
        }
        return null;
    }

    extractUsers(usersArray) {
        // Extract users from FollowUpBoss users array
        if (!usersArray || !Array.isArray(usersArray)) return [];
        return usersArray.map(user => user.name);
    }

    async lookupSpreadsheetRow(dealId) {
        const doc = new GoogleSpreadsheet(this.config.googleSheetId, this.getGoogleAuth());
        await doc.loadInfo();
        
        const sheet = doc.sheetsByTitle['Transactions Log'];
        await sheet.loadCells();
        
        const rows = await sheet.getRows();
        const dealRow = rows.find(row => row.get('FUB Deal ID') === dealId.toString());
        
        if (!dealRow) {
            throw new Error(`Deal ${dealId} not found in spreadsheet`);
        }
        
        return {
            pipelineName: dealRow.get('Transaction Type'),
            name: dealRow.get('Address / Client'),
            clientFubLink: dealRow.get('Client FUB Link'),
            description: dealRow.get('Deal Description'),
            customOffMarketShareStatus: dealRow.get('Off-Market Share Status'),
            customApptSetDate: dealRow.get('Appt Set Date'),
            customApptScheduledForDate: dealRow.get('Appt Scheduled For Date'),
            customApptHeldDate: dealRow.get('Appt Held Date'),
            customISAApptHeldDate: dealRow.get('ISA Appt Held Date'),
            customSignedDate: dealRow.get('Signed Date'),
            customLiveDate: dealRow.get('Listing Live Date'),
            customAttorneyReviewDate: dealRow.get('Attorney Review Date'),
            customContractRatifiedDate: dealRow.get('Contract Ratified Date'),
            projectedCloseDate: dealRow.get('Closing Date'),
            price: dealRow.get('Sale Price'),
            customISA: dealRow.get('ISA'),
            usersName: dealRow.get('Primary Agent'),
            usersId: dealRow.get('Primary Agent').includes('Eric Eckhardt') ? '12' : null
        };
    }

    async formatUCDate(pipelineName, spreadsheetData) {
        // Lookup table logic for UC dates based on pipeline
        const ucDateMappings = {
            'Listing': spreadsheetData.customContractRatifiedDate,
            'Landlord': spreadsheetData.customApplicationAcceptedDate,
            'Buyer': spreadsheetData.customContractRatifiedDate,
            'Tenant': spreadsheetData.customApplicationAcceptedDate
        };
        
        return ucDateMappings[pipelineName] || null;
    }

    determinePaths(spreadsheetData, dealData, usersList) {
        const paths = [];
        
        // Path 12/22: ISA custom field is filled AND ISA FUB Contact ID is blank in Airtable
        if (dealData.customISA && !spreadsheetData.isaFubContactIdFromAirtable) {
            paths.push('isa_path');
        }
        
        // Path 25: Users exists AND none are filtered names
        const filteredNames = ['JJ Trotter', 'Caitlin Kerrigan', 'Brett Sikora'];
        const hasFilteredNames = usersList.some(user => 
            filteredNames.some(filtered => user.includes(filtered))
        );
        
        if (usersList.length > 0 && !hasFilteredNames) {
            paths.push('agent_different_path');
        }
        
        // Path 31: There is a People ID on the deal AND Users ID exists
        if (dealData.people && Array.isArray(dealData.people) && dealData.people.length > 0 && spreadsheetData.usersId) {
            paths.push('no_contact_path');
        }
        
        return paths;
    }

    async executePath(pathName, dealData, contactData, spreadsheetData, usersList, formattedUCDate) {
        console.log(`🛤️ Executing path: ${pathName}`);
        
        switch (pathName) {
            case 'isa_path':
                await this.executeISAPath(dealData, spreadsheetData);
                break;
                
            case 'agent_different_path':
                await this.executeAgentDifferentPath(dealData, contactData, spreadsheetData, usersList);
                break;
                
            case 'no_contact_path':
                await this.executeNoContactPath(dealData, contactData, spreadsheetData, formattedUCDate);
                break;
        }
    }

    async executeISAPath(dealData, spreadsheetData) {
        console.log('🎯 Executing ISA Path');
        
        // Step 23: Find Record in Airtable (skip if not found)
        const agentRecord = await this.findAirtableRecord('Agents', 'Name', dealData.customISA);
        
        if (!agentRecord) {
            console.log(`⚠️ ISA agent "${dealData.customISA}" not found in Airtable - skipping ISA field update`);
            return;
        }
        
        // Step 24: Update Record in Airtable (create or update transaction record)
        await this.createOrUpdateAirtableRecord('Transactions Log', 'FUB Deal ID', dealData.id, {
            'ISA FUB Contact ID': agentRecord.fields['FUB Contact ID']
        });
    }

    async executeAgentDifferentPath(dealData, contactData, spreadsheetData, usersList) {
        console.log('🎯 Executing Agent Different Path');
        
        // Step 26: Determine Co-Agent based on Assigned To logic
        const coAgentResult = this.determineCoAgent(usersList, contactData.assignedTo, dealData.id);
        
        if (coAgentResult.error) {
            // Log error and skip this path
            console.error(`⚠️ ${coAgentResult.error} - skipping agent different path`);
            return;
        }
        
        const coAgent = coAgentResult.coAgent;
        console.log(`🎯 Determined Co-Agent: ${coAgent}`);
        
        if (coAgent) {
            // Step 27: Find Record in Airtable - Co Agent
            const coAgentRecord = await this.findAirtableRecord('Agents', 'Name', coAgent);
            
            // Step 29: Update Spreadsheet Row with co-agent info
            await this.updateSpreadsheetRow(dealData.id, {
                'Co-Agent': coAgent,
                'Primary Agent Deal Percent': 50,
                'Co-Agent Deal %': 50
            });
            
            // Step 30: Update Record in Airtable
            const updateData = {
                'Primary Agent Deal %': 50,
                'Co-Agent Deal %': 50
            };
            
            // Only add Co-Agent FUB Contact ID if co-agent record found
            if (coAgentRecord) {
                updateData['Co-Agent FUB Contact ID'] = coAgentRecord.fields['FUB Contact ID'];
            } else {
                console.log(`⚠️ Co-agent "${coAgent}" not found in Airtable - skipping Co-Agent FUB Contact ID field`);
            }
            
            await this.createOrUpdateAirtableRecord('Transactions Log', 'FUB Deal ID', dealData.id, updateData);
        }
    }

    async executeNoContactPath(dealData, contactData, spreadsheetData, formattedUCDate) {
        console.log('🎯 Executing No Contact Path');
        
        // Step 32: Find Record in Airtable (stop execution if not found)
        console.log('🔍 Looking for agent with User ID:', spreadsheetData.usersId);
        const agentRecord = await this.findAirtableRecord('Agents', 'FUB User ID', spreadsheetData.usersId);
        
        if (!agentRecord) {
            console.error(`❌ Primary agent not found for User ID: ${spreadsheetData.usersId} - stopping execution`);
            // For debugging, let's try to find any agents to see what's available
            console.log('🔍 Attempting to list available agents for debugging...');
            await this.debugListAirtableRecords('Agents');
            throw new Error(`Primary agent not found for User ID: ${spreadsheetData.usersId}`);
        }
        
        // Step 34: Create or Update Record in Airtable (all data from FUB APIs)
        const recordData = {
            'FUB Deal ID': dealData.id,
            'FUB Contact ID': contactData.id, // From contact API
            'Address / Client': dealData.name, // From deal API
            'Stage': dealData.stageName, // From deal API
            'Transaction Type': dealData.pipelineName, // From deal API
            'Primary Agent FUB Contact ID': agentRecord.fields['FUB Contact ID'],
            'Deal Description': dealData.description, // From deal API
            'Off-Market Share Status': dealData.customOffMarketShareStatus, // From deal API
            'Contact Created Date': contactData.created, // From contact API, not deal
            'Appt Set Date': dealData.customApptSetDate, // From deal API
            'Appt Scheduled For Date': dealData.customApptScheduledForDate, // From deal API
            'Appt Held Date': dealData.customApptHeldDate, // From deal API
            'Signed Date': dealData.customSignedDate, // From deal API
            'Listing Live Date': dealData.customLiveDate, // From deal API
            'Attorney Review Date': dealData.customAttorneyReviewDate, // From deal API
            'Under Contract Date': formattedUCDate,
            'Closing Date': dealData.projectedCloseDate, // From deal API
            'Sale Price': dealData.price, // From deal API
            'Primary Agent Deal %': 100, // Static value as requested
            'FUB Contact Tags': contactData.tags?.join(','), // From contact API, not deal
            'Existing Transaction': dealData.customExistingTransaction // From deal API
        };
        
        await this.createOrUpdateAirtableRecord('Transactions Log', 'FUB Deal ID', dealData.id, recordData);
    }

    determineCoAgent(usersList, assignedTo, dealId) {
        // Find which user matches assignedTo (primary agent)
        // Return the one that doesn't match (co-agent)
        if (usersList.length < 2) return { coAgent: null };
        
        // Take only first 2 users if more than 2 (error scenario)
        const users = usersList.slice(0, 2);
        
        const primaryAgent = users.find(user => user === assignedTo);
        const coAgent = users.find(user => user !== assignedTo);
        
        // Error handling: assignedTo doesn't match any users
        if (!primaryAgent) {
            return {
                error: `Deal ${dealId}: assignedTo "${assignedTo}" doesn't match any users in list: ${users.join(', ')}`
            };
        }
        
        console.log(`Primary Agent (assigned to): ${primaryAgent}`);
        console.log(`Co-Agent: ${coAgent}`);
        
        return { coAgent };
    }

    async lookupOrCreateSpreadsheetRow(dealId, dealData) {
        // For now, skip Google Sheets and return mock data
        console.log('📝 Bypassing Google Sheets for testing');
        
        // Extract users from deal data
        const usersList = this.extractUsers(dealData.users);
        console.log('🔍 Users from deal:', usersList);
        
        // Get the primary user ID from the actual FUB deal data
        // FollowUpBoss users array contains objects with 'id' property
        let primaryUserId = null;
        if (dealData.users && Array.isArray(dealData.users) && dealData.users.length > 0) {
            primaryUserId = dealData.users[0].id; // Get the actual FUB user ID
            console.log(`🎯 Primary user ID from FUB: ${primaryUserId}`);
        } else {
            console.log('⚠️ No users found in deal data');
        }
        
        return {
            pipelineName: null,
            name: null,
            customISA: null,
            usersName: usersList[0] || null,
            usersId: primaryUserId, // Use actual FUB user ID
            customContractRatifiedDate: null,
            customApplicationAcceptedDate: null,
            isaFubContactIdFromAirtable: null
        };
    }

    async createSpreadsheetRow(dealId) {
        const doc = new GoogleSpreadsheet(this.config.googleSheetId, this.getGoogleAuth());
        await doc.loadInfo();
        
        const sheet = doc.sheetsByTitle['Transactions Log'];
        
        // Create new row with basic deal ID
        const newRow = await sheet.addRow({
            'FUB Deal ID': dealId.toString()
        });
        
        console.log(`✅ Created new spreadsheet row for deal: ${dealId}`);
        
        // Return minimal data structure
        return {
            pipelineName: null,
            name: null,
            customISA: null,
            usersName: null,
            usersId: null,
            customContractRatifiedDate: null,
            customApplicationAcceptedDate: null
        };
    }

    async findAirtableRecord(tableName, fieldName, searchValue) {
        try {
            // Debug: Check if Airtable token exists
            if (!this.config.airtableToken) {
                console.error('❌ Airtable token is missing from config');
                return null;
            }
            
            console.log(`🔍 Searching Airtable ${tableName} for ${fieldName} = "${searchValue}"`);
            
            const tableId = tableName === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
            const response = await axios.get(`${this.config.airtableBaseUrl}/${tableId}`, {
                headers: {
                    'Authorization': `Bearer ${this.config.airtableToken}`
                },
                params: {
                    filterByFormula: `{${fieldName}} = "${searchValue}"`,
                    maxRecords: 1
                }
            });
            
            const record = response.data.records[0] || null;
            if (record) {
                console.log(`✅ Found record: ${record.id}`);
            } else {
                console.log(`⚠️ No record found for ${fieldName} = "${searchValue}"`);
            }
            
            return record;
        } catch (error) {
            console.error(`❌ Error finding Airtable record: ${error.message}`);
            if (error.response) {
                console.error('❌ Response status:', error.response.status);
                console.error('❌ Response data:', error.response.data);
            }
            return null;
        }
    }

    async debugListAirtableRecords(tableName) {
        try {
            console.log(`🔍 Debug: Listing first 5 records from ${tableName} table`);
            const tableId = tableName === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
            const response = await axios.get(`${this.config.airtableBaseUrl}/${tableId}`, {
                headers: {
                    'Authorization': `Bearer ${this.config.airtableToken}`
                },
                params: {
                    maxRecords: 5
                }
            });
            
            console.log(`📊 Found ${response.data.records.length} records:`);
            response.data.records.forEach((record, index) => {
                console.log(`  ${index + 1}. ID: ${record.id}`);
                console.log(`     Fields:`, Object.keys(record.fields));
            });
        } catch (error) {
            console.error(`❌ Debug listing failed: ${error.message}`);
        }
    }

    cleanAirtableData(data) {
        const cleaned = {};
        
        // Fields that are linked records and need to be formatted as arrays
        const linkedRecordFields = [
            'Primary Agent FUB Contact ID',
            'Co-Agent FUB Contact ID',
            'ISA FUB Contact ID'
        ];
        
        // Fields that contain dates and need special formatting
        const dateFields = [
            'Contact Created Date',
            'Appt Set Date',
            'Appt Scheduled For Date',
            'Appt Held Date',
            'Signed Date',
            'Listing Live Date',
            'Attorney Review Date',
            'Under Contract Date',
            'Closing Date'
        ];
        
        // Fields that are multi-select and need to be arrays
        const multiSelectFields = [
            'FUB Contact Tags'
        ];
        
        for (const [key, value] of Object.entries(data)) {
            // Skip null values
            if (value === null || value === undefined) {
                continue;
            }
            
            // Handle linked record fields - they need to be arrays
            if (linkedRecordFields.includes(key)) {
                if (typeof value === 'string' && value.trim() !== '') {
                    // Convert string to array of record IDs
                    cleaned[key] = [value.toString()];
                } else if (Array.isArray(value)) {
                    // Already an array, keep as is
                    cleaned[key] = value;
                }
                // Skip if empty string or invalid format
                continue;
            }
            
            // Handle multi-select fields - convert comma-separated strings to arrays
            if (multiSelectFields.includes(key)) {
                if (typeof value === 'string' && value.trim() !== '') {
                    // Split comma-separated string into array and trim whitespace
                    cleaned[key] = value.split(',').map(tag => tag.trim());
                } else if (Array.isArray(value)) {
                    // Already an array, keep as is
                    cleaned[key] = value;
                }
                // Skip if empty string or invalid format
                continue;
            }
            
            // Handle date fields - ALL are date-only (YYYY-MM-DD format)
            if (dateFields.includes(key)) {
                if (typeof value === 'string' && value.trim() !== '') {
                    try {
                        // Convert to date-only format (YYYY-MM-DD) for Airtable
                        const date = new Date(value);
                        if (!isNaN(date.getTime())) {
                            // All date fields are date-only, use YYYY-MM-DD format
                            cleaned[key] = date.toISOString().split('T')[0];
                        }
                    } catch (error) {
                        console.log(`⚠️ Invalid date format for ${key}: ${value}`);
                        // Skip invalid dates
                    }
                }
                continue;
            }
            
            // Convert numbers to strings for ID fields
            if (key.includes('ID') && typeof value === 'number') {
                cleaned[key] = value.toString();
            }
            // Handle empty strings
            else if (value === '') {
                continue; // Skip empty strings
            }
            // Keep valid values
            else {
                cleaned[key] = value;
            }
        }
        
        return cleaned;
    }

    async createOrUpdateAirtableRecord(tableName, primaryField, primaryValue, recordData) {
        // First try to find existing record
        const existingRecord = await this.findAirtableRecord(tableName, primaryField, primaryValue);
        
        if (existingRecord) {
            // For updates, exclude the primary field to avoid conflicts
            const updateData = { ...recordData };
            delete updateData[primaryField]; // Remove the primary field from updates
            console.log(`🔄 Updating existing record, excluding primary field: ${primaryField}`);
            
            // Update existing record
            return await this.updateAirtableRecord(tableName, existingRecord.id, updateData);
        } else {
            // Create new record (include all fields)
            console.log(`➕ Creating new record with all fields`);
            return await this.createAirtableRecord(tableName, recordData);
        }
    }

    async createAirtableRecord(tableName, recordData) {
        try {
            // Clean up the data before sending
            const cleanedData = this.cleanAirtableData(recordData);
            
            console.log('📤 Creating Airtable record:', JSON.stringify(cleanedData, null, 2));
            
            const tableId = tableName === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
            const response = await axios.post(`${this.config.airtableBaseUrl}/${tableId}`, {
                fields: cleanedData
            }, {
                headers: {
                    'Authorization': `Bearer ${this.config.airtableToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            console.log(`✅ Created Airtable record in ${tableName}:`, response.data.id);
            return response.data;
        } catch (error) {
            console.error(`❌ Failed to create Airtable record:`, error.response?.data || error.message);
            throw error;
        }
    }

    async updateAirtableRecord(tableName, recordId, recordData) {
        try {
            // Clean up the data before sending
            const cleanedData = this.cleanAirtableData(recordData);
            
            console.log('📤 Sending to Airtable:', JSON.stringify(cleanedData, null, 2));
            
            const tableId = tableName === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
            const response = await axios.patch(`${this.config.airtableBaseUrl}/${tableId}/${recordId}`, {
                fields: cleanedData
            }, {
                headers: {
                    'Authorization': `Bearer ${this.config.airtableToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            console.log(`✅ Updated Airtable record in ${tableName}:`, recordId);
            return response.data;
        } catch (error) {
            console.error(`❌ Failed to update Airtable record:`, error.response?.data || error.message);
            throw error;
        }
    }

    async updateSpreadsheetRow(dealId, updateData) {
        console.log(`📊 Would update Google Sheet for deal ${dealId}:`, updateData);
        // Skip Google Sheets for now during testing
        return true;
    }

    getGoogleAuth() {
        const credentials = JSON.parse(fs.readFileSync('./creds.json', 'utf8'));
        return new JWT({
            email: credentials.client_email,
            key: credentials.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
    }

    start(port = 3000) {
        this.app.listen(port, () => {
            console.log(`🚀 Deal Management Automation server running on port ${port}`);
            console.log(`📥 Webhook endpoint: http://localhost:${port}/webhook/deal-update`);
        });
    }
}

// Updated Configuration with your specific IDs
const config = {
    followUpBossApi: process.env.FUB_API_URL || 'https://api.followupboss.com/v1',
    followUpBossToken: process.env.FUB_TOKEN,
    airtableBaseUrl: `https://api.airtable.com/v0/appKPBEXCsXAVEJRU`,
    airtableToken: process.env.AIRTABLE_TOKEN,
    airtableAgentsTable: 'tbloJNfjbrodWRrCk',
    airtableTransactionsTable: 'tblQAs5EG3gU6TzT3',
    googleSheetId: '1d5F7tnLQC5Jt9nMHHEm0KG82VKMfR7bBK3mxla8G5V4'
};

// Initialize and start the automation
const automation = new DealManagementAutomation(config);

// Export for use as module
module.exports = { DealManagementAutomation, config };

// Start server if run directly
if (require.main === module) {
    automation.start();
}