require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { logError, classifyError } = require('./errorLogger');

// Suffix helpers for Airtable FUB Deal ID disambiguation
const FUB_SUFFIX = process.env.FUB_ACCOUNT_SUFFIX || '';
function toAirtableKey(dealId) {
  return FUB_SUFFIX ? `${dealId}-${FUB_SUFFIX}` : `${dealId}`;
}
function toFubDealId(airtableKey) {
  return parseInt(String(airtableKey).split('-')[0]);
}

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

  async updateFieldSafely(recordId, fieldName, fieldValue, description) {
    try {
      // Special handling for tags to debug the issue
      if (fieldName === 'FUB Contact Tags') {
        console.log(`🔍 DEBUG: Sending ${fieldValue.length} tags to Airtable: [${fieldValue.slice(0, 3).join(', ')}${fieldValue.length > 3 ? '...' : ''}]`);
        
        // Check for problematic characters only
        const problematicTags = fieldValue.filter(tag => {
          return tag.includes('"') || tag.includes("'") || tag.includes('\n') || tag.includes('\r');
        });
        
        if (problematicTags.length > 0) {
          console.log('⚠️ Found tags with problematic characters:', problematicTags);
        }
      }
      
      const updateData = { [fieldName]: fieldValue };
      await this.updateAirtableRecord('Transactions Log', recordId, updateData);
      console.log(`✅ ${description} updated successfully`);
      return true;
    } catch (error) {
      console.error(`❌ ${description} failed:`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      
      // For tags specifically, let's try a different approach
      if (fieldName === 'FUB Contact Tags' && error.response?.status === 422) {
        console.log('🔄 Attempting tags update with cleaned data...');
        
        try {
          // Clean the tags - remove any problematic characters and trim whitespace
          const cleanedTags = fieldValue
            .map(tag => tag.toString().trim())
            .filter(tag => tag.length > 0 && tag.length < 100) // Remove empty or overly long tags
            .map(tag => tag.replace(/[""'']/g, '')) // Remove quotes
            .filter((tag, index, arr) => arr.indexOf(tag) === index); // Remove duplicates
          
          console.log('🧹 Cleaned tags:', cleanedTags);
          
          if (cleanedTags.length > 0) {
            const cleanUpdateData = { [fieldName]: cleanedTags };
            await this.updateAirtableRecord('Transactions Log', recordId, cleanUpdateData);
            console.log(`✅ ${description} updated successfully with cleaned data`);
            return true;
          }
        } catch (cleanupError) {
          console.error('❌ Cleanup attempt also failed:', cleanupError.response?.data || cleanupError.message);
        }
      }
      
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

  async updateTagsInBatches(recordId, tags, description) {
    console.log(`🔄 Attempting to update tags in smaller batches...`);
    
    // Split tags into smaller groups
    const batchSize = 10;
    const batches = [];
    for (let i = 0; i < tags.length; i += batchSize) {
      batches.push(tags.slice(i, i + batchSize));
    }
    
    let successfulBatches = 0;
    let allSuccessful = true;
    
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`📦 Updating batch ${i + 1}/${batches.length}: ${batch.join(', ')}`);
      
      const success = await this.updateFieldSafely(recordId, 'FUB Contact Tags', batch, `Tags Batch ${i + 1}`);
      if (success) {
        successfulBatches++;
      } else {
        allSuccessful = false;
        
        // If a batch fails, try individual tags
        console.log(`🔄 Batch failed, trying individual tags...`);
        for (const tag of batch) {
          try {
            const individualSuccess = await this.updateFieldSafely(recordId, 'FUB Contact Tags', [tag], `Individual Tag: ${tag}`);
            if (individualSuccess) {
              console.log(`✅ Individual tag "${tag}" succeeded`);
            }
          } catch (individualError) {
            console.log(`❌ Individual tag "${tag}" failed: ${individualError.message}`);
          }
        }
      }
    }
    
    console.log(`📊 Batch update summary: ${successfulBatches}/${batches.length} batches successful`);
    return allSuccessful;
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
      const existing = await this.findAirtableRecord('Transactions Log', 'FUB Deal ID', toAirtableKey(dealData.id));
      const recordId = existing
        ? existing.id
        : (await this.createAirtableRecord('Transactions Log', { 'FUB Deal ID': toAirtableKey(dealData.id) })).id;
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
      // DISABLED: Set enableAsanaNoContactTasks to true in config to re-enable
      if (!contactData.id && this.config.enableAsanaNoContactTasks) {
        const agentInfo = { name: 'Unknown' };
        try {
          await this.createAsanaTask(dealData, agentInfo);
          console.log('Created Asana No-Contact task');
        } catch (asanaError) {
          console.error('Failed to create Asana task:', asanaError.message);
        }
      }

      console.log('🚀 Starting individual field updates...');
      const updateResults = [];

      // BASIC DEAL FIELDS - Update each one individually
      updateResults.push(await this.updateFieldSafely(recordId, 'Address / Client', dealData.name, 'Deal Name'));
      updateResults.push(await this.updateFieldSafely(recordId, 'Stage', dealData.stageName, 'Deal Stage'));
      updateResults.push(await this.updateFieldSafely(recordId, 'Transaction Type', dealData.pipelineName, 'Pipeline'));
      
      // Added to FUB checkbox - based on commissionValue
      const addedToFUB = dealData.commissionValue != null && dealData.commissionValue !== '';
      updateResults.push(await this.updateFieldSafely(recordId, 'Added to FUB', addedToFUB, 'Added to FUB'));
      
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
        : (dealData.customUnderContractDate || dealData.customContractRatifiedDate);
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

      // ENHANCED AGENT ASSIGNMENT WITH COMPREHENSIVE ERROR HANDLING
      console.log('👥 AGENT DEBUGGING - Starting agent assignment process');
      console.log('Deal users:', JSON.stringify(dealData.users, null, 2));
      console.log('Contact assigned user ID:', contactData.assignedUserId);

      const usersList = Array.isArray(dealData.users) ? dealData.users : [];
      let primaryUserId = null;
      let coUserId = null;
      let agentAssignmentReason = '';

      // Agent assignment logic with logging
      if (usersList.length === 0) {
        console.log('❌ No users found on deal');
        agentAssignmentReason = 'No users on deal';
      } else if (usersList.length === 1) {
        primaryUserId = usersList[0].id;
        agentAssignmentReason = 'Single user on deal';
        console.log(`✅ Single user assignment: ${primaryUserId} (${usersList[0].name})`);
      } else if (usersList.length > 1) {
        console.log('🔄 Multiple users found, determining primary...');
        
        if (contactData.assignedUserId) {
          // Check if assigned user is in the deal users list
          const assignedUserInDeal = usersList.find(u => u.id === contactData.assignedUserId);
          if (assignedUserInDeal) {
            primaryUserId = contactData.assignedUserId;
            coUserId = usersList.find(u => u.id !== primaryUserId)?.id;
            agentAssignmentReason = `Contact assigned to user ${primaryUserId}`;
            console.log(`✅ Using contact assignment: Primary=${primaryUserId}, Co=${coUserId}`);
          } else {
            console.log(`⚠️ Contact assigned user ${contactData.assignedUserId} not in deal users`);
            primaryUserId = usersList[0].id;
            coUserId = usersList[1].id;
            agentAssignmentReason = 'Contact assigned user not in deal, using first user';
            console.log(`✅ Fallback assignment: Primary=${primaryUserId}, Co=${coUserId}`);
          }
        } else {
          primaryUserId = usersList[0].id;
          coUserId = usersList[1].id;
          agentAssignmentReason = 'No contact assignment, using first user';
          console.log(`✅ Default assignment: Primary=${primaryUserId}, Co=${coUserId}`);
        }
      }

      console.log(`📋 Agent Assignment Summary: ${agentAssignmentReason}`);

      // Enhanced email fetching with detailed error logging
      let primaryEmail = null;
      let coEmail = null;
      let primaryUserData = null;
      let coUserData = null;

      // PRIMARY AGENT EMAIL FETCH
      if (primaryUserId) {
        console.log(`🔍 Fetching primary user data for ID: ${primaryUserId}`);
        try {
          primaryUserData = await this.getUserData(primaryUserId);
          primaryEmail = primaryUserData.email;
          console.log(`✅ Primary user email: ${primaryEmail}`);
          console.log(`📊 Primary user details:`, {
            id: primaryUserData.id,
            name: primaryUserData.name,
            email: primaryUserData.email,
            role: primaryUserData.role
          });
        } catch (primaryError) {
          console.error(`❌ CRITICAL: Failed to fetch primary user ${primaryUserId}:`, {
            message: primaryError.message,
            status: primaryError.response?.status,
            data: primaryError.response?.data
          });
          
          // Add this to updateResults so it gets tracked as a failure
          updateResults.push({
            success: false,
            field: 'Primary Agent FUB Contact ID',
            description: 'Primary Agent',
            error: 'Failed to fetch user email from FollowUpBoss',
            details: `User ID ${primaryUserId}: ${primaryError.message}`
          });
        }
      }

      // CO-AGENT EMAIL FETCH
      if (coUserId) {
        console.log(`🔍 Fetching co-user data for ID: ${coUserId}`);
        try {
          coUserData = await this.getUserData(coUserId);
          coEmail = coUserData.email;
          console.log(`✅ Co-user email: ${coEmail}`);
        } catch (coError) {
          console.error(`❌ Failed to fetch co-user ${coUserId}:`, {
            message: coError.message,
            status: coError.response?.status,
            data: coError.response?.data
          });
        }
      }

      console.log(`📧 Email Fetch Summary: Primary=${primaryEmail || 'FAILED'}, Co=${coEmail || 'N/A'}`);

      // PRIMARY AGENT AIRTABLE LOOKUP AND UPDATE
      if (primaryEmail) {
        console.log(`🔍 Looking up primary agent in Airtable by email: ${primaryEmail}`);
        try {
          const primRec = await this.findAirtableRecord('Agents', 'Company Email', primaryEmail);
          
          if (primRec) {
            console.log(`✅ Found primary agent in Airtable:`, {
              id: primRec.id,
              name: primRec.fields.Name,
              email: primRec.fields['Company Email'],
              role: primRec.fields.Role
            });
            
            const existingPrim = existing?.fields['Primary Agent FUB Contact ID'] || [];
            console.log(`🔍 Current primary agent in record: ${existingPrim[0] || 'None'}`);
            
            if (existingPrim[0] !== primRec.id) {
              console.log(`🔄 Updating primary agent from ${existingPrim[0] || 'None'} to ${primRec.id}`);
              updateResults.push(await this.updateFieldSafely(recordId, 'Primary Agent FUB Contact ID', [primRec.id], 'Primary Agent'));
            } else {
              console.log(`✅ Primary agent already correctly set`);
              updateResults.push(true); // Track as success, no update needed
            }
          } else {
            console.error(`❌ PRIMARY AGENT NOT FOUND in Airtable for email: ${primaryEmail}`);
            
            // Try alternative lookup by name
            let agentFoundByName = false;
            if (primaryUserData?.name) {
              console.log(`🔍 Trying lookup by name: ${primaryUserData.name}`);
              try {
                const primRecByName = await this.findAirtableRecord('Agents', 'Name', primaryUserData.name);
                if (primRecByName) {
                  console.log(`✅ Found agent by name with different email: ${primRecByName.fields['Company Email']}`);
                  console.log(`🔄 Using name-based match for agent assignment`);
                  
                  // Use the name-based match for assignment
                  const existingPrim = existing?.fields['Primary Agent FUB Contact ID'] || [];
                  if (existingPrim[0] !== primRecByName.id) {
                    console.log(`🔄 Updating primary agent from ${existingPrim[0] || 'None'} to ${primRecByName.id} (found by name)`);
                    updateResults.push(await this.updateFieldSafely(recordId, 'Primary Agent FUB Contact ID', [primRecByName.id], 'Primary Agent (Name Match)'));
                  } else {
                    console.log(`✅ Primary agent already correctly set (name match)`);
                    updateResults.push(true);
                  }
                  agentFoundByName = true;
                } else {
                  console.log(`❌ Agent not found by name either`);
                }
              } catch (nameError) {
                console.log(`❌ Name lookup also failed: ${nameError.message}`);
              }
            }
            
            // Only add error if both email and name lookups failed
            if (!agentFoundByName) {
              updateResults.push({
                success: false,
                field: 'Primary Agent FUB Contact ID',
                description: 'Primary Agent',
                error: 'Agent not found in Airtable',
                details: `Email ${primaryEmail} not found in Agents table. User: ${primaryUserData?.name || 'Unknown'}`
              });
            }
          }
        } catch (agentLookupError) {
          console.error(`❌ Primary agent Airtable lookup failed:`, {
            message: agentLookupError.message,
            status: agentLookupError.response?.status,
            data: agentLookupError.response?.data
          });
          
          updateResults.push({
            success: false,
            field: 'Primary Agent FUB Contact ID',
            description: 'Primary Agent',
            error: 'Airtable lookup failed',
            details: `Lookup failed for ${primaryEmail}: ${agentLookupError.message}`
          });
        }
      } else {
        console.error(`❌ CRITICAL: Cannot lookup primary agent - no email available`);
        console.log(`🔍 Diagnosis:`);
        console.log(`  - Primary user ID: ${primaryUserId || 'None'}`);
        console.log(`  - User data fetch: ${primaryUserData ? 'succeeded' : 'failed'}`);
        console.log(`  - Email in user data: ${primaryUserData?.email || 'missing'}`);
        
        updateResults.push({
          success: false,
          field: 'Primary Agent FUB Contact ID',
          description: 'Primary Agent',
          error: 'No email available for agent lookup',
          details: `Primary user ID: ${primaryUserId}, User fetch: ${primaryUserData ? 'succeeded but no email' : 'failed'}`
        });
      }

      // CO-AGENT LOGIC
      if (coEmail) {
        try {
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
        } catch (coAgentError) {
          console.error('Co-agent lookup failed:', coAgentError.message);
          updateResults.push(false);
        }
      } else if (usersList.length === 1) {
        // Single agent, set to 100%
        const existingPercent = existing?.fields['Primary Agent Deal %'];
        if (existingPercent == null) {
          updateResults.push(await this.updateFieldSafely(recordId, 'Primary Agent Deal %', 100, 'Primary Agent Percentage (Solo)'));
        }
      }

      // ISA FIELD
      if (dealData.customISA) {
        try {
          const isaRec = await this.findAirtableRecord('Agents', 'Name', dealData.customISA);
          if (isaRec) {
            updateResults.push(await this.updateFieldSafely(recordId, 'ISA FUB Contact ID', [isaRec.id], 'ISA Assignment'));
          } else {
            console.log(`ISA not found in Airtable: ${dealData.customISA}`);
            updateResults.push({ 
              success: false, 
              field: 'ISA FUB Contact ID', 
              description: 'ISA Assignment', 
              error: 'ISA not found in Airtable',
              details: `ISA name "${dealData.customISA}" not found in Agents table`
            });
          }
        } catch (isaError) {
          console.error('ISA lookup failed:', isaError.message);
          updateResults.push({ 
            success: false, 
            field: 'ISA FUB Contact ID', 
            description: 'ISA Assignment', 
            error: isaError.message,
            details: `ISA lookup failed: ${isaError.message}`
          });
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
          } else {
            updateResults.push({ 
              success: false, 
              field: 'Source', 
              description: `Source (${contactData.source})`, 
              error: 'Failed to find or create source',
              details: `Could not find or create source: ${contactData.source}`
            });
          }
        } catch (sourceError) {
          console.error('❌ Source lookup/creation failed:', sourceError.message);
          updateResults.push({ 
            success: false, 
            field: 'Source', 
            description: `Source (${contactData.source})`, 
            error: sourceError.message,
            details: `Source lookup/creation failed: ${sourceError.message}`
          });
        }
      }

      // TAGS FIELD - Handle multiselect separately with enhanced debugging
      if (contactData.tags && Array.isArray(contactData.tags) && contactData.tags.length > 0) {
        console.log('🏷️ Starting tags processing...');
        
        // First attempt with normal update
        const tagSuccess = await this.updateFieldSafely(recordId, 'FUB Contact Tags', contactData.tags, `Tags (${contactData.tags.join(', ')})`);
        
        if (!tagSuccess) {
          // If normal update failed, try batch approach
          console.log('🔄 Normal tags update failed, trying batch approach...');
          await this.updateTagsInBatches(recordId, contactData.tags, 'Tags (Batch Mode)');
        }
        
        updateResults.push(tagSuccess);
      }

      // Summary of results - fix the filtering to include all results
      const allResults = updateResults.filter(r => r !== null && r !== undefined);
      const objectResults = allResults.filter(r => typeof r === 'object' && r.hasOwnProperty('success'));
      const booleanResults = allResults.filter(r => typeof r === 'boolean');
      
      // Count successes from both object and boolean results
      const objectSuccesses = objectResults.filter(r => r.success === true).length;
      const booleanSuccesses = booleanResults.filter(r => r === true).length;
      const successCount = objectSuccesses + booleanSuccesses;
      
      // Count failures
      const objectFailures = objectResults.filter(r => r.success === false);
      const booleanFailures = booleanResults.filter(r => r === false).length;
      const failureCount = objectFailures.length + booleanFailures;
      
      const totalAttempts = allResults.length;

      console.log(`📊 Update Summary: ${successCount}/${totalAttempts} fields updated successfully`);
      console.log(`📊 Result breakdown: ${objectResults.length} object results, ${booleanResults.length} boolean results`);
      
      if (failureCount > 0) {
        console.log(`⚠️ ${failureCount} fields failed to update (check individual errors above)`);
      }

      // Send single consolidated Slack notification for all errors (only object failures have details)
      if (objectFailures.length > 0) {
        try {
          let errorSummary = `*Deal Sync Errors*\nDeal: *${dealData.name}*\n\n`;
          
          // Group similar errors
          const errorGroups = {};
          objectFailures.forEach(result => {
            const key = result.details || result.error;
            if (!errorGroups[key]) {
              errorGroups[key] = [];
            }
            errorGroups[key].push(result.description);
          });
          
          // Build error message
          Object.entries(errorGroups).forEach(([error, fields]) => {
            errorSummary += `• **${error}**\n  Fields: ${fields.join(', ')}\n\n`;
          });
          
          errorSummary += `Success Rate: ${successCount}/${totalAttempts} (${Math.round(successCount/totalAttempts*100)}%)`;
          
          if (primaryContactId) {
            errorSummary += `\nFUB Person: <https://align.followupboss.com/2/people/view/${primaryContactId}|View Contact>`;
          }
          
          await this.sendSlackErrorNotification(dealData, errorSummary, null);
        } catch (slackError) {
          console.error('Failed to send consolidated error notification:', slackError.message);
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
      logError({
        appName: 'fub-deal-sync-automation-r',
        errorType: classifyError(err),
        errorMessage: `Webhook processing error: ${err.message}`,
        httpStatus: err.response?.status,
        context: JSON.stringify(err.response?.data || {}).slice(0, 1000)
      });
      return res.status(500).json({ status: 'error', message: err.message });
    }
  }

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

  async createAsanaTask(dealData, agentInfo) {
    const taskName = `No Contact Attached - ${dealData.name || 'Deal'}`;
    const notes = `Deal: ${dealData.name}\nAgent: ${agentInfo.name || 'Unknown'}\nPipeline: ${dealData.pipelineName}`;
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const payload = { data: { name: taskName, notes, projects: [this.config.asana.projectNoContact], assignee: this.config.asana.assigneeGid, due_on: tomorrow.toISOString().split('T')[0] } };
    await axios.post('https://app.asana.com/api/1.0/tasks', payload, { headers: { Authorization: `Bearer ${this.config.asana.accessToken}` } });
  }

  async sendSlackErrorNotification(dealData, summary, contactId) {
    const channel = this.config.slack.channelJulianna;
    const contactLink = contactId ? `<https://align.followupboss.com/2/people/view/${contactId}|View Contact>` : 'No contact';
    const text = `*Airtable Sync Error*\n• Deal: *${dealData.name}*\n• Summary: ${summary}\n• FUB Person: ${contactLink}`;
    await axios.post('https://slack.com/api/chat.postMessage', { channel, text }, { headers: { Authorization: `Bearer ${this.config.slack.botToken}`, 'Content-Type':'application/json' } });
  }

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
    if (!userId) {
      throw new Error('User ID is required');
    }
    
    const response = await axios.get(
      `${this.config.followUpBossApi}/users/${userId}`,
      { 
        headers: { Authorization: `Basic ${Buffer.from(this.config.followUpBossToken + ':').toString('base64')}` },
        timeout: 10000 // 10 second timeout
      }
    );
    
    if (!response.data) {
      throw new Error('No user data returned from API');
    }
    
    if (!response.data.email) {
      console.warn(`User ${userId} has no email address in FollowUpBoss`);
    }
    
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
    
    // If exact match fails and it's an email, try case-insensitive search
    if (!resp.data.records[0] && fieldName.includes('Email')) {
      console.log(`Retrying email search with case-insensitive match for: ${searchValue}`);
      console.log(`Searching in field: ${fieldName}`);
      console.log(`Target value (lowercase): ${searchValue.toLowerCase()}`);
      
      try {
        // Fetch ALL records, handling pagination
        let allRecords = [];
        let offset = null;
        
        do {
          const params = {
            headers: { Authorization: `Bearer ${this.config.airtableToken}` }
          };
          if (offset) {
            params.params = { offset };
          }
          
          const response = await axios.get(`${this.config.airtableBaseUrl}/${tableId}`, params);
          allRecords = allRecords.concat(response.data.records);
          offset = response.data.offset;
        } while (offset);
        
        console.log(`Retrieved ${allRecords.length} total records from Airtable`);
        
        // Debug: show first few email values
        const emailSamples = allRecords.slice(0, 5).map(record => ({
          name: record.fields.Name || 'No Name',
          email: record.fields[fieldName] || 'No Email',
          emailLower: record.fields[fieldName]?.toLowerCase() || 'null'
        }));
        console.log(`Sample email values:`, emailSamples);
        
        const match = allRecords.find(record => {
          const recordEmail = record.fields[fieldName];
          if (!recordEmail) return false;
          
          const recordEmailLower = recordEmail.toLowerCase().trim();
          const searchValueLower = searchValue.toLowerCase().trim();
          
          const isMatch = recordEmailLower === searchValueLower;
          if (isMatch) {
            console.log(`FOUND MATCH: "${recordEmailLower}" === "${searchValueLower}"`);
          }
          
          return isMatch;
        });
        
        if (match) {
          console.log(`Found case-insensitive match: ${match.fields[fieldName]} (original: ${searchValue})`);
          return match;
        } else {
          console.log(`No case-insensitive match found after checking all ${allRecords.length} records`);
          
          // Debug: Show if any email contains the username part
          const searchUsername = searchValue.toLowerCase().split('@')[0];
          const partialMatches = allRecords.filter(record => 
            record.fields[fieldName]?.toLowerCase().includes(searchUsername)
          );
          if (partialMatches.length > 0) {
            console.log(`Found ${partialMatches.length} records containing "${searchUsername}":`, 
              partialMatches.map(r => ({ name: r.fields.Name, email: r.fields[fieldName] }))
            );
          } else {
            console.log(`No records found containing "${searchUsername}" in email field`);
          }
        }
      } catch (caseInsensitiveError) {
        console.log(`Case-insensitive search also failed: ${caseInsensitiveError.message}`);
      }
    }
    
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
