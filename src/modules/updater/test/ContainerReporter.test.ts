import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/db";
import { containerLogRequests } from "@modules/admin/schema/container.schema";
import ContainerService from "@modules/admin/ContainerService";
import { DockerCompose, mergeLogStreams, parseComposePs } from "@modules/updater/DockerCompose";
import { ContainerReporter } from "@modules/updater/ContainerReporter";
import { generateUser } from "@tests/test.helpers";
import type { User } from "@/db/schema";
import { FakeDocker } from "./FakeDocker";
// registers the database cleanup hooks
import "@tests/integration.setup";

describe("ContainerReporter", () => {
  const containerService = new ContainerService();
  let docker: FakeDocker;
  let reporter: ContainerReporter;
  let testUser: User;

  beforeEach(async () => {
    testUser = await generateUser();
    docker = new FakeDocker("0.0.3");
    reporter = new ContainerReporter(
      containerService,
      new DockerCompose(docker, { projectDir: "/volume1/docker/todo-api", commandTimeoutMs: 1000 }),
      { statusIntervalMs: 20, logPollIntervalMs: 10 },
    );
  });

  afterEach(async () => {
    await reporter.stop();
  });

  // ---------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------
  describe("refreshStatus", () => {
    it("should store a snapshot of all containers of the compose project", async () => {
      expect(await reporter.refreshStatus()).toBe(2);

      const { containers, stale, updatedAt } = await containerService.getStatus();
      expect(stale).toBe(false);
      expect(updatedAt).toBeInstanceOf(Date);
      expect(containers).toEqual([
        expect.objectContaining({
          service: "postgres",
          containerName: "todo-database",
          image: "postgres:16-alpine",
          state: "running",
          health: "healthy",
          statusText: "Up 2 hours (healthy)",
          exitCode: 0,
        }),
        // no healthcheck: an empty Health becomes null
        expect.objectContaining({ service: "updater", health: null }),
      ]);
    });

    it("should run docker compose ps for the whole project, also stopped containers", async () => {
      await reporter.refreshStatus();

      const [call] = docker.calls;
      expect(call.args.slice(-4)).toEqual(["ps", "--all", "--format", "json"]);
      expect(call.args).toContain("--project-directory");
    });

    it("should replace the snapshot, so a removed container disappears", async () => {
      await reporter.refreshStatus();
      docker.containers = docker.containers.filter((container) => container.Service === "postgres");

      await reporter.refreshStatus();

      expect((await containerService.getStatus()).containers.map((container) => container.service)).toEqual(["postgres"]);
    });

    it("should keep the old snapshot when docker cannot be asked", async () => {
      await reporter.refreshStatus();
      vi.spyOn(DockerCompose.prototype, "listContainers").mockRejectedValueOnce(new Error("Cannot connect to the Docker daemon"));

      await expect(reporter.refreshStatus()).rejects.toThrow("Cannot connect");

      expect((await containerService.getStatus()).containers).toHaveLength(2);
      vi.restoreAllMocks();
    });
  });

  // ---------------------------------------------------------------------------
  // logs
  // ---------------------------------------------------------------------------
  describe("answerNextLogRequest", () => {
    it("should answer with the logs of the service, stdout and stderr in the right order", async () => {
      docker.serviceLogs.postgres = {
        stdout: "2026-11-18T10:00:00.1Z first\n2026-11-18T10:00:00.3Z third\n",
        stderr: "2026-11-18T10:00:00.25Z second\n",
      };
      const request = await containerService.requestLogs({ service: "postgres", tail: 50, requestedBy: testUser.userId });

      await reporter.answerNextLogRequest();

      const answer = await containerService.waitForLogs(request.logRequestId);
      expect(answer?.status).toBe("done");
      expect(answer?.output).toBe(
        "2026-11-18T10:00:00.1Z first\n2026-11-18T10:00:00.25Z second\n2026-11-18T10:00:00.3Z third",
      );
      expect(docker.calls.at(-1)?.args.slice(-7)).toEqual([
        "logs",
        "--no-color",
        "--no-log-prefix",
        "--timestamps",
        "--tail",
        "50",
        "postgres",
      ]);
    });

    it("should answer with the reason when docker does not know the service", async () => {
      const request = await containerService.requestLogs({ service: "nosuchservice", tail: 10, requestedBy: testUser.userId });

      await reporter.answerNextLogRequest();

      const answer = await containerService.waitForLogs(request.logRequestId);
      expect(answer?.status).toBe("failed");
      expect(answer?.error).toBe("docker compose logs --no-color --no-log-prefix --timestamps --tail 10 nosuchservice failed: no such service: nosuchservice");
    });

    it("should refuse a request that was written to the database without the service", async () => {
      await db.insert(containerLogRequests).values({ service: "api; docker ps", tail: 10 });

      const request = await reporter.answerNextLogRequest();

      const answer = await containerService.waitForLogs(request!.logRequestId);
      expect(answer?.status).toBe("failed");
      expect(answer?.error).toContain("Refusing to read the logs");
      expect(docker.calls).toHaveLength(0);
    });

    it("should do nothing when there is no request", async () => {
      expect(await reporter.answerNextLogRequest()).toBeUndefined();
    });
  });

  describe("start / stop", () => {
    it("should refresh the status and answer log requests by itself", async () => {
      docker.serviceLogs.api = { stdout: "2026-11-18T10:00:00Z ready\n", stderr: "" };
      reporter.start();

      const request = await containerService.requestLogs({ service: "api", tail: 10, requestedBy: testUser.userId });
      const answer = await containerService.waitForLogs(request.logRequestId, 10);

      expect(answer?.output).toBe("2026-11-18T10:00:00Z ready");
      await vi.waitFor(async () => expect((await containerService.getStatus()).containers).toHaveLength(2));
    });

    it("should keep running after an error", async () => {
      const listContainers = vi
        .spyOn(DockerCompose.prototype, "listContainers")
        .mockRejectedValueOnce(new Error("temporary failure"));
      reporter.start();

      await vi.waitFor(async () => expect((await containerService.getStatus()).containers).toHaveLength(2), { timeout: 2000 });
      expect(listContainers.mock.calls.length).toBeGreaterThan(1);
      vi.restoreAllMocks();
    });
  });
});

