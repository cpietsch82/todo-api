import fs from "node:fs";
import path from "node:path";
import env from "../../../env";
import { logger } from "@/utils/logger";
import { waitForDatabase } from "@/db";
import { DeploymentService } from "@/modules/admin/DeploymentService";
import { ProcessCommandRunner } from "./CommandRunner";
import { COMPOSE_FILE_NAME, DEPLOY_ENV_FILE_NAME, DockerCompose } from "./DockerCompose";
import { DeployEnvFile } from "./DeployEnvFile";
import { Updater } from "./Updater";
import { ContainerReporter } from "./ContainerReporter";
import { ContainerService, LOG_POLL_INTERVAL_MS, STATUS_REFRESH_INTERVAL_MS } from "@/modules/admin/ContainerService";

/**
 * Entry point of the updater container (image todo-api-updater). It executes the docker operations that the admin
 * area of the api queues in the table deployments.
 */
async function main() {
  const projectDir = env.UPDATER_PROJECT_DIR;
  if (!projectDir) throw new Error("UPDATER_PROJECT_DIR is not set");
  for (const file of [COMPOSE_FILE_NAME, DEPLOY_ENV_FILE_NAME]) {
    if (!fs.existsSync(path.join(projectDir, file))) {
      throw new Error(`${file} not found in ${projectDir}, is the project folder mounted at the same path as on the host?`);
    }
  }

  await waitForDatabase();

  const compose = new DockerCompose(new ProcessCommandRunner(), {
    projectDir,
    commandTimeoutMs: env.UPDATER_COMMAND_TIMEOUT_MS,
  });
  const updater = new Updater(
    new DeploymentService(),
    compose,
    new DeployEnvFile(path.join(projectDir, DEPLOY_ENV_FILE_NAME)),
    {
      pollIntervalMs: env.UPDATER_POLL_INTERVAL_MS,
      healthTimeoutMs: env.UPDATER_HEALTH_TIMEOUT_MS,
      healthCheckIntervalMs: 3000,
      noHealthcheckGraceMs: 15_000,
    },
  );

  // up to 5 minutes, then the container restarts (restart: unless-stopped) and tries again
  await updater.prepare({ attempts: 60, delayMs: 5000 });
  updater.start();

  // status and logs of the containers, next to the operations so they also work during a long deploy
  const reporter = new ContainerReporter(new ContainerService(), compose, {
    statusIntervalMs: STATUS_REFRESH_INTERVAL_MS,
    logPollIntervalMs: LOG_POLL_INTERVAL_MS,
  });
  reporter.start();
  logger.info({ projectDir }, "Updater started, waiting for docker operations");

  // a running operation is finished first (docker compose waits up to stop_grace_period of the updater service)
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, the updater stops after the running operation`);
    await Promise.all([updater.stop(), reporter.stop()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "The updater could not start");
  process.exit(1);
});
