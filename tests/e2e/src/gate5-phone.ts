/**
 * The phone's approvals path for the phase 5 gate (ADR 0045), on top of `scenario-phone.ts`:
 * the Android app's inbox and answer calls against the real state service, with the
 * biometric assertion the app's shell adds to a high-risk confirmation (spec R.7, Q.8; the
 * signed string carries `biometric=1` and the request the `X-Biometric-Assertion` header,
 * `services/state-api/src/auth`), the quick-chat envelope the app relays to the PC
 * (`sendChat` in `apps/ui/src/mobile/store.tsx`), and a record of every answer the phone gave
 * so the harness can prove that every request of the week was answered there.
 *
 * The emulator is not driven: the screens are the app's React code; what enters here is what
 * the Inbox screen sends after the tap (and after the biometric prompt on a high-risk card).
 */
import type { Clock } from "@forerunner/platform";
import type { StateApiApp } from "../../../services/state-api/src/app.ts";
import { type DeviceKeyPair, signRequest } from "../../../services/state-api/src/auth/crypto.ts";
import { HEADER_BIOMETRIC } from "../../../services/state-api/src/auth/principal.ts";
import { type AppMobile, PhoneClient, type RemoteCommandView } from "./scenario-phone.ts";

/** The service's `humanRequestView`. */
export interface PhoneRequestView {
  id: string;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  sessionId: string | null;
  kind: string;
  why: string;
  steps: string[];
  options: string[];
  blocking: boolean;
  risk: "low" | "medium" | "high";
  changeCard: Record<string, unknown> | null;
  status: string;
  answer: unknown;
  createdAt: string;
  version: number;
}

export interface PhoneInboxView {
  messages: { id: string; body: string; type: string; projectId: string | null }[];
  requests: PhoneRequestView[];
  blockingCount: number;
}

/**
 * The same paired phone after the shell's biometric prompt: every mutation is signed with
 * `biometric=1` and carries the assertion header, which is what `confirm:high` needs. Built
 * from the paired `PhoneClient` (same key, same token, same device row).
 */
export class BiometricPhoneClient extends PhoneClient {
  private lastTs = 0;

  static from(phone: PhoneClient): BiometricPhoneClient {
    return new BiometricPhoneClient(
      phone.app,
      phone.token,
      phone.clock,
      phone.keys,
      phone.deviceId,
      phone.humanId,
    );
  }

  constructor(
    app: StateApiApp["app"],
    token: string,
    clock: Clock,
    keys: DeviceKeyPair,
    deviceId: string,
    humanId: string,
  ) {
    super(app, token, clock, keys, deviceId, humanId);
  }

  protected override headersFor(
    method: string,
    path: string,
    body: string,
  ): Record<string, string> {
    const base: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (method === "GET") return base;
    const ts = Math.max(this.clock.now(), this.lastTs + 1);
    this.lastTs = ts;
    const timestamp = String(ts);
    const signature = signRequest(this.keys.secretKey, {
      method,
      path,
      body,
      timestamp,
      biometric: true,
    });
    return {
      ...base,
      "x-device-signature": signature,
      "x-device-timestamp": timestamp,
      [HEADER_BIOMETRIC]: "1",
    };
  }
}

export interface PhoneAnswer {
  requestId: string;
  kind: string;
  risk: string;
  answer: unknown;
  biometric: boolean;
  status: number;
  at: string;
}

/** What the Inbox screen does: list, then answer one request with its current version. */
export class PhoneApprovals {
  readonly answers: PhoneAnswer[] = [];
  private readonly biometric: BiometricPhoneClient;

  constructor(readonly phone: PhoneClient) {
    this.biometric = BiometricPhoneClient.from(phone);
  }

  async inbox(): Promise<PhoneInboxView> {
    const r = await this.phone.get<PhoneInboxView>("/inbox");
    if (r.status !== 200) throw new Error(`phone GET /inbox: ${r.status}`);
    return r.body;
  }

  async request(id: string): Promise<PhoneRequestView> {
    const r = await this.phone.get<PhoneRequestView>(`/requests/${id}`);
    if (r.status !== 200) throw new Error(`phone GET /requests/${id}: ${r.status}`);
    return r.body;
  }

  /**
   * Answer a request as the app does after the tap: `{ version, answer }` signed by the
   * device, with the biometric assertion when the shell prompted for it. Returns the
   * service's status and body (a refusal is a result the harness asserts, not an error).
   */
  async answer(
    id: string,
    answer: unknown,
    opts: { biometric?: boolean } = {},
  ): Promise<{ status: number; body: PhoneRequestView | { code?: string; message?: string } }> {
    const current = await this.request(id);
    const client = opts.biometric ? this.biometric : this.phone;
    const r = await client.post<PhoneRequestView | { code?: string; message?: string }>(
      `/requests/${id}/answer`,
      { version: current.version, answer },
    );
    this.answers.push({
      requestId: id,
      kind: current.kind,
      risk: current.risk,
      answer,
      biometric: opts.biometric === true,
      status: r.status,
      at: this.phone.clock.nowIso(),
    });
    return { status: r.status, body: r.body };
  }

  /** The app's quick chat: one `kind: "chat"` envelope for the PC, verb `start` (`sendChat`). */
  async quickChat(
    app: Pick<AppMobile, "newClientId">,
    text: string,
    projectId: string | null,
  ): Promise<RemoteCommandView> {
    const r = await this.phone.post<RemoteCommandView>("/remote/commands", {
      target: "pc",
      command: "start",
      params: { v: 1, kind: "chat", text, projectId, clientId: app.newClientId() },
    });
    if (r.status !== 201) throw new Error(`phone POST /remote/commands: ${r.status}`);
    return r.body;
  }

  async command(id: string): Promise<RemoteCommandView> {
    const r = await this.phone.get<RemoteCommandView>(`/remote/commands/${id}`);
    if (r.status !== 200) throw new Error(`phone GET /remote/commands/${id}: ${r.status}`);
    return r.body;
  }
}
