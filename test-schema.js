require('dotenv').config();
const axios = require('axios');

// Test configuration - replace with your actual values
const config = {
  airtableBaseUrl: process.env.AIRTABLE_BASE_URL,
  airtableToken: process.env.AIRTABLE_TOKEN,
  airtableTransactionsTable: process.env.AIRTABLE_TRANSACTIONS_TABLE
};

// Extract base ID from the base URL
let baseId;
if (config.airtableBaseUrl) {
  baseId = config.airtableBaseUrl.split('/').pop();
} else {
  console.error('❌ AIRTABLE_BASE_URL environment variable is not set');
  console.log('Please check your .env file contains:');
  console.log('AIRTABLE_BASE_URL=https://api.airtable.com/v0/YOUR_BASE_ID');
  process.exit(1);
}

// Validate all required environment variables
if (!config.airtableToken) {
  console.error('❌ AIRTABLE_TOKEN environment variable is not set');
  process.exit(1);
}

if (!config.airtableTransactionsTable) {
  console.error('❌ AIRTABLE_TRANSACTIONS_TABLE environment variable is not set');
  process.exit(1);
}

async function testSchemaAPI() {
  console.log('Testing Airtable Schema API for multiselect options...');
  console.log('Base ID:', baseId);
  console.log('Table ID:', config.airtableTransactionsTable);
  
  const testTagName = 'TEST_TAG_' + Date.now(); // Unique test tag
  
  try {
    // Method 1: Try the table schema endpoint
    console.log('\n=== Method 1: Table Schema API ===');
    console.log(`Attempting to create tag option: ${testTagName}`);
    
    const schemaResponse = await axios.patch(
      `https://api.airtable.com/v0/meta/bases/${baseId}/tables/${config.airtableTransactionsTable}`,
      {
        fields: [
          {
            name: "FUB Contact Tags",
            options: {
              choices: [
                {
                  name: testTagName,
                  color: "gray"
                }
              ]
            }
          }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${config.airtableToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Schema API SUCCESS:', schemaResponse.status);
    console.log('Response:', JSON.stringify(schemaResponse.data, null, 2));
    
  } catch (schemaError) {
    console.log('❌ Schema API FAILED:');
    console.log('Status:', schemaError.response?.status);
    console.log('Error:', schemaError.response?.data || schemaError.message);
    
    // Method 2: Try the alternative approach
    console.log('\n=== Method 2: Alternative Field API ===');
    
    try {
      const fieldResponse = await axios.post(
        `https://api.airtable.com/v0/meta/bases/${baseId}/tables/${config.airtableTransactionsTable}/fields`,
        {
          name: "Test_Field_" + Date.now(),
          type: "multipleSelects",
          options: {
            choices: [
              { name: testTagName, color: "gray" }
            ]
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${config.airtableToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('✅ Field API SUCCESS:', fieldResponse.status);
      console.log('Response:', JSON.stringify(fieldResponse.data, null, 2));
      
    } catch (fieldError) {
      console.log('❌ Field API ALSO FAILED:');
      console.log('Status:', fieldError.response?.status);
      console.log('Error:', fieldError.response?.data || fieldError.message);
    }
  }
  
  // Method 3: Test what happens with current record approach
  console.log('\n=== Method 3: Current Record API (for comparison) ===');
  
  try {
    // Try to create a dummy record with the test tag to see the exact error
    const recordResponse = await axios.post(
      `${config.airtableBaseUrl}/${config.airtableTransactionsTable}`,
      {
        fields: {
          'FUB Deal ID': '111111' + Date.now(),
          'FUB Contact Tags': [testTagName]
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${config.airtableToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Record API SUCCESS (unexpected!):', recordResponse.status);
    
    // Clean up - delete the test record
    await axios.delete(
      `${config.airtableBaseUrl}/${config.airtableTransactionsTable}/${recordResponse.data.id}`,
      { headers: { 'Authorization': `Bearer ${config.airtableToken}` } }
    );
    console.log('Test record cleaned up');
    
  } catch (recordError) {
    console.log('❌ Record API FAILED (expected):');
    console.log('Status:', recordError.response?.status);
    console.log('Exact Error Message:', recordError.response?.data?.error?.message);
    console.log('Error Type:', recordError.response?.data?.error?.type);
  }
  
  // Method 4: Check current field schema
  console.log('\n=== Method 4: Get Current Field Schema ===');
  
  try {
    const tableInfo = await axios.get(
      `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
      {
        headers: { 'Authorization': `Bearer ${config.airtableToken}` }
      }
    );
    
    const targetTable = tableInfo.data.tables.find(t => t.id === config.airtableTransactionsTable);
    const tagsField = targetTable?.fields.find(f => f.name === 'FUB Contact Tags');
    
    if (tagsField) {
      console.log('✅ Found FUB Contact Tags field');
      console.log('Field type:', tagsField.type);
      console.log('Current options count:', tagsField.options?.choices?.length || 0);
      console.log('First few options:', tagsField.options?.choices?.slice(0, 5).map(c => c.name));
    } else {
      console.log('❌ FUB Contact Tags field not found');
    }
    
  } catch (metaError) {
    console.log('❌ Meta API failed:', metaError.response?.data || metaError.message);
  }
}

// Run the test
testSchemaAPI().catch(console.error);