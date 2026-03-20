// @ts-check
const { test, expect } = require('@playwright/test');
const { startTestServer, generateLogs } = require('./helpers');

let server;

// ============================================================================
//  Test 1: Basic table rendering (no live mode)
// ============================================================================

test.describe('Basic table rendering', () => {
  test.beforeAll(async () => {
    server = await startTestServer({ logCount: 300, live: false });
  });

  test.afterAll(async () => {
    server.viewer.stop();
  });

  test('renders initial batch of 200 rows', async ({ page }) => {
    await page.goto(server.url);
    await page.waitForSelector('#log-tbody tr[data-id]');

    const rowCount = await page.locator('#log-tbody tr[data-id]').count();
    expect(rowCount).toBe(200);
  });

  test('status bar shows correct counts for partial render', async ({ page }) => {
    await page.goto(server.url);
    await page.waitForSelector('#log-tbody tr[data-id]');

    const showingText = await page.locator('#showing-count').textContent();
    // Should indicate 200 rendered out of 300
    expect(showingText).toContain('200');
    expect(showingText).toContain('300');
  });

  test('header shows total entry count', async ({ page }) => {
    await page.goto(server.url);
    await page.waitForSelector('#log-tbody tr[data-id]');

    const logCount = await page.locator('#log-count').textContent();
    expect(logCount).toBe('300 entries');
  });

  test('LIVE button is hidden when not in live mode', async ({ page }) => {
    await page.goto(server.url);
    await page.waitForSelector('#log-tbody tr[data-id]');

    const liveBtn = page.locator('#live-indicator');
    await expect(liveBtn).toBeHidden();
  });

  test('load more button is visible', async ({ page }) => {
    await page.goto(server.url);
    await page.waitForSelector('#log-tbody tr[data-id]');

    const btn = page.locator('#btn-load-more');
    await expect(btn).toBeVisible();
    const text = await btn.textContent();
    expect(text).toContain('100 remaining');
  });
});

// ============================================================================
//  Test 2: Load more entries doesn't duplicate rows
// ============================================================================

test.describe('Load more entries', () => {
  test.beforeAll(async () => {
    server = await startTestServer({ logCount: 500, live: false });
  });

  test.afterAll(async () => {
    server.viewer.stop();
  });

  test('load more adds next batch without duplicates', async ({ page }) => {
    await page.goto(server.url);
    await page.waitForSelector('#log-tbody tr[data-id]');

    // Initial: 200 rows
    let rowCount = await page.locator('#log-tbody tr[data-id]').count();
    expect(rowCount).toBe(200);

    // Click "Load more"
    await page.click('#btn-load-more');
    await page.waitForTimeout(200);

    // Should now have 400 rows
    rowCount = await page.locator('#log-tbody tr[data-id]').count();
    expect(rowCount).toBe(400);

    // Click "Load more" again for the remaining 100
    await page.click('#btn-load-more');
    await page.waitForTimeout(200);

    // Should now have all 500
    rowCount = await page.locator('#log-tbody tr[data-id]').count();
    expect(rowCount).toBe(500);

    // Load more button should be gone
    const btn = page.locator('#btn-load-more');
    await expect(btn).toBeHidden();

    // Verify no duplicate IDs
    const ids = await page.locator('#log-tbody tr[data-id]').evaluateAll(
      rows => rows.map(r => r.dataset.id)
    );
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(500);

    // Verify IDs are sequential
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBe(String(i));
    }
  });

  test('status bar updates after loading more', async ({ page }) => {
    await page.goto(server.url);
    await page.waitForSelector('#log-tbody tr[data-id]');

    // Before: partial
    let text = await page.locator('#showing-count').textContent();
    expect(text).toContain('200');

    // Load more
    await page.click('#btn-load-more');
    await page.waitForTimeout(200);

    text = await page.locator('#showing-count').textContent();
    expect(text).toContain('400');
  });
});

// ============================================================================
//  Test 3: Live streaming adds new unique entries
// ============================================================================

