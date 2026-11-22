const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  for (const w of [390, 1200]) {
    const p = await b.newPage({ viewport: { width: w, height: 900 } });
    await p.goto('file://' + process.cwd() + '/forerunner-build-map.html');
    const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: document.documentElement.scrollHeight }));
    console.log(w, JSON.stringify(r));
    if (w === 1200) await p.screenshot({ path: 'dash-1200.png', clip: { x: 0, y: 0, width: 1200, height: 1500 } });
  }
  await b.close();
})();
