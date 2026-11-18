import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { AdminAPI } from "@modules/admin/AdminAPI";
import DeploymentService from "@modules/admin/DeploymentService";
import { deployments } from "@modules/admin/schema/deployment.schema";
import { VersionService } from "@modules/express/VersionService";
import AuthorizationService from "@modules/authorization/AuthorizationService";
import { permissions, rolePermissions, roles, userRoles } from "@modules/authorization/schema/authorization.schema";
import { createAuthHeader, generateUser, NON_EXISTENT_UUID, UUID_REGEX } from "@tests/test.helpers";
import { getTestApp } from "@tests/integration.setup";
import type { User } from "@/db/schema";
import type { UserRole } from "@modules/authorization/permissions";

describe("AdminAPI", () => {
  const authorizationService = new AuthorizationService();
  const deploymentService = new DeploymentService();
  let server: Express;
  let testUser: User;

  /** gives the user the roles in the database and returns a matching auth header */
  async function loginAs(user: User, userRolesToGrant: UserRole[]) {
    for (const role of userRolesToGrant) await authorizationService.assignRoleToUser(user.userId, role);
    return createAuthHeader(user, { roles: userRolesToGrant });
  }

  /** an operation that is finished, so a new one can be queued */
  async function finishedDeployment(output = "done") {
    const deployment = await deploymentService.requestDeployment({ action: "restart", requestedBy: testUser.userId });
    await deploymentService.claimNextDeployment();
    return deploymentService.finishDeployment(deployment.deploymentId, { status: "succeeded", output });
  }

  beforeAll(async () => {
    new AdminAPI();
    server = getTestApp();

    // a role that may only look at the status, to check that every operation requires its own permission
    await db.insert(roles).values({ name: "observer", description: "test role" }).onConflictDoNothing();
    const [observer] = await db.select().from(roles).where(eq(roles.name, "observer"));
    const [status] = await db.select().from(permissions).where(eq(permissions.key, "admin:docker:status"));
    await db.insert(rolePermissions).values({ roleId: observer.roleId, permissionId: status.permissionId }).onConflictDoNothing();
  });

  beforeEach(async () => {
    testUser = await generateUser();
  });

  // ---------------------------------------------------------------------------
  // gate of the admin area
  // ---------------------------------------------------------------------------
  describe("gate", () => {
    it("should answer 401 without a token", async () => {
      const response = await request(server).get("/api/admin/anything");

      expect(response.status).toBe(401);
    });

    it("should reject a normal user", async () => {
      const response = await request(server).get("/api/admin/anything").set(await loginAs(testUser, ["user"]));

      expect(response.status).toBe(403);
    });

    it.each(["admin", "deployer"] as const)("should let the role %s pass the gate", async (role) => {
      const response = await request(server).get("/api/admin/anything").set(await loginAs(testUser, [role]));

      // there is no such route, so passing the gate ends with 404
      expect(response.status).toBe(404);
    });

    it("should decide with the database, not with the roles in the token", async () => {
      await authorizationService.assignRoleToUser(testUser.userId, "user");

      const response = await request(server)
        .get("/api/admin/anything")
        .set(await createAuthHeader(testUser, { role: "admin" }));

      expect(response.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/admin/version
  // ---------------------------------------------------------------------------
  describe("GET /api/admin/version", () => {
    it("should return the version of the running api to a deployer", async () => {
      const response = await request(server).get("/api/admin/version").set(await loginAs(testUser, ["user", "deployer"]));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(new VersionService().getVersionInfo());
    });

    it("should reject an admin without the role deployer", async () => {
      const response = await request(server).get("/api/admin/version").set(await loginAs(testUser, ["admin"]));

      expect(response.status).toBe(403);
      expect(response.text).toBe("Missing permissions: admin:docker:status");
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/admin/deployments/{pull,deploy,restart}
  // ---------------------------------------------------------------------------
  describe("POST /api/admin/deployments/deploy", () => {
    it("should queue the deploy and answer 202 with the url of its status", async () => {
      const response = await request(server)
        .post("/api/admin/deployments/deploy")
        .set(await loginAs(testUser, ["user", "deployer"]))
        .send({ tag: "0.0.3" });

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        action: "deploy",
        status: "queued",
        targetTag: "0.0.3",
        requestedBy: testUser.userId,
      });
      expect(response.body.deploymentId).toMatch(UUID_REGEX);
      expect(response.headers.location).toBe(`/api/admin/deployments/${response.body.deploymentId}`);
      expect(response.body.output).toBeUndefined();
    });

    it("should reject an admin without the role deployer and queue nothing", async () => {
      const response = await request(server)
        .post("/api/admin/deployments/deploy")
        .set(await loginAs(testUser, ["admin"]))
        .send({ tag: "0.0.3" });

      expect(response.status).toBe(403);
      expect(await db.select().from(deployments)).toHaveLength(0);
    });

    it.each([
      ["latest", { tag: "latest" }],
      ["a shell command", { tag: "0.0.3 && docker ps" }],
      ["a number", { tag: 3 }],
      ["no tag", {}],
      ["an additional field", { tag: "0.0.3", service: "postgres" }],
    ])("should answer 400 for %s and queue nothing", async (_name, body) => {
      const response = await request(server)
        .post("/api/admin/deployments/deploy")
        .set(await loginAs(testUser, ["user", "deployer"]))
        .send(body);

      expect(response.status).toBe(400);
      expect(await db.select().from(deployments)).toHaveLength(0);
    });

    it("should answer 409 while another operation is queued", async () => {
      const authHeader = await loginAs(testUser, ["user", "deployer"]);
      await request(server).post("/api/admin/deployments/deploy").set(authHeader).send({ tag: "0.0.3" });

      const response = await request(server).post("/api/admin/deployments/deploy").set(authHeader).send({ tag: "0.0.2" });

      expect(response.status).toBe(409);
      expect(response.text).toBe("Another docker operation is still queued or running");
    });

    it("should take a revoked role deployer into account with the next request", async () => {
      const authHeader = await loginAs(testUser, ["user", "deployer"]);
      await db.delete(userRoles).where(eq(userRoles.userId, testUser.userId));

      const response = await request(server).post("/api/admin/deployments/deploy").set(authHeader).send({ tag: "0.0.3" });

      expect(response.status).toBe(403);
    });
  });

  describe("POST /api/admin/deployments/pull", () => {
    it("should queue a pull", async () => {
      const response = await request(server)
        .post("/api/admin/deployments/pull")
        .set(await loginAs(testUser, ["user", "deployer"]))
        .send({ tag: "0.0.2" });

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ action: "pull", targetTag: "0.0.2", status: "queued" });
    });
  });

  describe("POST /api/admin/deployments/restart", () => {
    it("should queue a restart without a body", async () => {
      const response = await request(server)
        .post("/api/admin/deployments/restart")
        .set(await loginAs(testUser, ["user", "deployer"]));

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ action: "restart", targetTag: null, status: "queued" });
    });
  });

  describe("permissions of the operations", () => {
    it.each([
      ["pull", { tag: "0.0.3" }],
      ["deploy", { tag: "0.0.3" }],
      ["restart", undefined],
    ])("should not let a user with the status permission only %s", async (action, body) => {
      await authorizationService.assignRoleToUser(testUser.userId, "observer");
      const authHeader = await createAuthHeader(testUser);

      const response = await request(server).post(`/api/admin/deployments/${action}`).set(authHeader).send(body);

      expect(response.status).toBe(403);
      expect(response.text).toBe(`Missing permissions: admin:docker:${action}`);
    });

    it("should let a user with the status permission only read", async () => {
      await authorizationService.assignRoleToUser(testUser.userId, "observer");

      const response = await request(server).get("/api/admin/deployments").set(await createAuthHeader(testUser));

      expect(response.status).toBe(200);
    });

    it("should answer 401 without a token", async () => {
      const response = await request(server).post("/api/admin/deployments/restart");

      expect(response.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/admin/deployments
  // ---------------------------------------------------------------------------
  describe("GET /api/admin/deployments", () => {
    it("should list the newest operation first and leave the output out", async () => {
      const older = await finishedDeployment();
      const newer = await finishedDeployment();

      const response = await request(server).get("/api/admin/deployments").set(await loginAs(testUser, ["user", "deployer"]));

      expect(response.status).toBe(200);
      expect(response.body.map((entry: { deploymentId: string }) => entry.deploymentId)).toEqual([
        newer.deploymentId,
        older.deploymentId,
      ]);
      expect(response.body[0]).not.toHaveProperty("output");
      expect(response.body[0]).not.toHaveProperty("sequence");
    });

    it("should limit the list", async () => {
      await finishedDeployment();
      await finishedDeployment();
      await finishedDeployment();

      const response = await request(server)
        .get("/api/admin/deployments?limit=2")
        .set(await loginAs(testUser, ["user", "deployer"]));

      expect(response.body).toHaveLength(2);
    });

    it.each(["0", "101", "abc", "1.5"])("should answer 400 for the limit %s", async (limit) => {
      const response = await request(server)
        .get(`/api/admin/deployments?limit=${limit}`)
        .set(await loginAs(testUser, ["user", "deployer"]));

      expect(response.status).toBe(400);
    });

    it("should reject an admin without the role deployer", async () => {
      const response = await request(server).get("/api/admin/deployments").set(await loginAs(testUser, ["admin"]));

      expect(response.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/admin/deployments/:deploymentId
  // ---------------------------------------------------------------------------
  describe("GET /api/admin/deployments/:deploymentId", () => {
    it("should return one operation including its output", async () => {
      const deployment = await finishedDeployment("container todo-api-api-1 restarted");

      const response = await request(server)
        .get(`/api/admin/deployments/${deployment.deploymentId}`)
        .set(await loginAs(testUser, ["user", "deployer"]));

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        deploymentId: deployment.deploymentId,
        status: "succeeded",
        output: "container todo-api-api-1 restarted",
      });
    });

    it("should answer 404 for an unknown operation", async () => {
      const response = await request(server)
        .get(`/api/admin/deployments/${NON_EXISTENT_UUID}`)
        .set(await loginAs(testUser, ["user", "deployer"]));

      expect(response.status).toBe(404);
    });

    it("should answer 400 for an id that is no uuid", async () => {
      const response = await request(server)
        .get("/api/admin/deployments/not-a-uuid")
        .set(await loginAs(testUser, ["user", "deployer"]));

      expect(response.status).toBe(400);
    });

    it("should check the permission before the id, so nothing is told to others", async () => {
      const response = await request(server).get("/api/admin/deployments/not-a-uuid").set(await loginAs(testUser, ["admin"]));

      expect(response.status).toBe(403);
    });
  });
});
