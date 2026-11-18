import { z } from "zod";
import { RELEASE_TAG_PATTERN } from "../DeploymentService";

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

export type DeploymentTagBody = z.infer<typeof deploymentTagSchema>;
export type DeploymentByIdParams = z.infer<typeof deploymentByIdSchema>;