test.describe('Live streaming', () => {
  test.beforeAll(async () => {
    server = await startTestServer({ logCount: 5, live: true });
  });

  test.afterAll(async () => {
    server.viewer.stop();
  });

  test('new entries appear via WebSocket without duplicates', async ({ page }) => {
    await page.goto(server.url);
    await page.waitForSelector('#log-tbody tr[data-id]');

    // Initial: 5 rows
    let rowCount = await page.locator('#log-tbody tr[data-id]').count();
    expect(rowCount).toBe(5);

    // LIVE button should be visible
    const liveBtn = page.locator('#live-indicator');
    await expect(liveBtn).toBeVisible();
    await expect(liveBtn).toHaveText('LIVE');

    // Inject 10 new log entries via the server
    const newLogs = generateLogs(10, { startId: 5 });
    for (const entry of newLogs) {
      server.viewer.addLog(entry);
    }

    // Wait for them to arrive
    await page.waitForTimeout(500);

    // Should now have 15 rows
    rowCount = await page.locator('#log-tbody tr[data-id]').count();
    expect(rowCount).toBe(15);

    // Verify all IDs are unique and sequential
    const ids = await page.locator('#log-tbody tr[data-id]').evaluateAll(
      rows => rows.map(r => r.dataset.id)
    );
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(15);
    for (let i = 0; i < 15; i++) {
      expect(ids[i]).toBe(String(i));
    }

    // Header should show 15 entries
    const logCount = await page.locator('#log-count').textContent();
    expect(logCount).toBe('15 entries');
  });

  test('live entries have unique messages', async ({ page }) => {
    await page.goto(server.url);
    await page.waitForSelector('#log-tbody tr[data-id]');

    const initialCount = await page.locator('#log-tbody tr[data-id]').count();

    // Add 3 entries with distinct messages
    for (let i = 0; i < 3; i++) {
      const id = 100 + i;
      server.viewer.addLog({
        id,
        cfTimestamp: '2026-03-20T12:00:00.00+0000',
        source: 'APP/PROC/WEB/0',
        direction: 'OUT',
        isJson: true,
        json: { level: 'info', msg: `Unique live msg ${id}` },
        raw: `{"level":"info","msg":"Unique live msg ${id}"}`,
        timestamp: '2026-03-20T12:00:00.000Z',
        level: 'info',
        logger: 'live-test',
        msg: `Unique live msg ${id}`,
        correlationId: null,
        tenantId: null,
      });
    }

    await page.waitForTimeout(500);

    const newCount = await page.locator('#log-tbody tr[data-id]').count();
    expect(newCount).toBe(initialCount + 3);

    // Check messages are actually different
    const messages = await page.locator('#log-tbody tr .msg-cell').evaluateAll(
      cells => cells.slice(-3).map(c => c.textContent.trim())
    );
    expect(messages[0]).toContain('Unique live msg 100');
    expect(messages[1]).toContain('Unique live msg 101');
    expect(messages[2]).toContain('Unique live msg 102');
  });
});

// ============================================================================
//  Test 4: Pause and resume live streaming
// ============================================================================

test.describe('Pause and resume live streaming', () => {
  test.beforeAll(async () => {
    server = await startTestServer({ logCount: 3, live: true });
  });

  test.afterAll(async () => {
    server.viewer.stop();
  });

  test('pause buffers entries, resume flushes them', async ({ page }) => {
    await page.goto(server.url);
    await page.waitForSelector('#log-tbody tr[data-id]');

    // Initial: 3 rows
    let rowCount = await page.locator('#log-tbody tr[data-id]').count();
    expect(rowCount).toBe(3);

    // Wait for WebSocket to connect
    await page.waitForFunction(() => {
      const btn = document.getElementById('live-indicator');
      return btn && btn.textContent === 'LIVE';
    });

    // Click LIVE to pause
    await page.click('#live-indicator');
    await expect(page.locator('#live-indicator')).toHaveText('PAUSED');

    // Send 5 entries while paused
    const pausedLogs = generateLogs(5, { startId: 3 });
    for (const entry of pausedLogs) {
      server.viewer.addLog(entry);
    }

    await page.waitForTimeout(500);

    // Rows should still be 3 (paused!)
    rowCount = await page.locator('#log-tbody tr[data-id]').count();
    expect(rowCount).toBe(3);

    // Button should show buffered count
    const btnText = await page.locator('#live-indicator').textContent();
    expect(btnText).toContain('PAUSED');
    expect(btnText).toContain('5');

    // Click to resume
    await page.click('#live-indicator');
    await page.waitForTimeout(500);

    // Should show LIVE again
    await expect(page.locator('#live-indicator')).toHaveText('LIVE');

    // All 8 entries should now be rendered
    rowCount = await page.locator('#log-tbody tr[data-id]').count();
    expect(rowCount).toBe(8);

    // Verify no duplicates
    const ids = await page.locator('#log-tbody tr[data-id]').evaluateAll(
      rows => rows.map(r => r.dataset.id)
    );
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(8);
  });
});