describe("parseComposePs", () => {
  it("should read one JSON object per line", () => {
    expect(parseComposePs('{"Service":"a"}\n{"Service":"b"}\n').map((container) => container.Service)).toEqual(["a", "b"]);
  });

  it("should read the JSON array of older compose versions", () => {
    expect(parseComposePs('[{"Service":"a"},{"Service":"b"}]').map((container) => container.Service)).toEqual(["a", "b"]);
  });

  it("should return nothing for an empty output", () => {
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs("\n")).toEqual([]);
  });
});

describe("mergeLogStreams", () => {
  it("should sort by the timestamp, also when docker cut the trailing zeros of the fraction", () => {
    // as text ".09Z" would come after ".092411883Z", as a time it is earlier
    const merged = mergeLogStreams("2026-11-18T10:00:00.092411883Z later\n", "2026-11-18T10:00:00.09Z earlier\n");

    expect(merged.split("\n")).toEqual(["2026-11-18T10:00:00.09Z earlier", "2026-11-18T10:00:00.092411883Z later"]);
  });

  it("should keep a line without a timestamp behind the line before it", () => {
    const merged = mergeLogStreams(
      "2026-11-18T10:00:01Z error\n    at stack line\n",
      "2026-11-18T10:00:00Z before\n2026-11-18T10:00:02Z after\n",
    );

    expect(merged.split("\n")).toEqual([
      "2026-11-18T10:00:00Z before",
      "2026-11-18T10:00:01Z error",
      "    at stack line",
      "2026-11-18T10:00:02Z after",
    ]);
  });

  it("should keep the order of lines with the same timestamp", () => {
    expect(mergeLogStreams("2026-11-18T10:00:00Z a\n2026-11-18T10:00:00Z b\n", "").split("\n")).toEqual([
      "2026-11-18T10:00:00Z a",
      "2026-11-18T10:00:00Z b",
    ]);
  });
});
