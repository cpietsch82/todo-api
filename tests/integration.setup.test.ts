import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { getTestServer } from "@tests/integration.setup";

describe("integration test server", () => {
  it("should already listen on the IPv4 loopback, so supertest uses its address instead of starting one on '::'", () => {
    // supertest wraps an app in http.createServer(app).listen(0) and requests http://127.0.0.1:<port>. On "::" the OS
    // may hand out a port another local process holds on 127.0.0.1 (macOS allows both), and that process answers.
    const server = getTestServer();

    expect(server.listening).toBe(true);
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });
});
