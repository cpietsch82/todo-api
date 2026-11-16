import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { configureTrustProxy } from "@modules/express/Express";
import { createRateLimiter } from "@/middleware/rateLimit";

/** small app with the response helper the limiter uses and a login like route */
function createApp(options: Parameters<typeof createRateLimiter>[0], trustedProxies = 0) {
  const app = express();
  configureTrustProxy(app, trustedProxies);
  app.use(express.json());
  app.use((_req, res, next) => {
    res.respondTooManyRequests = (message = "Too many requests") => res.status(429).send(message);
    next();
  });
  app.post("/login", createRateLimiter(options), (req, res) => {
    if (req.body.fail) return res.status(401).send("nope");
    res.send("ok");
  });
  app.get("/ip", (req, res) => {
    res.send(req.ip);
  });

  return app;
}

describe("createRateLimiter", () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp({ windowMs: 60_000, limit: 3, skipSuccessfulRequests: true, message: "slow down" });
  });

  it("should allow requests up to the limit and answer with 429 afterwards", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await request(app).post("/login").send({ fail: true })).status).toBe(401);
    }

    const limited = await request(app).post("/login").send({ fail: true });

    expect(limited.status).toBe(429);
    expect(limited.text).toBe("slow down");
  });

  it("should not count successful requests when skipSuccessfulRequests is set", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await request(app).post("/login").send({})).status).toBe(200);
    }

    expect((await request(app).post("/login").send({ fail: true })).status).toBe(401);
  });

  it("should block even a correct login once the failed attempts are used up", async () => {
    for (let i = 0; i < 3; i++) await request(app).post("/login").send({ fail: true });

    const response = await request(app).post("/login").send({});

    expect(response.status).toBe(429);
  });

  it("should count every request when skipSuccessfulRequests is not set", async () => {
    const countingApp = createApp({ windowMs: 60_000, limit: 2 });

    await request(countingApp).post("/login").send({});
    await request(countingApp).post("/login").send({});

    expect((await request(countingApp).post("/login").send({})).status).toBe(429);
  });

  it("should expose the rate limit headers", async () => {
    const response = await request(app).post("/login").send({});

    expect(response.headers["ratelimit-limit"] ?? response.headers["ratelimit"]).toBeDefined();
  });

  describe("client ip behind a proxy", () => {
    it("should ignore X-Forwarded-For when no proxy is trusted", async () => {
      const response = await request(createApp({ windowMs: 60_000, limit: 3 }, 0))
        .get("/ip")
        .set("X-Forwarded-For", "203.0.113.7");

      expect(response.text).not.toContain("203.0.113.7");
    });

    it("should use X-Forwarded-For when one proxy is trusted", async () => {
      const response = await request(createApp({ windowMs: 60_000, limit: 3 }, 1))
        .get("/ip")
        .set("X-Forwarded-For", "203.0.113.7");

      expect(response.text).toBe("203.0.113.7");
    });

    it("should count each client behind a trusted proxy separately", async () => {
      const proxied = createApp({ windowMs: 60_000, limit: 1, skipSuccessfulRequests: true }, 1);

      await request(proxied).post("/login").set("X-Forwarded-For", "203.0.113.1").send({ fail: true });
      const sameClient = await request(proxied).post("/login").set("X-Forwarded-For", "203.0.113.1").send({ fail: true });
      const otherClient = await request(proxied).post("/login").set("X-Forwarded-For", "203.0.113.2").send({ fail: true });

      expect(sameClient.status).toBe(429);
      expect(otherClient.status).toBe(401);
    });

    it("should not trust a forged header when no proxy is trusted", async () => {
      const direct = createApp({ windowMs: 60_000, limit: 1, skipSuccessfulRequests: true }, 0);

      await request(direct).post("/login").set("X-Forwarded-For", "203.0.113.1").send({ fail: true });
      const forged = await request(direct).post("/login").set("X-Forwarded-For", "203.0.113.2").send({ fail: true });

      expect(forged.status).toBe(429);
    });
  });
});
