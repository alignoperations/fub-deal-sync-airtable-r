// Helper method for safe individual field updates
async updateFieldSafely(recordId, fieldName, fieldValue, description) {
  try {
    const updateData = { [fieldName]: fieldValue };
    await this.updateAirtableRecord('Transactions Log', recordId, updateData);
    console.log(`✅ ${description} updated successfully`);
    return true;
  } catch (error) {
    console.error(`❌ ${description} failed:`, error.response?.data || error.message);
    
    // Send individual field error notification
    try {
      const errorMsg = `Field update failed - ${description}: ${error.message}`;
      await this.sendSlackErrorNotification({ name: `Record ${recordId}` }, errorMsg, null);
    } catch (slackError) {
      console.error('Failed to send field error notification:', slackError.message);
    }
    
    return false;
  }
}

// Updated handleDealUpdate method with individual field updates
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

    // If no contact, create Asana no-contact task
    if (!contactData.id) {
      const agentInfo = { name: 'Unknown' };
      const notes = `Deal: ${dealData.name}\nAgent: ${agentInfo.name || 'Unknown'}\nPipeline: ${dealData.pipelineName}\nStage: ${dealData.stageName}`;
      console.log('Created Asana No-Contact task');
    }

    // Get agent information for later use
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

    console.log('🚀 Starting individual field updates...');
    const updateResults = [];

    // BASIC DEAL FIELDS - Update each one individually
    updateResults.push(await this.updateFieldSafely(recordId, 'Address / Client', dealData.name, 'Deal Name'));
    updateResults.push(await this.updateFieldSafely(recordId, 'Stage', dealData.stageName, 'Deal Stage'));
    updateResults.push(await this.updateFieldSafely(recordId, 'Transaction Type', dealData.pipelineName, 'Pipeline'));
    
    if (dealData.description) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Deal Description', dealData.description, 'Deal Description'));
    }
    
    if (dealData.customOffMarketShareStatus) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Off-Market Share Status', dealData.customOffMarketShareStatus, 'Off-Market Share Status'));
    }

    // CONTACT FIELDS
    if (contactData.id) {
      updateResults.push(await this.updateFieldSafely(recordId, 'FUB Contact ID', contactData.id.toString(), 'FUB Contact ID'));
    }
    
    if (contactData.created) {
      const contactCreatedDate = new Date(contactData.created).toISOString().split('T')[0];
      updateResults.push(await this.updateFieldSafely(recordId, 'Contact Created Date', contactCreatedDate, 'Contact Created Date'));
    }

    // DATE FIELDS - Each one separately
    if (dealData.customApptSetDate) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Appt Set Date', dealData.customApptSetDate, 'Appointment Set Date'));
    }
    
    if (dealData.customApptScheduledForDate) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Appt Scheduled For Date', dealData.customApptScheduledForDate, 'Appointment Scheduled For Date'));
    }
    
    if (dealData.customApptHeldDate) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Appt Held Date', dealData.customApptHeldDate, 'Appointment Held Date'));
    }
    
    if (dealData.customAttorneyReviewDate) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Attorney Review Date', dealData.customAttorneyReviewDate, 'Attorney Review Date'));
    }
    
    if (dealData.customSignedDate) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Signed Date', dealData.customSignedDate, 'Signed Date'));
    }
    
    if (dealData.customLiveDate) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Listing Live Date', dealData.customLiveDate, 'Listing Live Date'));
    }
    
    if (dealData.customListingExpirationDate) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Listing Expiration Date', dealData.customListingExpirationDate, 'Listing Expiration Date'));
    }
    
    const ucDate = ['Landlord', 'Tenant'].includes(dealData.pipelineName)
      ? dealData.customApplicationAcceptedDate
      : dealData.customContractRatifiedDate;
    if (ucDate) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Under Contract Date', ucDate, 'Under Contract Date'));
    }
    
    if (dealData.projectedCloseDate) {
      const closingDate = dealData.projectedCloseDate.split('T')[0];
      updateResults.push(await this.updateFieldSafely(recordId, 'Closing Date', closingDate, 'Closing Date'));
    }

    // FINANCIAL FIELDS
    if (dealData.price) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Sale Price', dealData.price, 'Sale Price'));
    }
    
    if (dealData.customExistingTransaction) {
      updateResults.push(await this.updateFieldSafely(recordId, 'Existing Transaction', dealData.customExistingTransaction, 'Existing Transaction'));
    }

    // AGENT FIELDS - Primary Agent
    if (primaryEmail) {
      const primRec = await this.findAirtableRecord('Agents', 'Company Email', primaryEmail);
      if (primRec) {
        const existingPrim = existing?.fields['Primary Agent FUB Contact ID'] || [];
        if (existingPrim[0] !== primRec.id) {
          updateResults.push(await this.updateFieldSafely(recordId, 'Primary Agent FUB Contact ID', [primRec.id], 'Primary Agent'));
        }
      }
    }
    
    // Co-Agent Logic
    if (coEmail) {
      const coRec = await this.findAirtableRecord('Agents', 'Company Email', coEmail);
      if (coRec) {
        const validRoles = ['Agent', 'Mentor', 'Team Leader', 'Director of Sales', 'Location Leader', 'Production Partner'];
        const coAgentRole = coRec.fields['Role'];
        
        if (validRoles.includes(coAgentRole)) {
          const existingCo = existing?.fields['Co-Agent FUB Contact ID'] || [];
          if (existingCo[0] !== coRec.id) {
            updateResults.push(await this.updateFieldSafely(recordId, 'Co-Agent FUB Contact ID', [coRec.id], 'Co-Agent'));
          }
          updateResults.push(await this.updateFieldSafely(recordId, 'Primary Agent Deal %', 50, 'Primary Agent Percentage'));
          updateResults.push(await this.updateFieldSafely(recordId, 'Co-Agent Deal %', 50, 'Co-Agent Percentage'));
          console.log(`Co-agent added: ${coEmail} with role: ${coAgentRole}`);
        } else {
          console.log(`Co-agent rejected: ${coEmail} has invalid role: ${coAgentRole}`);
          const existingPercent = existing?.fields['Primary Agent Deal %'];
          if (existingPercent == null) {
            updateResults.push(await this.updateFieldSafely(recordId, 'Primary Agent Deal %', 100, 'Primary Agent Percentage (Solo)'));
          }
        }
      } else {
        console.log(`Co-agent not found in Airtable: ${coEmail}`);
        const existingPercent = existing?.fields['Primary Agent Deal %'];
        if (existingPercent == null) {
          updateResults.push(await this.updateFieldSafely(recordId, 'Primary Agent Deal %', 100, 'Primary Agent Percentage (Solo)'));
        }
      }
    } else if (usersList.length === 1) {
      const existingPercent = existing?.fields['Primary Agent Deal %'];
      if (existingPercent == null) {
        updateResults.push(await this.updateFieldSafely(recordId, 'Primary Agent Deal %', 100, 'Primary Agent Percentage (Solo)'));
      }
    }

    // ISA FIELD
    if (dealData.customISA) {
      const isaRec = await this.findAirtableRecord('Agents', 'Name', dealData.customISA);
      if (isaRec) {
        updateResults.push(await this.updateFieldSafely(recordId, 'ISA FUB Contact ID', [isaRec.id], 'ISA Assignment'));
      }
    } else {
      updateResults.push(await this.updateFieldSafely(recordId, 'ISA FUB Contact ID', [], 'ISA Clear'));
    }

    // SOURCE FIELD - Handle separately with lookup/creation
    if (contactData.source) {
      try {
        console.log(`🔍 Starting source lookup for: ${contactData.source}`);
        const sourceRecordId = await this.findOrCreateTransactionSource(contactData.source);
        
        if (sourceRecordId) {
          updateResults.push(await this.updateFieldSafely(recordId, 'Source', [sourceRecordId], `Source (${contactData.source})`));
        }
      } catch (sourceError) {
        console.error('❌ Source lookup/creation failed:', sourceError.message);
        updateResults.push(false);
      }
    }

    // TAGS FIELD - Handle multiselect separately
    if (contactData.tags && Array.isArray(contactData.tags) && contactData.tags.length > 0) {
      updateResults.push(await this.updateFieldSafely(recordId, 'FUB Contact Tags', contactData.tags, `Tags (${contactData.tags.join(', ')})`));
    }

    // Summary of results
    const successCount = updateResults.filter(result => result === true).length;
    const totalAttempts = updateResults.length;
    const failureCount = totalAttempts - successCount;

    console.log(`📊 Update Summary: ${successCount}/${totalAttempts} fields updated successfully`);
    
    if (failureCount > 0) {
      console.log(`⚠️  ${failureCount} fields failed to update (check individual errors above)`);
    }

    // Send summary notification if there were significant failures
    if (failureCount > totalAttempts * 0.5) { // If more than 50% failed
      try {
        const summaryMsg = `Multiple field failures: ${failureCount}/${totalAttempts} fields failed to update for deal "${dealData.name}"`;
        await this.sendSlackErrorNotification(dealData, summaryMsg, primaryContactId);
      } catch (slackError) {
        console.error('Failed to send summary notification:', slackError.message);
      }
    }

    return res.json({ 
      status: 'success', 
      updated: successCount, 
      failed: failureCount, 
      total: totalAttempts 
    });

  } catch (err) {
    console.error('Processing error:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}