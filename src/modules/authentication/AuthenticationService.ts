import { comparePasswords, hashPassword } from "@/utils/passwords";
import { BaseModule } from "../core/BaseModule";
import { UserService } from "../users/UserService";
import { users } from "../users/schema/user.schema";
import { db } from "@/db";
import { authentications } from "./schema/authentication.schema";
import { eq } from "drizzle-orm";
import TokenService from "./TokenService";
import { buildJwtClaims } from "../authorization/permissions";
import AuthorizationService from "../authorization/AuthorizationService";
import { HttpError } from "@/utils/HttpError";
import { isUniqueViolation } from "@/utils/dbErrors";

export class AuthenticationService extends BaseModule {
  public static instance: AuthenticationService;
  userService: UserService;
  tokenService: TokenService;
  authorizationService: AuthorizationService;

  constructor() {
    super("authentication.service", "Business logic for User authentication management");
    this.userService = new UserService();

    if (!AuthenticationService.instance) {
      AuthenticationService.instance = this;
    }

    this.tokenService = new TokenService();
    this.authorizationService = new AuthorizationService();

    return AuthenticationService.instance;
  }

  async register(
    email: string,
    username: string,
    password: string,
    firstName: string | undefined,
    lastName: string | undefined,
  ) {
    const user = await db
      .transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            email,
            username,
            firstName,
            lastName,
          })
          .returning();

        await tx.insert(authentications).values({
          userId: user.userId,
          password: await hashPassword(password),
        });

        return user;
      })
      .catch((error: unknown) => {
        // the message does not tell whether the email or the username is taken
        if (isUniqueViolation(error)) throw HttpError.conflict("Email or username already in use", error);
        throw error;
      });

    await this.authorizationService.assignRoleToUser(user.userId, "user");
    const authorization = await this.authorizationService.getAuthorizationForUser(user.userId);
    const tokenPair = await this.tokenService.generateTokenPair(buildJwtClaims(user, authorization));

    const result = {
      user: {
        userId: user.userId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        createdAt: user.createdAt,
      },
      tokenPair,
    };

    return result;
  }

  async login(email: string, password: string) {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user) throw HttpError.unauthorized("Invalid credentials");

    const authentication = await db.query.authentications.findFirst({
      where: eq(authentications.userId, user.userId),
    });
    if (!authentication) throw HttpError.unauthorized("Invalid credentials");

    const isValidatedPassword = await comparePasswords(password, authentication.password);
    if (!isValidatedPassword) throw HttpError.unauthorized("Invalid credentials");
    const authorization = await this.authorizationService.getAuthorizationForUser(user.userId);
    const tokenPair = await this.tokenService.generateTokenPair(buildJwtClaims(user, authorization));

    return tokenPair;
  }

  async rotateRefreshToken(incomingToken: string) {
    try {
      const { tokenPair } = await this.tokenService.rotateRefreshToken(incomingToken);

      return tokenPair;
    } catch (error) {
      // all reasons (unknown, expired, deleted user) look the same to the client
      const knownReasons = ["REFRESH_TOKEN_INVALID", "REFRESH_TOKEN_EXPIRED", "UNKNOWN_USER"];
      if (error instanceof Error && knownReasons.includes(error.message)) {
        throw HttpError.unauthorized("Invalid refresh token", error);
      }
      throw error;
    }
  }

  async revokeRefreshToken(incomingToken: string) {
    await this.tokenService.revokeRefreshToken(incomingToken);
  }
}

export default AuthenticationService;
