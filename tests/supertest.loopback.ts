import http from "node:http";
import { once } from "node:events";
import type { RequestListener } from "node:http";

/**
 * Starts the app on a free port of the IPv4 loopback. Hand the returned server to supertest, never the app itself:
 * supertest wraps an app in http.createServer(app).listen(0) and requests http://127.0.0.1:<port>. Without a host the
 * server listens on "::", where the OS may hand out a port that another local process (an editor, a language server)
 * already holds on 127.0.0.1 — macOS allows both — and that process answers: sporadic 200/404 responses that never
 * reached the app. On 127.0.0.1 itself no other process can hold the same port.
 * The caller closes the server when done.
 */
export async function listenOnLoopback(app: RequestListener): Promise<http.Server> {
  const server = http.createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
