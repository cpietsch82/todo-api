import type { Response } from "express";
import { APIModule } from "../core/APIModule";
import { AuthenticationService } from "./AuthenticationService";
import { TypedRequestBody } from "../express/Express";
import { validateBody } from "@/middleware/validate";
import { RegisterBody, registerSchema, loginSchema, LoginBody, refreshSchema, RefreshBody } from "./schema/authentication.schema";
import TokenService from "./TokenService";
import { createAuthMiddleware } from "@/middleware/authenticateToken";
import { requireAuthentication } from "@/middleware/permissions";

export class AuthenticationAPI extends APIModule {
  public static instance: AuthenticationAPI;
  protected service: AuthenticationService;
  protected tokenService: TokenService;

  constructor() {
    super("authentication.api", "API Module for user authentication operations", "/auth", true);

    this.service = new AuthenticationService();
    if (!AuthenticationAPI.instance) AuthenticationAPI.instance = this;
    this.tokenService = new TokenService();

    return AuthenticationAPI.instance;
  }

  protected initializeRoutes(): void {
    // TokenService is a singleton — using new TokenService() here avoids accessing
    // this.tokenService before it is assigned (super() runs initializeRoutes before
    // the constructor body sets this.tokenService).
    const authenticate = createAuthMiddleware(new TokenService());
    this.router.post("/register", validateBody(registerSchema), this.register.bind(this));
    this.router.post("/login", validateBody(loginSchema), this.login.bind(this));
    this.router.post("/refresh", validateBody(refreshSchema), this.refresh.bind(this));
    this.router.post("/logout", validateBody(refreshSchema), authenticate, requireAuthentication(), this.logout.bind(this));

    // -------------------------------------------------------------------------
    // GET /auth/me  (protected Test-Route)
    // -------------------------------------------------------------------------
    // this.router.get("/me", authenticate, this.checkMe.bind(this));
  }

  private async checkMe(req: TypedRequestBody<{ user: object }>, res: Response) {
    res.json({ user: req.user });
  }

  /**
   * Register a new user and returns a jwt token for authentication
   */
  private async register(req: TypedRequestBody<RegisterBody>, res: Response) {
    const { email, username, password, firstName, lastName } = req.body;
    const { user, tokenPair } = await this.service.register(email, username, password, firstName, lastName);

    const { accessToken, refreshToken } = tokenPair;
    res.status(201).json({ message: "User created", user, accessToken, refreshToken });
  }

  /**
   * Login with an existing user.
   */
  private async login(req: TypedRequestBody<LoginBody>, res: Response) {
    const { email, password } = req.body;

    const { accessToken, refreshToken } = await this.service.login(email, password);

    res.status(201).json({ accessToken, refreshToken });
  }

  /**
   * Refresh token
   */
  private async refresh(req: TypedRequestBody<RefreshBody>, res: Response) {
    const { refreshToken } = req.body; // as { refreshToken?: string };

    if (!refreshToken) {
      return res.status(400).json({ error: "refreshToken is required" });
    }

    try {
      const tokenPair = await this.service.rotateRefreshToken(refreshToken);
      res.json(tokenPair);
    } catch (err: Error | unknown) {
      res.status(401).json({ error: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  /**
   * Logout
   */
  private async logout(req: TypedRequestBody<RefreshBody>, res: Response) {
    const { refreshToken } = req.body;
    if (refreshToken) this.service.revokeRefreshToken(refreshToken);
    res.json({ message: "Logged out successfully" });
  }
}

export default AuthenticationAPI;
