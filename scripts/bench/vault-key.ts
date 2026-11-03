// The bench's API key written straight into the home's file vault (`start.mjs --api-key`): the
// app's setup checks a key before it stores one, and the bench needs keys the Messages API
// stand-in refuses or limits (`--provider bench-api`, U-078). The key is key-shaped and made
// here; its kind is in its text ("refused", "limited", "ok": testenv's keyRuleFromEnv), so
// the stand-in knows how to answer it. The value is never printed.
//   node --import tsx scripts/bench/vault-key.ts --home <home> --kind refused|limited|ok
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
if (!["refused", "limited", "ok"].includes(kind)) {
  console.error(`--kind must be refused, limited or ok (got ${kind})`);
  process.exit(2);
}
const env = { ...process.env, FORERUNNER_HOME: home, FORERUNNER_VAULT_BACKEND: "file" };
// The daemon's vault: profile "default" (compose's `config.profile ?? "default"`).
const vault = await openVault({ env, prefer: "file", profile: "default" });
const key = `sk-ant-api03-bench-${kind}-${randomBytes(24).toString("hex")}`;
await vault.set("anthropic_api_key", key);
console.log(`stored a ${kind} API key (anthropic_api_key) in the vault of ${home}`);
