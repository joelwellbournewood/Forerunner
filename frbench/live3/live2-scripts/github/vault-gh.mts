// Stores FORERUNNER_TEST_GITHUB_TOKEN as the app's GitHub token in the bench home's file vault.
// The value is never printed. Used because the setup assistant's check cannot pass in this
// sandbox (the agent proxy replaces GitHub credentials and blocks GET /user/repos).
import { openVault } from "/home/user/Forerunner/packages/vault/src/index.ts";
const home = process.argv[2];
const token = process.env.FORERUNNER_TEST_GITHUB_TOKEN ?? "";
if (!home || !token) { console.error("usage: vault-gh.ts <home> (token from env)"); process.exit(2); }
const env = { ...process.env, FORERUNNER_HOME: home, FORERUNNER_VAULT_BACKEND: "file" };
const vault = await openVault({ env, prefer: "file", profile: "default" });
await vault.set("github_token", token);
console.log(`stored the GitHub token (github_token) in the vault of ${home}: ${await vault.has("github_token")}`);
