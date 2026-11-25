import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import request from "supertest";
import env from "../../../../env";
import { getTestApp } from "@tests/integration.setup";
import { listenOnLoopback } from "@tests/supertest.loopback";

describe("ExpressAPI rate limit", () => {
  let server: http.Server;

  beforeAll(async () => {
    // one server for all requests, because a few hundred requests are sent
    server = await listenOnLoopback(getTestApp());
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should answer with 429 once the limit per IP is exceeded", async () => {
    for (let i = 0; i < env.RATE_LIMIT_PER_IP; i++) {
      const response = await request(server).get("/api/version");
      expect(response.status).toBe(200);
    }

    const limited = await request(server).get("/api/version");

    expect(limited.status).toBe(429);
    expect(limited.text).toBe("Too many requests from this IP, please try again later.");
    expect(limited.headers["ratelimit-remaining"]).toBe("0");
  });

  it("should reject throttled requests before their body is parsed", async () => {
    // the limit is exhausted by the test before: with the body parser first this would be a 400 for the malformed json
    const malformed = await request(server)
      .post("/api/express-methods")
      .set("Content-Type", "application/json")
      .send("{ not valid json");
    const tooBig = await request(server)
      .post("/api/express-methods")
      .send({ payload: "x".repeat(200 * 1024) });

    expect(malformed.status).toBe(429);
    expect(tooBig.status).toBe(429);
  });
});
