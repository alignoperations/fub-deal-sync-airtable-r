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
      console.log('📥 Received webhook:', JSON.stringify(req.body, null, 2));
      const dealId = req.body.resourceIds[0];
      const dealData = await this.getDealData(dealId);
      console.log('📊 Deal data retrieved:', JSON.stringify(dealData, null, 2));

      if (!this.filterActiveDeals(dealData) || dealData.pipelineName === 'Agent Recruiting') {
        console.log('🚫 Deal filtered out');
        return res.json({ status: 'filtered' });
      }

      // Find or create Transactions Log record
      const existing = await this.findAirtableRecord('Transactions Log', 'FUB Deal ID', dealData.id);
      const recordId = existing
        ? existing.id
        : (await this.createAirtableRecord('Transactions Log', { 'FUB Deal ID': dealData.id })).id;
      console.log(existing ? `🔍 Found record ${recordId}` : `➕ Created record ${recordId}`);

      // Fetch primary contact details
      const primaryContactId = this.getFirstPeopleId(dealData.people);
      let contactData = { id: null, assignedUserId: null, tags: [] };
      if (primaryContactId) {
        try {
          contactData = await this.getContactData(primaryContactId);
        } catch (err) {
          console.log('⚠️ Contact lookup failed:', err.message);
        }
      }
      console.log(`📇 Contact assignedUserId: ${contactData.assignedUserId}`);

      // Determine primary vs co-agent IDs using contactData.assignedUserId
      const usersList = Array.isArray(dealData.users) ? dealData.users : [];
      let primaryUserId = null;
      let coUserId = null;

      if (contactData.assignedUserId) {
        primaryUserId = contactData.assignedUserId;
        if (usersList.length > 1) {
          coUserId = usersList.find(u => u.id !== primaryUserId)?.id;
        }
      } else if (usersList.length === 1) {
        primaryUserId = usersList[0].id;
      } else if (usersList.length > 1) {
        primaryUserId = usersList[0].id;
        coUserId = usersList[1].id;
      }
      console.log(`🎯 PrimaryUserId: ${primaryUserId}, CoUserId: ${coUserId}`);

      // Fetch agent emails from FUB
      let primaryEmail = null;
      let coEmail = null;
      if (primaryUserId) {
        try {
          const user = await this.getUserData(primaryUserId);
          primaryEmail = user.email;
          console.log(`ℹ️ Primary agent email: ${primaryEmail}`);
        } catch (err) {
          console.log('⚠️ Failed to fetch primary user email:', err.message);
        }
      }
      if (coUserId) {
        try {
          const coUser = await this.getUserData(coUserId);
          coEmail = coUser.email;
          console.log(`ℹ️ Co-agent email: ${coEmail}`);
        } catch (err) {
          console.log('⚠️ Failed to fetch co-agent email:', err.message);
        }
      }

      // Build update payload for agents using Company Email lookup
      const updateData = {};

      if (primaryEmail) {
        const primaryRec = await this.findAirtableRecord('Agents', 'Company Email', primaryEmail);
        if (primaryRec) {
          updateData['Primary Agent FUB Contact ID'] = [primaryRec.id];
          console.log(`✅ Primary Agent linked-record set to [${primaryRec.id}]`);
        } else {
          console.log(`⚠️ No Airtable record for Company Email ${primaryEmail}`);
        }
      }

      if (coEmail) {
        const coRec = await this.findAirtableRecord('Agents', 'Company Email', coEmail);
        if (coRec) {
          updateData['Co-Agent FUB Contact ID'] = [coRec.id];
          console.log(`✅ Co-Agent linked-record set to [${coRec.id}]`);
        } else {
          console.log(`⚠️ No Airtable record for Company Email ${coEmail}`);
        }
        updateData['Primary Agent Deal %'] = 50;
        updateData['Co-Agent Deal %'] = 50;
      } else {
        updateData['Primary Agent Deal %'] = 100;
      }

      // Apply agent updates
      if (Object.keys(updateData).length) {
        try {
          await this.updateAirtableRecord('Transactions Log', recordId, updateData);
        } catch (err) {
          console.error('❌ Airtable agent update failed:', err.response?.data || err.message);
        }
      }

      // ISA update
      if (dealData.customISA) {
        console.log('🎯 Running ISA update');
        const isaRec = await this.findAirtableRecord('Agents', 'Name', dealData.customISA);
        if (isaRec) {
          try {
            await this.updateAirtableRecord('Transactions Log', recordId, { 'ISA FUB Contact ID': [isaRec.id] });
          } catch (err) {
            console.error('❌ ISA update failed:', err.response?.data || err.message);
          }
          console.log(`✅ ISA linked-record set to [${isaRec.id}]`);
        } else {
          console.log(`⚠️ ISA agent "${dealData.customISA}" not found`);
        }
      }

      return res.json({ status: 'success', dealId: dealData.id, airtableRecordId: recordId });
    } catch (err) {
      console.error('❌ Processing error:', err.message);
      return res.status(500).json({ status: 'error', message: err.message });
    }
  }

  getDealData(id) {
    return axios
      .get(`${this.config.followUpBossApi}/deals/${id}`, {
        headers: { Authorization: `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}` }
      })
      .then(r => r.data);
  }

  getContactData(id) {
    return axios
      .get(`${this.config.followUpBossApi}/people/${id}`, {
        headers: { Authorization: `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}` }
      })
      .then(r => r.data);
  }

  getUserData(id) {
    const url = `${this.config.followUpBossApi}/users/${id}`;
    console.log(`🔗 Calling FUB users endpoint: ${url}`);
    return axios
      .get(url, { headers: { Authorization: `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}` } })
      .then(r => r.data);
  }

  filterActiveDeals(d) {
    return d.status === 'Active' && !d.status.includes('Deleted');
  }

  getFirstPeopleId(p) {
    return Array.isArray(p) && p.length ? p[0].id : null;
  }

  findAirtableRecord(tableName, fieldName, value) {
    const tableId = tableName === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
    return axios
      .get(`${this.config.airtableBaseUrl}/${tableId}`, {
        headers: { Authorization: `Bearer ${this.config.airtableToken}` },
        params: { filterByFormula: `{${fieldName}} = "${value}"`, maxRecords: 1 }
      })
      .then(r => r.data.records[0] || null)
      .catch(() => null);
  }

  createAirtableRecord(tableName, data) {
    const tableId = tableName === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
    return axios
      .post(
        `${this.config.airtableBaseUrl}/${tableId}`,
        { fields: data },
        { headers: { Authorization: `Bearer ${this.config.airtableToken}`, 'Content-Type': 'application/json' } }
      )
      .then(r => r.data);
  }

  updateAirtableRecord(tableName, recordId, data) {
    const tableId = tableName === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
    return axios
      .patch(
        `${this.config.airtableBaseUrl}/${tableId}/${recordId}`,
        { fields: data },
        { headers: { Authorization: `Bearer ${this.config.airtableToken}`, 'Content-Type': 'application/json' } }
      )
      .then(r => r.data);
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
  airtableTransactionsTable: 'tblQAs5EG3gU6TzT3'
};

const automation = new DealManagementAutomation(config);
module.exports = { DealManagementAutomation, config };

if (require.main === module) automation.start();
