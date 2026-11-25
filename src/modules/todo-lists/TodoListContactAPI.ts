import type { Request, Response } from "express";
import { APIModule } from "@modules/core/APIModule";
import { requirePermissions } from "@/middleware/permissions";
import { TodoListMemberService } from "./TodoListMemberService";

/**
 * Suggestions for inviting: the users one currently shares a list with. There is no directory of all users, because
 * the registration is open (design 3.2).
 */
export class TodoListContactAPI extends APIModule {
  private static instance: TodoListContactAPI;
  private memberService: TodoListMemberService;

  constructor() {
    super("todo-list-contact.api", "API Module for the contacts of todo lists", "/todo-list-contacts");

    this.memberService = new TodoListMemberService();

    if (!TodoListContactAPI.instance) {
      TodoListContactAPI.instance = this;
    }
    return TodoListContactAPI.instance;
  }

  protected initializeRoutes(): void {
    this.router.get("/", requirePermissions("todo-lists:share"), this.getContacts.bind(this));
  }

  private async getContacts(req: Request, res: Response) {
    res.json(await this.memberService.getContacts(req.user!.id));
  }
}

export default TodoListContactAPI;
