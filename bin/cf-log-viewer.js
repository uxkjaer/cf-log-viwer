#!/usr/bin/env bun
'use strict';

const { spawn, execSync } = require('child_process');
const { parseOutput, parseLine } = require('../lib/parser');
const { createServer } = require('../lib/server');

// --- CLI argument parsing ---
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
  cf-log-viewer - Cloud Foundry Log Viewer

  Usage:
    cf-log-viewer <app-name> [options]

  Options:
    --live          Also tail live logs after fetching recent (default: recent only)
    --no-open       Do not auto-open browser
    -h, --help      Show this help

  Examples:
    cf-log-viewer my-app-srv              # fetch recent logs and show in browser
    cf-log-viewer my-app-srv --live       # fetch recent + stream live logs
    cf-log-viewer my-app-srv --no-open    # don't auto-open browser
  `);
  process.exit(0);
}

const appName = args.find(a => !a.startsWith('--'));
const enableLive = args.includes('--live');
const noOpen = args.includes('--no-open');

if (!appName) {
  console.error('Error: Please provide a CF application name.');
  process.exit(1);
}

// --- Main ---
async function main() {
  console.log(`\n  CF Log Viewer`);
  console.log(`  App: ${appName}\n`);

  // Step 1: Fetch recent logs
  console.log('  Fetching recent logs...');
  let recentOutput = '';

  try {
    recentOutput = execSync(`cf logs ${appName} --recent`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      timeout: 60000
    });
  } catch (err) {
    if (err.stdout) {
      recentOutput = err.stdout;
    } else {
      console.error(`  Error fetching logs: ${err.message}`);
      console.error('  Make sure you are logged in to CF (cf login) and the app exists.');
      process.exit(1);
    }
  }

  // Step 2: Parse
  const initialLogs = parseOutput(recentOutput);
  console.log(`  Parsed ${initialLogs.length} log entries.`);

  // Step 3: Start server
  const viewer = createServer({ initialLogs, appName, live: enableLive });
  const port = await viewer.start();
  const url = `http://127.0.0.1:${port}`;

  console.log(`\n  Log viewer running at: ${url}`);
  console.log(`  Press Ctrl+C to stop.\n`);

  // Auto-open browser
  if (!noOpen) {
    try {
      const platform = process.platform;
      if (platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else if (platform === 'linux') {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else if (platform === 'win32') {
        spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {
      // Silently fail if browser can't be opened
    }
  }

  // Step 4: Start live tailing (only with --live)
  if (enableLive) {
    console.log('  Starting live log tail...');
    let lineIndex = initialLogs.length;

    const tail = spawn('cf', ['logs', appName], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let buffer = '';

    tail.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep the last partial line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const entry = parseLine(line, lineIndex);
        if (entry) {
          viewer.addLog(entry);
          lineIndex++;
        }
      }
    });

    tail.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      // CF CLI writes "Connected, tailing logs..." to stderr, ignore that
      if (text && !text.includes('Connected') && !text.includes('tailing')) {
        console.error(`  cf stderr: ${text}`);
      }
    });

    tail.on('close', (code) => {
      if (code !== null && code !== 0) {
        console.error(`  Live tail exited with code ${code}. Viewer still running with existing logs.`);
      }
    });

    tail.on('error', (err) => {
      console.error(`  Failed to start live tail: ${err.message}`);
    });

    // Clean shutdown
    process.on('SIGINT', () => {
      console.log('\n  Shutting down...');
      tail.kill('SIGTERM');
      viewer.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      tail.kill('SIGTERM');
      viewer.stop();
      process.exit(0);
    });
  } else {
    // Default (recent-only) mode, just handle Ctrl+C
    process.on('SIGINT', () => {
      console.log('\n  Shutting down...');
      viewer.stop();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(`  Fatal error: ${err.message}`);
  process.exit(1);
});
