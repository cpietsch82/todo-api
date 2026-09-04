import type { Request, Response } from "express";
import { APIModule } from "../core/APIModule";
import { UserService } from "./UserService";
import { UpdateUserBody, updateUserSchema, UserByIdParams, userByIdSchema } from "./schema/user.schema";
import { TypedRequest, TypedRequestParams } from "../express/Express";
import { typedHandler } from "@/utils/typedHandler";
import { validateBody, validateParams } from "@/middleware/validate";
import { requirePermissions, requireUserOwnership } from "@/middleware/permissions";

export class UserAPI extends APIModule {
  public static instance: UserAPI;
  protected service: UserService;

  constructor() {
    super("user.api", "API Module for User management", "/users");

    this.service = new UserService();

    if (!UserAPI.instance) {
      UserAPI.instance = this;
    }
    return UserAPI.instance;
  }

  protected initializeRoutes(): void {
    const requireCurrentUser = requireUserOwnership(new UserService());

    this.router.get("/", requirePermissions("users:read"), this.getAllUsers.bind(this));
    this.router.get(
      "/:userId",
      validateParams(userByIdSchema),
      requirePermissions("users:read"),
      requireCurrentUser,
      typedHandler(this.getUserById.bind(this)),
    );
    this.router.patch(
      "/:userId",
      validateParams(userByIdSchema),
      requirePermissions("users:update"),
      requireCurrentUser,
      validateBody(updateUserSchema),
      typedHandler(this.updateUser.bind(this)),
    );
    this.router.delete(
      "/:userId",
      validateParams(userByIdSchema),
      requirePermissions("users:delete"),
      requireCurrentUser,
      typedHandler(this.deleteUser.bind(this)),
    );
  }

  private async getAllUsers(_req: Request, res: Response) {
    const users = await this.service.getAllUsers();

    res.json(users);
  }

  private async getUserById(req: TypedRequestParams<UserByIdParams>, res: Response) {
    const { userId } = req.params;

    const user = await this.service.getUserById(userId);
    if (!user) return res.respondNotFound();

    res.json(user);
  }

  private async updateUser(req: TypedRequest<UserByIdParams, UpdateUserBody>, res: Response) {
    const { updates } = req.body;
    const { userId } = req.params;

    const existingUser = await this.service.getUserById(userId);
    if (!existingUser) return res.respondNotFound();

    const result = await this.service.updateUser(userId, updates);

    res.json(result);
  }

  private async deleteUser(req: TypedRequestParams<UserByIdParams>, res: Response) {
    const { userId } = req.params;

    const existingUser = await this.service.getUserById(userId);
    if (!existingUser) return res.respondNotFound();

    const result = await this.service.deleteUser(userId);

    res.json(result);
  }
}

export default UserAPI;
