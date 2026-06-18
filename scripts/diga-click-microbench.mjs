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
    if ((await sidebarRows.count()) > 0) {
      await sidebarRows.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }

    const textarea = page.locator('textarea').first();
    await textarea.waitFor({ state: 'visible', timeout: 5000 });

    // 注入 perf hooks via evaluate
    await page.evaluate(() => {
      window.__perf = { events: [] };
      const log = (kind, extra = {}) => {
        window.__perf.events.push({ kind, t: performance.now(), ...extra });
      };
      window.__perfLog = log;

      // 包裹 React event dispatch 路径不可行；改成直接拦截 button.onclick
      // 不过 React 是合成事件，必须在 DOM 上挂 capture listener
      const sendBtn = document.querySelector('button[title="Send"]');
      if (sendBtn) {
        sendBtn.addEventListener('click', () => log('btn-click-capture'), true);
        sendBtn.addEventListener('click', () => log('btn-click-bubble'), false);
      }

      // 监听 textarea 变化
      const ta = document.querySelector('textarea');
      if (ta) {
        let lastVal = ta.value;
        const tick = () => {
          if (ta.value !== lastVal) {
            log('ta-changed', { from: lastVal.length, to: ta.value.length });
            lastVal = ta.value;
          }
          requestAnimationFrame(tick);
        };
        tick();
      }
    });

    await textarea.fill('PROBE-' + Date.now());
    await page.waitForTimeout(200);

    const sendBtn = page.locator('button[title="Send"]').first();
    // 不通过 playwright click（避免它内置的等待开销），用 evaluate 直接触发原生 click
    await page.evaluate(() => {
      window.__perfLog('before-click');
      const btn = document.querySelector('button[title="Send"]');
      if (btn) btn.click();
      window.__perfLog('after-click');
    });

    // 等 textarea 清空
    for (let i = 0; i < 30; i++) {
      const len = await page.evaluate(
        () => document.querySelector('textarea')?.value.length ?? -1
      );
      if (len === 0) break;
      await page.waitForTimeout(33);
    }

    const events = await page.evaluate(() => window.__perf.events);
    const t0 = events.find((e) => e.kind === 'before-click')?.t ?? 0;
    console.log('=== timeline (relative to before-click) ===');
    for (const e of events) {
      const rel = (e.t - t0).toFixed(1).padStart(7, ' ');
      console.log(`  ${rel} ms  ${e.kind} ${JSON.stringify({ ...e, kind: undefined, t: undefined })}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
