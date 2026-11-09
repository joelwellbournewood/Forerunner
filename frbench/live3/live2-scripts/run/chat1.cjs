// Quote page: drawer after done (Changed: click -> Files), sandbox line; chat: three lines + "what happened last time?"
const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const NAME = "run-live";
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(NAME);
  try {
    const p = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Quote page");
    const pid = p.id; out.pid = pid;
    const ts = await L.tasks(NAME, pid);
    const build = ts.find((t) => t.title.startsWith("Build"));
    await goto(page, NAME, `/projects/${enc(pid)}/tasks?task=${enc(build.id)}`, 2500);
    out.drawerDone = await R.step(page, "q01 drawer build done");
    out.sandboxLineInDrawer = /without its own sandbox/.test(out.drawerDone);
    const changed = page.getByRole("link", { name: "index.html" }).or(page.getByRole("button", { name: "index.html" })).first();
    if (await changed.count()) {
      await changed.click(); await page.waitForTimeout(2500);
      out.afterChangedClickUrl = page.url();
      out.filesView = await R.step(page, "q02 files after changed click");
    } else out.afterChangedClickUrl = "no index.html link in drawer";
    // chat
    const chat0 = R.modelCalls(NAME, "chat").length;
    const lines = ["what happened last time?", "Which file holds the quotes, and how many quotes are in it now?", "Why did the critic send the page back the first time?"];
    out.chat = [];
    for (let i = 0; i < lines.length; i++) {
      const r = await L.say(page, NAME, pid, lines[i], `q0${3 + i} chat line ${i + 1}`);
      out.chat.push({ line: lines[i], reply: r.reply, readback: r.readback });
      log("chat", i + 1, (r.reply || "").slice(0, 300));
    }
    const calls = R.modelCalls(NAME, "chat").slice(chat0);
    out.chatCalls = calls.map((c) => {
      const msgs = c.messages ?? [];
      const lastUser = msgs.filter((m) => m.role === "user").at(-1);
      const userText = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content ?? []).map((b) => b.text ?? "").join("\n");
      const sys = typeof c.system === "string" ? c.system : JSON.stringify(c.system);
      return {
        usage: c.reply?.usage, usd: c.usd, messages: msgs.length, cache: c.cache,
        lastUserStart: userText.slice(0, 200), lastUserEnd: userText.slice(-300),
        idInContext: /\[id /.test(sys + JSON.stringify(msgs)),
        toolCalls: (c.reply?.toolCalls ?? []).map((t) => t.name),
      };
    });
  } finally { save(NAME, "chat1.json", out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
