// Limits against abuse, see the design of the todo lists.

/** lists a user may own */
export const MAX_LISTS_PER_USER = 100;
/** todos in one list */
export const MAX_TODOS_PER_LIST = 500;
/** members of one list, the owner not counted */
export const MAX_MEMBERS_PER_LIST = 20;
/** open invitations of one list */
export const MAX_OPEN_INVITATIONS_PER_LIST = 20;
/** an invitation expires after 14 days */
export const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
