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
      let contactData = { id: null, assignedUserId: null, created: null, tags: [] };
      if (primaryContactId) {
        try { contactData = await this.getContactData(primaryContactId); }
        catch (err) { console.log('⚠️ Contact lookup failed:', err.message); }
      }
      console.log(`📇 Contact assignedUserId: ${contactData.assignedUserId}`);

      // Base fields update
      const updateData = {};
      if (contactData.id) updateData['FUB Contact ID'] = contactData.id.toString();
      updateData['Address / Client'] = dealData.name;
      updateData['Stage'] = dealData.stageName;
      updateData['Transaction Type'] = dealData.pipelineName;
      if (contactData.created) updateData['Contact Created Date'] = new Date(contactData.created).toISOString().split('T')[0];
      if (dealData.customApptSetDate) updateData['Appt Set Date'] = dealData.customApptSetDate;
      if (dealData.customApptScheduledForDate) updateData['Appt Scheduled For Date'] = dealData.customApptScheduledForDate;
      if (dealData.customApptHeldDate) updateData['Appt Held Date'] = dealData.customApptHeldDate;
      if (dealData.customAttorneyReviewDate) updateData['Attorney Review Date'] = dealData.customAttorneyReviewDate;
      const ucDate = ['Listing','Buyer'].includes(dealData.pipelineName)
        ? dealData.customContractRatifiedDate
        : dealData.customApplicationAcceptedDate;
      if (ucDate) updateData['Under Contract Date'] = ucDate;
      if (dealData.projectedCloseDate) updateData['Closing Date'] = dealData.projectedCloseDate.split('T')[0];
      if (dealData.price) updateData['Sale Price'] = dealData.price;
      // Existing Transaction
      if (dealData.customExistingTransaction) updateData['Existing Transaction'] = dealData.customExistingTransaction;

      // Determine primary vs co-agent IDs (solo-first)
      const usersList = Array.isArray(dealData.users) ? dealData.users : [];
      let primaryUserId = null;
      let coUserId = null;
      if (usersList.length === 1) {
        primaryUserId = usersList[0].id;
      } else if (contactData.assignedUserId) {
        primaryUserId = contactData.assignedUserId;
        coUserId = usersList.find(u => u.id !== primaryUserId)?.id;
      } else if (usersList.length > 1) {
        primaryUserId = usersList[0].id;
        coUserId = usersList[1].id;
      }
      console.log(`🎯 PrimaryUserId: ${primaryUserId}, CoUserId: ${coUserId}`);

      // Fetch agent emails
      let primaryEmail = null, coEmail = null;
      if (primaryUserId) {
        try { primaryEmail = (await this.getUserData(primaryUserId)).email; console.log(`ℹ️ Primary email: ${primaryEmail}`); }
        catch (err) { console.log('⚠️ Primary email fetch failed:', err.message); }
      }
      if (coUserId) {
        try { coEmail = (await this.getUserData(coUserId)).email; console.log(`ℹ️ Co email: ${coEmail}`); }
        catch (err) { console.log('⚠️ Co email fetch failed:', err.message); }
      }

      // Agent linked-records & percentages
      if (primaryEmail) {
        const primRec = await this.findAirtableRecord('Agents','Company Email',primaryEmail);
        if (primRec) { updateData['Primary Agent FUB Contact ID']=[primRec.id]; console.log(`✅ Primary Agent => [${primRec.id}]`); }
      }
      if (coEmail) {
        const coRec = await this.findAirtableRecord('Agents','Company Email',coEmail);
        if (coRec) { updateData['Co-Agent FUB Contact ID']=[coRec.id]; console.log(`✅ Co-Agent => [${coRec.id}]`); }
        updateData['Primary Agent Deal %']=50;
        updateData['Co-Agent Deal %']=50;
      } else {
        // solo agent: only set Primary Deal % if there is exactly one user and it's not already set on the existing record
        if (usersList.length === 1) {
          const existingPrimaryPercent = existing?.fields?.['Primary Agent Deal %'];
          if (existingPrimaryPercent === undefined || existingPrimaryPercent === null) {
            updateData['Primary Agent Deal %'] = 100;
            console.log('✅ Solo agent, setting Primary Agent Deal % to 100%');
          } else {
            console.log('ℹ️ Solo agent, existing Primary Agent Deal % detected, not modifying');
          }
        }
      }

      // ISA linked-record (clear if missing)
      if (dealData.customISA) {
        const isaRec = await this.findAirtableRecord('Agents','Name',dealData.customISA);
        if (isaRec) { updateData['ISA FUB Contact ID']=[isaRec.id]; console.log(`✅ ISA => [${isaRec.id}]`); }
      } else {
        updateData['ISA FUB Contact ID']=[];
      }

      // Final Airtable update
      try {
        await this.updateAirtableRecord('Transactions Log', recordId, updateData);
        console.log('✅ All fields updated');
      } catch (err) {
        console.error('❌ Final update failed:', err.response?.data||err.message);
      }

      return res.json({ status:'success', dealId:dealData.id, airtableRecordId:recordId });
    } catch (err) {
      console.error('❌ Processing error:', err.message);
      return res.status(500).json({ status:'error', message:err.message });
    }
  }

  getDealData(id) {
    return axios.get(`${this.config.followUpBossApi}/deals/${id}`,{headers:{Authorization:`Basic ${Buffer.from(this.config.followUpBossToken+':').toString('base64')}`}}).then(r=>r.data);
  }

  getContactData(id) {
    return axios.get(`${this.config.followUpBossApi}/people/${id}`,{headers:{Authorization:`Basic ${Buffer.from(this.config.followUpBossToken+':').toString('base64')}`}}).then(r=>r.data);
  }

  getUserData(id) {
    const url=`${this.config.followUpBossApi}/users/${id}`;
    console.log(`🔗 Calling FUB users endpoint: ${url}`);
    return axios.get(url,{headers:{Authorization:`Basic ${Buffer.from(this.config.followUpBossToken+':').toString('base64')}`}}).then(r=>r.data);
  }

  filterActiveDeals(d){return d.status==='Active'&&!d.status.includes('Deleted');}
  getFirstPeopleId(p){return Array.isArray(p)&&p.length?p[0].id:null;}

  findAirtableRecord(tableName,fieldName,value){
    const tableId=tableName==='Agents'?this.config.airtableAgentsTable:this.config.airtableTransactionsTable;
    const filterFormula=fieldName==='Company Email'?`LOWER({${fieldName}})=\"${value.toLowerCase()}\"`:`{${fieldName}}=\"${value}\"`;
    return axios.get(`${this.config.airtableBaseUrl}/${tableId}`,{headers:{Authorization:`Bearer ${this.config.airtableToken}`},params:{filterByFormula:filterFormula,maxRecords:1}})
      .then(r=>r.data.records[0]||null).catch(()=>null);
  }

  createAirtableRecord(tableName,data){
    const tableId=tableName==='Agents'?this.config.airtableAgentsTable:this.config.airtableTransactionsTable;
    return axios.post(`${this.config.airtableBaseUrl}/${tableId}`,{fields:data},{headers:{Authorization:`Bearer ${this.config.airtableToken}`,'Content-Type':'application/json'}}).then(r=>r.data);
  }

  updateAirtableRecord(tableName,recordId,data){
    const tableId=tableName==='Agents'?this.config.airtableAgentsTable:this.config.airtableTransactionsTable;
    return axios.patch(`${this.config.airtableBaseUrl}/${tableId}/${recordId}`,{fields:data},{headers:{Authorization:`Bearer ${this.config.airtableToken}`,'Content-Type':'application/json'}}).then(r=>r.data);
  }

  start(port=process.env.PORT||3000){this.app.listen(port,()=>console.log(`🚀 Server on port ${port}`));}
}

const config={
  followUpBossApi:process.env.FUB_API_URL||'https://api.followupboss.com/v1',
  followUpBossToken:process.env.FUB_TOKEN,
  airtableBaseUrl:'https://api.airtable.com/v0/appKPBEXCsXAVEJRU',
  airtableToken:process.env.AIRTABLE_TOKEN,
  airtableAgentsTable:'tbloJNfjbrodWRrCk',
  airtableTransactionsTable:'tblQAs5EG3gU6TzT3'
};

const automation=new DealManagementAutomation(config);
module.exports={DealManagementAutomation,config};
if(require.main===module)automation.start();
