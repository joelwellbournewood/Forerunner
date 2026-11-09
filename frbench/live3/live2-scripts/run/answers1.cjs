// extra §1 steps 1-3 on "Bakery Bern" (a plan card pending): approve in chat, then a card that needs answers.
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-live";
const idRe = /\b[0-9a-f]{8}-[0-9a-f]{1,4}\b|\b01a1[0-9a-f]{4,}/i;
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(NAME);
  try {
    const p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Bakery Bern");
    const pid = p.id; out.pid = pid;
    await R.until(async () => (await R.api(NAME, "GET", `/projects/${enc(pid)}/intake`)).state === "pending", 300000, 3000, "bakery plan");
    await goto(page, NAME, `/projects/${enc(pid)}`, 2500);
    out.header0 = await R.step(page, "a01 bakery project with plan card");
    await goto(page, NAME, "/inbox", 2500);
    out.inbox0 = await R.step(page, "a02 inbox bakery plan card");
    const inbox0 = await R.api(NAME, "GET", "/inbox");
    out.openCards0 = (inbox0.requests ?? []).filter((r) => r.status === "open").map((r) => ({ id: r.id, title: r.title }));
    const notes0 = ((await R.api(NAME, "GET", "/notifications/recent?limit=200")).notifications ?? []).length;
    const chatCalls0 = R.modelCalls(NAME, "chat").length;
    // Step 1: approve in chat
    const r1 = await L.say(page, NAME, pid, "approve the plan", "a03 chat approve the plan");
    out.approveReply = r1;
    log("approve reply:", JSON.stringify(r1).slice(0, 400));
    const chatCalls = R.modelCalls(NAME, "chat").slice(chatCalls0);
    out.chatToolUses = chatCalls.map((c) => ({ tools: (c.reply?.content ?? c.reply?.toolUses ?? []).filter?.((b) => b.type === "tool_use").map((b) => ({ name: b.name, input: b.input })), text: (c.reply?.text ?? "").slice(0, 300) }));
    // while Yes/No waits: header, home, inbox badge
    await goto(page, NAME, `/projects/${enc(pid)}`, 2000);
    out.headerWaiting = await R.step(page, "a04 bakery header while yes-no waits");
    await goto(page, NAME, "/", 2000);
    out.homeWaiting = await R.step(page, "a05 home while yes-no waits");
    const inbox1 = await R.api(NAME, "GET", "/inbox");
    out.openCards1 = (inbox1.requests ?? []).filter((r) => r.status === "open").map((r) => ({ id: r.id, title: r.title }));
    out.notesDuringWait = ((await R.api(NAME, "GET", "/notifications/recent?limit=200")).notifications ?? []).length - notes0;
    // Yes
    await goto(page, NAME, `/projects/${enc(pid)}/chat`, 2000);
    const yes = page.getByTestId("confirm-yes");
    out.hadYes = await yes.count();
    if (out.hadYes) await L.answerReadback(page, true);
    await page.waitForTimeout(4000);
    out.afterYes = await R.step(page, "a06 chat after yes");
    const replies = page.getByTestId("chat-agent");
    out.afterYesLast = (await replies.count()) ? await replies.last().innerText() : null;
    await goto(page, NAME, "/inbox", 2500);
    const ans = page.getByText(/^Answered/).first();
    if (await ans.count()) { await ans.click().catch(() => undefined); await page.waitForTimeout(800); }
    out.inboxAfterYes = await R.step(page, "a07 inbox after yes answered list");
    await page.waitForTimeout(8000);
    const tasks = await L.tasks(NAME, pid);
    out.tasks = tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, display: t.display?.label, specialist: t.specialist }));
    log("tasks", JSON.stringify(out.tasks));
    // Step 2: a card that needs answers
    const inbox2 = await R.api(NAME, "GET", "/inbox");
    const qcard = (inbox2.requests ?? []).find((r) => r.status === "open" && r.projectId === pid);
    out.qcard = qcard ? { id: qcard.id, title: qcard.title, body: qcard.body, options: qcard.options } : null;
    await goto(page, NAME, "/inbox", 2500);
    out.inboxQ = await R.step(page, "a08 inbox person card");
    if (qcard) {
      const short = qcard.title.replace(/^"|".*$/g, "").slice(0, 60);
      const r2 = await L.say(page, NAME, pid, `go ahead on the "${short}" card`, "a09 chat go ahead on card");
      out.goAhead = r2;
      log("go ahead reply:", JSON.stringify(r2).slice(0, 500));
      if (r2.readback) { await L.answerReadback(page, false); out.goAheadSaidNo = true; }
      await goto(page, NAME, `/projects/${enc(pid)}/tasks`, 2500);
      out.tasksAfterGoAhead = await R.step(page, "a10 tasks after go ahead");
      // Step 3: try again, then cancel
      const r3 = await L.say(page, NAME, pid, `try "${short}" again`, "a11 chat try again");
      out.tryAgain = r3;
      if (r3.readback) { await L.answerReadback(page, false); out.tryAgainSaidNo = true; }
      const r4 = await L.say(page, NAME, pid, `cancel "${short}"`, "a12 chat cancel it");
      out.cancel = r4;
      if (r4.readback) { await L.answerReadback(page, false); out.cancelSaidNo = true; }
      const inbox3 = await R.api(NAME, "GET", "/inbox");
      out.openCardsForTask = (inbox3.requests ?? []).filter((r) => r.status === "open" && r.projectId === pid).map((r) => r.title);
      await goto(page, NAME, "/inbox", 2000);
      out.inboxEnd = await R.step(page, "a13 inbox end");
    }
    out.idsInChat = [r1, out.goAhead, out.tryAgain, out.cancel].filter(Boolean).map((x) => `${x.reply ?? ""} ${x.readback ?? ""}`).filter((t) => idRe.test(t));
  } finally { save(NAME, "answers1.json", out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
