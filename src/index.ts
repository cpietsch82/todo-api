import { ExpressAPI } from "@modules/express/Express";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { TodoCommentAPI } from "@modules/todos/TodoCommentAPI";
import { TodoListAPI } from "@modules/todo-lists/TodoListAPI";
import { TodoListInvitationAPI } from "@modules/todo-lists/TodoListInvitationAPI";
import { TodoListContactAPI } from "@modules/todo-lists/TodoListContactAPI";
import { AuthenticationAPI } from "@/modules/authentication/AuthenticationAPI";
import { UserAPI } from "./modules/users/UserAPI";
import { AdminAPI } from "./modules/admin/AdminAPI";
import { waitForDatabase } from "@/db";
import { startRefreshTokenCleanup } from "@/modules/authentication/refreshTokenCleanup";
import env from "../env";
import { logger } from "@/utils/logger";

async function bootstrap() {
  if (env.EXPOSE_ERROR_DETAILS) {
    logger.warn("EXPOSE_ERROR_DETAILS is enabled: complete error messages and stack traces are sent to clients");
  }

  await waitForDatabase();

  const expressAPI = new ExpressAPI();
  new AuthenticationAPI();
  new TodoAPI();
  new TodoCommentAPI();
  new TodoListAPI();
  new TodoListInvitationAPI();
  new TodoListContactAPI();
  new UserAPI();
  new AdminAPI();
  expressAPI.listen();
  const stopRefreshTokenCleanup = startRefreshTokenCleanup();

  // graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);
    stopRefreshTokenCleanup();
    await expressAPI.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((error) => {
  console.error("Failed to start application: ", error);
  process.exit(1);
});
