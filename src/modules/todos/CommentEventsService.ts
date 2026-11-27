import { BaseModule } from "../core/BaseModule";
import { resolveModule } from "@modules/core/resolveModule";
import { TodoService, type AccessingUser } from "./TodoService";
import type { CommentRemoval, DiscussionComment } from "./TodoCommentService";

/** open live connections of one user, over all todos */
export const MAX_COMMENT_STREAMS_PER_USER = 5;
/** a comment on a connection keeps proxies from closing it and shows the server that the client is gone */
export const COMMENT_EVENTS_HEARTBEAT_MS = 25_000;

/** one open connection of a user to the live events of a todo, kept abstract so the distributor knows no HTTP */
export interface CommentStream {
  user: AccessingUser;
  /** Unix time in ms from which the access token has expired */
  expiresAt: number;
  send(event: string, data: unknown): void;
  ping(): void;
  close(): void;
}

export type CommentEvent =
  | { name: "comment.created"; data: { comment: DiscussionComment; parentReplyCount?: number } }
  | { name: "comment.updated"; data: { comment: DiscussionComment } }
  | {
      name: "comment.deleted";
      data: { commentId: string; parentCommentId: string | null; mode: CommentRemoval["mode"]; parentReplyCount?: number };
    };

interface Subscription {
  todoId: string;
  stream: CommentStream;
}

/**
 * Distributes comment events to the open connections of this process. Access is checked again on every event and
 * heartbeat, so a connection ends when its user loses access or the access token expires.
 */
export class CommentEventsService extends BaseModule {
  public static instance: CommentEventsService;
  protected todoService: TodoService;
  /** in subscription order, so the oldest connection of a user comes first */
  private subscriptions: Subscription[] = [];

  constructor() {
    super("comment.events.service", "Live distribution of comment events");
    this.todoService = resolveModule(TodoService);

    if (!CommentEventsService.instance) {
      CommentEventsService.instance = this;
    }
    return CommentEventsService.instance;
  }

  subscribe(todoId: string, stream: CommentStream): () => void {
    const subscription: Subscription = { todoId, stream };
    this.subscriptions.push(subscription);

    const ofUser = this.subscriptions.filter((entry) => entry.stream.user.id === stream.user.id);
    if (ofUser.length > MAX_COMMENT_STREAMS_PER_USER) this.drop(ofUser[0]);

    return () => this.remove(subscription);
  }

  async publish(todoId: string, event: CommentEvent): Promise<void> {
    await this.deliver(todoId, (stream) => stream.send(event.name, event.data));
  }

  async heartbeat(): Promise<void> {
    const todoIds = [...new Set(this.subscriptions.map((entry) => entry.todoId))];
    await Promise.all(todoIds.map((todoId) => this.deliver(todoId, (stream) => stream.ping())));
  }

  startHeartbeat(intervalMs = COMMENT_EVENTS_HEARTBEAT_MS): () => void {
    const timer = setInterval(() => {
      this.heartbeat().catch((error) => console.error("comment events heartbeat failed", error));
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  closeAll(): void {
    for (const subscription of [...this.subscriptions]) this.drop(subscription);
  }

  countStreams(): number {
    return this.subscriptions.length;
  }

  /** loads the todo once, drops connections without access or with an expired token and runs action on the rest */
  private async deliver(todoId: string, action: (stream: CommentStream) => void): Promise<void> {
    const targets = this.subscriptions.filter((entry) => entry.todoId === todoId);
    if (targets.length === 0) return;

    const todo = await this.todoService.getTodoById(todoId);
    for (const subscription of targets) {
      if (!this.subscriptions.includes(subscription)) continue; // gone while the todo was loading
      try {
        const allowed =
          todo !== undefined &&
          subscription.stream.expiresAt > Date.now() &&
          (await this.todoService.canAccessTodo(todo, subscription.stream.user));
        if (!allowed) {
          this.drop(subscription);
          continue;
        }
        // the access check is async: the connection may have been closed meanwhile
        if (this.subscriptions.includes(subscription)) action(subscription.stream);
      } catch {
        this.drop(subscription);
      }
    }
  }

  private remove(subscription: Subscription): void {
    const index = this.subscriptions.indexOf(subscription);
    if (index !== -1) this.subscriptions.splice(index, 1);
  }

  private drop(subscription: Subscription): void {
    this.remove(subscription);
    try {
      subscription.stream.close();
    } catch {
      // already broken, nothing left to close
    }
  }
}
