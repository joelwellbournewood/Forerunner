const R = require(process.env.REPO + "/scripts/bench/recorder.cjs");
(async () => {
  const ids = require("/tmp/frbench/fix-w8-together/steps/before-ids.json");
  const end = Date.now() + Number(process.argv[2] || 90) * 1000;
  for (;;) {
    const c = await R.api("fix-w8-together-bob", "GET", "/projects/" + ids.site);
    if (c.repositoryElsewhere || Date.now() > end) {
      console.log(JSON.stringify(c.repositoryElsewhere));
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
})();
