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

    // 1. 滚到中间
    await page.evaluate(() => {
      const scroll = document.querySelector('main .flex-1.overflow-y-auto');
      scroll.scrollTop = Math.floor((scroll.scrollHeight - scroll.clientHeight) / 2);
    });
    await page.waitForTimeout(500);

    const t0 = await page.evaluate(() => {
      const scroll = document.querySelector('main .flex-1.overflow-y-auto');
      return { scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight };
    });
    console.log('停在中间:', t0);

    // 2. 模拟"底部追加内容"——直接 DOM 操作，跳过 React，纯测浏览器锚点行为
    await page.evaluate(() => {
      const scroll = document.querySelector('main .flex-1.overflow-y-auto');
      const inner = scroll.querySelector('.mx-auto');
      if (!inner) return;
      // 在底部插一个高度 800px 的占位
      const pad = document.createElement('div');
      pad.style.height = '800px';
      pad.style.background = 'red';
      pad.id = 'TEST_PAD';
      inner.appendChild(pad);
    });
    await page.waitForTimeout(150);

    const t1 = await page.evaluate(() => {
      const scroll = document.querySelector('main .flex-1.overflow-y-auto');
      return { scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight };
    });
    console.log('追加 800px 后:', t1);
    console.log('scrollTop 移动:', t1.scrollTop - t0.scrollTop, 'px (期望 0)');

    // 3. 反过来：顶部插占位（这是触发 anchor 的经典场景）
    await page.evaluate(() => {
      const inner = document.querySelector('main .flex-1.overflow-y-auto .mx-auto');
      const pad = document.createElement('div');
      pad.style.height = '800px';
      pad.style.background = 'blue';
      pad.id = 'TEST_PAD_TOP';
      inner.insertBefore(pad, inner.firstChild);
    });
    await page.waitForTimeout(150);

    const t2 = await page.evaluate(() => {
      const scroll = document.querySelector('main .flex-1.overflow-y-auto');
      return { scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight };
    });
    console.log('顶部插 800px 后:', t2);
    console.log('scrollTop 移动:', t2.scrollTop - t1.scrollTop, 'px (anchor=auto 时浏览器会自动 +800 保持视口；anchor=none 应为 0)');

    // 清理
    await page.evaluate(() => {
      document.getElementById('TEST_PAD')?.remove();
      document.getElementById('TEST_PAD_TOP')?.remove();
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
