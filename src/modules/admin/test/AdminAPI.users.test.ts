import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { AdminAPI } from "@modules/admin/AdminAPI";
import { UserAPI } from "@modules/users/UserAPI";
import AuthorizationService from "@modules/authorization/AuthorizationService";
import { getPermissionsForRoles, type UserRole } from "@modules/authorization/permissions";
import { createAuthHeader, generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";
import { getTestServer } from "@tests/integration.setup";
import type { User } from "@/db/schema";

describe("AdminAPI users and roles", () => {
  const authorizationService = new AuthorizationService();
  let server: Server;
  let admin: User;
  let other: User;

  async function grant(user: User, roles: UserRole[]) {
    for (const role of roles) await authorizationService.assignRoleToUser(user.userId, role);
  }

  async function loginAs(user: User, roles: UserRole[]) {
    await grant(user, roles);
    return createAuthHeader(user, { roles });
  }

  const rolesOf = async (user: User) => (await authorizationService.getStoredAuthorization(user.userId))!.roles.sort();

  beforeAll(() => {
    new AdminAPI();
    new UserAPI();
    server = getTestServer();
  });

  beforeEach(async () => {
    admin = await generateUser({ username: "aaa-admin", firstName: "Ada" });
    other = await generateUser({ username: "zzz-other" });
    await grant(other, ["user"]);
  });

  // ---------------------------------------------------------------------------
  // GET /api/admin/users
  // ---------------------------------------------------------------------------
  describe("GET /api/admin/users", () => {
    it("should list all users with roles and permissions, ordered by username", async () => {
      const response = await request(server).get("/api/admin/users").set(await loginAs(admin, ["user", "admin"]));

      expect(response.status).toBe(200);
      expect(response.body.map((user: { username: string }) => user.username)).toEqual(["aaa-admin", "zzz-other"]);
      expect(response.body[0]).toMatchObject({
        userId: admin.userId,
        email: admin.email,
        username: "aaa-admin",
        firstName: "Ada",
        lastName: null,
        roles: ["admin", "user"],
      });
      expect(response.body[0].permissions).toEqual([...getPermissionsForRoles(["user", "admin"])].sort());
      expect(response.body[1].roles).toEqual(["user"]);
    });

    it("should not return secrets of the users", async () => {
      const response = await request(server).get("/api/admin/users").set(await loginAs(admin, ["admin"]));

      expect(Object.keys(response.body[0]).sort()).toEqual(
        ["createdAt", "email", "firstName", "lastName", "permissions", "roles", "updatedAt", "userId", "username"].sort(),
      );
    });

    it("should reject a deployer without the role admin", async () => {
      const response = await request(server).get("/api/admin/users").set(await loginAs(admin, ["user", "deployer"]));

      expect(response.status).toBe(403);
    });

    it("should reject a normal user", async () => {
      const response = await request(server).get("/api/admin/users").set(await loginAs(admin, ["user"]));

      expect(response.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/admin/roles
  // ---------------------------------------------------------------------------
  describe("GET /api/admin/roles", () => {
    it("should list the roles with the permissions they grant", async () => {
      const response = await request(server).get("/api/admin/roles").set(await loginAs(admin, ["admin"]));

      expect(response.status).toBe(200);
      const byName = Object.fromEntries(response.body.map((role: { name: string }) => [role.name, role]));
      for (const role of ["user", "admin", "deployer"] as const) {
        expect(byName[role].permissions).toEqual([...getPermissionsForRoles([role])].sort());
      }
    });
  });

  // ---------------------------------------------------------------------------
  // PUT /api/admin/users/:userId/roles
  // ---------------------------------------------------------------------------
  describe("PUT /api/admin/users/:userId/roles", () => {
    const put = (userId: string) => request(server).put(`/api/admin/users/${userId}/roles`);

    it("should replace the roles and answer with the new roles and permissions", async () => {
      const response = await put(other.userId)
        .set(await loginAs(admin, ["user", "admin"]))
        .send({ roles: ["user", "admin"] });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ userId: other.userId, roles: ["admin", "user"] });
      expect(response.body.permissions).toContain("admin:all");
      expect(await rolesOf(other)).toEqual(["admin", "user"]);
    });

    it("should remove roles that are not in the list", async () => {
      await grant(other, ["admin"]);

      const response = await put(other.userId)
        .set(await loginAs(admin, ["admin"]))
        .send({ roles: ["user"] });

      expect(response.status).toBe(200);
      expect(await rolesOf(other)).toEqual(["user"]);
    });

    it("should ignore duplicates", async () => {
      const response = await put(other.userId)
        .set(await loginAs(admin, ["admin"]))
        .send({ roles: ["user", "user"] });

      expect(response.status).toBe(200);
      expect(response.body.roles).toEqual(["user"]);
    });

    it("should take effect in the admin area immediately", async () => {
      const header = await createAuthHeader(other, { roles: ["user"] });
      await put(other.userId)
        .set(await loginAs(admin, ["admin"]))
        .send({ roles: ["user", "admin"] });

      // the token still says "user", the admin area checks the database
      const response = await request(server).get("/api/admin/users").set(header);

      expect(response.status).toBe(200);
    });

    it.each([
      ["an empty list", { roles: [] }],
      ["a missing list", {}],
      ["an invalid role name", { roles: ["Admin!"] }],
      ["unknown fields", { roles: ["user"], permissions: ["admin:all"] }],
    ])("should answer 400 for %s", async (_name, body) => {
      const response = await put(other.userId)
        .set(await loginAs(admin, ["admin"]))
        .send(body);

      expect(response.status).toBe(400);
      expect(await rolesOf(other)).toEqual(["user"]);
    });

    it("should answer 400 for a role that does not exist and change nothing", async () => {
      const response = await put(other.userId)
        .set(await loginAs(admin, ["admin"]))
        .send({ roles: ["user", "superuser"] });

      expect(response.status).toBe(400);
      expect(response.text).toBe("Unknown role: superuser");
      expect(await rolesOf(other)).toEqual(["user"]);
    });

    it("should answer 404 for an unknown user", async () => {
      const response = await put(NON_EXISTENT_UUID)
        .set(await loginAs(admin, ["admin"]))
        .send({ roles: ["user"] });

      expect(response.status).toBe(404);
    });

    it("should answer 400 for an invalid user id", async () => {
      const response = await put("not-a-uuid")
        .set(await loginAs(admin, ["admin"]))
        .send({ roles: ["user"] });

      expect(response.status).toBe(400);
    });

    it("should reject a normal user", async () => {
      const response = await put(other.userId)
        .set(await loginAs(admin, ["user"]))
        .send({ roles: ["user", "admin"] });

      expect(response.status).toBe(403);
      expect(await rolesOf(other)).toEqual(["user"]);
    });

    describe("role deployer", () => {
      it("should not let an admin without the role deployer grant it, not even to themselves", async () => {
        const header = await loginAs(admin, ["user", "admin"]);

        for (const user of [other, admin]) {
          const response = await put(user.userId)
            .set(header)
            .send({ roles: ["user", "admin", "deployer"].filter((role) => role !== "admin" || user === admin) });

          expect(response.status).toBe(403);
          // the rule itself stays in the log, the client gets the generic text
          expect(response.text).toBe("Insufficient Permissions!");
        }
        expect(await rolesOf(other)).toEqual(["user"]);
        expect(await rolesOf(admin)).toEqual(["admin", "user"]);
      });

      it("should not let an admin without the role deployer revoke it", async () => {
        await grant(other, ["deployer"]);

        const response = await put(other.userId)
          .set(await loginAs(admin, ["admin"]))
          .send({ roles: ["user"] });

        expect(response.status).toBe(403);
        expect(await rolesOf(other)).toEqual(["deployer", "user"]);
      });

      it("should let an admin without the role deployer change other roles of a deployer", async () => {
        await grant(other, ["deployer"]);

        const response = await put(other.userId)
          .set(await loginAs(admin, ["admin"]))
          .send({ roles: ["user", "admin", "deployer"] });

        expect(response.status).toBe(200);
        expect(await rolesOf(other)).toEqual(["admin", "deployer", "user"]);
      });

      it("should let an admin who is a deployer grant and revoke it", async () => {
        const header = await loginAs(admin, ["admin", "deployer"]);

        expect((await put(other.userId).set(header).send({ roles: ["user", "deployer"] })).status).toBe(200);
        expect(await rolesOf(other)).toEqual(["deployer", "user"]);
        expect((await put(other.userId).set(header).send({ roles: ["user"] })).status).toBe(200);
        expect(await rolesOf(other)).toEqual(["user"]);
      });
    });

    describe("role admin", () => {
      it("should not let an admin remove their own role admin", async () => {
        await grant(other, ["admin"]);

        const response = await put(admin.userId)
          .set(await loginAs(admin, ["user", "admin"]))
          .send({ roles: ["user"] });

        expect(response.status).toBe(409);
        expect(response.text).toBe("You cannot remove your own role admin");
        expect(await rolesOf(admin)).toEqual(["admin", "user"]);
      });

      it("should let an admin change their own other roles", async () => {
        const response = await put(admin.userId)
          .set(await loginAs(admin, ["user", "admin"]))
          .send({ roles: ["admin"] });

        expect(response.status).toBe(200);
        expect(await rolesOf(admin)).toEqual(["admin"]);
      });

      it("should let an admin remove the role admin of another admin", async () => {
        await grant(other, ["admin"]);

        const response = await put(other.userId)
          .set(await loginAs(admin, ["admin"]))
          .send({ roles: ["user"] });

        expect(response.status).toBe(200);
        expect(await rolesOf(other)).toEqual(["user"]);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // profile of another user, through the existing user routes
  // ---------------------------------------------------------------------------
  describe("PATCH /api/users/:userId as admin", () => {
    it("should let an admin change names and e-mail of another user", async () => {
      const response = await request(server)
        .patch(`/api/users/${other.userId}`)
        .set(await loginAs(admin, ["admin"]))
        .send({ updates: { firstName: "Otto", lastName: "Other", email: "otto@test.com" } });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ firstName: "Otto", lastName: "Other", email: "otto@test.com" });
    });

    it("should answer 409 for an e-mail that is taken", async () => {
      const response = await request(server)
        .patch(`/api/users/${other.userId}`)
        .set(await loginAs(admin, ["admin"]))
        .send({ updates: { email: admin.email } });

      expect(response.status).toBe(409);
    });
  });
});
