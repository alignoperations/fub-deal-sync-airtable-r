// Enhanced updateFieldSafely method with better debugging for tags
async updateFieldSafely(recordId, fieldName, fieldValue, description) {
  try {
    // Special handling for tags to debug the issue
    if (fieldName === 'FUB Contact Tags') {
      console.log('🔍 DEBUG: Raw tags data:', JSON.stringify(fieldValue, null, 2));
      console.log('🔍 DEBUG: Tags array length:', fieldValue.length);
      console.log('🔍 DEBUG: Each tag:');
      fieldValue.forEach((tag, index) => {
        console.log(`  ${index + 1}. "${tag}" (length: ${tag.length}, type: ${typeof tag})`);
      });
      
      // Check for problematic characters
      const problematicTags = fieldValue.filter(tag => {
        return tag.includes('"') || tag.includes("'") || tag.includes('\n') || tag.includes('\r');
      });
      
      if (problematicTags.length > 0) {
        console.log('⚠️ Found tags with problematic characters:', problematicTags);
      }
    }
    
    const updateData = { [fieldName]: fieldValue };
    
    // Log the exact payload being sent to Airtable
    console.log(`🔍 DEBUG: Sending to Airtable:`, JSON.stringify(updateData, null, 2));
    
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

// Alternative: Try updating tags in smaller batches
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