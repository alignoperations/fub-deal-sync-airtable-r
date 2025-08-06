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

            if (!this.filterActiveDeals(dealData) || dealData.pipelineName === 'Agent Recruiting') {
                console.log('🚫 Deal filtered out');
                return res.json({ status: 'filtered' });
            }

            // Find or create Airtable record
            const existing = await this.findAirtableRecord('Transactions Log', 'FUB Deal ID', dealData.id);
            let sharedRecord;
            if (existing) {
                console.log(`🔍 Found existing record ${existing.id}`);
                sharedRecord = { recordId: existing.id };
            } else {
                console.log(`➕ Creating stub record`);
                const created = await this.createAirtableRecord('Transactions Log', { 'FUB Deal ID': dealData.id });
                sharedRecord = { recordId: created.id };
            }

            const primaryContactId = this.getFirstPeopleId(dealData.people);
            let contactData = { id: null, assignedTo: null, tags: [] };
            if (primaryContactId) {
                try {
                    contactData = await this.getContactData(primaryContactId);
                } catch {
                    console.log('⚠️ Contact lookup failed');
                }
            }

            const sheetData = await this.lookupOrCreateSpreadsheetRow(dealData.id, dealData);
            const usersList = this.extractUsers(dealData.users);
            const formattedUCDate = this.formatUCDate(dealData.pipelineName, sheetData);
            const paths = this.determinePaths(sheetData, dealData, usersList);
            console.log('🛤️ Paths:', paths);

            for (const path of paths) {
                sharedRecord = await this.executePath(path, dealData, contactData, sheetData, usersList, formattedUCDate, sharedRecord);
                await new Promise(r => setTimeout(r, 100));
            }

            res.json({ status: 'success', dealId: dealData.id, pathsExecuted: paths, airtableRecordId: sharedRecord.recordId });
        } catch (err) {
            console.error('❌ Processing error:', err.message);
            res.status(500).json({ status: 'error', message: err.message });
        }
    }

    determinePaths(sheetData, dealData, usersList) {
        const paths = [];
        if (dealData.customISA && !sheetData.isaFubContactIdFromAirtable) paths.push('isa_path');
        const valid = usersList.filter(u => u.id);
        if (valid.length === 2) paths.push('agent_different_path');
        if (valid.length === 1) paths.push('no_contact_path');
        return paths;
    }

    async executePath(name, dealData, contactData, sheetData, usersList, ucDate, shared) {
        switch (name) {
            case 'isa_path': return this.executeISAPath(dealData, shared);
            case 'agent_different_path': return this.executeAgentDifferentPath(contactData, usersList, shared);
            case 'no_contact_path': return this.executeNoContactPath(dealData, contactData, ucDate, shared);
            default: return shared;
        }
    }

    async executeISAPath(dealData, shared) {
        console.log('🎯 ISA Path');
        const rec = await this.findAirtableRecord('Agents', 'FUB User ID', dealData.customISA);
        if (rec) await this.updateAirtableRecord('Transactions Log', shared.recordId, { 'ISA FUB Contact ID': [rec.id] });
        return shared;
    }

    async executeAgentDifferentPath(contactData, usersList, shared) {
        console.log('🎯 Agent Different Path');
        const ids = usersList.map(u => u.id);
        const coId = ids.find(id => id !== contactData.assignedTo);
        if (coId) {
            const rec = await this.findAirtableRecord('Agents', 'FUB User ID', coId);
            const data = { 'Primary Agent Deal %': 50, 'Co-Agent Deal %': 50 };
            if (rec) data['Co-Agent FUB Contact ID'] = [rec.id];
            await this.updateAirtableRecord('Transactions Log', shared.recordId, data);
        }
        return shared;
    }

    async executeNoContactPath(dealData, contactData, ucDate, shared) {
        console.log('🎯 No Contact Path');
        const data = {
            'FUB Contact ID': contactData.id,
            'Address / Client': dealData.name,
            'Stage': dealData.stageName,
            'Transaction Type': dealData.pipelineName,
            'Under Contract Date': ucDate,
            'Closing Date': dealData.projectedCloseDate,
            'Sale Price': dealData.price,
            'Primary Agent Deal %': 100
        };
        await this.updateAirtableRecord('Transactions Log', shared.recordId, data);
        return shared;
    }

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
    filterActiveDeals(d) { return d.status === 'Active' && !d.status.includes('Deleted'); }
    getFirstPeopleId(p) { return Array.isArray(p) && p.length ? p[0].id : null; }
    extractUsers(u) { return Array.isArray(u) ? u.map(x => ({ id: x.id })) : []; }
    formatUCDate(name, s) { const map = { Listing: s.customContractRatifiedDate, Landlord: s.customApplicationAcceptedDate, Buyer: s.customContractRatifiedDate, Tenant: s.customApplicationAcceptedDate }; return map[name] || null; }
    lookupOrCreateSpreadsheetRow(id) { console.log('📝 Skip Sheets'); return Promise.resolve({ usersId: id, isaFubContactIdFromAirtable: null, customContractRatifiedDate: null, customApplicationAcceptedDate: null }); }

    findAirtableRecord(table, field, value) {
        const id = table === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
        return axios.get(`${this.config.airtableBaseUrl}/${id}`, { headers: { Authorization: `Bearer ${this.config.airtableToken}` }, params: { filterByFormula: `{${field}} = "${value}"`, maxRecords: 1 } })
            .then(r => r.data.records[0] || null)
            .catch(() => null);
    }
    createAirtableRecord(table, data) {
        const id = table === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
        return axios.post(`${this.config.airtableBaseUrl}/${id}`, { fields: this.cleanAirtableData(data) }, { headers: { Authorization: `Bearer ${this.config.airtableToken}`, 'Content-Type': 'application/json' } })
            .then(r => r.data);
    }
    updateAirtableRecord(table, recId, data) {
        const id = table === 'Agents' ? this.config.airtableAgentsTable : this.config.airtableTransactionsTable;
        return axios.patch(`${this.config.airtableBaseUrl}/${id}/${recId}`, { fields: this.cleanAirtableData(data) }, { headers: { Authorization: `Bearer ${this.config.airtableToken}`, 'Content-Type': 'application/json' } })
            .then(r => r.data);
    }
    cleanAirtableData(obj) {
        const cleaned = {};
        Object.entries(obj).forEach(([k, v]) => { if (v != null) cleaned[k] = v; });
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
