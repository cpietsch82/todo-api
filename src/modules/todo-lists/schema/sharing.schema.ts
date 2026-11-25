import { z } from "zod";

// API request schemas for sharing a list: members, invitations, handing it over

/** the roles a member can get; the owner is no member role, it is handed over with the transfer */
const memberRoleSchema = z.enum(["editor", "viewer"]);

export const listMemberParamsSchema = z.object({
  listId: z.uuid("Invalid ListId"),
  userId: z.uuid("Invalid UserId"),
});

export const changeMemberRoleSchema = z.object({
  role: memberRoleSchema,
});

export const transferListSchema = z.object({
  userId: z.uuid("Invalid UserId"),
});

export const listInvitationParamsSchema = z.object({
  listId: z.uuid("Invalid ListId"),
  invitationId: z.uuid("Invalid InvitationId"),
});

export const invitationByIdSchema = z.object({
  invitationId: z.uuid("Invalid InvitationId"),
});

/**
 * Looser than the rules of the registration on purpose: an old username that does not meet today's rules should
 * still be found (404 instead of 400). Normalized like at the registration, the case is ignored by the lookup.
 */
export const createInvitationSchema = z.object({
  username: z.string().trim().normalize("NFKC").min(1, "Username is required").max(50, "Username is too long"),
  role: memberRoleSchema.default("viewer"),
});

export type ListMemberParams = z.infer<typeof listMemberParamsSchema>;
export type ChangeMemberRoleBody = z.infer<typeof changeMemberRoleSchema>;
export type TransferListBody = z.infer<typeof transferListSchema>;
export type ListInvitationParams = z.infer<typeof listInvitationParamsSchema>;
export type CreateInvitationBody = z.infer<typeof createInvitationSchema>;
export type InvitationByIdParams = z.infer<typeof invitationByIdSchema>;
