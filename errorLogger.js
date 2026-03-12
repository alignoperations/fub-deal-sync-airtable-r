// errorLogger.js - Centralized error logging to Airtable
// Fire-and-forget: never throws, never blocks the main app

const axios = require('axios');

const ERROR_LOG_PAT = process.env.ERROR_LOG_PAT;
const ERROR_LOG_BASE_ID = process.env.ERROR_LOG_BASE_ID;
const ERROR_LOG_TABLE_ID = process.env.ERROR_LOG_TABLE_ID;

/**
 * Log an error to the centralized Airtable error table.
 * Fire-and-forget - never throws, never needs to be awaited.
 *
 * @param {Object} params
 * @param {string} params.appName - Heroku app name
 * @param {string} [params.errorType] - API_ERROR, VALIDATION_ERROR, NOT_FOUND, FIELD_UPDATE, TIMEOUT, WEBHOOK_ERROR, UNKNOWN
 * @param {string} [params.dealId] - FUB Deal ID
 * @param {string} [params.contactId] - FUB Contact ID
 * @param {string} [params.recordId] - Airtable Record ID
 * @param {string} [params.errorMessage] - Error description
 * @param {number} [params.httpStatus] - HTTP status code
 * @param {string} [params.fieldName] - Field that failed
 * @param {string} [params.dealName] - Deal name/address
 * @param {string} [params.context] - Additional context string
 */
function logError(params) {
  _sendErrorLog(params).catch(() => {});
}

async function _sendErrorLog(params) {
  try {
    if (!ERROR_LOG_PAT || !ERROR_LOG_BASE_ID || !ERROR_LOG_TABLE_ID) return;

    const fields = {
      'App Name': String(params.appName || 'unknown').slice(0, 200),
      'Status': 'New'
    };

    if (params.errorType) fields['Error Type'] = params.errorType;
    if (params.dealId) fields['FUB Deal ID'] = String(params.dealId).slice(0, 50);
    if (params.contactId) fields['FUB Contact ID'] = String(params.contactId).slice(0, 50);
    if (params.recordId) fields['Airtable Record ID'] = String(params.recordId).slice(0, 50);
    if (params.errorMessage) fields['Error Message'] = String(params.errorMessage).slice(0, 5000);
    if (params.httpStatus) fields['HTTP Status'] = Number(params.httpStatus) || null;
    if (params.fieldName) fields['Field Name'] = String(params.fieldName).slice(0, 200);
    if (params.dealName) fields['Deal Name'] = String(params.dealName).slice(0, 200);
    if (params.context) {
      const existing = fields['Error Message'] || '';
      fields['Error Message'] = (existing + '\n\nContext: ' + String(params.context).slice(0, 2000)).trim();
    }

    await axios.post(
      `https://api.airtable.com/v0/${ERROR_LOG_BASE_ID}/${ERROR_LOG_TABLE_ID}`,
      { fields },
      {
        headers: {
          Authorization: `Bearer ${ERROR_LOG_PAT}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
  } catch (e) {
    console.error('[errorLogger] Failed to log error to Airtable:', e.message);
  }
}

/**
 * Classify an axios error into an error type string.
 */
function classifyError(error) {
  if (!error) return 'UNKNOWN';
  const status = error.response?.status;
  if (status === 404) return 'NOT_FOUND';
  if (status === 422) return 'VALIDATION_ERROR';
  if (status === 429) return 'API_ERROR';
  if (status >= 400 && status < 500) return 'API_ERROR';
  if (status >= 500) return 'API_ERROR';
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return 'TIMEOUT';
  if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') return 'API_ERROR';
  return 'UNKNOWN';
}

module.exports = { logError, classifyError };
