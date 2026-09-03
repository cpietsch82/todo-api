import env, { isDevEnv } from "../../env";
import pino from "pino";

export const logger = pino({
  level: env.LOG_LEVEL || "info",
  transport: isDevEnv()
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss Z",
          ignore: "pid,hostname",
        },
      }
    : undefined,
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
});
