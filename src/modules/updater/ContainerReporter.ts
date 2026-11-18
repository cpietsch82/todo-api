import { logger } from "@/utils/logger";
import type { ContainerService } from "@/modules/admin/ContainerService";
import type { ContainerLogRequest } from "@/modules/admin/schema/container.schema";
import { mergeLogStreams, isSuccess, type DockerCompose } from "./DockerCompose";

export interface ContainerReporterConfig {
  statusIntervalMs: number;
  logPollIntervalMs: number;
}

/**
 * Reports what the api cannot see itself: the status of all containers of the compose project (a snapshot in the
 * database, refreshed in an interval) and the logs of a service on request. Read only, it never changes a container.
 * It runs next to the operations of the Updater, so status and logs stay available during a long deploy.
 */
export class ContainerReporter {
  private running = false;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inProgress = new Set<Promise<unknown>>();

  constructor(
    private readonly containerService: ContainerService,
    private readonly compose: DockerCompose,
    private readonly config: ContainerReporterConfig,
  ) {}

  /** reads all containers of the compose project and replaces the snapshot */
  async refreshStatus(): Promise<number> {
    const containers = await this.compose.listContainers();
    await this.containerService.replaceStatus(
      containers.map((container) => ({
        service: container.Service,
        containerName: container.Name,
        image: container.Image,
        state: container.State,
        health: container.Health || null,
        statusText: container.Status,
        exitCode: Number.isInteger(container.ExitCode) ? container.ExitCode : null,
      })),
    );
    await this.containerService.deleteOldLogRequests();
    return containers.length;
  }

  /**
   * Answers the oldest open log request.
   * @returns the request, undefined when there was none
   */
  async answerNextLogRequest(): Promise<ContainerLogRequest | undefined> {
    const request = await this.containerService.claimNextLogRequest();
    if (!request) return undefined;

    try {
      const step = await this.compose.logs(request.service, request.tail);
      if (isSuccess(step)) {
        await this.containerService.answerLogRequest(request.logRequestId, {
          output: mergeLogStreams(step.result.stdout, step.result.stderr),
        });
      } else {
        const reason = step.result.timedOut ? "timed out" : step.result.stderr.trim().split("\n").pop();
        await this.containerService.answerLogRequest(request.logRequestId, {
          error: `${step.label} failed${reason ? `: ${reason}` : ""}`,
        });
      }
    } catch (error) {
      await this.containerService.answerLogRequest(request.logRequestId, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return request;
  }

  start(): void {
    this.running = true;
    this.loop(() => this.refreshStatus(), this.config.statusIntervalMs, "Refreshing the container status failed");
    this.loop(() => this.answerAllLogRequests(), this.config.logPollIntervalMs, "Answering a log request failed");
  }

  /** stops both loops and waits for the work that is running */
  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    await Promise.allSettled([...this.inProgress]);
  }

  private async answerAllLogRequests(): Promise<void> {
    while (this.running && (await this.answerNextLogRequest()));
  }

  /** runs the task now and then again after each interval, an error is logged and the loop goes on */
  private loop(task: () => Promise<unknown>, intervalMs: number, errorMessage: string) {
    const tick = async () => {
      if (!this.running) return;
      const work = task().catch((error: unknown) => logger.error({ err: error }, errorMessage));
      this.inProgress.add(work);
      await work;
      this.inProgress.delete(work);
      if (this.running) this.timers.push(setTimeout(tick, intervalMs));
    };
    void tick();
  }
}
