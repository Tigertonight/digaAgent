import { chromium } from 'playwright';

const URL = process.env.DIGA_URL || 'http://localhost:3000';

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);

    const sidebarRows = page.locator('aside button[title]');
    const sidebarCount = await sidebarRows.count();
    console.log('sidebar rows:', sidebarCount);
    if (sidebarCount > 0) {
      await sidebarRows.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(2500); // 长会话需要更久 hydrate
    }

    // 等 textarea 出现
    const textarea = page.locator('textarea').first();
    await textarea.waitFor({ state: 'visible', timeout: 5000 });

    // 测试 1: 重复点击 Send 5 次（每次填入新文本），看响应延迟分布
    const samples = [];
    for (let trial = 0; trial < 5; trial++) {
      await page.evaluate(() => {
        window.__perf = { events: [] };
      });

      const probe = `DIGA-PERF-PROBE-${trial}-${Date.now()}`;
      await textarea.fill(probe);
      await page.waitForTimeout(150);

      // 注入 textarea-changed observer
      await page.evaluate(() => {
        const ta = document.querySelector('textarea');
        if (!ta) return;
        let lastVal = ta.value;
        window.__taTickStop = false;
        const tick = () => {
          if (window.__taTickStop) return;
          if (ta.value !== lastVal) {
            window.__perf.events.push({ kind: 'ta-changed', t: performance.now(), len: ta.value.length });
            lastVal = ta.value;
          }
          requestAnimationFrame(tick);
        };
        tick();
      });

      const sendBtn = page.locator('button[title="Send"]').first();
      await page.evaluate(() => {
        window.__clickStart = performance.now();
        window.__perf.events.push({ kind: 'click-start', t: window.__clickStart });
      });

      await sendBtn.click({ timeout: 3000 });

      await page.evaluate(() => {
        window.__perf.events.push({ kind: 'playwright-click-returned', t: performance.now() });
      });

      // 等到 textarea 清空或 1s
      let cleared = null;
      for (let i = 0; i < 30; i++) {
        const r = await page.evaluate(() => ({
          taLen: document.querySelector('textarea')?.value.length ?? -1,
          events: window.__perf.events,
          start: window.__clickStart,
        }));
        if (r.taLen === 0) {
          cleared = r;
          break;
        }
        await page.waitForTimeout(33);
      }

      await page.evaluate(() => {
        window.__taTickStop = true;
      });

      if (!cleared) {
        console.log(`trial ${trial}: TIMEOUT`);
        continue;
      }
      const events = cleared.events;
      const t0 = events.find((e) => e.kind === 'click-start')?.t ?? 0;
      const taChanged = events.find((e) => e.kind === 'ta-changed' && e.len === 0);
      const playwrightReturn = events.find((e) => e.kind === 'playwright-click-returned');
      const sample = {
        trial,
        clickToTaCleared: taChanged ? +(taChanged.t - t0).toFixed(1) : null,
        clickToPlaywrightReturn: playwrightReturn ? +(playwrightReturn.t - t0).toFixed(1) : null,
      };
      samples.push(sample);
      console.log(`trial ${trial}:`, JSON.stringify(sample));
      // 等 SSE / 网络稳定一下再下一次
      await page.waitForTimeout(800);
    }

    if (samples.length > 0) {
      const avg = (key) =>
        +(samples.reduce((s, x) => s + (x[key] ?? 0), 0) / samples.length).toFixed(1);
      console.log('--- summary ---');
      console.log('avg click→ta-cleared:    ', avg('clickToTaCleared'), 'ms');
      console.log('avg click→playwright-ret:', avg('clickToPlaywrightReturn'), 'ms');
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
