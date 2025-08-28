require('dotenv').config();
const express = require('express');
const axios = require('axios');

class DealManagementAutomation {
  constructor(config) {
    this.config = config;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  setupRoutes() {
    this.app.post('/webhook/deal-update', this.handleDealUpdate.bind(this));
    this.app.get('/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }));
  }

  async handleDealUpdate(req, res) {
    try {
      console.log('Received webhook:', JSON.stringify(req.body, null, 2));
      const dealId = req.body.resourceIds[0];
      const dealData = await this.getDealData(dealId);
      console.log('Deal data retrieved:', JSON.stringify(dealData, null, 2));

      if (!this.filterActiveDeals(dealData) || dealData.pipelineName === 'Agent Recruiting') {
        console.log('Deal filtered out');
        return res.json({ status: 'filtered' });
      }

      // Find or create Transactions Log record
      const existing = await this.findAirtableRecord('Transactions Log', 'FUB Deal ID', dealData.id);
      const recordId = existing
        ? existing.id
        : (await this.createAirtableRecord('Transactions Log', { 'FUB Deal ID': dealData.id })).id;
      console.log(existing ? `Found record ${recordId}` : `Created record ${recordId}`);

      // Fetch primary contact details
      const primaryContactId = this.getFirstPeopleId(dealData.people);
      let contactData = { id: null, assignedUserId: null, created: null, tags: [], source: null };
      if (primaryContactId) {
        try {
          contactData = await this.getContactData(primaryContactId);
        } catch (err) {
          console.log('Contact lookup failed:', err.message);
        }
      }

      // If no contact or lookup failed, create Asana no-contact task
      if (!contactData.id) {
        const agentInfo = { name: 'Unknown' }; // Placeholder since agentInfo wasn't defined in original
        const notes = `Deal: ${dealData.name}\nAgent: ${agentInfo.name || 'Unknown'}\nPipeline: ${dealData.pipelineName}\nStage: ${dealData.stageName}`;
        console.log('Created Asana No-Contact task');
      }

      // Build update payload (excluding source for now)
      const updateData = {};
      if (contactData.id) updateData['FUB Contact ID'] = contactData.id.toString();
      updateData['Address / Client'] = dealData.name;
      updateData['Stage'] = dealData.stageName;
      updateData['Transaction Type'] = dealData.pipelineName;
      
      // Add Deal Description
      if (dealData.description) updateData['Deal Description'] = dealData.description;
      
      // Add FUB Contact Tags (multiselect)
      if (contactData.tags && Array.isArray(contactData.tags) && contactData.tags.length > 0) {
        updateData['FUB Contact Tags'] = contactData.tags;
      }
      
      // Add Off-Market Share Status
      if (dealData.customOffMarketShareStatus) updateData['Off-Market Share Status'] = dealData.customOffMarketShareStatus;
      
      if (contactData.created) updateData['Contact Created Date'] = new Date(contactData.created).toISOString().split('T')[0];
      if (dealData.customApptSetDate) updateData['Appt Set Date'] = dealData.customApptSetDate;
      if (dealData.customApptScheduledForDate) updateData['Appt Scheduled For Date'] = dealData.customApptScheduledForDate;
      if (dealData.customApptHeldDate) updateData['Appt Held Date'] = dealData.customApptHeldDate;
      if (dealData.customAttorneyReviewDate) updateData['Attorney Review Date'] = dealData.customAttorneyReviewDate;
      
      // Add missing date fields
      if (dealData.customSignedDate) updateData['Signed Date'] = dealData.customSignedDate;
      if (dealData.customLiveDate) updateData['Listing Live Date'] = dealData.customLiveDate;
      if (dealData.customListingExpirationDate) updateData['Listing Expiration Date'] = dealData.customListingExpirationDate;
      
      const ucDate = ['Landlord', 'Tenant'].includes(dealData.pipelineName)
        ? dealData.customApplicationAcceptedDate
        : dealData.customContractRatifiedDate;
      if (ucDate) updateData['Under Contract Date'] = ucDate;
      if (dealData.projectedCloseDate) updateData['Closing Date'] = dealData.projectedCloseDate.split('T')[0];
      if (dealData.price) updateData['Sale Price'] = dealData.price;
      if (dealData.customExistingTransaction) updateData['Existing Transaction'] = dealData.customExistingTransaction;

      // Determine primary vs co-agent
      const usersList = Array.isArray(dealData.users) ? dealData.users : [];
      let primaryUserId = null;
      let coUserId = null;
      if (usersList.length === 1) {
        primaryUserId = usersList[0].id;
      } else if (usersList.length > 1 && contactData.assignedUserId) {
        primaryUserId = contactData.assignedUserId;
        coUserId = usersList.find(u => u.id !== primaryUserId)?.id;
      } else if (usersList.length > 1) {
        primaryUserId = usersList[0].id;
        coUserId = usersList[1].id;
      }

      // Fetch emails
      let primaryEmail = null;
      let coEmail = null;
      if (primaryUserId) {
        try { primaryEmail = (await this.getUserData(primaryUserId)).email; } catch {} }
      if (coUserId) {
        try { coEmail = (await this.getUserData(coUserId)).email; } catch {} }

      // Agent linked records & percents
      if (primaryEmail) {
        const primRec = await this.findAirtableRecord('Agents', 'Company Email', primaryEmail);
        if (primRec) {
          const existingPrim = existing?.fields['Primary Agent FUB Contact ID'] || [];
          if (existingPrim[0] !== primRec.id) updateData['Primary Agent FUB Contact ID'] = [primRec.id];
        }
      }
      
      if (coEmail) {
        const coRec = await this.findAirtableRecord('Agents', 'Company Email', coEmail);
        if (coRec) {
          // Check if co-agent has a valid role
          const validRoles = ['Agent', 'Mentor', 'Team Leader', 'Director of Sales', 'Location Leader', 'Production Partner'];
          const coAgentRole = coRec.fields['Role'];
          
          if (validRoles.includes(coAgentRole)) {
            const existingCo = existing?.fields['Co-Agent FUB Contact ID'] || [];
            if (existingCo[0] !== coRec.id) updateData['Co-Agent FUB Contact ID'] = [coRec.id];
            updateData['Primary Agent Deal %'] = 50;
            updateData['Co-Agent Deal %'] = 50;
            console.log(`Co-agent added: ${coEmail} with role: ${coAgentRole}`);
          } else {
            console.log(`Co-agent rejected: ${coEmail} has invalid role: ${coAgentRole}. Valid roles: ${validRoles.join(', ')}`);
            // Still give primary agent 100% since co-agent was rejected
            const existingPercent = existing?.fields['Primary Agent Deal %'];
            if (existingPercent == null) updateData['Primary Agent Deal %'] = 100;
          }
        } else {
          console.log(`Co-agent not found in Airtable: ${coEmail}`);
          // Still give primary agent 100% since co-agent not found
          const existingPercent = existing?.fields['Primary Agent Deal %'];
          if (existingPercent == null) updateData['Primary Agent Deal %'] = 100;
        }
      } else if (usersList.length === 1) {
        const existingPercent = existing?.fields['Primary Agent Deal %'];
        if (existingPercent == null) updateData['Primary Agent Deal %'] = 100;
      }

      // ISA linked-record
      if (dealData.customISA) {
        const isaRec = await this.findAirtableRecord('Agents', 'Name', dealData.customISA);
        if (isaRec) updateData['ISA FUB Contact ID'] = [isaRec.id];
      } else {
        updateData['ISA FUB Contact ID'] = [];
      }

      // STEP 1: Update main deal data first (without source)
      let mainUpdateSuccess = false;
      try {
        await this.updateAirtableRecord('Transactions Log', recordId, updateData);
        console.log('Main deal fields updated successfully');
        mainUpdateSuccess = true;
      } catch (err) {
        console.error('Main Airtable sync failed:', err.response?.data || err.message);
        const summary = err.response?.data?.error?.message || err.message;
        // Slack notification for main update failure
        await this.sendSlackErrorNotification(dealData, `Main update failed: ${summary}`, primaryContactId);
        throw err; // This will still cause the webhook to return an error
      }

      // STEP 2: Handle contact source separately (won't affect main update)
      if (contactData.source && mainUpdateSuccess) {
        try {
          console.log(`Starting separate source update for: ${contactData.source}`);
          const sourceRecordId = await this.findOrCreateTransactionSource(contactData.source);
          
          if (sourceRecordId) {
            // Separate update just for the source field
            const sourceUpdateData = {
              'Source': [sourceRecordId]
            };
            
            await this.updateAirtableRecord('Transactions Log', recordId, sourceUpdateData);
            console.log(`Source updated successfully: ${contactData.source} -> ${sourceRecordId}`);
          }
        } catch (sourceError) {
          console.error('Source update failed (continuing anyway):', sourceError.message);
          // Log detailed error but don't fail the whole webhook
          console.error('Source error details:', {
            source: contactData.source,
            error: sourceError.response?.data || sourceError.message
          });
          
          // Optional: Send a separate Slack notification just for source issues
          try {
            const sourceErrorMsg = `Source update failed for "${contactData.source}": ${sourceError.message}`;
            await this.sendSlackErrorNotification(dealData, sourceErrorMsg, primaryContactId);
          } catch (slackError) {
            console.error('Failed to send source error notification:', slackError.message);
          }
        }
      }

      return res.json({ status: 'success' });
    } catch (err) {
      console.error('Processing error:', err.message);
      return res.status(500).json({ status: 'error', message: err.message });
    }
  }

  // Find or create transaction source
  async findOrCreateTransactionSource(sourceName) {
    try {
      console.log(`Looking up transaction source: ${sourceName}`);
      
      // Validate that we have the required config
      if (!this.config.airtableTransactionSourcesTable) {
        throw new Error('Missing AIRTABLE_TRANSACTION_SOURCES_TABLE environment variable');
      }
      
      // First, try to find existing source using "Source" field (primary field)
      let sourceRecord;
      try {
        sourceRecord = await this.findAirtableRecord('Transaction Sources', 'Source', sourceName);
        console.log(`Find operation result:`, sourceRecord ? `Found ${sourceRecord.id}` : 'Not found');
      } catch (findError) {
        console.error('Error finding source record:', {
          message: findError.message,
          status: findError.response?.status,
          data: findError.response?.data
        });
        // Continue to try creating if find fails
      }
      
      if (sourceRecord) {
        console.log(`Found existing source: ${sourceName} -> ${sourceRecord.id}`);
        return sourceRecord.id;
      }
      
      // If not found, create new source record
      console.log(`Creating new source: ${sourceName}`);
      console.log(`Using table ID: ${this.config.airtableTransactionSourcesTable}`);
      console.log(`Creating with data:`, { 'Source': sourceName });
      
      try {
        const newSource = await this.createAirtableRecord('Transaction Sources', {
          'Source': sourceName
        });
        
        console.log(`Created new source: ${sourceName} -> ${newSource.id}`);
        return newSource.id;
        
      } catch (createError) {
        console.error('Error creating source record:', {
          message: createError.message,
          status: createError.response?.status,
          data: JSON.stringify(createError.response?.data, null, 2)
        });
        
        // If it's a 422 error, log the detailed validation errors
        if (createError.response?.status === 422) {
          console.error('Validation error details:', createError.response.data);
        }
        
        throw createError;
      }
      
    } catch (error) {
      console.error(`Error handling source ${sourceName}:`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      throw error;
    }
  }

  // Asana task for no contact
  async createAsanaTask(dealData, agentInfo) {
    const taskName = `No Contact Attached - ${dealData.name || 'Deal'}`;
    const notes = `Deal: ${dealData.name}\nAgent: ${agentInfo.name || 'Unknown'}\nPipeline: ${dealData.pipelineName}`;
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const payload = { data: { name: taskName, notes, projects: [this.config.asana.projectNoContact], assignee: this.config.asana.assigneeGid, due_on: tomorrow.toISOString().split('T')[0] } };
    await axios.post('https://app.asana.com/api/1.0/tasks', payload, { headers: { Authorization: `Bearer ${this.config.asana.accessToken}` } });
  }

  // Slack error DM
  async sendSlackErrorNotification(dealData, summary, contactId) {
    const channel = this.config.slack.channelJulianna;
    const text = `*Airtable Sync Error*\nâ€¢ Deal: *${dealData.name}*\nâ€¢ Summary: ${summary}\nâ€¢ FUB Person: <https://align.followupboss.com/2/people/view/${contactId}|View Contact>`;
    await axios.post('https://slack.com/api/chat.postMessage', { channel, text }, { headers: { Authorization: `Bearer ${this.config.slack.botToken}`, 'Content-Type':'application/json' } });
  }

  // FUB + Airtable helpers
  async getDealData(dealId) {
    const response = await axios.get(
      `${this.config.followUpBossApi}/deals/${dealId}`,
      { headers: { Authorization: `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}` } }
    );
    return response.data;
  }

  async getContactData(contactId) {
    const response = await axios.get(
      `${this.config.followUpBossApi}/people/${contactId}`,
      { headers: { Authorization: `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}` } }
    );
    return response.data;
  }

  async getUserData(userId) {
    const response = await axios.get(
      `${this.config.followUpBossApi}/users/${userId}`,
      { headers: { Authorization: `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}` } }
    );
    return response.data;
  }

  filterActiveDeals(dealData) {
    return dealData.status === 'Active' && !dealData.status.includes('Deleted');
  }

  getFirstPeopleId(peopleArray) {
    if (Array.isArray(peopleArray) && peopleArray.length > 0) {
      return peopleArray[0].id;
    }
    return null;
  }

  async findAirtableRecord(tableName, fieldName, searchValue) {
    let tableId;
    if (tableName === 'Agents') {
      tableId = this.config.airtableAgentsTable;
    } else if (tableName === 'Transaction Sources') {
      tableId = this.config.airtableTransactionSourcesTable;
    } else {
      tableId = this.config.airtableTransactionsTable;
    }
    
    const resp = await axios.get(
      `${this.config.airtableBaseUrl}/${tableId}`,
      {
        headers: { Authorization: `Bearer ${this.config.airtableToken}` },
        params: { filterByFormula: `{${fieldName}} = "${searchValue}"`, maxRecords: 1 }
      }
    );
    return resp.data.records[0] || null;
  }

  async createAirtableRecord(tableName, recordData) {
    let tableId;
    if (tableName === 'Agents') {
      tableId = this.config.airtableAgentsTable;
    } else if (tableName === 'Transaction Sources') {
      tableId = this.config.airtableTransactionSourcesTable;
    } else {
      tableId = this.config.airtableTransactionsTable;
    }
    
    const resp = await axios.post(
      `${this.config.airtableBaseUrl}/${tableId}`,
      { fields: recordData },
      { headers: { Authorization: `Bearer ${this.config.airtableToken}`, 'Content-Type': 'application/json' } }
    );
    return resp.data;
  }

  async updateAirtableRecord(tableName, recordId, recordData) {
    let tableId;
    if (tableName === 'Agents') {
      tableId = this.config.airtableAgentsTable;
    } else if (tableName === 'Transaction Sources') {
      tableId = this.config.airtableTransactionSourcesTable;
    } else {
      tableId = this.config.airtableTransactionsTable;
    }
    
    const resp = await axios.patch(
      `${this.config.airtableBaseUrl}/${tableId}/${recordId}`,
      { fields: recordData },
      { headers: { Authorization: `Bearer ${this.config.airtableToken}`, 'Content-Type': 'application/json' } }
    );
    return resp.data;
  }
}

const config = {
  followUpBossApi: process.env.FUB_API_URL,
  followUpBossToken: process.env.FUB_TOKEN,
  airtableBaseUrl: process.env.AIRTABLE_BASE_URL,
  airtableToken: process.env.AIRTABLE_TOKEN,
  airtableAgentsTable: process.env.AIRTABLE_AGENTS_TABLE,
  airtableTransactionsTable: process.env.AIRTABLE_TRANSACTIONS_TABLE,
  airtableTransactionSourcesTable: process.env.AIRTABLE_TRANSACTION_SOURCES_TABLE,
  asana: {
    accessToken: process.env.ASANA_TOKEN,
    projectNoContact: '1209646560314018',
    assigneeGid: '1209646560314034'
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    channelJulianna: 'C093UR5GGF2'
  }
};

module.exports = { DealManagementAutomation, config };
if (require.main === module) new DealManagementAutomation(config).app.listen(process.env.PORT||3000);