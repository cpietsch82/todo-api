import { z } from "zod";
import { RELEASE_TAG_PATTERN } from "../DeploymentService";
import { DEFAULT_LOG_TAIL, MAX_LOG_TAIL, SERVICE_NAME_PATTERN } from "../ContainerService";

// body of POST /admin/deployments/pull and /deploy. Unknown fields are rejected, so nothing else can be smuggled in.
export const deploymentTagSchema = z
  .object({
    tag: z.string().regex(RELEASE_TAG_PATTERN, "The tag has to be a released version like 1.2.3"),
  })
  .strict();

export const deploymentByIdSchema = z.object({
  deploymentId: z.uuid("Invalid DeploymentId"),
});

export const listDeploymentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const containerServiceSchema = z.object({
  service: z.string().regex(SERVICE_NAME_PATTERN, "Invalid service name"),
});

export const containerLogsQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(MAX_LOG_TAIL).default(DEFAULT_LOG_TAIL),
});

export const adminUserByIdSchema = z.object({
  userId: z.uuid("Invalid UserId"),
});

// body of PUT /admin/users/:userId/roles, the complete new list of roles (permissions follow from the roles)
export const userRolesSchema = z
  .object({
    roles: z
      .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, "Invalid role name"))
      .min(1, "A user needs at least one role")
      .max(20),
  })
  .strict();

export type DeploymentTagBody = z.infer<typeof deploymentTagSchema>;
export type AdminUserByIdParams = z.infer<typeof adminUserByIdSchema>;
export type UserRolesBody = z.infer<typeof userRolesSchema>;
export type ContainerServiceParams = z.infer<typeof containerServiceSchema>;
export type DeploymentByIdParams = z.infer<typeof deploymentByIdSchema>;
