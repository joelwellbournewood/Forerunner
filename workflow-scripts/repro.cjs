const R = require("/home/user/Forerunner/.claude/worktrees/live4-4cf11fd/scripts/bench/recorder.cjs");
const N = "v4s2";
(async () => {
  const me = await R.api(N, "GET", "/me");
  const p = await R.api(N, "POST", "/projects", { name: "Garden club", goal: "A small website for the garden club", switch: true });
  const pid = p.id ?? p.project?.id;
  const say = async (text) => {
    const r = await R.api(N, "POST", "/chat", { humanId: me.human?.id ?? me.humanId ?? me.id, agentId: me.agent.id, projectId: pid, projectTab: true, text });
    const sessions = await R.api(N, "GET", `/sessions?projectId=${encodeURIComponent(pid)}`);
    console.log(JSON.stringify({ text, reply: r.reply, card: r.pendingConfirmation?.ask ?? r.pendingConfirmation?.what ?? null, offer: r.offer ?? null, sessions: sessions.length }));
    return r;
  };
  await say("add a task: write the README");
  await say("add a task: write the welcome page");
  const tasks = await R.api(N, "GET", `/projects/${encodeURIComponent(pid)}/tasks`);
  console.log("tasks", JSON.stringify(tasks.map((t) => [t.title, t.status])));
  // The model asks a yes/no question in prose (as the live model did), with no card.
  await say("say: Nothing has started yet. Do you want me to start a session on Garden club (up to CHF 1)?");
  const y = await say("yes");
  const calls = R.modelCalls(N, "chat");
  console.log("chat model calls", calls.length, "last human line seen by model:", JSON.stringify((calls.at(-1)?.messages ?? []).filter(m=>m.role==="user").map(m=>typeof m.content==="string"?m.content.slice(-120):JSON.stringify(m.content).slice(-160)).at(-1)));
  await say("say: Tell me more whenever you're ready, or say if you want a session started.");
  await say("ok");
  console.log("chat model calls after", R.modelCalls(N, "chat").length);
})().catch((e) => { console.error(e); process.exit(1); });
