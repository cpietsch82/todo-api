import { APIModule } from "../core/APIModule";
import { AdminService } from "./AdminService";
import { requirePermissions } from "@/middleware/permissions";

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
    // every route of this module is admin only
    this.router.use(requirePermissions("admin:all"));
  }
}

export default AdminAPI;
