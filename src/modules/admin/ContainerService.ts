import { db } from "@/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { BaseModule } from "../core/BaseModule";
import {
  containerLogRequests,
  containerStatus,
  type ContainerLogRequest,
  type ContainerStatusRecord,
  type NewContainerStatusRecord,
} from "./schema/container.schema";

// how often the updater refreshes the snapshot of the containers
export const STATUS_REFRESH_INTERVAL_MS = 15_000;
// a snapshot older than this means the updater does not run (anymore)
export const STATUS_STALE_AFTER_MS = 60_000;
// how often the updater looks for log requests
export const LOG_POLL_INTERVAL_MS = 1000;
// log requests nobody picked up or read are removed after this time
export const LOG_REQUEST_RETENTION_MS = 10 * 60 * 1000;

export const MAX_LOG_TAIL = 1000;
export const DEFAULT_LOG_TAIL = 200;
// a compose service name: lower case letters, digits, "-" and "_"
export const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ContainerStatusSnapshot {
  /** when the updater took the snapshot, undefined when it never did */
  updatedAt: Date | undefined;
  /** the updater did not refresh the snapshot for a while (or never) */
  stale: boolean;
  containers: ContainerStatusRecord[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Status and logs of the containers of the compose project. The api only reads the status and queues log requests,
 * the updater (the only container with access to docker) writes the status and answers the requests.
 */
export class ContainerService extends BaseModule {
  public static instance: ContainerService;
  /** how long the api waits for the updater to answer a log request (shorter in the tests) */
  public logWaitMs = 15_000;

  constructor() {
    super("container.service", "Status and logs of the docker containers");

    if (!ContainerService.instance) {
      ContainerService.instance = this;
    }
    return ContainerService.instance;
  }

  // ---------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------

  async getStatus(now = new Date()): Promise<ContainerStatusSnapshot> {
    const containers = await db.select().from(containerStatus).orderBy(containerStatus.service);
    const updatedAt = containers.length
      ? new Date(Math.min(...containers.map((container) => container.updatedAt.getTime())))
      : undefined;
    const stale = !updatedAt || now.getTime() - updatedAt.getTime() > STATUS_STALE_AFTER_MS;

    return { updatedAt, stale, containers };
  }

  /** Used by the updater: replaces the snapshot, containers that are gone disappear from it. */
  async replaceStatus(containers: NewContainerStatusRecord[]): Promise<void> {
    const updatedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(containerStatus);
      if (containers.length) {
        await tx.insert(containerStatus).values(containers.map((container) => ({ ...container, updatedAt })));
      }
    });
  }

  /** the services of the last snapshot, the logs can only be requested for these */
  async isKnownService(service: string): Promise<boolean> {
    const [row] = await db
      .select({ service: containerStatus.service })
      .from(containerStatus)
      .where(eq(containerStatus.service, service))
      .limit(1);
    return Boolean(row);
  }

  // ---------------------------------------------------------------------------
  // logs
  // ---------------------------------------------------------------------------

  async requestLogs({ service, tail, requestedBy }: { service: string; tail: number; requestedBy: string }) {
    if (!SERVICE_NAME_PATTERN.test(service)) throw new Error(`Invalid service ${JSON.stringify(service)}`);
    if (!Number.isInteger(tail) || tail < 1 || tail > MAX_LOG_TAIL) throw new Error(`Invalid tail ${tail}`);

    const [request] = await db.insert(containerLogRequests).values({ service, tail, requestedBy }).returning();
    return request;
  }

  /**
   * Waits until the updater answered the request.
   * @returns the answered request, undefined when the updater did not answer within logWaitMs
   */
  async waitForLogs(logRequestId: string, pollMs = 250): Promise<ContainerLogRequest | undefined> {
    const deadline = Date.now() + this.logWaitMs;

    while (Date.now() < deadline) {
      const [request] = await db
        .select()
        .from(containerLogRequests)
        .where(eq(containerLogRequests.logRequestId, logRequestId))
        .limit(1);
      if (request && request.status !== "queued") return request;
      await sleep(pollMs);
    }
    return undefined;
  }

  /** the logs are only shown once, they are not kept in the database */
  async deleteLogRequest(logRequestId: string): Promise<void> {
    await db.delete(containerLogRequests).where(eq(containerLogRequests.logRequestId, logRequestId));
  }

  /** Used by the updater: the oldest open request, claimed so it is answered only once. */
  async claimNextLogRequest(): Promise<ContainerLogRequest | undefined> {
    const [claimed] = await db
      .update(containerLogRequests)
      // stays "queued" until it is answered, finishedAt marks it as being worked on
      .set({ finishedAt: new Date() })
      .where(
        eq(
          containerLogRequests.logRequestId,
          sql`(select ${containerLogRequests.logRequestId} from ${containerLogRequests} where ${containerLogRequests.status} = 'queued' and ${containerLogRequests.finishedAt} is null order by ${containerLogRequests.sequence} limit 1 for update skip locked)`,
        ),
      )
      .returning();
    return claimed;
  }

  /** Used by the updater: stores the logs or the reason why they could not be read. */
  async answerLogRequest(logRequestId: string, answer: { output: string } | { error: string }): Promise<void> {
    await db
      .update(containerLogRequests)
      .set({
        status: "output" in answer ? "done" : "failed",
        output: "output" in answer ? answer.output : null,
        error: "error" in answer ? answer.error : null,
        finishedAt: new Date(),
      })
      .where(and(eq(containerLogRequests.logRequestId, logRequestId), eq(containerLogRequests.status, "queued")));
  }

  /** Used by the updater: removes requests nobody picked up or read (e.g. the api was restarted while waiting). */
  async deleteOldLogRequests(now = new Date()): Promise<number> {
    const removed = await db
      .delete(containerLogRequests)
      .where(lt(containerLogRequests.createdAt, new Date(now.getTime() - LOG_REQUEST_RETENTION_MS)))
      .returning({ logRequestId: containerLogRequests.logRequestId });
    return removed.length;
  }
}

export default ContainerService;
