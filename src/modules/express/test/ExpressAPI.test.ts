import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express, Request, Response } from "express";
import { ExpressAPI } from "@modules/express/Express";
import { VersionService } from "@modules/express/VersionService";
import { db } from "@/db";
import { logger } from "@/utils/logger";
import env from "../../../../env";
import { createAuthHeader, generateUser, UUID_REGEX } from "@tests/test.helpers";
import { getTestApp } from "@tests/integration.setup";
import packageJson from "../../../../package.json";

describe("ExpressAPI", () => {
  let server: Express;
  let api: ExpressAPI;

  beforeAll(() => {
    server = getTestApp();
    api = new ExpressAPI();

    // routes without authentication, used to check the predefined response helpers
    const open = api.preAuthRoute("/express-test");
    open.get("/respond-error", (_req: Request, res: Response) => res.respondError("something broke", 500, true));
    open.get("/respond-error-hidden", (_req: Request, res: Response) => res.respondError("secret details"));
    open.get("/respond-error-custom", (_req: Request, res: Response) => res.respondError("teapot", 418, true));
    open.get("/respond-401", (_req: Request, res: Response) => res.respondAuthorizationRequired());
    open.get("/respond-403", (_req: Request, res: Response) => res.respondAuthorizationInsufficient());
    open.get("/respond-missing-parameter", (_req: Request, res: Response) => res.respondMissingParameter("userId"));
    open.get("/respond-missing-body", (_req: Request, res: Response) => res.respondMissingBody());
    open.get("/respond-invalid-parameter", (_req: Request, res: Response) =>
      res.respondInvalidParameter("limit", "must be a number"),
    );
    open.get("/respond-service-unavailable", (_req: Request, res: Response) =>
      res.respondServiceUnavailable("maintenance"),
    );
    open.get("/respond-no-content", (_req: Request, res: Response) => res.respondOkNoContent());
    open.get("/respond-not-found", (_req: Request, res: Response) => res.respondNotFound());
    open.get("/respond-not-found-custom", (_req: Request, res: Response) => res.respondNotFound("no todo here"));
    open.get("/throw", () => {
      throw new Error("sync failure");
    });
    open.get("/throw-async", async () => {
      throw new Error("async failure");
    });
    open.get("/throw-with-status", () => {
      throw Object.assign(new Error("not allowed here"), { status: 403 });
    });
    open.get("/throw-with-status-code", () => {
      throw Object.assign(new Error("slow down"), { statusCode: 429 });
    });
    open.get("/throw-invalid-status", () => {
      throw Object.assign(new Error("weird status"), { status: 200 });
    });
    open.get("/throw-string", () => {
      throw "plain string failure";
    });

    // routes for the HTTP methods, body parsing and nested routes
    const methods = api.preAuthRoute("/express-methods");
    methods.get("/", (_req: Request, res: Response) => res.json({ method: "get" }));
    methods.post("/", (req: Request, res: Response) => res.status(201).json({ method: "post", body: req.body }));
    methods.put("/", (req: Request, res: Response) => res.json({ method: "put", body: req.body }));
    methods.patch("/", (req: Request, res: Response) => res.json({ method: "patch", body: req.body }));
    methods.delete("/", (_req: Request, res: Response) => res.json({ method: "delete" }));
    methods.get("/query", (req: Request, res: Response) => res.json({ query: req.query }));
    methods.route("/nested").get("/deep", (_req: Request, res: Response) => res.json({ nested: true }));
    methods.param("itemId", (req: Request, _res: Response, next, value) => {
      (req as Request & { resolvedItemId?: string }).resolvedItemId = `item-${value}`;
      next();
    });
    methods.get("/items/:itemId", (req: Request, res: Response) =>
      res.json({ itemId: (req as Request & { resolvedItemId?: string }).resolvedItemId }),
    );

    // route protected by the authentication of the main router
    api.route("/express-protected").get("/ping", (req: Request, res: Response) => res.json({ userId: req.user?.id }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Module basics
  // ---------------------------------------------------------------------------
  describe("module", () => {
    it("should always return the same singleton instance", () => {
      expect(new ExpressAPI()).toBe(api);
    });

    it("should expose its module id and description", () => {
      expect(api.getModuleId()).toBe("express.api");
      expect(api.description).toBeTruthy();
    });

    it("should expose the express app, the router and the running server", () => {
      expect(api.getApp()).toBe(server);
      expect(api.getRouter()).toBeDefined();
      expect(api.getServer()).not.toBeNull();
      expect(api.getServer()?.listening).toBe(true);
    });

    it("should build a request label from method and url", () => {
      const label = ExpressAPI.makeRequestLabel({ method: "GET", originalUrl: "/api/todos" } as Request);

      expect(label).toBe("GET on /api/todos");
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health
  // ---------------------------------------------------------------------------
  describe("GET /api/health", () => {
    it("should return the status without authentication", async () => {
      const response = await request(server).get("/api/health");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: "OK", db: "connected" });
      expect(typeof response.body.uptime).toBe("number");
      expect(new Date(response.body.timestamp).toString()).not.toBe("Invalid Date");
    });

    it("should return 503 when the database is unreachable", async () => {
      vi.spyOn(db, "execute").mockRejectedValueOnce(new Error("connection refused"));

      const response = await request(server).get("/api/health");

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ status: "degraded", db: "unreachable" });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/version
  // ---------------------------------------------------------------------------
  describe("GET /api/version", () => {
    it("should return the version info without authentication", async () => {
      const response = await request(server).get("/api/version");

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        name: packageJson.name,
        version: packageJson.version,
        environment: "test",
      });
      expect(response.body.commit).toBeDefined();
    });

    it("should match the output of the VersionService", async () => {
      const response = await request(server).get("/api/version");

      expect(response.body).toEqual(new VersionService().getVersionInfo());
    });

    it("should use the commit from the environment when available", async () => {
      vi.stubEnv("APP_COMMIT", "abc1234");

      const response = await request(server).get("/api/version");

      expect(response.body.commit).toBe("abc1234");
      vi.unstubAllEnvs();
    });
  });

  // ---------------------------------------------------------------------------
  // Authentication of the main router
  // ---------------------------------------------------------------------------
  describe("authentication", () => {
    it("should return 401 for a protected route without a token", async () => {
      const response = await request(server).get("/api/express-protected/ping");

      expect(response.status).toBe(401);
    });

    it("should return 403 for a protected route with an invalid token", async () => {
      const response = await request(server)
        .get("/api/express-protected/ping")
        .set("Authorization", "Bearer not-a-valid-token");

      expect(response.status).toBe(403);
    });

    it("should allow a protected route with a valid token and attach the user", async () => {
      const user = await generateUser();

      const response = await request(server).get("/api/express-protected/ping").set(await createAuthHeader(user));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ userId: user.userId });
    });

    it("should not require a token for pre-auth routes", async () => {
      const response = await request(server).get("/api/express-methods");

      expect(response.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------
  describe("routing", () => {
    it("should route the HTTP methods to their handlers", async () => {
      const body = { hello: "world" };

      expect((await request(server).get("/api/express-methods")).body).toEqual({ method: "get" });

      const post = await request(server).post("/api/express-methods").send(body);
      expect(post.status).toBe(201);
      expect(post.body).toEqual({ method: "post", body });

      expect((await request(server).put("/api/express-methods").send(body)).body).toEqual({ method: "put", body });
      expect((await request(server).patch("/api/express-methods").send(body)).body).toEqual({
        method: "patch",
        body,
      });
      expect((await request(server).delete("/api/express-methods")).body).toEqual({ method: "delete" });
    });

    it("should parse urlencoded bodies", async () => {
      const response = await request(server).post("/api/express-methods").type("form").send("name=todo&done=false");

      expect(response.body.body).toEqual({ name: "todo", done: "false" });
    });

    it("should pass query parameters to the handler", async () => {
      const response = await request(server).get("/api/express-methods/query?limit=5&sort=asc");

      expect(response.body).toEqual({ query: { limit: "5", sort: "asc" } });
    });

    it("should support nested routes", async () => {
      const response = await request(server).get("/api/express-methods/nested/deep");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ nested: true });
    });

    it("should call registered param handlers", async () => {
      const response = await request(server).get("/api/express-methods/items/42");

      expect(response.body).toEqual({ itemId: "item-42" });
    });

    it("should return 404 for an unknown route outside of the api", async () => {
      const response = await request(server).get("/this-route-does-not-exist");

      expect(response.status).toBe(404);
      expect(response.text).toBe("Route /this-route-does-not-exist not found.");
    });

    it("should return 404 for an unknown api route when authenticated", async () => {
      const user = await generateUser();

      const response = await request(server).get("/api/this-route-does-not-exist").set(await createAuthHeader(user));

      expect(response.status).toBe(404);
    });

    it("should return 401 for an unknown api route without a token", async () => {
      const response = await request(server).get("/api/this-route-does-not-exist");

      expect(response.status).toBe(401);
    });

    it("should return 400 with the parser message for a malformed JSON body", async () => {
      const response = await request(server)
        .post("/api/express-methods")
        .set("Content-Type", "application/json")
        .send("{ not valid json");

      expect(response.status).toBe(400);
      expect(response.text).toContain("JSON");
    });
  });

  // ---------------------------------------------------------------------------
  // Global error handler
  // ---------------------------------------------------------------------------
  describe("global error handler", () => {
    it("should return 500 with the error message when a handler throws synchronously", async () => {
      const response = await request(server).get("/api/express-test/throw");

      expect(response.status).toBe(500);
      expect(response.text).toBe("sync failure");
    });

    it("should return 500 with the error message when an async handler rejects", async () => {
      const response = await request(server).get("/api/express-test/throw-async");

      expect(response.status).toBe(500);
      expect(response.text).toBe("async failure");
    });

    it("should use the status of the error and its message as response text", async () => {
      const response = await request(server).get("/api/express-test/throw-with-status");

      expect(response.status).toBe(403);
      expect(response.text).toBe("not allowed here");
    });

    it("should also support the statusCode property", async () => {
      const response = await request(server).get("/api/express-test/throw-with-status-code");

      expect(response.status).toBe(429);
      expect(response.text).toBe("slow down");
    });

    it("should fall back to 500 when the error carries no error status", async () => {
      const response = await request(server).get("/api/express-test/throw-invalid-status");

      expect(response.status).toBe(500);
      expect(response.text).toBe("weird status");
    });

    it("should handle thrown values that are not an Error", async () => {
      const response = await request(server).get("/api/express-test/throw-string");

      expect(response.status).toBe(500);
      expect(response.text).toBe("plain string failure");
    });

    it("should add a unique error id header for 5xx errors", async () => {
      const first = await request(server).get("/api/express-test/throw");
      const second = await request(server).get("/api/express-test/throw");

      expect(first.headers["x-error-id"]).toMatch(UUID_REGEX);
      expect(second.headers["x-error-id"]).toMatch(UUID_REGEX);
      expect(first.headers["x-error-id"]).not.toBe(second.headers["x-error-id"]);
    });

    it("should not add an error id header for 4xx errors", async () => {
      const response = await request(server).get("/api/express-test/throw-with-status");

      expect(response.headers["x-error-id"]).toBeUndefined();
    });

    it("should log the error id of 5xx errors", async () => {
      const spy = vi.spyOn(logger, "error");

      const response = await request(server).get("/api/express-test/throw");

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ errorId: response.headers["x-error-id"], status: 500 }),
        expect.any(String),
      );
    });

    it("should hide the message but name the error id in production", async () => {
      vi.spyOn(env, "APP_STAGE", "get").mockReturnValue("production");

      const response = await request(server).get("/api/express-test/throw");

      expect(response.status).toBe(500);
      expect(response.text).toBe(`Internal Server Error (Error ID: ${response.headers["x-error-id"]})`);
      expect(response.text).not.toContain("sync failure");
    });

    it("should keep the message of 4xx errors in production", async () => {
      vi.spyOn(env, "APP_STAGE", "get").mockReturnValue("production");

      const response = await request(server).get("/api/express-test/throw-with-status");

      expect(response.status).toBe(403);
      expect(response.text).toBe("not allowed here");
    });

    it("should not expose the stack trace", async () => {
      const response = await request(server).get("/api/express-test/throw");

      expect(response.text).not.toContain("at ");
    });
  });

  // ---------------------------------------------------------------------------
  // Response helpers
  // ---------------------------------------------------------------------------
  describe("response helpers", () => {
    it("respondError should return the message when requested", async () => {
      const response = await request(server).get("/api/express-test/respond-error");

      expect(response.status).toBe(500);
      expect(response.text).toBe("something broke");
    });

    it("respondError should hide the message by default", async () => {
      const response = await request(server).get("/api/express-test/respond-error-hidden");

      expect(response.status).toBe(500);
      expect(response.text).toBe("");
    });

    it("respondError should use a custom status code", async () => {
      const response = await request(server).get("/api/express-test/respond-error-custom");

      expect(response.status).toBe(418);
      expect(response.text).toBe("teapot");
    });

    it("respondAuthorizationRequired should return 401", async () => {
      const response = await request(server).get("/api/express-test/respond-401");

      expect(response.status).toBe(401);
    });

    it("respondAuthorizationInsufficient should return 403", async () => {
      const response = await request(server).get("/api/express-test/respond-403");

      expect(response.status).toBe(403);
    });

    it("respondMissingParameter should return 400 with the parameter name", async () => {
      const response = await request(server).get("/api/express-test/respond-missing-parameter");

      expect(response.status).toBe(400);
      expect(response.text).toBe("missing parameter userId");
    });

    it("respondMissingBody should return 400", async () => {
      const response = await request(server).get("/api/express-test/respond-missing-body");

      expect(response.status).toBe(400);
      expect(response.text).toBe("missing body");
    });

    it("respondInvalidParameter should return 400 with the explanation", async () => {
      const response = await request(server).get("/api/express-test/respond-invalid-parameter");

      expect(response.status).toBe(400);
      expect(response.text).toBe("parameter limit has invalid value: must be a number");
    });

    it("respondServiceUnavailable should return 503 with the message", async () => {
      const response = await request(server).get("/api/express-test/respond-service-unavailable");

      expect(response.status).toBe(503);
      expect(response.text).toBe("maintenance");
    });

    it("respondOkNoContent should return 204 without a body", async () => {
      const response = await request(server).get("/api/express-test/respond-no-content");

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
    });

    it("respondNotFound should return 404 with the default message", async () => {
      const response = await request(server).get("/api/express-test/respond-not-found");

      expect(response.status).toBe(404);
      expect(response.text).toBe("Not found.");
    });

    it("respondNotFound should return 404 with a custom message", async () => {
      const response = await request(server).get("/api/express-test/respond-not-found-custom");

      expect(response.status).toBe(404);
      expect(response.text).toBe("no todo here");
    });
  });

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------
  describe("middleware", () => {
    it("should add a unique X-Request-ID header to every response", async () => {
      const first = await request(server).get("/api/version");
      const second = await request(server).get("/api/version");

      expect(first.headers["x-request-id"]).toMatch(UUID_REGEX);
      expect(second.headers["x-request-id"]).toMatch(UUID_REGEX);
      expect(first.headers["x-request-id"]).not.toBe(second.headers["x-request-id"]);
    });

    it("should set security headers via helmet", async () => {
      const response = await request(server).get("/api/version");

      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-powered-by"]).toBeUndefined();
    });

    it("should answer CORS preflight requests", async () => {
      const response = await request(server)
        .options("/api/version")
        .set("Origin", "http://localhost:5173")
        .set("Access-Control-Request-Method", "POST");

      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-methods"]).toContain("POST");
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("should expose the rate limit headers on API routes", async () => {
      const response = await request(server).get("/api/version");

      expect(response.headers["ratelimit-limit"] ?? response.headers["ratelimit"]).toBeDefined();
    });
  });
});
