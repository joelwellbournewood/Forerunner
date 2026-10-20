/**
 * Notifications (phase 5): kinds and preferences, channels (desktop, email, Telegram, Signal),
 * the notifier with quiet hours, digest, dedupe, retry and fallback, producer helpers and the
 * daemon routes. See docs/maintainers/notifications.md and ADR 0017.
 */
export * from "./channels/index.ts";
export * from "./config.ts";
export * from "./emitter.ts";
export * from "./notifier.ts";
export * from "./prefs.ts";
export * as producers from "./producers.ts";
export { bindProducers, type NotifierLike, type ProducerHooks } from "./producers.ts";
export * from "./routes.ts";
export * from "./types.ts";
