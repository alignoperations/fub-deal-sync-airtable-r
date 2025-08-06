require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

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

      // Find or create the Transactions Log record
      const existing = await this.findAirtableRecord('Transactions Log', 'FUB Deal ID', dealData.id);
      let recordId;
      if (existing) {
        recordId = existing.id;
        console.log(`🔍 Found existing record ${recordId}`);
      } else {
        const created = await this.createAirtableRecord('Transactions Log', { 'FUB Deal ID': dealData.id });
        recordId = created.id;
        console.log(`➕ Created stub record ${recordId}`);
      }

      // Get contact data, if any
      const primaryContactId = this.getFirstPeopleId(dealData.people);
      let contactData = { id: null, assignedTo: null, tags: [] };
      if (primaryContactId) {
        try {
          contactData = await this.getContactData(primaryContactId);
        } catch (err) {
          console.log('⚠️ Contact lookup failed:', err.message);
        }
      }

      // Build agent update payload
      const users = this.extractUsers(dealData.users).map(u => u.id);
      const updateData = {};

      // Primary agent
      if (contactData.id) {
        const primaryRec = await this.findAirtableRecord('Agents', 'FUB User ID', contactData.id);
        if (primaryRec) {
          updateData['Primary Agent FUB Contact ID'] = primaryRec.fields['FUB Contact ID'];
          console.log(`✅ Primary Agent FUB Contact ID set to ${updateData['Primary Agent FUB Contact ID']}`);
        } else {
          console.log(`⚠️ Primary agent record for User ID ${contactData.id} not found`);
        }
      }

      // Co-agent, if present
      const coId = users.find(id => id !== contactData.id);
      if (coId) {
        const coRec = await this.findAirtableRecord('Agents', 'FUB User ID', coId);
        if (coRec) {
          updateData['Co-Agent FUB Contact ID'] = coRec.fields['FUB Contact ID'];
          console.log(`✅ Co-Agent FUB Contact ID set to ${updateData['Co-Agent FUB Contact ID']}`);
        } else {
          console.log(`⚠️ Co-agent record for User ID ${coId} not found`);
        }
        // Split 50/50
        updateData['Primary Agent Deal %'] = 50;
        updateData['Co-Agent Deal %'] = 50;
      } else {
        // Only primary, 100%
        updateData['Primary Agent Deal %'] = 100;
      }

      // Push agent update
      if (Object.keys(updateData).length) {
        await this.updateAirtableRecord('Transactions Log', recordId, updateData);
      }

      // ISA (after agents)
      if (dealData.customISA) {
        console.log('🎯 Running ISA update');
        const isaRec = await this.findAirtableRecord('Agents', 'Name', dealData.customISA);
        if (isaRec) {
          const fubContactId = isaRec.fields['FUB Contact ID'];
          await this.updateAirtableRecord('Transactions Log', recordId, { 'ISA FUB Contact ID': fubContactId });
          console.log(`✅ ISA FUB Contact ID set to ${fubContactId}`);
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

  // Utility methods
  getDealData(id) {
    return axios.get(`${this.config.followUpBossApi}/deals/${id}`, {
      headers: { Authorization: `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}` }
    }).then(r => r.data);
  }
  getContactData(id) {
    return axios.get(`${this.config.followUpBossApi}/people/${id}`, {
      headers: { Authorization: `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}` }
    }).then(r => r.data);
  }
  filterActiveDeals(dealData) {
    return dealData.status === 'Active' && !dealData.status.includes('Deleted');
  }
  getFirstPeopleId(people) {
    return Array.isArray(people) && people.length ? people[0].id : null;
  }
  extractUsers(usersArray) {
    if (!Array.isArray(usersArray)) return [];
    return usersArray.map(u => ({ id: u.id }));
  }

  findAirtableRecord(tableName, fieldName, value) {
    const tableId = tableName === 'Agents'
      ? this.config.airtableAgentsTable
      : this.config.airtableTransactionsTable;
    return axios.get(`${this.config.airtableBaseUrl}/${tableId}`, {
      headers: { Authorization: `Bearer ${this.config.airtableToken}` },
      params: { filterByFormula: `{${fieldName}} = "${value}"`, maxRecords: 1 }
    })
      .then(r => (r.data.records[0] || null))
      .catch(() => null);
  }
  createAirtableRecord(tableName, data) {
    const tableId = tableName === 'Agents'
      ? this.config.airtableAgentsTable
      : this.config.airtableTransactionsTable;
    return axios.post(
      `${this.config.airtableBaseUrl}/${tableId}`,
      { fields: this.cleanAirtableData(data) },
      { headers: { Authorization: `Bearer ${this.config.airtableToken}`, 'Content-Type': 'application/json' } }
    ).then(r => r.data);
  }
  updateAirtableRecord(tableName, recordId, data) {
    const tableId = tableName === 'Agents'
      ? this.config.airtableAgentsTable
      : this.config.airtableTransactionsTable;
    return axios.patch(
      `${this.config.airtableBaseUrl}/${tableId}/${recordId}`,
      { fields: this.cleanAirtableData(data) },
      { headers: { Authorization: `Bearer ${this.config.airtableToken}`, 'Content-Type': 'application/json' } }
    ).then(r => r.data);
  }
  cleanAirtableData(obj) {
    const cleaned = {};
    Object.entries(obj).forEach(([k, v]) => {
      if (v != null) cleaned[k] = v;
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
  airtableTransactionsTable: 'tblQAs5EG3gU6TzT3'
};

const automation = new DealManagementAutomation(config);
module.exports = { DealManagementAutomation, config };

if (require.main === module) automation.start();
