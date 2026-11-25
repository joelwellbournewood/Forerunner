// Add to on Ada's project: how long POST /projects/:id/intake takes and what it answers.
const R = require(process.env.REPO + "/scripts/bench/recorder.cjs");
(async () => {
  const ids = require("/tmp/frbench/fix-w8-together/steps/before-ids.json");
  const t0 = Date.now();
  const r = await R.apiRaw("fix-w8-together", "POST", `/projects/${ids.made}/intake`, {
    brief: "Add a contact form page with a short thank-you note after sending",
  });
  console.log("answered after ms", Date.now() - t0, "status", r.status, JSON.stringify(r.body).slice(0, 300));
  const s = await R.api("fix-w8-together", "GET", `/projects/${ids.made}/intake`);
  console.log("intake state now", s.state);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
