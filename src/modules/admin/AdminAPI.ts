import type { Request, Response } from "express";
import { APIModule } from "../core/APIModule";
import { AdminService } from "./AdminService";
import { DeploymentService } from "./DeploymentService";
import { VersionService } from "../express/VersionService";
import { requireAnyFreshPermission, requireFreshPermissions } from "@/middleware/permissions";
import { createDockerOperationRateLimiter } from "@/middleware/rateLimit";
import { validateBody, validateParams } from "@/middleware/validate";
import { DOCKER_PERMISSIONS, type DockerPermission } from "@/modules/authorization/permissions";
import { typedHandler } from "@/utils/typedHandler";
import { TypedRequestBody, TypedRequestParams } from "../express/Express";
import {
  DeploymentByIdParams,
  deploymentByIdSchema,
  DeploymentTagBody,
  deploymentTagSchema,
  listDeploymentsQuerySchema,
} from "./schema/admin.schema";
import type { Deployment, DeploymentAction } from "./schema/deployment.schema";

// the permission that every operation requires, pull/deploy/restart only affect the api container
const OPERATION_PERMISSIONS: Record<DeploymentAction, DockerPermission> = {
  pull: "admin:docker:pull",
  deploy: "admin:docker:deploy",
  restart: "admin:docker:restart",
};

/**
 * A deployment as the api returns it, built from an explicit list of fields, so a new column is not returned by
 * accident. The list leaves the output out, it can be up to 20.000 characters per entry.
 */
function toResponse(deployment: Deployment, { withOutput }: { withOutput: boolean }) {
  const response = {
    deploymentId: deployment.deploymentId,
    action: deployment.action,
    status: deployment.status,
    targetTag: deployment.targetTag,
    previousTag: deployment.previousTag,
    requestedBy: deployment.requestedBy,
    error: deployment.error,
    createdAt: deployment.createdAt,
    startedAt: deployment.startedAt,
    finishedAt: deployment.finishedAt,
  };

  return withOutput ? { ...response, output: deployment.output } : response;
}

export class AdminAPI extends APIModule {
  public static instance: AdminAPI;
  protected service: AdminService;
  protected deploymentService: DeploymentService;
  protected versionService: VersionService;

  constructor() {
    super("admin.api", "API Module for administrative tasks", "/admin");

    this.service = new AdminService();
    this.deploymentService = new DeploymentService();
    this.versionService = new VersionService();

    if (!AdminAPI.instance) {
      AdminAPI.instance = this;
    }
    return AdminAPI.instance;
  }

  protected initializeRoutes(): void {
    // The admin area is only open for admins and deployers, checked against the database on every request.
    // This is only the outer gate: every route additionally requires its own permission with requireFreshPermissions
    // (admin:all does not cover the docker permissions).
    this.router.use(requireAnyFreshPermission("admin:all", ...DOCKER_PERMISSIONS));

    // ---- reading -------------------------------------------------------------
    this.router.get("/version", requireFreshPermissions("admin:docker:status"), this.getVersion.bind(this));
    this.router.get("/deployments", requireFreshPermissions("admin:docker:status"), this.listDeployments.bind(this));
    this.router.get(
      "/deployments/:deploymentId",
      requireFreshPermissions("admin:docker:status"),
      validateParams(deploymentByIdSchema),
      typedHandler(this.getDeployment.bind(this)),
    );

    // ---- operations, executed later by the updater ------------------------------
    // the rate limit comes first, so rejected requests do not even reach the validation and the database
    this.router.post(
      "/deployments/pull",
      createDockerOperationRateLimiter(),
      requireFreshPermissions(OPERATION_PERMISSIONS.pull),
      validateBody(deploymentTagSchema),
      typedHandler(this.requestPull.bind(this)),
    );
    this.router.post(
      "/deployments/deploy",
      createDockerOperationRateLimiter(),
      requireFreshPermissions(OPERATION_PERMISSIONS.deploy),
      validateBody(deploymentTagSchema),
      typedHandler(this.requestDeploy.bind(this)),
    );
    this.router.post(
      "/deployments/restart",
      createDockerOperationRateLimiter(),
      requireFreshPermissions(OPERATION_PERMISSIONS.restart),
      this.requestRestart.bind(this),
    );
  }

  /**
   * Version of the running api. The version the updater has deployed comes with the deployments.
   */
  private async getVersion(_req: Request, res: Response) {
    res.json(this.versionService.getVersionInfo());
  }

  private async listDeployments(req: Request, res: Response) {
    const query = listDeploymentsQuerySchema.safeParse(req.query);
    if (!query.success) return res.respondInvalidParameter("limit", "must be a number between 1 and 100");

    const deployments = await this.deploymentService.listDeployments(query.data.limit);
    res.json(deployments.map((deployment) => toResponse(deployment, { withOutput: false })));
  }

  private async getDeployment(req: TypedRequestParams<DeploymentByIdParams>, res: Response) {
    const deployment = await this.deploymentService.getDeployment(req.params.deploymentId);
    if (!deployment) return res.respondNotFound();

    res.json(toResponse(deployment, { withOutput: true }));
  }

  private async requestPull(req: TypedRequestBody<DeploymentTagBody>, res: Response) {
    await this.queue(req, res, "pull", req.body.tag);
  }

  private async requestDeploy(req: TypedRequestBody<DeploymentTagBody>, res: Response) {
    await this.queue(req, res, "deploy", req.body.tag);
  }

  private async requestRestart(req: Request, res: Response) {
    await this.queue(req, res, "restart", undefined);
  }

  /**
   * Queues the operation and answers 202: it is accepted but not executed yet, its status can be followed
   * under the url of the Location header. 409 while another operation is queued or running (from the service).
   */
  private async queue(req: Pick<Request, "user">, res: Response, action: DeploymentAction, targetTag: string | undefined) {
    const deployment = await this.deploymentService.requestDeployment({
      action,
      targetTag,
      requestedBy: req.user!.id,
    });

    res
      .status(202)
      .location(`/api/admin/deployments/${deployment.deploymentId}`)
      .json(toResponse(deployment, { withOutput: false }));
  }
}

export default AdminAPI;
