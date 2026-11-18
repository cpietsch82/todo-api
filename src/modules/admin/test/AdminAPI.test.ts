import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { AdminAPI } from "@modules/admin/AdminAPI";
import AuthorizationService from "@modules/authorization/AuthorizationService";
import { createAuthHeader, generateUser } from "@tests/test.helpers";
import { getTestApp } from "@tests/integration.setup";
import type { User } from "@/db/schema";

// The admin area has no routes yet, so a request that passes the gate ends with 404 and a rejected one with 401/403.
describe("AdminAPI", () => {
  const authorizationService = new AuthorizationService();
  let server: Express;
  let testUser: User;

  beforeAll(() => {
    new AdminAPI();
    server = getTestApp();
  });

  beforeEach(async () => {
    testUser = await generateUser();
  });

  it("should answer 401 without a token", async () => {
    const response = await request(server).get("/api/admin/anything");

    expect(response.status).toBe(401);
  });

  it("should reject a normal user", async () => {
    await authorizationService.assignRoleToUser(testUser.userId, "user");

    const response = await request(server).get("/api/admin/anything").set(await createAuthHeader(testUser));

    expect(response.status).toBe(403);
  });

  it.each(["admin", "deployer"] as const)("should let the role %s pass the gate", async (role) => {
    await authorizationService.assignRoleToUser(testUser.userId, role);

    const response = await request(server)
      .get("/api/admin/anything")
      .set(await createAuthHeader(testUser, { role }));

    expect(response.status).toBe(404);
  });

  it("should decide with the database, not with the roles in the token", async () => {
    // the token claims admin, but the user only has the role user (e.g. admin was revoked a minute ago)
    await authorizationService.assignRoleToUser(testUser.userId, "user");

    const response = await request(server)
      .get("/api/admin/anything")
      .set(await createAuthHeader(testUser, { role: "admin" }));

    expect(response.status).toBe(403);
  });
});
