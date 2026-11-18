import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { containerLogRequests, containerStatus } from "@modules/admin/schema/container.schema";
import ContainerService, { LOG_REQUEST_RETENTION_MS, STATUS_STALE_AFTER_MS } from "@modules/admin/ContainerService";
import { generateUser } from "@tests/test.helpers";
import type { User } from "@/db/schema";
// registers the database cleanup hooks
import "@tests/integration.setup";

const POSTGRES = {
  service: "postgres",
  containerName: "todo-database",
  image: "postgres:16-alpine",
  state: "running",
  health: "healthy",
  statusText: "Up 2 hours (healthy)",
  exitCode: 0,
};

describe("ContainerService", () => {
  const service = new ContainerService();
  const originalWait = service.logWaitMs;
  let testUser: User;

  beforeEach(async () => {
    testUser = await generateUser();
    service.logWaitMs = 500;
  });

  afterEach(() => {
    service.logWaitMs = originalWait;
  });

  // ---------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------
  describe("status", () => {
    it("should report no containers and stale when the updater never reported", async () => {
      expect(await service.getStatus()).toEqual({ updatedAt: undefined, stale: true, containers: [] });
    });

    it("should return the snapshot sorted by service and not stale while it is fresh", async () => {
      await service.replaceStatus([{ ...POSTGRES, service: "updater", containerName: "todo-updater" }, POSTGRES]);

      const status = await service.getStatus();

      expect(status.stale).toBe(false);
      expect(status.containers.map((container) => container.service)).toEqual(["postgres", "updater"]);
    });

    it("should mark the snapshot as stale when the updater did not refresh it for a while", async () => {
      await service.replaceStatus([POSTGRES]);
      const later = new Date(Date.now() + STATUS_STALE_AFTER_MS + 1000);

      expect((await service.getStatus(later)).stale).toBe(true);
    });

    it("should know only the services of the snapshot", async () => {
      await service.replaceStatus([POSTGRES]);

      expect(await service.isKnownService("postgres")).toBe(true);
      expect(await service.isKnownService("api")).toBe(false);
    });

    it("should clear the snapshot when there are no containers", async () => {
      await service.replaceStatus([POSTGRES]);
      await service.replaceStatus([]);

      expect(await db.select().from(containerStatus)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // logs
  // ---------------------------------------------------------------------------
  describe("log requests", () => {
    it.each([
      ["an invalid service", { service: "api; docker ps", tail: 10 }],
      ["an upper case service", { service: "API", tail: 10 }],
      ["a tail of 0", { service: "api", tail: 0 }],
      ["a tail above 1000", { service: "api", tail: 1001 }],
    ])("should refuse %s", async (_name, request) => {
      await expect(service.requestLogs({ ...request, requestedBy: testUser.userId })).rejects.toThrow();
    });

    it("should hand a request to the updater exactly once", async () => {
      const request = await service.requestLogs({ service: "api", tail: 10, requestedBy: testUser.userId });

      const [first, second] = await Promise.all([service.claimNextLogRequest(), service.claimNextLogRequest()]);

      expect([first, second].filter(Boolean).map((claimed) => claimed!.logRequestId)).toEqual([request.logRequestId]);
      expect(await service.claimNextLogRequest()).toBeUndefined();
    });

    it("should return the answer as soon as the updater stored it", async () => {
      const request = await service.requestLogs({ service: "api", tail: 10, requestedBy: testUser.userId });
      setTimeout(() => void service.answerLogRequest(request.logRequestId, { output: "line 1\nline 2" }), 50);

      const answer = await service.waitForLogs(request.logRequestId, 10);

      expect(answer).toMatchObject({ status: "done", output: "line 1\nline 2", error: null });
    });

    it("should return a failed answer with its reason", async () => {
      const request = await service.requestLogs({ service: "api", tail: 10, requestedBy: testUser.userId });
      await service.answerLogRequest(request.logRequestId, { error: "no such service" });

      expect(await service.waitForLogs(request.logRequestId, 10)).toMatchObject({ status: "failed", error: "no such service" });
    });

    it("should give up when the updater does not answer in time", async () => {
      service.logWaitMs = 100;
      const request = await service.requestLogs({ service: "api", tail: 10, requestedBy: testUser.userId });

      expect(await service.waitForLogs(request.logRequestId, 10)).toBeUndefined();
    });

    it("should not change an answer that is already stored", async () => {
      const request = await service.requestLogs({ service: "api", tail: 10, requestedBy: testUser.userId });
      await service.answerLogRequest(request.logRequestId, { output: "first" });
      await service.answerLogRequest(request.logRequestId, { error: "second" });

      expect((await service.waitForLogs(request.logRequestId, 10))?.output).toBe("first");
    });

    it("should remove old requests nobody read", async () => {
      const old = await service.requestLogs({ service: "api", tail: 10, requestedBy: testUser.userId });
      const fresh = await service.requestLogs({ service: "api", tail: 10, requestedBy: testUser.userId });
      await db
        .update(containerLogRequests)
        .set({ createdAt: new Date(Date.now() - LOG_REQUEST_RETENTION_MS - 1000) })
        .where(eq(containerLogRequests.logRequestId, old.logRequestId));

      expect(await service.deleteOldLogRequests()).toBe(1);

      const left = await db.select().from(containerLogRequests);
      expect(left.map((request) => request.logRequestId)).toEqual([fresh.logRequestId]);
    });
  });
});
