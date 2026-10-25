import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the two Google endpoints the FCM sender talks to, served over real HTTP on
 * the loopback address:
 *
 * - `POST /token`: the OAuth2 JWT-bearer grant. It verifies the RS256 assertion against the
 *   service account's public key and its claims (iss, aud, scope, exp - iat <= 3600) and
 *   returns a fresh access token per mint.
 * - `POST /v1/projects/<project>/messages:send`: FCM HTTP v1. It checks the bearer access
 *   token and the project, records the message, and answers from a per-registration-token
 *   script (`script(token, [...responses])`), default 200.
 *
 * Every value here is generated per run; nothing is a real credential.
 */
export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const TEST_PROJECT = "fr-push-test-project";
export const TEST_CLIENT_EMAIL = `push-sender@${TEST_PROJECT}.iam.example.test`;

export interface ScriptedResponse {
  status: number;
  /** Never answer (a stalled connection); the request is recorded with status 0. */
  hang?: boolean;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface SentMessage {
  project: string;
  authorization: string;
  message: {
    token: string;
    notification?: { title?: string; body?: string };
    data?: Record<string, string>;
    android?: { priority?: string; notification?: { channel_id?: string } };
  };
}

export interface TokenRequest {
  grantType: string | null;
  claims: Record<string, unknown>;
  signatureValid: boolean;
}

export interface FakeGoogle {
  url: string;
  tokenUri: string;
  /** The service-account JSON (with a freshly generated private key). */
  serviceAccountJson: string;
  privateKeyPem: string;
  /** Access tokens minted so far, in order. */
  accessTokens: string[];
  tokenRequests: TokenRequest[];
  sent: SentMessage[];
  /** Every FCM request, accepted or not (status recorded). */
  attempts: { token: string; status: number }[];
  script(registrationToken: string, responses: ScriptedResponse[]): void;
  /** Make the next `n` token requests fail with `status`. */
  failTokenRequests(n: number, status: number): void;
  close(): Promise<void>;
}

const { privateKey: PRIVATE_KEY_PEM, publicKey: PUBLIC_KEY_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body ?? {}));
}

function decodeJwt(jwt: string): { claims: Record<string, unknown>; signatureValid: boolean } {
  const [h, c, s] = jwt.split(".");
  if (!h || !c || !s) return { claims: {}, signatureValid: false };
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string };
  const claims = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const signatureValid =
    header.alg === "RS256" &&
    createVerify("RSA-SHA256")
      .update(`${h}.${c}`)
      .verify(PUBLIC_KEY_PEM, Buffer.from(s, "base64url"));
  return { claims, signatureValid };
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const scripts = new Map<string, ScriptedResponse[]>();
  const accessTokens: string[] = [];
  const tokenRequests: TokenRequest[] = [];
  const sent: SentMessage[] = [];
  const attempts: { token: string; status: number }[] = [];
  let failTokens = 0;
  let failTokenStatus = 500;
  let base = "";

  const server: Server = createServer((req, res) => {
    void (async () => {
      const text = await readBody(req);
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "POST" && path === "/token") {
        const form = new URLSearchParams(text);
        const decoded = decodeJwt(form.get("assertion") ?? "");
        tokenRequests.push({ grantType: form.get("grant_type"), ...decoded });
        if (failTokens > 0) {
          failTokens -= 1;
          send(res, failTokenStatus, { error: "backend_error" });
          return;
        }
        const c = decoded.claims;
        const iat = Number(c.iat);
        const exp = Number(c.exp);
        if (
          form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
          !decoded.signatureValid ||
          c.iss !== TEST_CLIENT_EMAIL ||
          c.aud !== `${base}/token` ||
          c.scope !== FCM_SCOPE ||
          !(exp > iat && exp - iat <= 3600)
        ) {
          send(res, 400, { error: "invalid_grant" });
          return;
        }
        const token = `fake-access-${accessTokens.length + 1}-${Math.random().toString(36).slice(2)}`;
        accessTokens.push(token);
        send(res, 200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
        return;
      }
      const m = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(path);
      if (req.method === "POST" && m?.[1]) {
        const auth = req.headers.authorization ?? "";
        const parsed = JSON.parse(text) as { message: SentMessage["message"] };
        const regToken = parsed.message?.token ?? "";
        const current = accessTokens[accessTokens.length - 1];
        if (!current || auth !== `Bearer ${current}`) {
          attempts.push({ token: regToken, status: 401 });
          send(res, 401, { error: { code: 401, status: "UNAUTHENTICATED" } });
          return;
        }
        if (decodeURIComponent(m[1]) !== TEST_PROJECT) {
          attempts.push({ token: regToken, status: 403 });
          send(res, 403, { error: { code: 403, status: "PERMISSION_DENIED" } });
          return;
        }
        const next = scripts.get(regToken)?.shift();
        if (next?.hang) {
          attempts.push({ token: regToken, status: 0 });
          return;
        }
        const status = next?.status ?? 200;
        attempts.push({ token: regToken, status });
        if (status === 200) {
          sent.push({ project: m[1], authorization: auth, message: parsed.message });
          send(res, 200, { name: `projects/${TEST_PROJECT}/messages/${sent.length}` });
          return;
        }
        send(res, status, next?.body ?? {}, next?.headers ?? {});
        return;
      }
      send(res, 404, { error: { code: 404, status: "NOT_FOUND" } });
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const serviceAccountJson = JSON.stringify({
    type: "service_account",
    project_id: TEST_PROJECT,
    private_key_id: "0123456789abcdef",
    private_key: PRIVATE_KEY_PEM,
    client_email: TEST_CLIENT_EMAIL,
    client_id: "100000000000000000001",
    token_uri: `${base}/token`,
  });
  return {
    url: base,
    tokenUri: `${base}/token`,
    serviceAccountJson,
    privateKeyPem: PRIVATE_KEY_PEM,
    accessTokens,
    tokenRequests,
    sent,
    attempts,
    script(token, responses) {
      scripts.set(token, [...responses]);
    },
    failTokenRequests(n, status) {
      failTokens = n;
      failTokenStatus = status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** UNREGISTERED as FCM HTTP v1 reports it (404 with an FcmError detail). */
export const UNREGISTERED: ScriptedResponse = {
  status: 404,
  body: {
    error: {
      code: 404,
      message: "Requested entity was not found.",
      status: "NOT_FOUND",
      details: [
        {
          "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
          errorCode: "UNREGISTERED",
        },
      ],
    },
  },
};

/** A connection that accepts the request and never answers. */
export const HANG: ScriptedResponse = { status: 0, hang: true };

export const UNAVAILABLE: ScriptedResponse = {
  status: 503,
  body: { error: { code: 503, status: "UNAVAILABLE" } },
};
