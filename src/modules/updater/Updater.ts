import { logger } from "@/utils/logger";
import { DeploymentService, RELEASE_TAG_PATTERN, type DeploymentResult } from "@/modules/admin/DeploymentService";
import type { Deployment } from "@/modules/admin/schema/deployment.schema";
import { DockerCompose, isSuccess, type CommandStep } from "./DockerCompose";
import type { DeployEnvFile } from "./DeployEnvFile";

export interface UpdaterConfig {
  pollIntervalMs: number;
  /** how long a started api container may take to become healthy */
  healthTimeoutMs: number;
  /** pause between two health checks of the container */
  healthCheckIntervalMs: number;
  /** an image without a healthcheck counts as healthy when it runs this long */
  noHealthcheckGraceMs: number;
}

interface HealthResult {
  healthy: boolean;
  detail: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** collects the output of all commands of one operation, it is stored with the operation */
class Transcript {
  private readonly parts: string[] = [];

  add(step: CommandStep): CommandStep {
    const { exitCode, stdout, stderr, timedOut } = step.result;
    const status = timedOut ? "timed out" : `exit code ${exitCode}`;
    this.parts.push(`$ ${step.command}\n${stdout}${stderr}(${status})`);
    return step;
  }

  note(text: string) {
    this.parts.push(text);
  }

  toString() {
    return this.parts.join("\n\n");
  }
}

/** a short reason of a failed command for the error field */
function describeFailure(step: CommandStep): string {
  const { exitCode, stderr, timedOut } = step.result;
  if (timedOut) return `${step.label} timed out`;
  const lastLine = stderr.trim().split("\n").pop();
  return `${step.label} failed with exit code ${exitCode}${lastLine ? `: ${lastLine}` : ""}`;
}

/**
 * Executes the queued docker operations one after another. Runs in its own container, the only one with access to
 * docker. The api only queues the operations (see DeploymentService) and never talks to docker itself.
 */
export class Updater {
  private running = false;
  private current: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deploymentService: DeploymentService,
    private readonly compose: DockerCompose,
    private readonly deployEnv: DeployEnvFile,
    private readonly config: UpdaterConfig,
  ) {}

