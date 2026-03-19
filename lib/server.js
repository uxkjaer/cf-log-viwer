'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { categorizeFields } = require('./parser');

/**
 * Create and start the log viewer web server.
 *
 * @param {object} opts
 * @param {object[]} opts.initialLogs - Pre-loaded log entries (from --recent)
 * @param {string} opts.appName - CF application name
 * @returns {{ server, wss, addLog, getPort }}
 */
function createServer({ initialLogs = [], appName = '', live = false } = {}) {
  const app = express();
  const server = http.createServer(app);

  // WebSocket server piggybacks on the HTTP server
  const wss = new WebSocketServer({ server });

  // In-memory log store
  const logs = [...initialLogs];

  // Serve static files from /public
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // --- API Routes ---

  // GET /api/logs - Return all logs with optional filtering
  app.get('/api/logs', (req, res) => {
    const { level, logger, correlation_id, search, limit, offset } = req.query;

    let filtered = logs;

    if (level && level !== 'all') {
      filtered = filtered.filter(e => e.level === level);
    }

    if (logger) {
      filtered = filtered.filter(e =>
        e.logger && e.logger.toLowerCase().includes(logger.toLowerCase())
      );
    }

    if (correlation_id) {
      filtered = filtered.filter(e => e.correlationId === correlation_id);
    }

    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(e =>
        (e.msg && e.msg.toLowerCase().includes(s)) ||
        (e.logger && e.logger.toLowerCase().includes(s)) ||
        (e.raw && e.raw.toLowerCase().includes(s))
      );
    }

    const total = filtered.length;
    const off = parseInt(offset, 10) || 0;
    const lim = parseInt(limit, 10) || 500;
    const page = filtered.slice(off, off + lim);

    res.json({
      appName,
      total,
      offset: off,
      limit: lim,
      entries: page
    });
  });

  // GET /api/logs/:id - Return a single log entry with categorized fields
  app.get('/api/logs/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const entry = logs.find(e => e.id === id);

    if (!entry) {
      return res.status(404).json({ error: 'Log entry not found' });
    }

    res.json({
      ...entry,
      categories: categorizeFields(entry)
    });
  });

  // GET /api/stats - Return summary stats
  app.get('/api/stats', (req, res) => {
    const levels = {};
    const loggers = {};
    const correlations = new Set();

    for (const entry of logs) {
      levels[entry.level] = (levels[entry.level] || 0) + 1;
      if (entry.logger) {
        loggers[entry.logger] = (loggers[entry.logger] || 0) + 1;
      }
      if (entry.correlationId) {
        correlations.add(entry.correlationId);
      }
    }

    res.json({
      appName,
      totalEntries: logs.length,
      levels,
      loggers,
      uniqueCorrelations: correlations.size
    });
  });

  // GET /api/meta - Return app info
  app.get('/api/meta', (req, res) => {
    res.json({
      appName,
      totalEntries: logs.length,
      live
    });
  });

  // --- WebSocket ---
  wss.on('connection', (ws) => {
    // Send current count on connect
    ws.send(JSON.stringify({ type: 'init', totalEntries: logs.length }));
  });

  /**
   * Add a new log entry and broadcast to all WebSocket clients.
   */
  function addLog(entry) {
    logs.push(entry);
    const message = JSON.stringify({ type: 'newLog', entry });
    for (const client of wss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    }
  }

  /**
   * Start listening on port 0 (random) and return the assigned port.
   */
  function start() {
    return new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve(port);
      });
      server.on('error', reject);
    });
  }

  function getPort() {
    const addr = server.address();
    return addr ? addr.port : null;
  }

  function stop() {
    wss.close();
    server.close();
  }

  return { server, wss, app, addLog, start, getPort, stop };
}

module.exports = { createServer };
