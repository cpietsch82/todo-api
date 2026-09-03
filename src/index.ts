import { ExpressAPI } from "@modules/express/Express";
import { TodoAPI } from "@modules/todos/TodoAPI";
import { AuthAPI } from "@/modules/authentication/AuthAPI";
import { UserAPI } from "./modules/users/UserAPI";
import { waitForDatabase } from "@/db";

async function bootstrap() {
  await waitForDatabase();

  const expressAPI = new ExpressAPI();
  new AuthAPI();
  new TodoAPI();
  new UserAPI();
  expressAPI.listen();

  // graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);
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
