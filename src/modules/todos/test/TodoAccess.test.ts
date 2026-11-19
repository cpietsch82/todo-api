import { describe, it, expect, beforeEach } from "vitest";
import { TodoService } from "@modules/todos/TodoService";
import { TodoCommentService } from "@modules/todos/TodoCommentService";
import { getPermissionsForRole } from "@modules/authorization/permissions";
import { generateTodo, generateTodoComment, generateUser } from "@tests/test.helpers";
import type { Todo, User } from "@/db/schema";
import { db } from "@/db";
import { todoComments } from "@modules/todos/schema/todo.comment.schema";
// registers the database cleanup hooks
import "@tests/integration.setup";

const asUser = (user: User) => ({ id: user.userId, permissions: getPermissionsForRole("user") });
const asAdmin = (user: User) => ({ id: user.userId, permissions: getPermissionsForRole("admin") });

describe("todo access and discussion", () => {
  const todoService = new TodoService();
  const commentService = new TodoCommentService();
  let creator: User;
  let other: User;
  let todo: Todo;

  beforeEach(async () => {
    creator = await generateUser();
    other = await generateUser();
    todo = await generateTodo(creator.userId);
  });

  describe("TodoService.canAccessTodo", () => {
    it("should let the creator see the todo", async () => {
      expect(await todoService.canAccessTodo(todo, asUser(creator))).toBe(true);
    });

    it("should hide the todo from other users", async () => {
      expect(await todoService.canAccessTodo(todo, asUser(other))).toBe(false);
    });

    it("should let an admin see every todo", async () => {
      expect(await todoService.canAccessTodo(todo, asAdmin(other))).toBe(true);
    });

    it("should not count the docker permissions of a deployer as admin", async () => {
      const deployer = { id: other.userId, permissions: getPermissionsForRole("deployer") };

      expect(await todoService.canAccessTodo(todo, deployer)).toBe(false);
    });

    it("should hide the todo from a user without permissions", async () => {
      expect(await todoService.canAccessTodo(todo, { id: other.userId })).toBe(false);
    });
  });

  // prepared for the discussion on shared todos, see the TODO(discussion) comments in TodoCommentService
  describe("TodoCommentService.getCommentsForTodo", () => {
    it("should return the comments of all users on the todo, oldest first, with the author", async () => {
      // written in a different order than created, so the test shows the order comes from createdAt
      await db.insert(todoComments).values([
        { todoId: todo.todoId, userId: creator.userId, comment: "third", createdAt: new Date("2026-11-18T10:10:00Z") },
        { todoId: todo.todoId, userId: creator.userId, comment: "first", createdAt: new Date("2026-11-18T10:00:00Z") },
        { todoId: todo.todoId, userId: other.userId, comment: "second", createdAt: new Date("2026-11-18T10:05:00Z") },
      ]);

      const discussion = await commentService.getCommentsForTodo(todo.todoId);

      expect(discussion.map((comment) => comment.comment)).toEqual(["first", "second", "third"]);
      expect(discussion[1].author).toEqual({ userId: other.userId, username: other.username });
    });

    it("should only return the comments of this todo", async () => {
      const otherTodo = await generateTodo(other.userId);
      await generateTodoComment(otherTodo.todoId, other.userId, { comment: "elsewhere" });

      expect(await commentService.getCommentsForTodo(todo.todoId)).toEqual([]);
    });

    it("should not return private fields of the author", async () => {
      await generateTodoComment(todo.todoId, other.userId);

      const [comment] = await commentService.getCommentsForTodo(todo.todoId);

      expect(Object.keys(comment.author)).toEqual(["userId", "username"]);
      expect(JSON.stringify(comment)).not.toContain(other.email);
    });
  });

  describe("TodoCommentService.canDeleteComment", () => {
    it("should let the author delete the own comment", () => {
      expect(commentService.canDeleteComment({ userId: other.userId }, todo, asUser(other))).toBe(true);
    });

    it("should let the creator of the todo moderate the discussion", () => {
      expect(commentService.canDeleteComment({ userId: other.userId }, todo, asUser(creator))).toBe(true);
    });

    it("should let an admin delete every comment", async () => {
      const admin = await generateUser();

      expect(commentService.canDeleteComment({ userId: other.userId }, todo, asAdmin(admin))).toBe(true);
    });

    it("should not let another participant delete the comment", async () => {
      const participant = await generateUser();

      expect(commentService.canDeleteComment({ userId: other.userId }, todo, asUser(participant))).toBe(false);
    });
  });
});
