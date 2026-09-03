import pinoHttp from "pino-http";
import { logger } from "@utils/logger";
import { IncomingMessage } from "http";
import { ServerResponse } from "http";

export const httpLogger = pinoHttp({
  logger,
  serializers: {
    // overrides the standard serializer for 'req'
    req: (req: IncomingMessage) => ({
      method: req.method,
      url: req.url,
      // add only what you really need
    }),
    // overrides the standard serializer for 'res'
    res: (res: ServerResponse<IncomingMessage>) => ({
      statusCode: res.statusCode,
      statusMessage: res.statusMessage,
    }),
  },
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 400 && res.statusCode < 500) {
      return "warn";
    } else if (res.statusCode >= 500 || err) {
      return "error";
    }
    return "info";
  },
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${req.url} ${res.statusCode} - ${err.message}`;
  },
});
