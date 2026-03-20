'use strict';

const { createServer } = require('../lib/server');

/**
 * Generate synthetic log entries for testing.
 */
function generateLogs(count, { startId = 0, levelPattern = ['info', 'debug', 'warn', 'error'] } = {}) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    const id = startId + i;
    const level = levelPattern[i % levelPattern.length];
    entries.push({
      id,
      cfTimestamp: `2026-03-20T10:00:${String(i % 60).padStart(2, '0')}.00+0000`,
      source: 'APP/PROC/WEB/0',
      direction: 'OUT',
      isJson: true,
      json: {
        timestamp: `2026-03-20T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
        level,
        logger: `test-logger-${i % 5}`,
        msg: `Test message number ${id}`,
        correlation_id: `corr-${Math.floor(i / 3)}`,
        tenant_id: `tenant-${i % 2}`,
      },
      raw: JSON.stringify({ level, msg: `Test message number ${id}` }),
      timestamp: `2026-03-20T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
      level,
      logger: `test-logger-${i % 5}`,
      msg: `Test message number ${id}`,
      correlationId: `corr-${Math.floor(i / 3)}`,
      tenantId: `tenant-${i % 2}`,
    });
  }
  return entries;
}

/**
 * Start a test server with synthetic data.
 * Returns { url, viewer, logs } where viewer has addLog/stop methods.
 */
async function startTestServer({ logCount = 300, live = false } = {}) {
  const logs = generateLogs(logCount);
  const viewer = createServer({ initialLogs: logs, appName: 'test-app', live });
  const port = await viewer.start();
  const url = `http://127.0.0.1:${port}`;
  return { url, viewer, logs, port };
}

module.exports = { generateLogs, startTestServer };
