// CORRECTED MAIN WEBHOOK HANDLER WITH PROPER RECORD MANAGEMENT
async handleDealUpdate(req, res) {
    try {
        console.log('📥 Received webhook:', JSON.stringify(req.body, null, 2));
        
        // Step 1-6: Get and validate deal data (existing logic)
        const dealId = req.body.resourceIds[0];
        const dealData = await this.getDealData(dealId);
        console.log('📊 Deal data retrieved:', JSON.stringify(dealData, null, 2));
        
        if (!this.filterActiveDeals(dealData)) {
            console.log('🚫 Deal filtered out - not active or deleted');
            return res.json({ status: 'filtered', reason: 'not active or deleted' });
        }
        
        if (dealData.pipelineName === 'Agent Recruiting') {
            console.log('🚫 Deal filtered out - Agent Recruiting pipeline');
            return res.json({ status: 'filtered', reason: 'agent recruiting pipeline' });
        }
        
        const primaryContactId = this.getFirstPeopleId(dealData.people);
        console.log('🎯 Primary contact ID extracted:', primaryContactId);
        
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
        
        const spreadsheetData = await this.lookupOrCreateSpreadsheetRow(dealData.id, dealData);
        const usersList = this.extractUsers(dealData.users);
        console.log('👥 Users extracted from deal:', usersList);
        
        const formattedUCDate = await this.formatUCDate(dealData.pipelineName, spreadsheetData);
        
        // NEW LOGIC: First check if record exists by FUB Deal ID
        console.log('🔍 STEP 1: Checking if Airtable record exists for Deal ID:', dealData.id);
        let existingRecord = await this.findAirtableRecord('Transactions Log', 'FUB Deal ID', dealData.id);
        
        let currentRecord;
        if (existingRecord) {
            console.log(`✅ Found existing Airtable record: ${existingRecord.id}`);
            currentRecord = { recordId: existingRecord.id, record: existingRecord };
        } else {
            console.log('➕ No existing record found - will create new one during path execution');
            currentRecord = null;
        }
        
        // Determine which paths to execute
        const pathsToExecute = this.determinePaths(spreadsheetData, dealData, usersList);
        console.log('🛤️ Paths to execute:', pathsToExecute);
        
        // Execute each path sequentially, all operating on the same record
        for (const path of pathsToExecute) {
            currentRecord = await this.executePath(path, dealData, contactData, spreadsheetData, usersList, formattedUCDate, currentRecord);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        res.json({ 
            status: 'success', 
            dealId: dealData.id,
            pathsExecuted: pathsToExecute,
            airtableRecordId: currentRecord?.recordId,
            recordAction: existingRecord ? 'updated' : 'created'
        });
        
    } catch (error) {
        console.error('❌ Error processing deal update:', error);
        res.status(500).json({ 
            status: 'error', 
            message: error.message 
        });
    }
}

// CORRECTED ISA PATH - SHOULD UPDATE/CREATE MAIN RECORD
async executeISAPath(dealData, spreadsheetData, currentRecord) {
    console.log('🎯 Executing ISA Path');
    
    // Find ISA agent record
    console.log(`🔍 Looking for ISA agent: "${dealData.customISA}"`);
    const isaAgentRecord = await this.findAirtableRecord('Agents', 'Name', dealData.customISA);
    
    if (!isaAgentRecord) {
        console.log(`⚠️ ISA agent "${dealData.customISA}" not found in Airtable - skipping ISA field update`);
        return currentRecord;
    }
    
    console.log(`✅ Found ISA agent record: ${isaAgentRecord.id}`);
    console.log(`✅ ISA FUB Contact ID: ${isaAgentRecord.fields['FUB Contact ID']}`);
    
    // Prepare ISA data to add to the record
    const isaData = {
        'ISA FUB Contact ID': isaAgentRecord.fields['FUB Contact ID']
    };
    
    if (currentRecord) {
        // Update existing record with ISA info
        console.log(`🔄 Adding ISA data to existing record: ${currentRecord.recordId}`);
        await this.updateAirtableRecord('Transactions Log', currentRecord.recordId, isaData);
        return currentRecord;
    } else {
        // Create new record with ISA info (and FUB Deal ID so other paths can find it)
        console.log('➕ Creating new record with ISA data');
        const newRecordData = {
            'FUB Deal ID': dealData.id, // CRITICAL: Include Deal ID so other paths can find this record
            ...isaData
        };
        
        const result = await this.createAirtableRecord('Transactions Log', newRecordData);
        console.log(`✅ ISA Path created record: ${result.id}`);
        return { recordId: result.id, record: result };
    }
}

// CORRECTED AGENT DIFFERENT PATH
async executeAgentDifferentPath(dealData, contactData, spreadsheetData, usersList, currentRecord) {
    console.log('🎯 Executing Agent Different Path');
    
    const coAgentResult = this.determineCoAgent(usersList, contactData.assignedTo, dealData.id);
    
    if (coAgentResult.error || !coAgentResult.coAgent) {
        console.log(`⚠️ No co-agent determined - skipping agent different path`);
        return currentRecord;
    }
    
    const coAgent = coAgentResult.coAgent;
    console.log(`🎯 Determined Co-Agent: ${coAgent}`);
    
    // Find co-agent record in Airtable
    console.log(`🔍 Looking for co-agent: "${coAgent}"`);
    const coAgentRecord = await this.findAirtableRecord('Agents', 'Name', coAgent);
    
    // Prepare co-agent data
    const coAgentData = {
        'Primary Agent Deal %': 50,
        'Co-Agent Deal %': 50
    };
    
    if (coAgentRecord) {
        coAgentData['Co-Agent FUB Contact ID'] = coAgentRecord.fields['FUB Contact ID'];
        console.log(`✅ Found co-agent record, FUB Contact ID: ${coAgentRecord.fields['FUB Contact ID']}`);
    } else {
        console.log(`⚠️ Co-agent "${coAgent}" not found in Airtable - skipping Co-Agent FUB Contact ID field`);
    }
    
    if (currentRecord) {
        // Update existing record
        console.log(`🔄 Adding co-agent data to existing record: ${currentRecord.recordId}`);
        await this.updateAirtableRecord('Transactions Log', currentRecord.recordId, coAgentData);
        return currentRecord;
    } else {
        // Create new record with co-agent info
        console.log('➕ Creating new record with co-agent data');
        const newRecordData = {
            'FUB Deal ID': dealData.id, // CRITICAL: Include Deal ID
            ...coAgentData
        };
        
        const result = await this.createAirtableRecord('Transactions Log', newRecordData);
        console.log(`✅ Agent Different Path created record: ${result.id}`);
        return { recordId: result.id, record: result };
    }
}

// CORRECTED NO CONTACT PATH - SHOULD FIND AGENT BY FUB USER ID
async executeNoContactPath(dealData, contactData, spreadsheetData, formattedUCDate, currentRecord) {
    console.log('🎯 Executing No Contact Path');
    console.log('🔍 Input data:');
    console.log('  - Deal ID:', dealData.id);
    console.log('  - Contact ID:', contactData.id);
    console.log('  - Users ID from spreadsheet:', spreadsheetData.usersId);
    
    // CORRECTED: Find agent by FUB User ID (not by name)
    console.log(`🔍 Looking for agent with FUB User ID: "${spreadsheetData.usersId}"`);
    const primaryAgentRecord = await this.findAirtableRecord('Agents', 'FUB User ID', spreadsheetData.usersId);
    
    if (!primaryAgentRecord) {
        console.error(`❌ Primary agent not found for FUB User ID: ${spreadsheetData.usersId} - stopping execution`);
        // Debug: Show what agents exist
        await this.debugListAirtableRecords('Agents');
        throw new Error(`Primary agent not found for FUB User ID: ${spreadsheetData.usersId}`);
    }
    
    console.log(`✅ Found primary agent record: ${primaryAgentRecord.id}`);
    console.log(`✅ Primary agent FUB Contact ID: ${primaryAgentRecord.fields['FUB Contact ID']}`);
    
    // Build complete transaction data
    const transactionData = {
        'FUB Deal ID': dealData.id,
        'FUB Contact ID': contactData.id?.toString(),
        'Address / Client': dealData.name,
        'Stage': dealData.stageName,
        'Transaction Type': dealData.pipelineName,
        'Primary Agent FUB Contact ID': primaryAgentRecord.fields['FUB Contact ID'],
        'Contact Created Date': contactData.created ? new Date(contactData.created).toISOString().split('T')[0] : null,
        'Appt Set Date': dealData.customApptSetDate,
        'Appt Scheduled For Date': dealData.customApptScheduledForDate,
        'Appt Held Date': dealData.customApptHeldDate,
        'Signed Date': dealData.customSignedDate,
        'Listing Live Date': dealData.customLiveDate,
        'Attorney Review Date': dealData.customAttorneyReviewDate,
        'Under Contract Date': formattedUCDate,
        'Closing Date': dealData.projectedCloseDate,
        'Sale Price': dealData.price,
        'Primary Agent Deal %': 100, // Default - will be overridden if co-agent exists
        'FUB Contact Tags': contactData.tags,
        'Existing Transaction': dealData.customExistingTransaction
    };
    
    console.log('📝 Prepared transaction data:', JSON.stringify(transactionData, null, 2));
    
    if (currentRecord) {
        // Update existing record with all transaction data
        console.log(`🔄 Updating existing record: ${currentRecord.recordId} with transaction data`);
        await this.updateAirtableRecord('Transactions Log', currentRecord.recordId, transactionData);
        return currentRecord;
    } else {
        // Create new record with all transaction data
        console.log('➕ Creating new record with transaction data');
        const result = await this.createAirtableRecord('Transactions Log', transactionData);
        console.log(`✅ No Contact Path created record: ${result.id}`);
        return { recordId: result.id, record: result };
    }
}

// ENHANCED DEBUG METHOD TO SEE AGENTS TABLE
async debugListAirtableRecords(tableName) {
    try {
        console.log(`🔍 Debug: Listing records from ${tableName} table`);
        const tableId = tableName === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
        const response = await axios.get(`${this.config.airtableBaseUrl}/${tableId}`, {
            headers: {
                'Authorization': `Bearer ${this.config.airtableToken}`
            },
            params: {
                maxRecords: 10
            }
        });
        
        console.log(`📊 Found ${response.data.records.length} records in ${tableName}:`);
        response.data.records.forEach((record, index) => {
            console.log(`  ${index + 1}. Record ID: ${record.id}`);
            if (tableName === 'Agents') {
                console.log(`     Name: "${record.fields.Name || 'N/A'}"`);
                console.log(`     FUB User ID: "${record.fields['FUB User ID'] || 'N/A'}" (type: ${typeof record.fields['FUB User ID']})`);
                console.log(`     FUB Contact ID: "${record.fields['FUB Contact ID'] || 'N/A'}"`);
            } else {
                console.log(`     FUB Deal ID: "${record.fields['FUB Deal ID'] || 'N/A'}" (type: ${typeof record.fields['FUB Deal ID']})`);
                console.log(`     Address/Client: "${record.fields['Address / Client'] || 'N/A'}"`);
            }
            console.log(`     All fields: ${Object.keys(record.fields).join(', ')}`);
        });
    } catch (error) {
        console.error(`❌ Debug listing failed: ${error.message}`);
    }
}