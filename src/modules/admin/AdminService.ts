import { BaseModule } from "../core/BaseModule";

export class AdminService extends BaseModule {
  public static instance: AdminService;

  constructor() {
    super("admin.service", "Business logic for administrative tasks");

    if (!AdminService.instance) {
      AdminService.instance = this;
    }
    return AdminService.instance;
  }
}

export default AdminService;
