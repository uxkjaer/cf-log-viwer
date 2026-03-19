'use strict';

/**
 * CF Log Line Parser
 *
 * Parses raw `cf logs` output lines into structured objects.
 *
 * CF log line format:
 *   <timestamp> [<source>/<instance>] <direction> <payload>
 *
 * Example:
 *   2026-03-19T13:33:22.03+1000 [APP/PROC/WEB/0] OUT {"level":"info",...}
 */

// Regex to capture CF envelope fields
// Group 1: CF timestamp
// Group 2: Source type (e.g. APP/PROC/WEB/0, RTR/0, STG/0)
// Group 3: Direction (OUT or ERR)
// Group 4: Remainder (the payload)
const CF_LINE_REGEX = /^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{2}[+-]\d{4})\s+\[([^\]]+)\]\s+(OUT|ERR)\s+(.*)$/;

// Fields to show in the summary / table view
const CORE_FIELDS = [
  'timestamp', 'level', 'logger', 'msg', 'type',
  'correlation_id', 'tenant_id', 'request_id'
];

// HTTP context fields
const HTTP_FIELDS = [
  'x_forwarded_path', 'x_forwarded_host', 'x_forwarded_proto',
  'content_type', 'content_length', 'request_size_b',
  'accept', 'accept_encoding', 'accept_language',
  'user_agent', 'origin', 'referer',
  'odata_version', 'odata_maxversion',
  'sec_fetch_dest', 'sec_fetch_mode', 'sec_fetch_site', 'sec_gpc',
  'mime_version', 'te', 'x_requested_with'
];

// Tracing / correlation fields
const TRACING_FIELDS = [
  'correlation_id', 'x_correlation_id', 'x_correlationid',
  'request_id', 'x_vcap_request_id', 'x_scp_request_id', 'x_sf_correlation_id',
  'b3', 'x_b3_traceid', 'x_b3_spanid',
  'traceparent', 'w3c_traceparent', 'tracestate',
  'sap_passport',
  'x_dynatrace', 'x_dynatrace_application'
];

// Infrastructure / CF fields
const INFRA_FIELDS = [
  'component_name', 'component_id', 'component_type', 'component_instance',
  'container_id', 'source_instance',
  'organization_name', 'organization_id',
  'space_name', 'space_id',
  'x_cf_applicationid', 'x_cf_instanceid', 'x_cf_instanceindex',
  'x_cf_true_client_ip', 'x_forwarded_for',
  'host', 'layer'
];

// SAP-specific fields
const SAP_FIELDS = [
  'tenant_host_pattern', 'tenantid', 'x_attribute_scenario',
  'x_portal_internal_host', 'x_request_start',
  'x_forwarded_path'
];

/**
 * Categorize all fields of a parsed log entry into meaningful groups.
 */
function categorizeFields(entry) {
  if (!entry || !entry.json) return null;

  const json = entry.json;
  const categories = {
    core: {},
    http: {},
    tracing: {},
    infrastructure: {},
    sap: {},
    other: {}
  };

  const assigned = new Set();

  // Assign known fields to categories
  for (const field of CORE_FIELDS) {
    if (json[field] !== undefined) {
      categories.core[field] = json[field];
      assigned.add(field);
    }
  }

  for (const field of HTTP_FIELDS) {
    if (json[field] !== undefined) {
      categories.http[field] = json[field];
      assigned.add(field);
    }
  }

  for (const field of TRACING_FIELDS) {
    if (json[field] !== undefined) {
      categories.tracing[field] = json[field];
      assigned.add(field);
    }
  }

  for (const field of INFRA_FIELDS) {
    if (json[field] !== undefined) {
      categories.infrastructure[field] = json[field];
      assigned.add(field);
    }
  }

  for (const field of SAP_FIELDS) {
    if (json[field] !== undefined) {
      categories.sap[field] = json[field];
      assigned.add(field);
    }
  }

  // Everything else goes to "other"
  for (const [key, value] of Object.entries(json)) {
    if (!assigned.has(key)) {
      categories.other[key] = value;
    }
  }

  return categories;
}

/**
 * Parse a single CF log line into a structured object.
 *
 * @param {string} line - Raw line from cf logs output
 * @param {number} index - Line number / index
 * @returns {object|null} Parsed log entry, or null if line should be skipped
 */
function parseLine(line, index) {
  if (!line || !line.trim()) return null;

  const match = line.match(CF_LINE_REGEX);

  if (!match) {
    // Not a standard CF log line (e.g. "Retrieving logs for app..." header)
    // Skip metadata lines from cf cli
    if (line.includes('Retrieving logs for app') || line.trim() === '') {
      return null;
    }

    // Treat as plain text log
    return {
      id: index,
      cfTimestamp: null,
      source: 'UNKNOWN',
      direction: 'OUT',
      isJson: false,
      json: null,
      raw: line.trim(),
      // Summary fields for table
      timestamp: null,
      level: 'unknown',
      logger: '',
      msg: line.trim(),
      correlationId: null,
      tenantId: null
    };
  }

  const [, cfTimestamp, source, direction, payload] = match;

  // Try to parse the payload as JSON
  let json = null;
  let isJson = false;

  try {
    json = JSON.parse(payload);
    isJson = true;
  } catch {
    // Not JSON - plain text payload
  }

  const entry = {
    id: index,
    cfTimestamp,
    source,
    direction,
    isJson,
    json,
    raw: payload,
    // Summary fields for table view (extracted from JSON or defaults)
    timestamp: isJson ? (json.timestamp || cfTimestamp) : cfTimestamp,
    level: isJson ? (json.level || 'unknown') : (direction === 'ERR' ? 'error' : 'info'),
    logger: isJson ? (json.logger || '') : source,
    msg: isJson ? (json.msg || '') : payload,
    correlationId: isJson ? (json.correlation_id || json.x_correlation_id || null) : null,
    tenantId: isJson ? (json.tenant_id || null) : null
  };

  return entry;
}

/**
 * Parse multiple lines of CF log output.
 *
 * @param {string} rawOutput - Full cf logs output
 * @returns {object[]} Array of parsed log entries
 */
function parseOutput(rawOutput) {
  const lines = rawOutput.split('\n');
  const entries = [];
  let index = 0;

  for (const line of lines) {
    const entry = parseLine(line, index);
    if (entry) {
      entries.push(entry);
      index++;
    }
  }

  return entries;
}

module.exports = {
  parseLine,
  parseOutput,
  categorizeFields,
  CORE_FIELDS,
  HTTP_FIELDS,
  TRACING_FIELDS,
  INFRA_FIELDS,
  SAP_FIELDS
};
