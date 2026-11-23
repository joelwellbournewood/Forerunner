const R = require(`${process.argv[2]}/scripts/bench/recorder.cjs`);
(async () => {
  const id = process.argv[3];
  const said = await R.apiRaw("fix-l4-github-link", "POST", "/commands/execute", {
    commands: [
      { name: "settings.set", params: { key: "status_pull_request", value: true, project: id } },
    ],
    wordsUsed: "turn on the status pull request",
    source: "ui",
    projectId: id,
    confirm: "tap",
  });
  console.log(JSON.stringify(said).slice(0, 800));
})();
