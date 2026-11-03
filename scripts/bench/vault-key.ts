// The bench's API key written straight into the home's file vault (`start.mjs --api-key`): the
// app's setup checks a key before it stores one, and the bench needs keys the Messages API
// stand-in refuses or limits (`--provider bench-api`, U-078). The key is key-shaped and made
// here; its kind is in its text ("refused", "limited", "ok": testenv's keyRuleFromEnv), so
// the stand-in knows how to answer it. The value is never printed.
//   node --import tsx scripts/bench/vault-key.ts --home <home> --kind refused|limited|ok|subscription
// `subscription` (`start.mjs --subscription`, credential-chooser): a token-shaped Claude
// subscription token under the subscription's secret, so the plan card, New task and Settings
// show where work runs with both credentials saved. The stand-in has no Claude Code, so a task
// the router gives to the subscription does not run on the bench.
import { randomBytes } from "node:crypto";
import { openVault } from "../../packages/vault/src/index.ts";

function arg(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const v = at >= 0 ? process.argv[at + 1] : undefined;
  if (!v) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return v;
}

const home = arg("home");
const kind = arg("kind");
if (!["refused", "limited", "ok", "subscription"].includes(kind)) {
  console.error(`--kind must be refused, limited, ok or subscription (got ${kind})`);
  process.exit(2);
}
const env = { ...process.env, FORERUNNER_HOME: home, FORERUNNER_VAULT_BACKEND: "file" };
// The daemon's vault: profile "default" (compose's `config.profile ?? "default"`).
const vault = await openVault({ env, prefer: "file", profile: "default" });
if (kind === "subscription") {
  const token = `sk-ant-oat01-bench-${randomBytes(24).toString("hex")}`;
  await vault.set("anthropic_subscription_token", token);
  console.log(`stored a subscription token (anthropic_subscription_token) in the vault of ${home}`);
} else {
  const key = `sk-ant-api03-bench-${kind}-${randomBytes(24).toString("hex")}`;
  await vault.set("anthropic_api_key", key);
  console.log(`stored a ${kind} API key (anthropic_api_key) in the vault of ${home}`);
}
