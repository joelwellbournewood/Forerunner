const http = require("node:http");
const fs = require("node:fs");
const PAGES = {
  "/hosts/alpha": ["Alpha Pages free tier", "Alpha Pages gives 100 GB of bandwidth a month and unlimited sites."],
  "/hosts/beta": ["Beta Static free plan", "Beta Static allows 3 sites and 10 GB of storage on its free plan."],
  "/hosts/gamma": ["Gamma Host pricing", "Gamma Host builds 300 minutes a month for free."],
};
// Pages of a realistic size (a pricing page with its FAQ): about 50,000 characters of text.
const filler = (name) =>
  Array.from(
    { length: 400 },
    (_, i) =>
      `<p>${name} plan detail ${i + 1}: the free tier includes builds, bandwidth, custom domains and support terms that differ by region and by month; see section ${i + 1} of the terms.</p>`,
  ).join("\n");
http
  .createServer((req, res) => {
    const p = (req.url || "/").split("?")[0];
    fs.appendFileSync(
      "/tmp/frbench/review-web-search/page-hits.log",
      `${new Date().toISOString()} ${req.method} ${req.url}\n`,
    );
    const big = p.startsWith("/big/");
    const page = PAGES[big ? p.replace("/big/", "/hosts/") : p];
    res.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(
      page
        ? `<!doctype html><html><head><title>${page[0]}</title></head><body><main><h1>${page[0]}</h1><p>${page[1]}</p>${big ? filler(page[0]) : ""}</main></body></html>`
        : "not found",
    );
  })
  .listen(48319, "127.0.0.1", () => console.log("pages on 48319"));
