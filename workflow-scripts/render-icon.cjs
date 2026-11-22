// Renders the icon master (an SVG) to a 1024 x 1024 PNG with a transparent background.
// Usage: node render-icon.cjs <master.svg> <out.png>
const { readFileSync } = require("node:fs");
const { chromium } = require("playwright");

(async () => {
  const [svgPath, outPath] = process.argv.slice(2);
  const svg = readFileSync(svgPath, "utf8");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1024, height: 1024 },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:1024px;height:1024px}</style></head><body>${svg}</body></html>`,
    );
    await page.screenshot({
      path: outPath,
      omitBackground: true,
      clip: { x: 0, y: 0, width: 1024, height: 1024 },
    });
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
