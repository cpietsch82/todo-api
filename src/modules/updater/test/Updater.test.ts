import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/db";
import { deployments } from "@modules/admin/schema/deployment.schema";
import DeploymentService from "@modules/admin/DeploymentService";
import { DockerCompose } from "@modules/updater/DockerCompose";
import { DeployEnvFile } from "@modules/updater/DeployEnvFile";
import { Updater, type UpdaterConfig } from "@modules/updater/Updater";
import { generateUser } from "@tests/test.helpers";
import type { User } from "@/db/schema";
import { FakeDocker } from "./FakeDocker";
// registers the database cleanup hooks (deployments and users are removed after each test)
import "@tests/integration.setup";

const CONFIG: UpdaterConfig = {
  pollIntervalMs: 10,
  healthTimeoutMs: 300,
  healthCheckIntervalMs: 10,
  noHealthcheckGraceMs: 0,
};

describe("Updater", () => {
  const deploymentService = new DeploymentService();
  let testUser: User;
  let projectDir: string;
  let deployEnv: DeployEnvFile;
  let docker: FakeDocker;
  let updater: Updater;

  /** queues an operation like the admin api does and lets the updater execute it */
  async function run(action: "pull" | "deploy" | "restart", targetTag?: string) {
    await deploymentService.requestDeployment({ action, targetTag, requestedBy: testUser.userId });
    return updater.processNext();
  }

  beforeEach(async () => {
    testUser = await generateUser();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-api-updater-"));
    fs.writeFileSync(path.join(projectDir, "deploy.env"), "API_IMAGE_TAG=0.0.1\nUPDATER_IMAGE_TAG=0.0.4\n");
    deployEnv = new DeployEnvFile(path.join(projectDir, "deploy.env"));
    docker = new FakeDocker("0.0.1");
    updater = new Updater(
      deploymentService,
      new DockerCompose(docker, { projectDir, commandTimeoutMs: 1000 }),
      deployEnv,
      CONFIG,
    );
  });

  afterEach(async () => {
    await updater.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("should do nothing when nothing is queued", async () => {
    expect(await updater.processNext()).toBeUndefined();
    expect(docker.calls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // pull
  // ---------------------------------------------------------------------------
  describe("pull", () => {
    it("should pull the image without touching the running container or deploy.env", async () => {
      const result = await run("pull", "0.0.3");

      expect(result).toMatchObject({ status: "succeeded", error: null });
      expect(docker.composeCommands()).toEqual(["pull api"]);
      expect(docker.calls[0].apiTag).toBe("0.0.3");
      expect(docker.runningTag).toBe("0.0.1");
      expect(await deployEnv.readApiTag()).toBe("0.0.1");
      expect(result?.output).toContain("pulled 0.0.3");
    });

    it("should fail with the reason when the image does not exist", async () => {
      docker.missingTags.add("9.9.9");

      const result = await run("pull", "9.9.9");

      expect(result?.status).toBe("failed");
      // short and readable: the command without the long project paths, then the reason
      expect(result?.error).toBe("docker compose pull api failed with exit code 1: manifest for todo-api:9.9.9 not found");
      // the full command line is still in the output
      expect(result?.output).toContain("--env-file");
    });
  });

  // ---------------------------------------------------------------------------
  // deploy
  // ---------------------------------------------------------------------------
  describe("deploy", () => {
    it("should pull, store the new tag, start only the api and wait until it is healthy", async () => {
      const result = await run("deploy", "0.0.3");

      expect(result).toMatchObject({ status: "succeeded", previousTag: "0.0.1", error: null });
      expect(docker.composeCommands()).toEqual(["pull api", "up -d --no-deps api"]);
      expect(docker.runningTag).toBe("0.0.3");
      expect(await deployEnv.readApiTag()).toBe("0.0.3");
      expect(result?.output).toContain("Health of the api container: healthy");
    });

    it("should keep the other lines of deploy.env, especially the version of the updater", async () => {
      await run("deploy", "0.0.3");

      expect(fs.readFileSync(deployEnv.path, "utf8")).toBe("API_IMAGE_TAG=0.0.3\nUPDATER_IMAGE_TAG=0.0.4\n");
    });

    it("should not touch the running api when the pull fails", async () => {
      docker.missingTags.add("9.9.9");

      const result = await run("deploy", "9.9.9");

      expect(result).toMatchObject({ status: "failed", previousTag: "0.0.1" });
      expect(docker.composeCommands()).toEqual(["pull api"]);
      expect(docker.runningTag).toBe("0.0.1");
      expect(await deployEnv.readApiTag()).toBe("0.0.1");
    });

    it("should roll back to the previous version when the new one becomes unhealthy", async () => {
      docker.unhealthyTags.add("0.0.3");

      const result = await run("deploy", "0.0.3");

      expect(result).toMatchObject({ status: "rolled_back", previousTag: "0.0.1" });
      expect(result?.error).toBe("0.0.3 did not become healthy: the container is unhealthy");
      expect(docker.composeCommands()).toEqual(["pull api", "up -d --no-deps api", "up -d --no-deps api"]);
      expect(docker.calls.filter((call) => call.args.includes("up")).map((call) => call.apiTag)).toEqual(["0.0.3", "0.0.1"]);
      expect(docker.runningTag).toBe("0.0.1");
      expect(await deployEnv.readApiTag()).toBe("0.0.1");
      expect(result?.output).toContain("Rolling back to 0.0.1");
    });

    it("should roll back when the new container stops right after the start", async () => {
      docker.crashingTags.add("0.0.3");

      const result = await run("deploy", "0.0.3");

      expect(result?.status).toBe("rolled_back");
      expect(result?.error).toContain("the container stopped");
    });

    it("should fail and say so when the rollback does not become healthy either", async () => {
      docker.unhealthyTags.add("0.0.3");
      docker.unhealthyTags.add("0.0.1");

      const result = await run("deploy", "0.0.3");

      expect(result?.status).toBe("failed");
      expect(result?.error).toBe(
        "0.0.3 did not become healthy: the container is unhealthy. The rollback to 0.0.1 failed as well: the container is unhealthy",
      );
    });

    it("should fail without a rollback when there was no previous version", async () => {
      fs.writeFileSync(deployEnv.path, "UPDATER_IMAGE_TAG=0.0.4\n");
      docker.unhealthyTags.add("0.0.3");

      const result = await run("deploy", "0.0.3");

      expect(result?.status).toBe("failed");
      expect(result?.error).toContain("There is no previous version to roll back to");
      expect(docker.composeCommands()).toEqual(["pull api", "up -d --no-deps api"]);
    });

    it("should count an image without a healthcheck as healthy once it runs", async () => {
      docker.withoutHealthcheck.add("0.0.3");

      const result = await run("deploy", "0.0.3");

      expect(result?.status).toBe("succeeded");
      expect(result?.output).toContain("the image has no healthcheck");
    });

    it("should give up waiting after the health timeout", async () => {
      // stays "starting" forever
      vi.spyOn(DockerCompose.prototype, "getApiState").mockResolvedValue({ Status: "running", Health: { Status: "starting" } });

      const result = await run("deploy", "0.0.3");

      expect(result?.status).toBe("failed");
      expect(result?.error).toContain("not healthy within 0s (last state: running, starting)");
      vi.restoreAllMocks();
    });

    it("should refuse a tag that was written to the database without the service", async () => {
      await db.insert(deployments).values({ action: "deploy", targetTag: "latest; docker rm -f todo-database" });

      const result = await updater.processNext();

      expect(result?.status).toBe("failed");
      expect(result?.error).toContain("Invalid tag");
      expect(docker.calls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // restart
  // ---------------------------------------------------------------------------
  describe("restart", () => {
    it("should restart only the api and wait until it is healthy", async () => {
      const result = await run("restart");

      expect(result?.status).toBe("succeeded");
      expect(docker.composeCommands()).toEqual(["restart api"]);
      expect(docker.calls[0].apiTag).toBeUndefined();
    });

    it("should fail when the restart command fails", async () => {
      docker.failRestart = true;

      const result = await run("restart");

      expect(result?.status).toBe("failed");
      expect(result?.error).toContain("restart failed");
    });

    it("should fail when the api is unhealthy after the restart", async () => {
      docker.unhealthyTags.add("0.0.1");

      const result = await run("restart");

      expect(result?.status).toBe("failed");
      expect(result?.error).toBe("The api did not become healthy after the restart: the container is unhealthy");
    });
  });

  // ---------------------------------------------------------------------------
  // robustness
  // ---------------------------------------------------------------------------
  describe("robustness", () => {
    it("should finish the operation as failed when something unexpected breaks", async () => {
      fs.rmSync(projectDir, { recursive: true, force: true });

      const result = await run("deploy", "0.0.3");

      expect(result?.status).toBe("failed");
      expect(result?.error).toBeTruthy();
      // the next operation is not blocked
      await expect(deploymentService.requestDeployment({ action: "restart", requestedBy: testUser.userId })).resolves.toBeDefined();
    });

    it("should mark operations that were interrupted by a stop of the updater as failed", async () => {
      await deploymentService.requestDeployment({ action: "restart", requestedBy: testUser.userId });
      const interrupted = await deploymentService.claimNextDeployment();

      expect(await updater.recoverInterruptedOperations()).toBe(1);

      const stored = await deploymentService.getDeployment(interrupted!.deploymentId);
      expect(stored?.status).toBe("failed");
      expect(stored?.error).toContain("The updater was stopped");
      expect(await deploymentService.getActiveDeployment()).toBeUndefined();
    });

    it("should wait at the start until the table deployments exists", async () => {
      // e.g. the first start of the stack: the api has not run the migrations yet
      const recover = vi
        .spyOn(deploymentService, "failInterruptedDeployments")
        .mockRejectedValueOnce(new Error('relation "deployments" does not exist'))
        .mockRejectedValueOnce(new Error('relation "deployments" does not exist'))
        .mockResolvedValue(0);

      await updater.prepare({ attempts: 5, delayMs: 1 });

      expect(recover).toHaveBeenCalledTimes(3);
      vi.restoreAllMocks();
    });

    it("should give up after the last attempt", async () => {
      vi.spyOn(deploymentService, "failInterruptedDeployments").mockRejectedValue(new Error("database gone"));

      await expect(updater.prepare({ attempts: 3, delayMs: 1 })).rejects.toThrow("database gone");
      vi.restoreAllMocks();
    });

    it("should not touch queued operations when recovering", async () => {
      await deploymentService.requestDeployment({ action: "restart", requestedBy: testUser.userId });

      expect(await updater.recoverInterruptedOperations()).toBe(0);
      expect((await deploymentService.getActiveDeployment())?.status).toBe("queued");
    });

    it("should pick up queued operations by itself after start() and stop cleanly", async () => {
      updater.start();
      const queued = await deploymentService.requestDeployment({ action: "pull", targetTag: "0.0.3", requestedBy: testUser.userId });

      await vi.waitFor(async () => expect((await deploymentService.getDeployment(queued.deploymentId))?.status).toBe("succeeded"), {
        timeout: 3000,
      });
      await updater.stop();

      // nothing is processed after the stop
      const afterStop = await deploymentService.requestDeployment({ action: "restart", requestedBy: testUser.userId });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await deploymentService.getDeployment(afterStop.deploymentId))?.status).toBe("queued");
    });
  });
});
