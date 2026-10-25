import { type Clock, errorMessage, ForerunnerError, isForerunnerError } from "@forerunner/platform";
import { assertStorableSecretName, unwrapSecret, type Vault } from "@forerunner/vault";
import {
  type ProposeSharedGrantInput,
  proposeSharedGrant,
  revokeSharedGrant,
  type SharedGrantStore,
  type SharedGrantView,
  serveSharedBlob,
  sharedGrantView,
  type WrapTarget,
  wrapTargetsFor,
} from "./shared-grants.ts";

/**
 * The resolving side of shared secrets (spec S.13, ADR 0065). `SharedSecretVault` is the
 * `Vault` the runtime's `SecretResolver` reads: the install's own vault first, then, for a
 * name the local vault does not hold, the wrapped copy the shared state serves for this
 * agent on this install, unwrapped with the install's private key. Nothing is written to the
 * local vault or to disk; the string handed to the tool call is the only copy, as for a local
 * secret. The hooks' `grantedSecrets` rule is unchanged: a name the run token does not grant
 * is refused before this vault is asked.
 */

export interface ServedBlob {
  grantId: string;
  ownerHumanId: string;
  blob: unknown;
}

/** Where wrapped copies come from: the shared store directly, or the state service over HTTP. */
export interface SharedSecretSource {
  /** The copy for (name, agent, install), or null when there is no active grant for it. */
  fetchBlob(name: string, agentId: string, deviceId: string): Promise<ServedBlob | null>;
}

/** The full owner-side surface: wrap targets, proposals, revocation, listing, plus the source. */
export interface SharedSecretService extends SharedSecretSource {
  wrapTargets(agentIds: string[]): Promise<WrapTarget[]>;
  propose(
    input: ProposeSharedGrantInput,
  ): Promise<{ grant: SharedGrantView; requestIds: string[] }>;
  revoke(grantId: string, by: string | null): Promise<SharedGrantView>;
  list(humanId: string): Promise<SharedGrantView[]>;
}

export interface SharedSecretInstall {
  /** This install's device row (the key the blobs were wrapped to is registered on it). */
  deviceId: string;
  /** The install's private wrapping key, raw base64, read from its vault when needed. */
  privateKey: () => Promise<string> | string;
}

export interface SharedSecretVaultOptions {
  local: Vault;
  source: SharedSecretSource;
  agentId: string;
  /** Unset until the install registered its device row; until then only the local vault answers. */
  install?: SharedSecretInstall | null;
  /** Called after a wrapped copy was unwrapped for a read (the name and ids, never the value). */
  onResolved?: (info: {
    name: string;
    grantId: string;
    ownerHumanId: string;
  }) => void | Promise<void>;
}

export class SharedSecretVault implements Vault {
  private install: SharedSecretInstall | null;

  constructor(private readonly opts: SharedSecretVaultOptions) {
    this.install = opts.install ?? null;
  }

  get backend(): Vault["backend"] {
    return this.opts.local.backend;
  }

  /** Bind the install once its device row exists (the daemon registers it after the vault opened). */
  bind(install: SharedSecretInstall | null): void {
    this.install = install;
  }

  get bound(): boolean {
    return this.install !== null;
  }

  set(name: string, value: string): Promise<void> {
    return this.opts.local.set(name, value);
  }

  delete(name: string): Promise<boolean> {
    return this.opts.local.delete(name);
  }

  list(): Promise<string[]> {
    return this.opts.local.list();
  }

  async has(name: string): Promise<boolean> {
    if (await this.opts.local.has(name)) return true;
    return (await this.fetch(assertStorableSecretName(name))) !== null;
  }

  async get(name: string): Promise<string | null> {
    // A Vault: the syntax rule only. The reserved rule is the resolver's (`resolveSecretRefs`
    // refuses `forerunner.*` before this vault is asked) and every grant path's.
    assertStorableSecretName(name);
    const local = await this.opts.local.get(name);
    if (local !== null) return local;
    const served = await this.fetch(name);
    if (!served || !this.install) return null;
    const privateKey = await this.install.privateKey();
    const value = unwrapSecret(served.blob, privateKey, {
      name,
      ownerHumanId: served.ownerHumanId,
      agentId: this.opts.agentId,
      deviceId: this.install.deviceId,
    });
    await this.opts.onResolved?.({
      name,
      grantId: served.grantId,
      ownerHumanId: served.ownerHumanId,
    });
    return value;
  }

  private async fetch(name: string): Promise<ServedBlob | null> {
    if (!this.install) return null;
    try {
      return await this.opts.source.fetchBlob(name, this.opts.agentId, this.install.deviceId);
    } catch (e) {
      if (isForerunnerError(e, "secret_not_granted") || isForerunnerError(e, "not_found"))
        return null;
      throw e;
    }
  }
}

/** The service over the shared store itself (the daemon and the runner, ADR 0024). */
export class StoreSharedSecretService implements SharedSecretService {
  /** The calling install, named in the audit rows; the daemon sets it once its device row exists. */
  installId: string | null;

  constructor(
    private readonly store: SharedGrantStore,
    private readonly opts: { clock: Clock; installId?: string | null },
  ) {
    this.installId = opts.installId ?? null;
  }

  private get grantOpts(): { clock: Clock; installId: string | null } {
    return { clock: this.opts.clock, installId: this.installId };
  }

