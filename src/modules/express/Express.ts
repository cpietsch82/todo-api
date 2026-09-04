import express from "express";
import type { NextFunction, Request, Response, Express, Router, RequestHandler } from "express";
import { BaseModule } from "@modules/core/BaseModule";
import env from "../../../env";
import http from "http";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import compression from "compression";
import cookieParser from "cookie-parser";
import { randomUUID } from "crypto";
import { httpLogger } from "@/middleware/httpLogger";
import { createAuthMiddleware } from "@/middleware/authenticateToken";
import { additionalRequestDetailsForTesting } from "@/middleware/additionalRequestDetailsForTesting";
import { globalErrorHandler } from "@/middleware/globalErrorHandler";
import TokenService from "../authentication/TokenService";
import { requireAuthentication } from "@/middleware/permissions";
// import https from "https";
import { sql } from "drizzle-orm";
import { db } from "@/db";

// Extend Express's Response type to include custom response methods
declare global {
  namespace Express {
    interface Response {
      respondError: (message: string, status?: number, returnMessage?: boolean) => Response;
      respondAuthorizationRequired: (message?: string, returnMessage?: boolean) => Response;
      respondAuthorizationInsufficient: (message?: string, returnMessage?: boolean) => Response;
      respondMissingParameter: (param: string, status?: number, returnMessage?: boolean) => Response;
      respondMissingBody: (status?: number, returnMessage?: boolean) => Response;
      respondInvalidParameter: (
        param: string,
        explanation?: string,
        status?: number,
        returnMessage?: boolean,
      ) => Response;
      respondServiceUnavailable: (message: string, status?: number, returnMessage?: boolean) => Response;
      respondOkNoContent: () => Response;
      respondNotFound: (message?: string) => Response;
    }
  }
}

export type HTTPMethod = "get" | "post" | "put" | "delete" | "patch" | "options" | "head" | "all";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<any> | any;
export type RouteHandler = RequestHandler | AsyncRequestHandler | Array<RequestHandler | AsyncRequestHandler>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ParamHandler = (req: Request, res: Response, next: NextFunction, name: string) => Promise<any> | any;
// export type UnhandledRequestError = (err: Error, req: Request, res: Response, next: NextFunction) => Promise<any> | any;

export interface SubRouter {
  route: (...paths: string[]) => SubRouter;
  use: (pathOrHandler: string | RouteHandler, ...handlers: RouteHandler[]) => void;
  all: (pathOrHandler: string | RouteHandler, ...handlers: RouteHandler[]) => void;
  get: (pathOrHandler: string | RouteHandler, ...handlers: RouteHandler[]) => void;
  post: (pathOrHandler: string | RouteHandler, ...handlers: RouteHandler[]) => void;
  put: (pathOrHandler: string | RouteHandler, ...handlers: RouteHandler[]) => void;
  delete: (pathOrHandler: string | RouteHandler, ...handlers: RouteHandler[]) => void;
  patch: (pathOrHandler: string | RouteHandler, ...handlers: RouteHandler[]) => void;
  options: (pathOrHandler: string | RouteHandler, ...handlers: RouteHandler[]) => void;
  head: (pathOrHandler: string | RouteHandler, ...handlers: RouteHandler[]) => void;
  param: (name: string, handler: ParamHandler) => void;
  toString: () => string;
}

// Base Types
export type TypedRequestBody<TBody> = Omit<Request, "body"> & {
  body: TBody;
};

