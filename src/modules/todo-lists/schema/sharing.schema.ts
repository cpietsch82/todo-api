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

export type ListMemberParams = z.infer<typeof listMemberParamsSchema>;
export type ChangeMemberRoleBody = z.infer<typeof changeMemberRoleSchema>;
export type TransferListBody = z.infer<typeof transferListSchema>;
