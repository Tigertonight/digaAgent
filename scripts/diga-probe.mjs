import { chromium } from 'playwright';

const URL = process.env.DIGA_URL || 'http://localhost:3000';

const probe = `(() => {
  const scroll = document.querySelector('main .flex-1.overflow-y-auto');
  const parent = scroll?.parentElement;
  const siblings = parent ? Array.from(parent.children) : [];
  const minimap = siblings.find((el) => el !== scroll);
  const minimapStyles = minimap ? getComputedStyle(minimap) : null;
  // ChatMinimap 节点：圆点 div 在 inline style 上 borderRadius 是 2 (user) 或 50% (assistant)
  const dots = minimap
    ? Array.from(minimap.querySelectorAll('div')).filter((d) => {
        const style = d.getAttribute('style') || '';
        return /border-radius:\\s*(2px|50%)/.test(style) && /width:\\s*[68]px/.test(style);
      })
    : [];
  // 它们的容器（绝对定位的 wrapper）
  const dotWrappers = minimap
    ? Array.from(minimap.querySelectorAll('div')).filter((d) => {
        const style = d.getAttribute('style') || '';
        return /position:\\s*absolute/.test(style) && /top:\\s*[\\d.]+%/.test(style) && /height:\\s*12px/.test(style);
      })
    : [];
  return {
    scroll: {
      scrollHeight: scroll?.scrollHeight,
      clientHeight: scroll?.clientHeight,
      scrollable: scroll ? scroll.scrollHeight - scroll.clientHeight : null,
    },
    minimap: {
      inDOM: !!minimap,
      width: minimapStyles?.width,
      childCount: minimap?.children.length,
      dotCount: dots.length,
      dotWrapperCount: dotWrappers.length,
    },
    refsHints: {
      cvAutoBlocks: scroll?.querySelectorAll('.cv-auto').length ?? 0,
      processGroups: document.querySelectorAll('[data-testid=\"assistant-process-group\"]').length,
    },
    bodyHead: document.body.innerText.slice(0, 120).replace(/\\s+/g, ' '),
  };
})()`;

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1500);
  // 选 sidebar 第二条（第一条可能是当前空 draft）
  const sidebarRows = page.locator('aside button[title]');
  const count = await sidebarRows.count();
  console.log('sidebar rows:', count);
  for (let i = 0; i < Math.min(count, 5); i++) {
    const row = sidebarRows.nth(i);
    try { await row.click({ timeout: 1500 }); } catch {}
    await page.waitForTimeout(1200);
    const r = await page.evaluate(probe);
    console.log(`--- row ${i} ---`);
    console.log(JSON.stringify(r, null, 2));
  }
  await page.screenshot({ path: '/tmp/diga-probe.png', fullPage: false });
} finally {
  await browser.close();
}