  /**
   * Prepares the start: waits until the table deployments exists and marks interrupted operations as failed.
   * The migrations are run by the api container when it starts, so on the first start of the stack (or after an
   * update with a new migration) the table can be missing for a moment. Waiting for the api to be healthy instead
   * would block the updater for good while a broken api version runs, which is exactly when a rollback is needed.
   */
  async prepare({ attempts, delayMs }: { attempts: number; delayMs: number }): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.recoverInterruptedOperations();
        return;
      } catch (error) {
        if (attempt >= attempts) throw error;
        logger.warn(
          { attempt, attempts, reason: error instanceof Error ? error.message.split("\n")[0] : String(error) },
          `The table deployments is not available yet (the api runs the migrations), retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }
  }

  /** marks operations that were interrupted by a stop or crash of the updater as failed */
  async recoverInterruptedOperations(): Promise<number> {
    const count = await this.deploymentService.failInterruptedDeployments();
    if (count > 0) logger.warn({ count }, "Marked interrupted docker operations as failed");
    return count;
  }

  /** looks for queued operations in the configured interval until stop() is called */
  start(): void {
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      this.current = this.processNext()
        .then(() => undefined)
        .catch((error: unknown) => logger.error({ err: error }, "Processing a docker operation failed"));
      await this.current;
      this.current = undefined;
      if (this.running) this.timer = setTimeout(tick, this.config.pollIntervalMs);
    };
    void tick();
  }

  /** stops looking for operations and waits for the one that is running, an operation is never cut off */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.current;
  }

  /**
   * Claims and executes one queued operation.
   * @returns the finished operation, or undefined when nothing was queued
   */
  async processNext(): Promise<Deployment | undefined> {
    const deployment = await this.deploymentService.claimNextDeployment();
    if (!deployment) return undefined;

    logger.info(
      { deploymentId: deployment.deploymentId, action: deployment.action, targetTag: deployment.targetTag },
      "Docker operation started",
    );

    let result: DeploymentResult;
    try {
      result = await this.execute(deployment);
    } catch (error) {
      // an unexpected error (e.g. deploy.env not writable) must still finish the operation, or it blocks all others
      result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }

    return this.deploymentService.finishDeployment(deployment.deploymentId, result);
  }

  private async execute(deployment: Deployment): Promise<DeploymentResult> {
    // checked again here, the database row could have been written without the service
    if (deployment.action !== "restart" && !RELEASE_TAG_PATTERN.test(deployment.targetTag ?? "")) {
      return { status: "failed", error: `Invalid tag ${JSON.stringify(deployment.targetTag)}` };
    }

    switch (deployment.action) {
      case "pull":
        return this.pull(deployment.targetTag!);
      case "deploy":
        return this.deploy(deployment.targetTag!);
      case "restart":
        return this.restart();
    }
  }

  private async pull(tag: string): Promise<DeploymentResult> {
    const transcript = new Transcript();
    const pull = transcript.add(await this.compose.pull(tag));

    return isSuccess(pull)
      ? { status: "succeeded", output: transcript.toString() }
      : { status: "failed", output: transcript.toString(), error: describeFailure(pull) };
  }

  private async restart(): Promise<DeploymentResult> {
    const transcript = new Transcript();
    const restart = transcript.add(await this.compose.restart());
    if (!isSuccess(restart)) {
      return { status: "failed", output: transcript.toString(), error: describeFailure(restart) };
    }

    const health = await this.waitForHealthy(transcript);
    return health.healthy
      ? { status: "succeeded", output: transcript.toString() }
      : { status: "failed", output: transcript.toString(), error: `The api did not become healthy after the restart: ${health.detail}` };
  }

  /**
   * Switches the api to the tag. When the new version does not start or does not become healthy, the previous version
   * is started again (rolled_back). The previous tag is stored with the operation.
   */
  private async deploy(tag: string): Promise<DeploymentResult> {
    const transcript = new Transcript();
    const previousTag = await this.deployEnv.readApiTag();

    // pull first: a missing image or a login problem stops the deploy before the running api is touched
    const pull = transcript.add(await this.compose.pull(tag));
    if (!isSuccess(pull)) {
      return { status: "failed", previousTag, output: transcript.toString(), error: describeFailure(pull) };
    }

    await this.deployEnv.writeApiTag(tag);
    const up = transcript.add(await this.compose.up(tag));
    const health = isSuccess(up) ? await this.waitForHealthy(transcript) : undefined;
    if (health?.healthy) {
      return { status: "succeeded", previousTag, output: transcript.toString() };
    }

    const reason = health ? `${tag} did not become healthy: ${health.detail}` : describeFailure(up);
    if (!previousTag) {
      return { status: "failed", output: transcript.toString(), error: `${reason}. There is no previous version to roll back to` };
    }

    transcript.note(`Rolling back to ${previousTag}`);
    await this.deployEnv.writeApiTag(previousTag);
    const rollbackUp = transcript.add(await this.compose.up(previousTag));
    const rollbackHealth = isSuccess(rollbackUp) ? await this.waitForHealthy(transcript) : undefined;

    if (rollbackHealth?.healthy) {
      return { status: "rolled_back", previousTag, output: transcript.toString(), error: reason };
    }

    const rollbackReason = rollbackHealth ? rollbackHealth.detail : describeFailure(rollbackUp);
    return {
      status: "failed",
      previousTag,
      output: transcript.toString(),
      error: `${reason}. The rollback to ${previousTag} failed as well: ${rollbackReason}`,
    };
  }

  /**
   * Waits until the api container reports healthy. Fails early when the container stopped or reports unhealthy.
   * An image without a healthcheck counts as healthy once it has been running for noHealthcheckGraceMs.
   */
  private async waitForHealthy(transcript: Transcript): Promise<HealthResult> {
    const deadline = Date.now() + this.config.healthTimeoutMs;
    let lastState = "unknown";

    while (Date.now() < deadline) {
      const state = await this.compose.getApiState();

      if (state) {
        lastState = state.Health ? `${state.Status}, ${state.Health.Status}` : state.Status;

        if (state.Status === "exited" || state.Status === "dead") {
          return this.healthResult(transcript, false, `the container stopped (${lastState})`);
        }
        if (state.Health?.Status === "healthy") return this.healthResult(transcript, true, "healthy");
        if (state.Health?.Status === "unhealthy") return this.healthResult(transcript, false, "the container is unhealthy");

        const runningSince = state.StartedAt ? Date.parse(state.StartedAt) : NaN;
        if (!state.Health && state.Status === "running" && Date.now() - runningSince >= this.config.noHealthcheckGraceMs) {
          return this.healthResult(transcript, true, "running (the image has no healthcheck)");
        }
      }

      await sleep(this.config.healthCheckIntervalMs);
    }

    return this.healthResult(
      transcript,
      false,
      `not healthy within ${Math.round(this.config.healthTimeoutMs / 1000)}s (last state: ${lastState})`,
    );
  }

  private healthResult(transcript: Transcript, healthy: boolean, detail: string): HealthResult {
    transcript.note(`Health of the api container: ${detail}`);
    return { healthy, detail };
  }
}