  async fetchBlob(name: string, agentId: string, deviceId: string): Promise<ServedBlob | null> {
    try {
      const { grant, blob } = await serveSharedBlob(
        this.store,
        { name, agentId, deviceId },
        this.grantOpts,
      );
      return { grantId: grant.id, ownerHumanId: grant.owner_human_id, blob: blob.blob };
    } catch (e) {
      if (isForerunnerError(e, "secret_not_granted")) return null;
      throw e;
    }
  }

  wrapTargets(agentIds: string[]): Promise<WrapTarget[]> {
    return wrapTargetsFor(this.store, agentIds);
  }

  async propose(
    input: ProposeSharedGrantInput,
  ): Promise<{ grant: SharedGrantView; requestIds: string[] }> {
    const { grant, requests } = await proposeSharedGrant(this.store, input, this.grantOpts);
    return { grant: sharedGrantView(grant), requestIds: requests.map((r) => r.id) };
  }

  async revoke(grantId: string, by: string | null): Promise<SharedGrantView> {
    return sharedGrantView(await revokeSharedGrant(this.store, grantId, { ...this.grantOpts, by }));
  }

  async list(humanId: string): Promise<SharedGrantView[]> {
    return (await this.store.secretGrant.forHuman(humanId)).map(sharedGrantView);
  }
}

export interface HttpSharedSecretServiceOptions {
  /** The state service, e.g. https://state.example.test (no trailing slash needed). */
  baseUrl: string;
  /** The service admin token (the install's credential, ADR 0009); never logged. */
  token: string;
  /** `X-Forerunner-Install`: this install's id, for the service's rate bucket and audit rows. */
  installId?: string | null;
  /** Schema version this install runs, declared on every request (spec M.6). */
  schemaVersion?: number;
  fetch?: typeof fetch;
}

/**
 * The service over HTTP, for an install that reaches the shared state through the state
 * service rather than Postgres. Responses that mean "nothing for you" (403, 404) resolve to
 * null; anything else is `unavailable` with the status and never the body.
 */
export class HttpSharedSecretService implements SharedSecretService {
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(private readonly opts: HttpSharedSecretServiceOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.base = opts.baseUrl.replace(/\/+$/, "");
  }

  private headers(json: boolean): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.token}`,
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.opts.installId ? { "x-forerunner-install": this.opts.installId } : {}),
      ...(this.opts.schemaVersion !== undefined
        ? { "x-forerunner-schema": String(this.opts.schemaVersion) }
        : {}),
    };
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    nullOn: number[] = [],
  ): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new ForerunnerError("unavailable", `state service unreachable: ${errorMessage(e)}`, {
        details: { path },
        cause: e,
      });
    }
    if (nullOn.includes(res.status)) return null;
    if (!res.ok) {
      let code: string | undefined;
      let message = "";
      try {
        const parsed = (await res.json()) as { code?: string; message?: string };
        code = parsed.code;
        message = parsed.message ?? "";
      } catch {
        // not JSON: the status is what we know
      }
      if (code === "validation" || code === "not_found" || code === "secret_not_granted") {
        throw new ForerunnerError(code, message || `state service answered ${res.status}`, {
          details: { path, status: res.status },
        });
      }
      throw new ForerunnerError("unavailable", `state service answered ${res.status}`, {
        details: { path, status: res.status, code: code ?? null },
      });
    }
    return (await res.json()) as T;
  }

  async fetchBlob(name: string, agentId: string, deviceId: string): Promise<ServedBlob | null> {
    const q = new URLSearchParams({ name, agentId, deviceId });
    return this.call<ServedBlob>(
      "GET",
      `/secrets/shared/blob?${q.toString()}`,
      undefined,
      [403, 404],
    );
  }

  async wrapTargets(agentIds: string[]): Promise<WrapTarget[]> {
    const q = new URLSearchParams({ agentIds: agentIds.join(",") });
    const body = await this.call<{ targets: WrapTarget[] }>(
      "GET",
      `/secrets/wrap-keys?${q.toString()}`,
    );
    return body?.targets ?? [];
  }

  async propose(
    input: ProposeSharedGrantInput,
  ): Promise<{ grant: SharedGrantView; requestIds: string[] }> {
    const body = await this.call<{ grant: SharedGrantView; requestIds: string[] }>(
      "POST",
      "/secrets/shared",
      input,
    );
    if (!body) throw new ForerunnerError("unavailable", "state service returned no grant");
    return body;
  }

  async revoke(grantId: string, _by: string | null): Promise<SharedGrantView> {
    const body = await this.call<{ grant: SharedGrantView }>(
      "POST",
      `/secrets/shared/${encodeURIComponent(grantId)}/revoke`,
      {},
    );
    if (!body) throw new ForerunnerError("unavailable", "state service returned no grant");
    return body.grant;
  }

  async list(humanId: string): Promise<SharedGrantView[]> {
    const q = new URLSearchParams({ humanId });
    const body = await this.call<{ grants: SharedGrantView[] }>(
      "GET",
      `/secrets/shared?${q.toString()}`,
    );
    return body?.grants ?? [];
  }
}

/** Names of the shared secrets an agent may resolve right now: what joins its run grant. */
export async function sharedSecretNamesFor(
  store: Pick<SharedGrantStore, "secretGrant">,
  agentId: string,
): Promise<string[]> {
  return store.secretGrant.activeNamesFor(agentId);
}
