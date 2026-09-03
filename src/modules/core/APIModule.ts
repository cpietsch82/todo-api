import { BaseModule } from "./BaseModule";
import { ExpressAPI, SubRouter } from "@modules/express/Express";

export abstract class APIModule extends BaseModule {
  protected router: SubRouter;
  private expressAPI: ExpressAPI;

  constructor(moduleId: string, description: string, apiRoute: string, isPreAuthRoute: boolean = false) {
    if (!apiRoute.startsWith("/")) throw new Error("you most certainly don't want that.");
    if (!moduleId.endsWith(".api")) throw new Error("API Module IDs must end with .api");
    super(moduleId, description);

    this.expressAPI = new ExpressAPI();
    this.router = isPreAuthRoute ? this.expressAPI.preAuthRoute(apiRoute) : this.expressAPI.route(apiRoute);

    this.initializeRoutes();
  }

  protected abstract initializeRoutes(): void;
}
