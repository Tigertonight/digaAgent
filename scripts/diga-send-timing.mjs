import { chromium } from 'playwright';

const URL = process.env.DIGA_URL || 'http://localhost:3000';

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);

    // 选 sidebar 第一个会话（最长那条 800 条消息）
    const sidebarRows = page.locator('aside button[title]');
    const sidebarCount = await sidebarRows.count();
    console.log('sidebar rows:', sidebarCount);
    if (sidebarCount > 0) {
      await sidebarRows.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    const textarea = page.locator('textarea').first();
    if ((await textarea.count()) === 0) {
      console.log('no textarea');
      return;
    }

    // 测多个维度的点击响应延迟
    // 维度 A: textarea fill 用时（敲键 → DOM 反映）
    // 维度 B: 点击 Send 后多久 textarea 被清空（本地 setInput 完成）
    // 维度 C: 点击 Send 后 user 气泡多久出现（optimistic）
    const probeText = 'DIGA-PERF-PROBE-' + Date.now();

    // 注入 perf hooks
    await page.evaluate(() => {
      window.__perf = { events: [] };
      const log = (kind, extra = {}) => {
        window.__perf.events.push({ kind, t: performance.now(), ...extra });
      };
      window.__perfLog = log;
      // 监听 textarea 的 value 变化
      const ta = document.querySelector('textarea');
      if (ta) {
        let lastVal = ta.value;
        const tick = () => {
          if (ta.value !== lastVal) {
            log('textarea-changed', { from: lastVal.length, to: ta.value.length });
            lastVal = ta.value;
          }
          requestAnimationFrame(tick);
        };
        tick();
      }
      // 监听新 user 气泡
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            const text = n.innerText || '';
            if (text.includes('DIGA-PERF-PROBE')) {
              log('user-bubble-appeared', { len: text.length });
            }
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });

    await textarea.fill(probeText);
    await page.waitForTimeout(300);

    // 找 Send 按钮（优先含 title="Send"，其次按文字）
    const sendBtn = page.locator('button[title="Send"]').first();
    const sendBtnCount = await sendBtn.count();
    console.log('Send button (title=Send):', sendBtnCount);
    if (sendBtnCount === 0) {
      // 尝试找其它 Send
      const alt = page.locator('button:has-text("Send")');
      console.log('Send button (text):', await alt.count());
      return;
    }

    await page.evaluate(() => {
      window.__perfLog('click-fired');
    });
    await sendBtn.click({ timeout: 2000 });
    await page.evaluate(() => {
      window.__perfLog('click-returned');
    });

    // 等 user 气泡 3 秒，无所谓有没有
    await page.waitForTimeout(3000);

    const events = await page.evaluate(() => window.__perf.events);
    console.log('=== events (relative to click-fired) ===');
    const base = events.find((e) => e.kind === 'click-fired')?.t ?? 0;
    for (const e of events) {
      const rel = (e.t - base).toFixed(1).padStart(7, ' ');
      console.log(`  ${rel} ms  ${e.kind}  ${JSON.stringify(e).replace(/.t":[^,}]*/, '')}`);
    }
    console.log('event count:', events.length);

    await page.screenshot({ path: '/tmp/diga-send.png', fullPage: false });
    console.log('saved /tmp/diga-send.png');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
