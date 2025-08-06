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
      const existing = await this.findAirtableRecord(tableName, fieldName, value) {
    const tableId = tableName === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
    // Case-insensitive match for email field
    const filterFormula = fieldName === 'Company Email'
      ? `LOWER({${fieldName}}) = "${value.toLowerCase()}"`
      : `{${fieldName}} = "${value}"`;
    return axios
      .get(`${this.config.airtableBaseUrl}/${tableId}`, {
        headers: { Authorization: `Bearer ${this.config.airtableToken}` },
        params: { filterByFormula: filterFormula, maxRecords: 1 }
      })
      .then(r => r.data.records[0] || null)
      .catch(() => null);
  }
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
    // Case-insensitive match for email field
    const filterFormula = fieldName === 'Company Email'
      ? `LOWER({${fieldName}}) = "${value.toLowerCase()}"`
      : `{${fieldName}} = "${value}"`;
    return axios
      .get(`${this.config.airtableBaseUrl}/${tableId}`, {
        headers: { Authorization: `Bearer ${this.config.airtableToken}` },
        params: { filterByFormula, maxRecords: 1 }
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
