/**
 * Smart HTTP for git over the fake host: each request under `/:owner/:repo.git/*` runs
 * `git http-backend` as a CGI program (found next to git's other helpers, `.exe` or not),
 * with the request body piped in and the CGI response (headers, blank line, body) parsed
 * back into an HTTP response. Works unchanged on Windows and Linux because the process is
 * spawned with an argv array and talks only over stdin/stdout.
 */
import { spawnProcess } from "@forerunner/platform";
import { gitEnv } from "./git.ts";

export interface CgiRequest {
  rootDir: string;
  /** e.g. `/alice/demo.git/info/refs` */
  pathInfo: string;
  method: string;
  query: string;
  headers: Headers;
  body: Uint8Array | null;
  remoteUser: string | null;
  serverName: string;
  serverPort: string;
}

export interface CgiResponse {
  response: Response;
  /** Resolves when the backend process has exited (after the whole body was produced). */
  done: Promise<{ code: number | null; stderr: string }>;
}

const HEADER_END = Buffer.from("\r\n\r\n");

export function cgiEnvironment(req: CgiRequest): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_PROJECT_ROOT: req.rootDir,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: req.pathInfo,
    REQUEST_METHOD: req.method,
    QUERY_STRING: req.query,
    REQUEST_URI: req.query ? `${req.pathInfo}?${req.query}` : req.pathInfo,
    SCRIPT_NAME: "",
    SERVER_PROTOCOL: "HTTP/1.1",
    GATEWAY_INTERFACE: "CGI/1.1",
    SERVER_SOFTWARE: "fake-git-host",
    SERVER_NAME: req.serverName,
    SERVER_PORT: req.serverPort,
    REMOTE_ADDR: "127.0.0.1",
    REMOTE_HOST: "127.0.0.1",
  };
  if (req.remoteUser) env.REMOTE_USER = req.remoteUser;
  const contentType = req.headers.get("content-type");
  if (contentType) env.CONTENT_TYPE = contentType;
  if (req.body) env.CONTENT_LENGTH = String(req.body.byteLength);
  req.headers.forEach((value, name) => {
    const key = name.toUpperCase().replace(/-/g, "_");
    if (key === "CONTENT_TYPE" || key === "CONTENT_LENGTH" || key === "AUTHORIZATION") return;
    env[`HTTP_${key}`] = value;
  });
  return env;
}

export function parseCgiHeaders(block: string): { status: number; headers: Headers } {
  const headers = new Headers();
  let status = 200;
  for (const line of block.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") {
      const n = Number.parseInt(value, 10);
      if (!Number.isNaN(n)) status = n;
      continue;
    }
    headers.append(name, value);
  }
  return { status, headers };
}

/**
 * Run the backend; resolves as soon as the CGI headers (or an early exit) arrived, with the
 * body streamed to the client as the process produces it.
 */
export function handleGitHttp(backend: string, req: CgiRequest): Promise<CgiResponse> {
  const child = spawnProcess([backend], { env: gitEnv(cgiEnvironment(req)) });
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
  });
  const push = (chunk: Uint8Array) => {
    if (closed || chunk.byteLength === 0) return;
    try {
      controller?.enqueue(chunk);
    } catch {
      closed = true;
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      controller?.close();
    } catch {
      // consumer already gone
    }
  };

  let headerBuf = Buffer.alloc(0);
  let headersDone = false;
  const stderr: Buffer[] = [];
  let resolveResponse: (r: Response) => void = () => undefined;
  const response = new Promise<Response>((res) => {
    resolveResponse = res;
  });

  child.stderr?.on("data", (c: Buffer) => stderr.push(c));
  child.stdout?.on("data", (chunk: Buffer) => {
    if (headersDone) {
      push(chunk);
      return;
    }
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const idx = headerBuf.indexOf(HEADER_END);
    if (idx === -1) return;
    headersDone = true;
    const { status, headers } = parseCgiHeaders(headerBuf.subarray(0, idx).toString("latin1"));
    const rest = headerBuf.subarray(idx + HEADER_END.length);
    const bodyless = status === 204 || status === 304;
    if (bodyless) close();
    resolveResponse(new Response(bodyless ? null : stream, { status, headers }));
    push(rest);
  });
  child.stdin?.on("error", () => {
    // backend closed its input early (e.g. after an auth error); its exit code decides
  });
  if (req.body) child.stdin?.end(req.body);
  else child.stdin?.end();

  const done = new Promise<{ code: number | null; stderr: string }>((res) => {
    const finish = (code: number | null) => {
      const err = Buffer.concat(stderr).toString("utf8");
      if (!headersDone) {
        headersDone = true;
        close();
        resolveResponse(
          new Response(err.length > 0 ? err : "git http-backend produced no response", {
            status: 500,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }),
        );
      }
      close();
      res({ code, stderr: err });
    };
    child.on("close", (code) => finish(code));
    child.on("error", () => finish(null));
  });

  return response.then((r) => ({ response: r, done }));
}
