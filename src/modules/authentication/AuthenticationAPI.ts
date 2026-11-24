import type { Response } from "express";
import { APIModule } from "../core/APIModule";
import { AuthenticationService } from "./AuthenticationService";
import { TypedRequestBody } from "../express/Express";
import { validateBody } from "@/middleware/validate";
import { RegisterBody, registerSchema, loginSchema, LoginBody, refreshSchema, RefreshBody } from "./schema/authentication.schema";
import TokenService from "./TokenService";
import {
  createLoginAccountRateLimiter,
  createLoginRateLimiter,
  createRegisterRateLimiter,
  createTokenRateLimiter,
} from "@/middleware/rateLimit";

export class AuthenticationAPI extends APIModule {
  public static instance: AuthenticationAPI;
  protected authenticationService: AuthenticationService;
  protected tokenService: TokenService;

  constructor() {
    super("authentication.api", "API Module for user authentication operations", "/auth", true);

    this.authenticationService = new AuthenticationService();
    if (!AuthenticationAPI.instance) AuthenticationAPI.instance = this;
    this.tokenService = new TokenService();

    return AuthenticationAPI.instance;
  }

  protected initializeRoutes(): void {
    this.router.post("/register", createRegisterRateLimiter(), validateBody(registerSchema), this.register.bind(this));
    // the limit per account comes after the validation, because it counts by the normalized e-mail
    this.router.post(
      "/login",
      createLoginRateLimiter(),
      validateBody(loginSchema),
      createLoginAccountRateLimiter(),
      this.login.bind(this),
    );
    this.router.post("/refresh", createTokenRateLimiter(), validateBody(refreshSchema), this.refresh.bind(this));
    // logout needs no access token: the refresh token itself proves that the client may revoke it,
    // so a client with an expired access token can still end its session on the server
    this.router.post("/logout", createTokenRateLimiter(), validateBody(refreshSchema), this.logout.bind(this));
  }

  private async checkMe(req: TypedRequestBody<{ user: object }>, res: Response) {
    res.json({ user: req.user });
  }

  /**
   * Register a new user and returns a jwt token for authentication
   */
  private async register(req: TypedRequestBody<RegisterBody>, res: Response) {
    const { email, username, password, firstName, lastName } = req.body;
    const { user, tokenPair } = await this.authenticationService.register(email, username, password, firstName, lastName);

    const { accessToken, refreshToken } = tokenPair;
    res.status(201).json({ message: "User created", user, accessToken, refreshToken });
  }

  /**
   * Login with an existing user.
   */
  private async login(req: TypedRequestBody<LoginBody>, res: Response) {
    const { email, password } = req.body;

    const { accessToken, refreshToken } = await this.authenticationService.login(email, password);

    res.status(201).json({ accessToken, refreshToken });
  }

  /**
   * Refresh token
   */
  private async refresh(req: TypedRequestBody<RefreshBody>, res: Response) {
    const { refreshToken } = req.body;

    const tokenPair = await this.authenticationService.rotateRefreshToken(refreshToken);
    res.json(tokenPair);
  }

  /**
   * Logout
   */
  private async logout(req: TypedRequestBody<RefreshBody>, res: Response) {
    const { refreshToken } = req.body;
    if (refreshToken) await this.authenticationService.revokeRefreshToken(refreshToken);
    res.json({ message: "Logged out successfully" });
  }
}

export default AuthenticationAPI;
