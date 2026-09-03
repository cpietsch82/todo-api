import { db } from "@/db";
import { eq } from "drizzle-orm";
import { BaseModule } from "../core/BaseModule";
import { users, type NewUser, type UpdateUser, type User } from "./schema/user.schema";

export class UserService extends BaseModule {
  public static instance: UserService;

  constructor() {
    super("user.service", "Business logic for User management");

    if (!UserService.instance) {
      UserService.instance = this;
    }
    return UserService.instance;
  }

  async createUser(data: NewUser): Promise<User> {
    const [user] = await db.insert(users).values(data).returning();

    return user;
  }

  async updateUser(userId: string, updateData: UpdateUser): Promise<User> {
    const [user] = await db.update(users).set(updateData).where(eq(users.userId, userId)).returning();

    return user;
  }

  async getAllUsers(): Promise<User[]> {
    const users = await db.query.users.findMany({});

    return users;
  }

  async getUserById(userId: string): Promise<User | undefined> {
    const user = await db.query.users.findFirst({
      where: eq(users.userId, userId),
    });

    return user;
  }

  async deleteUser(userId: string): Promise<User> {
    const [user] = await db.delete(users).where(eq(users.userId, userId)).returning();

    return user;
  }
}

export default UserService;
