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

    // 强制把 overflow-anchor 切回 auto
    await page.evaluate(() => {
      const scroll = document.querySelector('main .flex-1.overflow-y-auto');
      scroll.style.overflowAnchor = 'auto';
      document.querySelectorAll('.cv-auto').forEach((n) => {
        n.style.overflowAnchor = 'auto';
      });
    });

    await page.evaluate(() => {
      const scroll = document.querySelector('main .flex-1.overflow-y-auto');
      scroll.scrollTop = Math.floor((scroll.scrollHeight - scroll.clientHeight) / 2);
    });
    await page.waitForTimeout(500);

    const t0 = await page.evaluate(() => {
      const scroll = document.querySelector('main .flex-1.overflow-y-auto');
      return { scrollTop: scroll.scrollTop };
    });

    await page.evaluate(() => {
      const inner = document.querySelector('main .flex-1.overflow-y-auto .mx-auto');
      const pad = document.createElement('div');
      pad.style.height = '800px';
      pad.id = 'TEST_PAD_TOP';
      inner.insertBefore(pad, inner.firstChild);
    });
    await page.waitForTimeout(150);

    const t1 = await page.evaluate(() => {
      const scroll = document.querySelector('main .flex-1.overflow-y-auto');
      return { scrollTop: scroll.scrollTop };
    });
    console.log('anchor=auto, 顶部插 800px 后 scrollTop 移动:', t1.scrollTop - t0.scrollTop, 'px');

    await page.evaluate(() => {
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
