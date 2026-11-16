import TokenService from "./TokenService";
import { logger } from "@/utils/logger";

export const REFRESH_TOKEN_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Removes expired and old used refresh tokens once right away and then in the given interval.
 * The timer does not keep the process alive.
 * @returns a function that stops the cleanup
 */
export function startRefreshTokenCleanup(intervalMs = REFRESH_TOKEN_CLEANUP_INTERVAL_MS): () => void {
  const tokenService = new TokenService();

  const cleanup = async () => {
    try {
      const removed = await tokenService.deleteExpiredRefreshTokens();
      if (removed > 0) logger.info({ removed }, "Removed expired refresh tokens");
    } catch (error) {
      // a failed cleanup must never crash the api, the next run tries again
      logger.error({ err: error }, "Cleanup of expired refresh tokens failed");
    }
  };

  void cleanup();
  const timer = setInterval(cleanup, intervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
