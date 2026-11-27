/** a mention is the token <@uuid> with a lowercase uuid; anything else in the text is plain text */
const mentionPattern = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;

/** ids of all mentioned users, without duplicates, in the order of their first appearance; a deleted comment (null) mentions nobody */
export function extractMentionIds(text: string | null): string[] {
  if (text === null) return [];
  const ids = new Set<string>();
  for (const match of text.matchAll(mentionPattern)) {
    ids.add(match[1]);
  }
  return [...ids];
}
