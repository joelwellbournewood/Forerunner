// The repository guide's walk (w8-repo-guide): both people's Docs tabs and Ada's docs pull
// request as the stand-in serves it (its files, AGENTS.md, CLAUDE.md). Usage:
//   node guide-walk.cjs <repo root> <ada bench> <bob bench> <label>
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const [root, A, B, label] = process.argv.slice(2);
const R = require(path.join(root, "scripts/bench/recorder.cjs"));

async function gh(bench, route) {
  const g = JSON.parse(fs.readFileSync(path.join("/tmp/frbench", bench, "githost.json"), "utf8"));
  const res = await fetch(`${g.url}${route}`, {
    headers: { authorization: `token ${g.token}`, accept: "application/vnd.github+json" },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  const out = { label, prs: [] };
  const projects = await R.api(A, "GET", "/projects");
  const p = projects.find((x) => x.name === "Team site") ?? projects[0];
  const bp = (await R.api(B, "GET", "/projects")).find((x) => x.id === p.id);
  const prs = (await gh(A, "/repos/team/shared/pulls?state=all&per_page=100")).body ?? [];
  for (const pr of prs) {
    const files = (await gh(A, `/repos/team/shared/pulls/${pr.number}/files?per_page=100`)).body ?? [];
    out.prs.push({
      number: pr.number,
      head: pr.head?.ref,
      author: pr.user?.login,
      state: pr.state,
      files: files.map((f) => f.filename),
    });
  }
  const docsPr = out.prs.find((x) => /^fr\/(intake-|docs-scaffold)/.test(x.head ?? ""));
  for (const f of ["AGENTS.md", "CLAUDE.md", "docs/status.md"]) {
    const ref = docsPr?.head ?? "main";
    const r = await gh(A, `/repos/team/shared/contents/${f}?ref=${encodeURIComponent(ref)}`);
    out[f] =
      r.status === 200 && r.body?.content
        ? Buffer.from(r.body.content, "base64").toString("utf8")
        : `(${r.status}: not on ${ref})`;
  }
  out.adaDocs = await R.api(A, "GET", `/projects/${p.id}/docs`).catch((e) => String(e));
  out.bobDocs = bp ? await R.api(B, "GET", `/projects/${bp.id}/docs`).catch((e) => String(e)) : null;
  const dir = path.join("/tmp/frbench", A, "steps");
  fs.writeFileSync(path.join(dir, `guide-${label}.json`), JSON.stringify(out, null, 2));
  const two = await R.openTwo(A, B);
  try {
    for (const [side, bench, id, who] of [
      [two.a, A, p.id, "ada"],
      [two.b, B, bp?.id, "bob"],
    ]) {
      if (!id) continue;
      const b = R.bench(bench);
      await side.page.goto(`${b.uiUrl}/projects/${id}/docs`, { waitUntil: "domcontentloaded" });
      await side.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      await R.skipSetup(side.page).catch(() => undefined);
      await R.step(side.page, `guide-${label}-docs-${who}`, { settleMs: 4000 });
    }
  } finally {
    await two.close();
  }
  console.log(JSON.stringify({ docsPr, agents: out["AGENTS.md"].slice(0, 300) }, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
