import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import env from "../../../../env";
import { AdminAPI } from "@modules/admin/AdminAPI";
import AuthorizationService from "@modules/authorization/AuthorizationService";
import { createAuthHeader, generateUser } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";

describe("AdminAPI rate limit of the docker operations", () => {
  let server: Server;

  beforeAll(() => {
    // the limiters read the limit when the routes are created
    vi.spyOn(env, "DOCKER_OPERATION_RATE_LIMIT_MAX", "get").mockReturnValue(2);

    new AdminAPI();
    server = getTestServer();
  });

  it("should limit the operations per IP, also the rejected ones", async () => {
    const user = await generateUser();
    await new AuthorizationService().assignRoleToUser(user.userId, "deployer");
    const authHeader = await createAuthHeader(user, { role: "deployer" });

    const first = await request(server).post("/api/admin/deployments/restart").set(authHeader);
    const second = await request(server).post("/api/admin/deployments/restart").set(authHeader); // 409, counts as well
    const third = await request(server).post("/api/admin/deployments/restart").set(authHeader);

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(third.status).toBe(429);
    expect(third.text).toBe("Too many docker operations from this IP, please try again later.");
  });

  it("should not limit the reading routes", async () => {
    const user = await generateUser();
    await new AuthorizationService().assignRoleToUser(user.userId, "deployer");
    const authHeader = await createAuthHeader(user, { role: "deployer" });

    for (let i = 0; i < 5; i++) {
      expect((await request(server).get("/api/admin/deployments").set(authHeader)).status).toBe(200);
    }
  });
});
