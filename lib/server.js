'use strict';

const { categorizeFields } = require('./parser');

// --- Embedded static assets ---
// These are loaded at module scope with static paths relative to this file.
// Bun's bundler resolves these at compile time and embeds them in the binary.
const ASSET_INDEX_HTML = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf-8');
const ASSET_STYLE_CSS = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'style.css'), 'utf-8');
const ASSET_APP_JS = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf-8');

const ASSETS = {
  'index.html': { content: ASSET_INDEX_HTML, type: 'text/html; charset=utf-8' },
  'style.css': { content: ASSET_STYLE_CSS, type: 'text/css; charset=utf-8' },
  'app.js': { content: ASSET_APP_JS, type: 'application/javascript; charset=utf-8' },
};

/**
 * Create and start the log viewer web server using Bun.serve().
 */
function createServer({ initialLogs = [], appName = '', live = false } = {}) {
  const logs = [...initialLogs];
  const wsClients = new Set();
  let server = null;

  // --- Request handler ---
  function handleRequest(req, server) {
    const url = new URL(req.url, `http://${req.headers.get('host') || 'localhost'}`);
    const pathname = url.pathname;

    // --- WebSocket upgrade ---
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return undefined;
    }

    // --- API Routes ---

    // GET /api/logs
    if (pathname === '/api/logs') {
      const params = url.searchParams;
      const level = params.get('level');
      const logger = params.get('logger');
      const correlation_id = params.get('correlation_id');
      const search = params.get('search');
      const limitParam = params.get('limit');
      const offsetParam = params.get('offset');

      let filtered = logs;

      if (level && level !== 'all') {
        filtered = filtered.filter(e => e.level === level);
      }
      if (logger) {
        const lowerLogger = logger.toLowerCase();
        filtered = filtered.filter(e => e.logger && e.logger.toLowerCase().includes(lowerLogger));
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
      const off = parseInt(offsetParam, 10) || 0;
      const lim = parseInt(limitParam, 10) || 500;
      const page = filtered.slice(off, off + lim);

      return Response.json({ appName, total, offset: off, limit: lim, entries: page });
    }

    // GET /api/logs/:id
    const logDetailMatch = pathname.match(/^\/api\/logs\/(\d+)$/);
    if (logDetailMatch) {
      const id = parseInt(logDetailMatch[1], 10);
      const entry = logs.find(e => e.id === id);
      if (!entry) {
        return Response.json({ error: 'Log entry not found' }, { status: 404 });
      }
      return Response.json({ ...entry, categories: categorizeFields(entry) });
    }

    // GET /api/stats
    if (pathname === '/api/stats') {
      const levels = {};
      const loggers = {};
      const correlations = new Set();
      for (const entry of logs) {
        levels[entry.level] = (levels[entry.level] || 0) + 1;
        if (entry.logger) loggers[entry.logger] = (loggers[entry.logger] || 0) + 1;
        if (entry.correlationId) correlations.add(entry.correlationId);
      }
      return Response.json({ appName, totalEntries: logs.length, levels, loggers, uniqueCorrelations: correlations.size });
    }

    // GET /api/meta
    if (pathname === '/api/meta') {
      return Response.json({ appName, totalEntries: logs.length, live });
    }

    // --- Static files ---
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    const asset = ASSETS[filename];
    if (asset) {
      return new Response(asset.content, {
        headers: { 'Content-Type': asset.type, 'Cache-Control': 'no-cache' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  // --- Public API ---

  function addLog(entry) {
    logs.push(entry);
    const message = JSON.stringify({ type: 'newLog', entry });
    for (const ws of wsClients) {
      try {
        ws.send(message);
      } catch {
        // Client may have disconnected
      }
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      try {
        server = Bun.serve({
          port: 0,
          hostname: '127.0.0.1',
          fetch(req, srv) {
            return handleRequest(req, srv);
          },
          websocket: {
            open(ws) {
              wsClients.add(ws);
              ws.send(JSON.stringify({ type: 'init', totalEntries: logs.length }));
            },
            close(ws) {
              wsClients.delete(ws);
            },
            message() {
              // No client-to-server messages expected
            },
          },
        });
        resolve(server.port);
      } catch (err) {
        reject(err);
      }
    });
  }

  function getPort() {
    return server ? server.port : null;
  }

  function stop() {
    if (server) {
      server.stop();
      server = null;
    }
  }

  return { addLog, start, getPort, stop };
}

module.exports = { createServer };
