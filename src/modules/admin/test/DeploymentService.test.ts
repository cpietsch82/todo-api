import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { deployments } from "@modules/admin/schema/deployment.schema";
import DeploymentService, { MAX_OUTPUT_LENGTH, trimOutput } from "@modules/admin/DeploymentService";
import { HttpError } from "@/utils/HttpError";
import { getPgErrorCode } from "@/utils/dbErrors";
import { generateUser, NON_EXISTENT_UUID } from "@tests/test.helpers";
import type { User } from "@/db/schema";
// registers the database cleanup hooks (deployments and users are removed after each test)
import "@tests/integration.setup";

/** catches the error of a promise, so its status and message can be checked */
async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to fail");
}

describe("DeploymentService", () => {
  const service = new DeploymentService();
  let testUser: User;

  beforeEach(async () => {
    testUser = await generateUser();
  });

  // ---------------------------------------------------------------------------
  // requestDeployment
  // ---------------------------------------------------------------------------
  describe("requestDeployment", () => {
    it.each(["deploy", "pull"] as const)("should queue a %s with its tag and requester", async (action) => {
      const deployment = await service.requestDeployment({ action, targetTag: "0.0.3", requestedBy: testUser.userId });

      expect(deployment).toMatchObject({
        action,
        status: "queued",
        targetTag: "0.0.3",
        requestedBy: testUser.userId,
        previousTag: null,
        startedAt: null,
        finishedAt: null,
      });
    });

    it("should queue a restart without a tag", async () => {
      const deployment = await service.requestDeployment({ action: "restart", requestedBy: testUser.userId });

      expect(deployment).toMatchObject({ action: "restart", status: "queued", targetTag: null });
    });

    it.each([
      ["no tag", undefined],
      ["latest", "latest"],
      ["dev", "dev"],
      ["a v prefix", "v1.2.3"],
      ["two parts", "1.2"],
      ["a pre-release", "1.2.3-beta"],
      ["a shell command", "1.2.3; docker rm -f todo-database"],
      ["an empty string", ""],
    ])("should reject a deploy with %s as tag", async (_name, targetTag) => {
      const error = await errorOf(service.requestDeployment({ action: "deploy", targetTag, requestedBy: testUser.userId }));

      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect(await db.select().from(deployments)).toHaveLength(0);
    });

    it("should reject a restart with a tag", async () => {
      const error = await errorOf(
        service.requestDeployment({ action: "restart", targetTag: "0.0.3", requestedBy: testUser.userId }),
      );

      expect((error as HttpError).status).toBe(400);
    });

    it("should answer 409 while another operation is queued", async () => {
      await service.requestDeployment({ action: "pull", targetTag: "0.0.3", requestedBy: testUser.userId });

      const error = await errorOf(service.requestDeployment({ action: "restart", requestedBy: testUser.userId }));

      expect((error as HttpError).status).toBe(409);
      expect((error as HttpError).message).toBe("Another docker operation is still queued or running");
    });

    it("should answer 409 while another operation is running", async () => {
      await service.requestDeployment({ action: "pull", targetTag: "0.0.3", requestedBy: testUser.userId });
      await service.claimNextDeployment();

      const error = await errorOf(service.requestDeployment({ action: "restart", requestedBy: testUser.userId }));

      expect((error as HttpError).status).toBe(409);
    });

    it("should only accept one of several parallel requests", async () => {
      const results = await Promise.allSettled(
        ["0.0.1", "0.0.2", "0.0.3"].map((targetTag) =>
          service.requestDeployment({ action: "deploy", targetTag, requestedBy: testUser.userId }),
        ),
      );

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await db.select().from(deployments)).toHaveLength(1);
    });

    it("should accept a new operation once the previous one is finished", async () => {
      const first = await service.requestDeployment({ action: "pull", targetTag: "0.0.3", requestedBy: testUser.userId });
      await service.claimNextDeployment();
      await service.finishDeployment(first.deploymentId, { status: "failed", error: "image not found" });

      await expect(service.requestDeployment({ action: "restart", requestedBy: testUser.userId })).resolves.toBeDefined();
    });

    it("should fail for a requester that does not exist", async () => {
      await expect(service.requestDeployment({ action: "restart", requestedBy: NON_EXISTENT_UUID })).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // reading
  // ---------------------------------------------------------------------------
  describe("reading", () => {
    /** finished operations, oldest first */
    async function createHistory(count: number) {
      const created = [];
      for (let i = 0; i < count; i++) {
        const deployment = await service.requestDeployment({ action: "restart", requestedBy: testUser.userId });
        await service.claimNextDeployment();
        created.push(await service.finishDeployment(deployment.deploymentId, { status: "succeeded" }));
      }
      return created;
    }

    it("should list the newest operation first", async () => {
      const created = await createHistory(4);

      const listed = await service.listDeployments();

      expect(listed.map((deployment) => deployment.deploymentId)).toEqual(
        [...created].reverse().map((deployment) => deployment.deploymentId),
      );
    });

    it("should limit the list", async () => {
      const created = await createHistory(3);

      const listed = await service.listDeployments(2);

      expect(listed).toHaveLength(2);
      expect(listed[0].deploymentId).toBe(created[2].deploymentId);
    });

    it("should get an operation by id and return undefined for an unknown id", async () => {
      const deployment = await service.requestDeployment({ action: "restart", requestedBy: testUser.userId });

      expect((await service.getDeployment(deployment.deploymentId))?.action).toBe("restart");
      expect(await service.getDeployment(NON_EXISTENT_UUID)).toBeUndefined();
    });

    it("should return the active operation and nothing when all are finished", async () => {
      expect(await service.getActiveDeployment()).toBeUndefined();

      const deployment = await service.requestDeployment({ action: "restart", requestedBy: testUser.userId });
      expect((await service.getActiveDeployment())?.deploymentId).toBe(deployment.deploymentId);

      await service.claimNextDeployment();
      await service.finishDeployment(deployment.deploymentId, { status: "succeeded" });
      expect(await service.getActiveDeployment()).toBeUndefined();
    });

    it("should keep the history when the requesting user is deleted", async () => {
      const deployment = await service.requestDeployment({ action: "restart", requestedBy: testUser.userId });

      await db.delete(users).where(eq(users.userId, testUser.userId));

      expect((await service.getDeployment(deployment.deploymentId))?.requestedBy).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // used by the updater
  // ---------------------------------------------------------------------------
  describe("claimNextDeployment", () => {
    it("should mark the queued operation as running", async () => {
      const deployment = await service.requestDeployment({ action: "deploy", targetTag: "0.0.3", requestedBy: testUser.userId });

      const claimed = await service.claimNextDeployment();

      expect(claimed?.deploymentId).toBe(deployment.deploymentId);
      expect(claimed?.status).toBe("running");
      expect(claimed?.startedAt).toBeInstanceOf(Date);
    });

    it("should return nothing when nothing is queued", async () => {
      expect(await service.claimNextDeployment()).toBeUndefined();
    });

    it("should not claim a running operation a second time", async () => {
      await service.requestDeployment({ action: "restart", requestedBy: testUser.userId });

      const [first, second] = await Promise.all([service.claimNextDeployment(), service.claimNextDeployment()]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
    });
  });

  describe("finishDeployment", () => {
    it("should store result, previous tag, output and end time", async () => {
      const deployment = await service.requestDeployment({ action: "deploy", targetTag: "0.0.3", requestedBy: testUser.userId });
      await service.claimNextDeployment();

      const finished = await service.finishDeployment(deployment.deploymentId, {
        status: "rolled_back",
        previousTag: "0.0.2",
        output: "pulling ... done",
        error: "0.0.3 did not become healthy",
      });

      expect(finished).toMatchObject({
        status: "rolled_back",
        previousTag: "0.0.2",
        output: "pulling ... done",
        error: "0.0.3 did not become healthy",
      });
      expect(finished.finishedAt).toBeInstanceOf(Date);
    });

    it("should only finish a running operation", async () => {
      const deployment = await service.requestDeployment({ action: "restart", requestedBy: testUser.userId });

      // still queued
      await expect(service.finishDeployment(deployment.deploymentId, { status: "succeeded" })).rejects.toThrow(
        "DEPLOYMENT_NOT_RUNNING",
      );

      await service.claimNextDeployment();
      await service.finishDeployment(deployment.deploymentId, { status: "succeeded" });

      // already finished
      await expect(service.finishDeployment(deployment.deploymentId, { status: "failed" })).rejects.toThrow(
        "DEPLOYMENT_NOT_RUNNING",
      );
    });

    it("should keep only the end of a long output", async () => {
      const deployment = await service.requestDeployment({ action: "restart", requestedBy: testUser.userId });
      await service.claimNextDeployment();
      const output = `start-marker${"x".repeat(MAX_OUTPUT_LENGTH)}end-marker`;

      const finished = await service.finishDeployment(deployment.deploymentId, { status: "succeeded", output });

      expect(finished.output).toContain("end-marker");
      expect(finished.output).not.toContain("start-marker");
      expect(finished.output).toContain("characters cut");
    });
  });

  describe("trimOutput", () => {
    it("should not change a short output or a missing one", () => {
      expect(trimOutput("short")).toBe("short");
      expect(trimOutput(undefined)).toBeUndefined();
      expect(trimOutput("x".repeat(MAX_OUTPUT_LENGTH))).toHaveLength(MAX_OUTPUT_LENGTH);
    });
  });

  // ---------------------------------------------------------------------------
  // rules of the database itself (the migration), also for writes that bypass the service
  // ---------------------------------------------------------------------------
  describe("database rules", () => {
    async function pgCode(promise: Promise<unknown>) {
      return getPgErrorCode(await errorOf(promise));
    }

    it("should not allow two active operations", async () => {
      await db.insert(deployments).values({ action: "restart" });

      expect(await pgCode(db.insert(deployments).values({ action: "restart", status: "running" }))).toBe("23505");
    });

    it("should allow any number of finished operations", async () => {
      await db.insert(deployments).values([
        { action: "restart", status: "succeeded" },
        { action: "restart", status: "failed" },
        { action: "restart", status: "rolled_back" },
      ]);

      expect(await db.select().from(deployments)).toHaveLength(3);
    });

    it.each([
      ["a deploy without a tag", { action: "deploy" as const }],
      ["a pull without a tag", { action: "pull" as const }],
      ["a restart with a tag", { action: "restart" as const, targetTag: "0.0.3" }],
    ])("should reject %s", async (_name, values) => {
      // 23514 = check_violation
      expect(await pgCode(db.insert(deployments).values(values))).toBe("23514");
    });

    it("should give every row a strictly increasing sequence", async () => {
      const rows = await db
        .insert(deployments)
        .values([
          { action: "restart", status: "succeeded" },
          { action: "restart", status: "succeeded" },
        ])
        .returning();

      expect(rows[1].sequence).toBeGreaterThan(rows[0].sequence);
    });
  });
});
