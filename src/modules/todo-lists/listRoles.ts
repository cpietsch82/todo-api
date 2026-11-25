import type { ListRole } from "./schema/todo-list.schema";

const LIST_ROLE_RANK: Readonly<Record<ListRole, number>> = { viewer: 1, editor: 2, owner: 3 };

/**
 * Whether a role in a list is at least the given one (owner > editor > viewer).
 * @param role undefined when the user has no role in the list
 */
export function hasListRole(role: ListRole | undefined, minimum: ListRole): boolean {
  return role !== undefined && LIST_ROLE_RANK[role] >= LIST_ROLE_RANK[minimum];
}
