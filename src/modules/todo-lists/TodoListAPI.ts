import type { Request, Response } from "express";
import { APIModule } from "@modules/core/APIModule";
import { validateBody, validateParams } from "@/middleware/validate";
import { requireListRole, requirePermissions } from "@/middleware/permissions";
import { typedHandler } from "@/utils/typedHandler";
import { HttpError } from "@/utils/HttpError";
import { hasPermission } from "@/modules/authorization/permissions";
import type { TypedRequest, TypedRequestBody } from "../express/Express";
import { TodoListService } from "./TodoListService";
import { TodoListMemberService } from "./TodoListMemberService";
import { MAX_LISTS_PER_USER } from "./limits";
import {
  createTodoListSchema,
  todoListByIdSchema,
  updateTodoListSchema,
  type CreateTodoListBody,
  type UpdateTodoListBody,
} from "./schema/todo-list.schema";
import {
  changeMemberRoleSchema,
  listMemberParamsSchema,
  transferListSchema,
  type ChangeMemberRoleBody,
  type ListMemberParams,
  type TransferListBody,
} from "./schema/sharing.schema";

/**
 * Lists of todos. Who may do what in a list follows from the role in it (requireListRole); the permissions of the
 * access token are only the coarse gate.
 */
export class TodoListAPI extends APIModule {
  private static instance: TodoListAPI;
  private todoListService: TodoListService;
  private memberService: TodoListMemberService;

  constructor() {
    super("todo-list.api", "API Module for todo lists", "/todo-lists");

    this.todoListService = new TodoListService();
    this.memberService = new TodoListMemberService();

    if (!TodoListAPI.instance) {
      TodoListAPI.instance = this;
    }
    return TodoListAPI.instance;
  }

  protected initializeRoutes(): void {
    const byId = validateParams(todoListByIdSchema);

    this.router.get("/", requirePermissions("todo-lists:read"), this.getLists.bind(this));
    this.router.post(
      "/",
      requirePermissions("todo-lists:create"),
      validateBody(createTodoListSchema),
      typedHandler(this.createList.bind(this)),
    );
    this.router.get("/:listId", byId, requirePermissions("todo-lists:read"), requireListRole("viewer"), this.getList.bind(this));
    this.router.patch(
      "/:listId",
      byId,
      requirePermissions("todo-lists:update"),
      requireListRole("owner"),
      validateBody(updateTodoListSchema),
      typedHandler(this.updateList.bind(this)),
    );
    this.router.delete(
      "/:listId",
      byId,
      requirePermissions("todo-lists:delete"),
      requireListRole("owner"),
      this.deleteList.bind(this),
    );
    this.router.get(
      "/:listId/todos",
      byId,
      requirePermissions("todos:read"),
      requireListRole("viewer"),
      this.getTodosOfList.bind(this),
    );

    // members: every role sees them, the owner changes them, members may leave
    const byMember = validateParams(listMemberParamsSchema);
    this.router.get("/:listId/members", byId, requirePermissions("todo-lists:read"), requireListRole("viewer"), this.getMembers.bind(this));
    this.router.patch(
      "/:listId/members/:userId",
      byMember,
      requirePermissions("todo-lists:share"),
      requireListRole("owner"),
      validateBody(changeMemberRoleSchema),
      typedHandler(this.changeMemberRole.bind(this)),
    );
    // leaving needs no permission beyond being in the list, removing others is checked in the handler
    this.router.delete("/:listId/members/:userId", byMember, requireListRole("viewer"), typedHandler(this.removeMember.bind(this)));
    this.router.post(
      "/:listId/transfer",
      byId,
      requirePermissions("todo-lists:share"),
      requireListRole("owner"),
      validateBody(transferListSchema),
      typedHandler(this.transferList.bind(this)),
    );
  }

  private async getLists(req: Request, res: Response) {
    res.json(await this.todoListService.getListsForUser(req.user!.id));
  }

  private async createList(req: TypedRequestBody<CreateTodoListBody>, res: Response) {
    const ownerId = req.user!.id;
    if ((await this.todoListService.countListsOwnedBy(ownerId)) >= MAX_LISTS_PER_USER) {
      throw HttpError.conflict("List limit reached");
    }

    const { name, description } = req.body.listRecord;
    const list = await this.todoListService.createList({ name, description, ownerId });
    res.status(201).json(list);
  }

  private async getList(req: Request, res: Response) {
    const summary = await this.todoListService.getListSummary(req.todoList!, req.listRole!);
    // deleted after requireListRole found it
    if (!summary) throw HttpError.notFound();
    res.json(summary);
  }

  private async updateList(req: TypedRequestBody<UpdateTodoListBody>, res: Response) {
    const { name, description } = req.body.updates;
    const list = await this.todoListService.updateList(req.todoList!.listId, { name, description });
    // deleted after requireListRole found it
    if (!list) throw HttpError.notFound();
    const summary = await this.todoListService.getListSummary(list, req.listRole!);
    // deleted right after the update
    if (!summary) throw HttpError.notFound();
    res.json(summary);
  }

  private async deleteList(req: Request, res: Response) {
    const list = await this.todoListService.deleteList(req.todoList!.listId);
    // deleted by someone else after requireListRole found it
    if (!list) throw HttpError.notFound();
    res.json(list);
  }

  private async getTodosOfList(req: Request, res: Response) {
    res.json(await this.todoListService.getTodosOfList(req.todoList!.listId));
  }

  private async getMembers(req: Request, res: Response) {
    res.json(await this.memberService.getMembers(req.todoList!));
  }

  private async changeMemberRole(req: TypedRequest<ListMemberParams, ChangeMemberRoleBody>, res: Response) {
    const list = req.todoList!;
    res.json(await this.memberService.changeRole(list.listId, req.params.userId, req.body.role, list.ownerId));
  }

  /** Hands the list over to a member; answers with the list as the requesting user sees it now. */
  private async transferList(req: TypedRequestBody<TransferListBody>, res: Response) {
    const user = req.user!;
    const { listId, ownerId } = req.todoList!;
    const list = await this.memberService.transferList(listId, req.body.userId, user.id, ownerId);

    const myRole = await this.todoListService.getListRole(list, user);
    const summary = myRole ? await this.todoListService.getListSummary(list, myRole) : undefined;
    // deleted right after the transfer
    if (!summary) throw HttpError.notFound();
    res.json(summary);
  }

  /** A member leaves the list, or the owner removes someone else. */
  private async removeMember(req: TypedRequest<ListMemberParams>, res: Response) {
    const list = req.todoList!;
    const { userId } = req.params;

    if (userId === req.user!.id) {
      res.json(await this.memberService.removeMember(list.listId, userId));
      return;
    }

    if (req.listRole !== "owner" || !hasPermission(req.user!.permissions, "todo-lists:share")) {
      throw HttpError.forbidden("Removing others needs the owner role");
    }
    res.json(await this.memberService.removeMember(list.listId, userId, list.ownerId));
  }
}

export default TodoListAPI;