export type TypedRequestParams<TParams> = Omit<Request, "params"> & {
  params: TParams;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TypedRequest<TParams = any, TBody = any, TQuery = any> = Omit<Request, "params" | "body" | "query"> & {
  params: TParams;
  body: TBody;
  query: TQuery;
};

// // ✅ Authenticated Request (with User)
// export interface AuthenticatedRequest extends Request {
//   user: JwtPayload; // User is not optional (because it's authenticated)
// }

// // ✅ Authenticated + Typed Body
// export type AuthenticatedRequestBody<TBody> = Omit<AuthenticatedRequest, "body"> & {
//   body: TBody;
// };

// // ✅ Authenticated + Typed Params
// export type AuthenticatedRequestParams<TParams> = Omit<AuthenticatedRequest, "params"> & {
//   params: TParams;
// };

// // ✅ Authenticated + Typed Body + Params + Query (complete)
// export type AuthenticatedTypedRequest<TParams = any, TBody = any, TQuery = any> = Omit<
//   AuthenticatedRequest,
//   "params" | "body" | "query"
// > & {
//   params: TParams;
//   body: TBody;
//   query: TQuery;
//   user: JwtPayload;
// };

export class ExpressAPI extends BaseModule {
  private static instance: ExpressAPI;

  private app: Express;

  protected router: Router;
  protected preAuthRouter: Router;
  protected server: http.Server | null = null;
  protected tokenService: TokenService;

  static makeRequestLabel(req: Request) {
    return `${req.method ?? "request"} on ${req.originalUrl}`;
  }

  constructor() {
    super("express.api", "Module for Express API Configuration");

    this.app = express();
    this.app.use(this.addResponseHandler.bind(this));

    this.router = express.Router();
    this.preAuthRouter = express.Router();

    this.tokenService = new TokenService();

    this.setupMiddleware();
    this.setupErrorHandling();

    // this.setupAPIRoutes(); // ?? automatically initialize all necessary api packages to setup routes

    if (!ExpressAPI.instance) ExpressAPI.instance = this;

    return ExpressAPI.instance;
  }

  private setupMiddleware(): void {
    this.app.use(express.json({ limit: "4mb" }));
    // this.router.use((err, req, res, next) => res.respondError("Body is malformed JSON: " + err.message, 400, true))
    this.app.use(express.urlencoded({ extended: true, limit: "10mb" }));

    const authenticate = createAuthMiddleware(this.tokenService);
    this.router.use(authenticate);
    this.router.use(this.preAuthRouter);
    this.router.use(requireAuthentication());
    this.router.use(additionalRequestDetailsForTesting);

    // security headers
    this.app.use(helmet());
    // CORS - cross origin resource sharing
    this.app.use(
      cors({
        origin: env.ALLOWED_ORIGINS?.split(",") || "*",
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
      }),
    );
    // request logging
    this.app.use(httpLogger);
    // rate limiting
    const limiter = rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_PER_IP,
      message: "Too many requests from this IP, please try again later.",
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        this.logger.warn({ ip: req.ip, path: req.path }, "Rate limit exceeded");
        res.respondError("Too many requests from this IP, please try again later.", 429);
      },
    });
    this.app.use("/api/", limiter);
    // response compression
    this.app.use(compression());
    // cookie parser
    this.app.use(cookieParser());
    // request ID for tracing
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).id = randomUUID();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.setHeader("X-Request-ID", (req as any).id);
      next();
    });

    // use api sub route per default
    this.app.use("/api", this.router);

    // api health check
    this.preAuthRouter.get("/health", async (_req: Request, res: Response) => {
      try {
        // const { db } = await import("../../db/index.js");
        // const { sql } = await import("drizzle-orm");
        await db.execute(sql`SELECT 1`);
        res.json({
          status: "OK",
          db: "connected",
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
        });
      } catch (error) {
        this.logger.error({ error }, "Health check: database unreachable");
        res.status(503).json({
          status: "degraded",
          db: "unreachable",
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
        });
      }
    });
  }

  private setupErrorHandling(): void {
    // 404 Handler
    this.app.use((req: Request, res: Response) => {
      this.logger.warn({ path: req.path, method: req.method }, "Route not found");
      res.respondNotFound(`Route ${req.path} not found.`);
    });

    this.app.use(globalErrorHandler("Unhandled Error"));
  }

  // for later https availability
  /**
   * @returns an option object to configure the server's TLSSecureContext or so from {@link #credentials}
   */
  // buildSecureContextOptions() {
  //   this.console.info("loaded certificate is valid until", this.credentials.certificateChain[0].validity.notAfter);
  //   return {
  //     key: pki.privateKeyToPem(this.credentials.privateKey),
  //     cert: this.credentials.certificateChain.map((cert) => pki.certificateToPem(cert)).join(""),
  //   };
  // }

  // getRouter() {
  //   return this.router;
  // }

  /**
   * Added predefined response handlers to the response object from express
   */
  private addResponseHandler(req: Request, res: Response, next: NextFunction) {
    res.respondError = (message: string, status = 500, returnMessage = false) =>
      this.respondError(req, res, message, status, returnMessage);
    res.respondAuthorizationRequired = (message = "Authorization required!", returnMessage = false) =>
      res.respondError(message, 401, returnMessage);
    res.respondAuthorizationInsufficient = (message = "Insufficient Permissions!", returnMessage = false) =>
      res.respondError(message, 403, returnMessage);
    res.respondMissingParameter = (param, status = 400, returnMessage = true) =>
      res.respondError(`missing parameter ${param}`, status, returnMessage);
    res.respondMissingBody = (status = 400, returnMessage = true) =>
      res.respondError("missing body", status, returnMessage);
    res.respondInvalidParameter = (param, explanation = undefined, status = 400, returnMessage = true) => {
      let message = `parameter ${param} has invalid value`;
      if (explanation) message += `: ${explanation}`;
      return res.respondError(message, status, returnMessage);
    };
    res.respondServiceUnavailable = (message, status = 503, returnMessage = true) =>
      res.respondError(message, status, returnMessage);
    res.respondOkNoContent = () => res.status(204).end();
    res.respondNotFound = (message = "Not found.") => res.status(404).send(message);
    // res.betterRespondNotFound = (message = "Not found.") => res.status(410).send(message)
    return next();
  }

  private respondError(_req: Request, res: Response, message: string, status = 500, returnMessage = false) {
    if (typeof message !== "string" || typeof status !== "number")
      throw new Error(
        "don't mix up your parameters please (this is otherwise reported as an express deprecation warning, which is hard to locate the origin)!",
      );
    // if (this.debug) console.warn(ExpressAPI.makeRequestLabel(req) + " returning " + status + " because " + message);
    res.status(status);
    // if (this.debug || returnMessage === true || req.hasPermission?.("express.see.hidden.errors")) res.send(message);
    // res.end();
    if (returnMessage) res.send(message);
    return res.end();
  }

  // helper method for typesafe apply calls
  private applyHandlers(method: HTTPMethod, router: Router, handlers: RequestHandler[]): void {
    const routerMethod = router[method] as (...args: RequestHandler[]) => Router;
    routerMethod.apply(router, handlers);
  }

  // because typescript is sometimes to strict and cannot calculate how many paths exists during compile time
  // so the only solution here is to use the apply function to avoid typescript parsing
  private useWithPaths(parentRouter: Router, paths: string[], router: Router): void {
    const args = [...paths, router];
    (parentRouter.use as (...args: unknown[]) => Router).apply(parentRouter, args);
  }

  public preAuthRoute(...paths: string[]): SubRouter {
    return this.route(this.preAuthRouter, ...paths);
  }

  public route(parentRouter: Router | string, ...paths: string[]): SubRouter {
    let actualParentRouter: Router;
    let actualPaths: string[];

    if (typeof parentRouter === "string") {
      // case 1: api.route("/todos")
      actualPaths = [parentRouter, ...paths];
      actualParentRouter = this.router;
    } else {
      // case 2: api.route(existingRouter, "/subtask")
      actualParentRouter = parentRouter;
      actualPaths = paths;
    }

    const router = express.Router();
    this.useWithPaths(actualParentRouter, actualPaths, router);
    // if (actualPaths.length > 0) {
    //   // because typescript is sometimes to strict and cannot calculate how many paths exists during compile time
    //   // so the only solution here is to use the apply function to avoid typescript parsing
    //   (actualParentRouter.use as Function).apply(actualParentRouter, [...actualPaths, router]);
    // } else {
    //   actualParentRouter.use(router);
    // }

    const subRouterRouter = express.Router();
    router.use(subRouterRouter);

    // helper for HTTP methods with optional path
    const createMethodHandler = (method: HTTPMethod) => {
      return (pathOrHandler: string | RouteHandler, ...handlers: RouteHandler[]) => {
        if (typeof pathOrHandler === "string") {
          // path was passed: router.get('/path', handler1, handler2)
          this.applyHandlers(method, router, [pathOrHandler, ...handlers] as RequestHandler[]);
        } else {
          // only handler: router.get(handler1, handler2)
          this.applyHandlers(method, router, [pathOrHandler, ...handlers] as RequestHandler[]);
        }
      };
    };

    return {
      route: (...routePaths: string[]) => this.route(subRouterRouter, ...routePaths),

      use: (pathOrHandler: string | RouteHandler, ...handlers: RouteHandler[]) => {
        router.use(...([pathOrHandler, ...handlers] as Parameters<typeof router.use>));
        // if (typeof pathOrHandler === "string") {
        //   router.use(...([pathOrHandler, ...handlers] as Parameters<typeof router.use>));
        // } else {
        //   router.use(...([pathOrHandler, ...handlers] as Parameters<typeof router.use>));
        // }
      },

      all: createMethodHandler("all"),
      get: createMethodHandler("get"),
      post: createMethodHandler("post"),
      put: createMethodHandler("put"),
      delete: createMethodHandler("delete"),
      patch: createMethodHandler("patch"),
      options: createMethodHandler("options"),
      head: createMethodHandler("head"),

      param: (name: string, handler: ParamHandler) => {
        router.param(name, handler);
      },

      toString: () => String(actualParentRouter) + actualPaths[0],
    };
  }

  public listen(port: number = env.PORT, callback?: () => void): http.Server {
    this.app.use(this.router);
    this.server = http.createServer(this.app);

    this.server.listen(port, () => {
      this.logger.info(`🚀 Server is running on http://localhost:${port}`);
      if (callback) callback();
    });

    return this.server;
  }

  public async close(): Promise<void> {
    if (!this.server) {
      throw new Error("Server was not started yet");
    }

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          this.logger.error({ err }, "Error while closing server");
          reject(err);
        } else {
          this.logger.info("Server has been shut down");
          resolve();
        }
      });
    });
  }

  public getServer(): http.Server | null {
    return this.server;
  }

  public getApp(): Express {
    return this.app;
  }

  public getRouter(): Router {
    return this.router;
  }
}

export default ExpressAPI;
