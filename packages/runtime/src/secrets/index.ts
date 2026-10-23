/**
 * Shared secrets (spec S.13, ADR 0065): the grant rules over the store, the resolving vault
 * adapter and the owner-side proposal. The state service's `/secrets` routes and the daemon
 * both build on this module.
 */
export * from "./propose.ts";
export * from "./resolver.ts";
export * from "./routes.ts";
export * from "./shared-grants.ts";
