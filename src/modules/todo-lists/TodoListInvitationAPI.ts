import type { Request, Response } from "express";
import { APIModule } from "@modules/core/APIModule";
import { validateParams } from "@/middleware/validate";
import { requirePermissions } from "@/middleware/permissions";
import { typedHandler } from "@/utils/typedHandler";
import { HttpError } from "@/utils/HttpError";
import type { TypedRequestParams } from "../express/Express";
import { TodoListService } from "./TodoListService";
import { TodoListInvitationService } from "./TodoListInvitationService";
import { invitationByIdSchema, type InvitationByIdParams } from "./schema/sharing.schema";

/**
 * The invitations to lists as the invited user sees them: the own open ones, accepting and declining them. Only the
 * invited user can answer an invitation.
 */
export class TodoListInvitationAPI extends APIModule {
  private static instance: TodoListInvitationAPI;
  private invitationService: TodoListInvitationService;
  private todoListService: TodoListService;

  constructor() {
    super("todo-list-invitation.api", "API Module for the own invitations to todo lists", "/todo-list-invitations");

    this.invitationService = new TodoListInvitationService();
    this.todoListService = new TodoListService();

    if (!TodoListInvitationAPI.instance) {
      TodoListInvitationAPI.instance = this;
    }
    return TodoListInvitationAPI.instance;
  }

  protected initializeRoutes(): void {
    const byId = validateParams(invitationByIdSchema);

    this.router.get("/", requirePermissions("todo-lists:read"), this.getInvitations.bind(this));
    this.router.post(
      "/:invitationId/accept",
      byId,
      requirePermissions("todo-lists:read"),
      typedHandler(this.acceptInvitation.bind(this)),
    );
    this.router.post(
      "/:invitationId/decline",
      byId,
      requirePermissions("todo-lists:read"),
      typedHandler(this.declineInvitation.bind(this)),
    );
  }

  private async getInvitations(req: Request, res: Response) {
    res.json(await this.invitationService.getInvitationsForUser(req.user!.id));
  }

  /** Answers with the list as the new member sees it. */
  private async acceptInvitation(req: TypedRequestParams<InvitationByIdParams>, res: Response) {
    const user = req.user!;
    const list = await this.invitationService.acceptInvitation(req.params.invitationId, user.id);

    const myRole = await this.todoListService.getListRole(list, user);
    const summary = myRole ? await this.todoListService.getListSummary(list, myRole) : undefined;
    // removed or deleted right after accepting
    if (!summary) throw HttpError.notFound();
    res.json(summary);
  }

  private async declineInvitation(req: TypedRequestParams<InvitationByIdParams>, res: Response) {
    await this.invitationService.declineInvitation(req.params.invitationId, req.user!.id);
    res.respondOkNoContent();
  }
}

export default TodoListInvitationAPI;
