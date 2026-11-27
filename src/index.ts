import { ExpressAPI } from "@modules/express/Express";
import { findAPIModuleFiles, instantiateAPIModules } from "@modules/core/apiLoader";
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the API modules are found at runtime, see apiLoader
  instantiateAPIModules(findAPIModuleFiles().map((file) => require(file)));
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
