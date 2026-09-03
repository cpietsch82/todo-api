import { comparePasswords, hashPassword } from "@/utils/passwords";
import { BaseModule } from "../core/BaseModule";
import { UserService } from "../users/UserService";
import { users } from "../users/schema/user.schema";
import { db } from "@/db";
import { authentications } from "./schema/auth.schema";
import { eq } from "drizzle-orm";
import TokenService from "./TokenService";

export class AuthService extends BaseModule {
  public static instance: AuthService;
  userService: UserService;
  tokenService: TokenService;

  constructor() {
    super("auth.service", "Business logic for User authentication management");
    this.userService = new UserService();

    if (!AuthService.instance) {
      AuthService.instance = this;
    }

    this.tokenService = new TokenService();

    return AuthService.instance;
  }

  async register(
    email: string,
    username: string,
    password: string,
    firstName: string | undefined,
    lastName: string | undefined,
  ) {
    const result = await db.transaction(async (tx) => {
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

      const tokenPair = await this.tokenService.generateTokenPair({
        id: user.userId,
        email: user.email,
        username: user.username,
      });

      return {
        user: {
          userId: user.userId,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          createdAt: user.createdAt,
        },
        tokenPair,
      };
    });

    return result;
  }

  async login(email: string, password: string) {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user) throw Error("Invalid credentials");

    const authentication = await db.query.authentications.findFirst({
      where: eq(authentications.userId, user.userId),
    });
    if (!authentication) throw Error("Invalid credentials");

    const isValidatedPassword = await comparePasswords(password, authentication.password);
    if (!isValidatedPassword) throw Error("Invalid credentials");

    const tokenPair = await this.tokenService.generateTokenPair({
      id: user.userId,
      email: user.email,
      username: user.username,
    });

    return tokenPair;
  }

  async rotateRefreshToken(incomingToken: string) {
    const { tokenPair } = await this.tokenService.rotateRefreshToken(incomingToken);

    return tokenPair;
  }

  async revokeRefreshToken(incomingToken: string) {
    this.tokenService.revokeRefreshToken(incomingToken);
  }
}

export default AuthService;
