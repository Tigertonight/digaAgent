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

    // 注入 perf hooks
    const result = await page.evaluate(() => {
      const scroll = document.querySelector('main .flex-1.overflow-y-auto');
      if (!scroll) return { err: 'no scroll container' };
      const style = getComputedStyle(scroll);

      // cv-auto 节点
      const cvNodes = scroll.querySelectorAll('.cv-auto');
      const cvSamples = [];
      for (let i = 0; i < Math.min(cvNodes.length, 10); i++) {
        const n = cvNodes[i];
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        cvSamples.push({
          i,
          height: r.height,
          intrinsicSize: cs.containIntrinsicSize,
          contentVisibility: cs.contentVisibility,
          overflowAnchor: cs.overflowAnchor,
        });
      }

      return {
        scroll: {
          scrollHeight: scroll.scrollHeight,
          clientHeight: scroll.clientHeight,
          scrollTop: scroll.scrollTop,
          scrollableMax: scroll.scrollHeight - scroll.clientHeight,
          overflowAnchor: style.overflowAnchor,
          scrollBehavior: style.scrollBehavior,
        },
        cvSampleCount: cvNodes.length,
        cvSamples,
      };
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
