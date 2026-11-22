// Review walk, part 2 (after a daemon restart): Changes shows the join with Undo and Site's
// creation refused in words; press Undo in the UI; Kite club is its own project again with its
// tasks (the merged one still merged, its merge record with it) and the shared line on both.
const fs = require("node:fs");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-3";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const N = "review-d1109-onerepo-join";
const B = () => JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/bench.json`, "utf8"));
const pair = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/pair.json`, "utf8"));
const out = { checks: [], texts: {} };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail: detail === undefined ? undefined : String(detail).slice(0, 600) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${String(detail).slice(0, 300)}` : ""}`);
};
const text = async (loc) => ((await loc.textContent()) ?? "").replace(/\s+/g, " ").trim();

(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await page.goto(`${B().uiUrl}/changes`);
    const joinRow = page.locator('[data-testid="change"]', { hasText: 'Made one project: "Kite club" joined "Site".' }).first();
    await joinRow.waitFor({ timeout: 30_000 });
    check("join row has Undo after the restart", (await joinRow.getByTestId("change-undo").count()) === 1);
    const all = await R.api(N, "GET", "/changes");
    const rows = Array.isArray(all) ? all : all.changes ?? all.rows ?? [];
    const created = rows.find((r) => /Site/.test(r.sentence) && /^(Created|Made)/.test(r.sentence) && !/joined/.test(r.sentence));
    out.siteCreated = created ? { sentence: created.sentence, undoable: created.undoable, blocked: created.undoBlockedReason } : null;
    console.log("site created row", JSON.stringify(out.siteCreated));
    out.texts.changesBefore = await R.step(page, "b01-changes-after-restart");
    await joinRow.getByTestId("change-undo").click();
    await page.waitForTimeout(3000);
    out.texts.changesAfterUndo = await R.step(page, "b02-changes-after-undo");
    const note = page.getByTestId("changes-note");
    out.undoNote = (await note.count()) ? await text(note) : "(no note)";
    check("Undo says Kite club is its own again", out.undoNote.includes('"Kite club" is its own project again.'), out.undoNote);
    const kt = await R.api(N, "GET", `/projects/${pair.kite}/tasks`);
    out.kiteTasks = kt.map((t) => `${t.title}=${t.status}`);
    check("Kite club has its moved tasks back", kt.some((t) => /club notes/.test(t.title)) && kt.some((t) => /rules/.test(t.title)), out.kiteTasks.join("; "));
    const st = await R.api(N, "GET", `/projects/${pair.site}/tasks`);
    out.siteTasks = st.map((t) => `${t.title}=${t.status}`);
    check("Site keeps only its own task", st.length === 1, out.siteTasks.join("; "));
    const notes = kt.find((t) => /club notes/.test(t.title));
    const detail = notes ? await R.api(N, "GET", `/tasks/${notes.id}`) : null;
    out.notesTask = detail ? { status: detail.status, merged: detail.merged ?? detail.merge ?? null, prUrl: detail.prUrl } : null;
    console.log("notes task", JSON.stringify(out.notesTask).slice(0, 400));
    await page.goto(`${B().uiUrl}/projects/${pair.kite}/summary`);
    const line = page.getByTestId("shared-repository-line");
    await line.waitFor({ timeout: 20_000 });
    check("Kite club's Overview shows the shared line again", (await text(line)).includes("both work in bench/seeded"), await text(line));
    check("Kite club has Start session again", (await page.getByRole("button", { name: /Start session/ }).count()) === 1);
    await page.waitForTimeout(2000);
    out.texts.kiteAfterUndo = await R.step(page, "b03-kite-after-undo");
    await page.goto(`${B().uiUrl}/projects/${pair.site}/summary`);
    await page.getByTestId("shared-repository-line").waitFor({ timeout: 20_000 });
    check("Site has no Includes line", (await page.getByTestId("includes-work-of").count()) === 0);
    await page.waitForTimeout(2000);
    out.texts.siteAfterUndo = await R.step(page, "b04-site-after-undo");
    await page.goto(`${B().uiUrl}/`);
    await page.waitForTimeout(2500);
    out.texts.homeAfterUndo = await R.step(page, "b05-home-after-undo");
  } finally {
    await browser.close().catch(() => undefined);
    fs.writeFileSync(`/tmp/frbench/${N}/walk2.json`, JSON.stringify(out, null, 2));
  }
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(`/tmp/frbench/${N}/walk2.json`, JSON.stringify({ ...out, error: String(e) }, null, 2));
  process.exit(1);
});
