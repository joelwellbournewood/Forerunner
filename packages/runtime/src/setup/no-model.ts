/**
 * What a person reads when something needs a Claude key or subscription and this install has
 * none (U-047). The installed app has no `fr` command, so the way to add one is the app's own
 * setup assistant, reached from Settings; no message for a missing credential names `fr setup`.
 */
export const SETUP_ASSISTANT_PATH = "Settings → Accounts and keys → Open the setup assistant";

/** The message of a refusal for want of a model credential (`provider_auth`, `unavailable`). */
export const NO_MODEL_CREDENTIAL = `No Claude key or subscription is set up yet. Add one in the app: ${SETUP_ASSISTANT_PATH}.`;

/**
 * The chat's reply to a line only the model can answer, on an install without a credential:
 * the missing key, where to add it, and the commands Chat still runs without one.
 */
export const NO_MODEL_CHAT_REPLY = `${NO_MODEL_CREDENTIAL} Until then I can still run commands that need no model: "add a task: …", "make this a task", "start a session" and "switch to <project>".`;
