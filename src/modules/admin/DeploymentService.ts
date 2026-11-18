import { db } from "@/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { BaseModule } from "../core/BaseModule";
import { HttpError } from "@/utils/HttpError";
import { isUniqueViolation } from "@/utils/dbErrors";
import { deployments, type Deployment, type DeploymentAction } from "./schema/deployment.schema";

// Only released versions can be pulled or deployed (the tags the release workflow pushes to GHCR, e.g. 0.0.3).
export const RELEASE_TAG_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

// only the end of the command output is kept, that is where the result and the errors are
export const MAX_OUTPUT_LENGTH = 20_000;

export interface DeploymentRequest {
  action: DeploymentAction;
  targetTag?: string;
  requestedBy: string;
}

export interface DeploymentResult {
  status: "succeeded" | "failed" | "rolled_back";
  output?: string;
  error?: string;
  previousTag?: string;
}

export function trimOutput(output: string | undefined): string | undefined {
  if (output === undefined || output.length <= MAX_OUTPUT_LENGTH) return output;
  return `[... ${output.length - MAX_OUTPUT_LENGTH} characters cut ...]\n${output.slice(-MAX_OUTPUT_LENGTH)}`;
}

/**
 * Queue of the docker operations. The api only creates and reads them, the updater (a separate container with access
 * to docker) claims and executes them one after another.
 */
export class DeploymentService extends BaseModule {
  public static instance: DeploymentService;

  constructor() {
    super("deployment.service", "Queue and history of the docker operations of the api");

    if (!DeploymentService.instance) {
      DeploymentService.instance = this;
    }
    return DeploymentService.instance;
  }

  /**
   * Queues a new operation.
   * @throws HttpError 400 for an invalid tag, 409 while another operation is still queued or running
   */
  async requestDeployment({ action, targetTag, requestedBy }: DeploymentRequest): Promise<Deployment> {
    if (action === "restart") {
      if (targetTag !== undefined) throw HttpError.badRequest("A restart takes no tag");
    } else if (targetTag === undefined || !RELEASE_TAG_PATTERN.test(targetTag)) {
      throw HttpError.badRequest("The tag has to be a released version like 1.2.3");
    }

    try {
      const [deployment] = await db
        .insert(deployments)
        .values({ action, targetTag: action === "restart" ? null : targetTag, requestedBy })
        .returning();

      this.logger.info({ deploymentId: deployment.deploymentId, action, targetTag, requestedBy }, "Docker operation queued");
      return deployment;
    } catch (error) {
      // the unique index uq_deployments_one_active, also when two requests come in at the same time
      if (isUniqueViolation(error)) {
        throw HttpError.conflict("Another docker operation is still queued or running", error);
      }
      throw error;
    }
  }

  async getDeployment(deploymentId: string): Promise<Deployment | undefined> {
    const [deployment] = await db.select().from(deployments).where(eq(deployments.deploymentId, deploymentId)).limit(1);
    return deployment;
  }

  /** newest first */
  async listDeployments(limit = 20): Promise<Deployment[]> {
    return db.select().from(deployments).orderBy(desc(deployments.sequence)).limit(limit);
  }

  async getActiveDeployment(): Promise<Deployment | undefined> {
    const [deployment] = await db
      .select()
      .from(deployments)
      .where(sql`${deployments.status} in ('queued', 'running')`)
      .limit(1);
    return deployment;
  }

  /**
   * Used by the updater: marks the queued operation as running and returns it.
   * The claim is one statement, so two updaters can never start the same operation.
   */
  async claimNextDeployment(): Promise<Deployment | undefined> {
    const [claimed] = await db
      .update(deployments)
      .set({ status: "running", startedAt: new Date() })
      .where(
        eq(
          deployments.deploymentId,
          sql`(select ${deployments.deploymentId} from ${deployments} where ${deployments.status} = 'queued' order by ${deployments.sequence} limit 1 for update skip locked)`,
        ),
      )
      .returning();

    return claimed;
  }

  /**
   * Used by the updater when it starts: an operation that is still "running" was interrupted by a stop or crash of the
   * updater. It is marked as failed, otherwise it would block every new operation forever.
   * @returns the number of interrupted operations
   */
  async failInterruptedDeployments(): Promise<number> {
    const interrupted = await db
      .update(deployments)
      .set({
        status: "failed",
        error: "The updater was stopped while the operation was running, check the state of the api container",
        finishedAt: new Date(),
      })
      .where(eq(deployments.status, "running"))
      .returning({ deploymentId: deployments.deploymentId });

    return interrupted.length;
  }

  /**
   * Used by the updater: stores the result of a running operation.
   * @throws Error DEPLOYMENT_NOT_RUNNING when the operation is not running (anymore)
   */
  async finishDeployment(deploymentId: string, result: DeploymentResult): Promise<Deployment> {
    const [finished] = await db
      .update(deployments)
      .set({
        status: result.status,
        output: trimOutput(result.output),
        error: result.error,
        previousTag: result.previousTag,
        finishedAt: new Date(),
      })
      .where(and(eq(deployments.deploymentId, deploymentId), eq(deployments.status, "running")))
      .returning();

    if (!finished) throw new Error("DEPLOYMENT_NOT_RUNNING");

    this.logger.info({ deploymentId, status: result.status }, "Docker operation finished");
    return finished;
  }
}

export default DeploymentService;
