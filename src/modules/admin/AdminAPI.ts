import { APIModule } from "../core/APIModule";
import { AdminService } from "./AdminService";
import { requireAnyFreshPermission } from "@/middleware/permissions";
import { DOCKER_PERMISSIONS } from "@/modules/authorization/permissions";

export class AdminAPI extends APIModule {
  public static instance: AdminAPI;
  protected service: AdminService;

  constructor() {
    super("admin.api", "API Module for administrative tasks", "/admin");

    this.service = new AdminService();

    if (!AdminAPI.instance) {
      AdminAPI.instance = this;
    }
    return AdminAPI.instance;
  }

  protected initializeRoutes(): void {
    // The admin area is only open for admins and deployers, checked against the database on every request.
    // This is only the outer gate: every route additionally requires its own permission with requireFreshPermissions,
    // e.g. requireFreshPermissions("admin:docker:deploy") (admin:all does not cover the docker permissions).
    this.router.use(requireAnyFreshPermission("admin:all", ...DOCKER_PERMISSIONS));
  }
}

export default AdminAPI;
