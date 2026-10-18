import type { XPost, AcquisitionOrigin } from "@personal-wiki/contracts/processing";

export type ObservedPost = {
  post: XPost;
  origins: AcquisitionOrigin[];
  variants: string[];
  conflict: boolean;
};
export type Posts = Map<string, ObservedPost>;
export const sourceOrder = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
export const originalText = (post: XPost) => (post.longText ?? post.text).replace(/\r\n?/g, "\n");
export const compatibleConversation = (a: XPost, b: XPost) =>
  a.conversationId === null || b.conversationId === null || a.conversationId === b.conversationId;

export function resolveFocus(anchorId: string, posts: Posts) {
  const anchor = posts.get(anchorId)?.post;
  if (!anchor) return { primaryId: anchorId, main: [], uncertain: true, conflict: false };
  let primary = anchor;
  let uncertain = anchor.authorId === null || anchor.parentStatus === "unknown";
  let conflict = posts.get(anchorId)!.conflict;
  const ancestors = new Set([anchorId]);
  while (primary.parentId !== null && primary.authorId !== null) {
    const parent = posts.get(primary.parentId);
    if (!parent) {
      uncertain = true;
      break;
    }
    if (
      ancestors.has(parent.post.id) ||
      !compatibleConversation(anchor, parent.post) ||
      parent.conflict
    ) {
      conflict = true;
      break;
    }
    if (parent.post.authorId === null) {
      uncertain = true;
      break;
    }
    if (parent.post.authorId !== primary.authorId) break;
    ancestors.add(parent.post.id);
    primary = parent.post;
    if (primary.parentStatus === "unknown") uncertain = true;
  }
  const main = [...ancestors].reverse();
  const members = new Set(main);
  for (let i = 0; i < main.length; i++) {
    const children = [...posts.values()]
      .filter(
        ({ post, conflict }) =>
          !conflict &&
          post.parentId === main[i] &&
          post.authorId !== null &&
          post.authorId === anchor.authorId &&
          compatibleConversation(post, anchor),
      )
      .sort((a, b) => sourceOrder(a.post.id, b.post.id));
    for (const child of children)
      if (!members.has(child.post.id)) {
        members.add(child.post.id);
        main.push(child.post.id);
      }
  }
  return { primaryId: uncertain ? anchorId : primary.id, main, uncertain, conflict };
}

/** A shared conversation is supporting metadata, never sufficient membership. */
export function reaches(id: string, roots: ReadonlySet<string>, posts: Posts) {
  const seen = new Set<string>();
  let current = posts.get(id);
  const initial = current?.post;
  while (current && initial && !seen.has(current.post.id)) {
    if (current.conflict || !compatibleConversation(initial, current.post)) return false;
    if (roots.has(current.post.id)) return true;
    seen.add(current.post.id);
    current = current.post.parentId ? posts.get(current.post.parentId) : undefined;
  }
  return false;
}

export function missingParents(ids: Iterable<string>, posts: Posts) {
  const missing = new Set<string>();
  for (const id of ids) {
    const seen = new Set<string>();
    let post = posts.get(id)?.post;
    while (post?.parentId && !seen.has(post.id)) {
      seen.add(post.id);
      if (!posts.has(post.parentId)) {
        missing.add(post.parentId);
        break;
      }
      post = posts.get(post.parentId)?.post;
    }
  }
  return [...missing].sort(sourceOrder);
}

export function allocate(targetIds: ReadonlyArray<string>, allowance: number) {
  const ids = [...new Set(targetIds)].slice(0, allowance);
  const each = Math.floor(allowance / ids.length);
  const remainder = allowance % ids.length;
  return ids.map((targetId, i) => ({ targetId, limit: each + (i < remainder ? 1 : 0) }));
}
