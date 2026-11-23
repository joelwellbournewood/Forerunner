const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const f = 'file://' + process.argv[2];
  for (const [w, scheme, name] of [[1200, 'light', 'dash-desk.png'], [390, 'dark', 'dash-phone.png']]) {
    const p = await b.newPage({ viewport: { width: w, height: 900 }, colorScheme: scheme });
    await p.goto(f);
    const sw = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    console.log(name, 'scrollWidth/innerWidth', sw);
    await p.screenshot({ path: name, fullPage: true });
    await p.close();
  }
  await b.close();
})();
