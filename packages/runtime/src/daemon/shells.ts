/**
 * Which `/events` consumers show the desktop channel's toasts (ADR 0038 point 3). Every open
 * `GET /events` stream receives the `notification` frame, but only a *shell* (the desktop
 * sidecar, ADR 0031) turns it into an OS notification; the React UI's own EventSource (inbox
 * counts), the phone's web view and a browser tab do not. The desktop channel therefore counts
 * shells, not streams: with none attached it falls back to the OS notifier.
 *
 * A stream is a shell when it says so (`?client=shell`, or the `X-Forerunner-Client: shell`
 * header) and not one when it says otherwise (`client=ui`). A stream that says nothing counts
 * as a shell only when its bearer token came in the `Authorization` header: a browser's
 * EventSource cannot send headers and carries the token as `?token=`, so that rule keeps
 * today's desktop shell (reqwest with the header, no declaration) counted and leaves every
 * web view out. Once the shell declares itself the undeclared rule can go.
 */

/** The `client` value that marks a toast-showing shell. */
export const SHELL_CLIENT = "shell";
/** Header a native client uses to declare itself (query parameter: `client`). */
export const CLIENT_HEADER = "x-forerunner-client";

export interface ShellStreamFacts {
  /** The `client` query parameter, when given. */
  client?: string | undefined;
  /** The `X-Forerunner-Client` header, when given. */
  clientHeader?: string | undefined;
  /** Whether the bearer token came in the `Authorization` header (never from an EventSource). */
  bearerHeader: boolean;
}

/** Whether an `/events` stream will show the `notification` frames it receives as toasts. */
export function isShellStream(facts: ShellStreamFacts): boolean {
  const declared = (facts.client ?? facts.clientHeader ?? "").trim().toLowerCase();
  if (declared.length > 0) return declared === SHELL_CLIENT;
  return facts.bearerHeader;
}

/** The `speech` value that marks a client that plays the `speak.started` utterances (ADR 0063). */
export const SPEECH_PLAYER = "play";

/**
 * Whether an `/events` stream plays speech: it declared `?speech=play` (the UI does where it
 * has Web Audio and EventSource). Counted separately from the toast shells: the desktop
 * sidecar shows toasts but plays no audio, the UI's window plays audio but shows no toast.
 */
export function isSpeechPlayerStream(facts: { speech?: string | undefined }): boolean {
  return (facts.speech ?? "").trim().toLowerCase() === SPEECH_PLAYER;
}

/** The shells (or speech players) attached to this daemon, counted by `/events` and read by the desktop channel. */
export class ShellPresence {
  private attached = 0;

  /** Register one shell stream; the returned function detaches it exactly once. */
  attach(): () => void {
    this.attached += 1;
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      this.attached -= 1;
    };
  }

  count(): number {
    return this.attached;
  }
}
