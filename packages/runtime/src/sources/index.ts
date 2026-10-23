/**
 * Source discovery (spec A.4, ADR 0056): connect GitHub orgs, accounts, chosen repositories
 * and local folders; scan, propose one project per repository or folder, detect an existing
 * install, never duplicate; add, rescan, remove. The daemon's `/sources` routes and the
 * `fr sources` command sit on `SourceDiscovery`. See docs/maintainers/runtime.md.
 */
export * from "./cli.ts";
export * from "./discovery.ts";
export * from "./locators.ts";
export * from "./routes.ts";
export * from "./types.ts";
