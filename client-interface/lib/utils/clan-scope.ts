import { ALL_CLANS } from '@/lib/context/ClanContext';
import type { ConversationSummary } from '@/lib/types/messaging';

/**
 * How the sidebar's clan picker narrows a list — one rule, in one place.
 *
 * A mentor can run several clans, and the picker scopes their screens to one of
 * them. Each screen used to implement that filter itself, which produced two
 * recurring faults:
 *
 *   1. **The badge and the list disagreed.** The sidebar counted every unread
 *      conversation while the inbox counted only the selected clan's, so a
 *      mentor could read "No conversations yet" with a red 1 beside Messages.
 *   2. **The empty state blamed the data.** A list emptied by the picker said
 *      "All caught up" or "No mentees yet" — which is false when the work is
 *      simply sitting in another clan, and indistinguishable from a real bug.
 *
 * The rule below also refuses to hide what it cannot attribute. A conversation
 * with an admin belongs to no clan; a submission from a mentee matched 1:1 has
 * no clan either. Dropping those from every clan view makes them unreachable,
 * so they show in all of them instead. This mirrors the server's own rule when
 * it splits the inbox by role: never hide what cannot be classified.
 */

/** Does a row attributed to `clanIds` belong in the `activeClanId` view? */
export function matchesClanScope(clanIds: readonly string[] | null | undefined, activeClanId: string): boolean {
  if (!activeClanId || activeClanId === ALL_CLANS) return true;
  if (!clanIds || clanIds.length === 0) return true; // unattributable → always shown
  return clanIds.includes(activeClanId);
}

export interface ClanScopeResult<T> {
  /** What to render. */
  visible: T[];
  /** How many rows the picker held back — 0 when it filtered nothing. */
  hiddenByClan: number;
  /** True when a clan is selected and it is what emptied the list. */
  emptiedByClan: boolean;
}

/**
 * Narrow any list to the selected clan, reporting what was removed so the
 * caller can say "none in this clan" rather than "none at all".
 *
 * `clanIdsOf` maps a row to the clans it belongs to — one id for a mentee or a
 * submission, several for a conversation (its counterparts' clans).
 */
export function scopeToClan<T>(
  rows: readonly T[],
  activeClanId: string,
  clanIdsOf: (row: T) => readonly string[] | null | undefined,
): ClanScopeResult<T> {
  if (!activeClanId || activeClanId === ALL_CLANS) {
    return { visible: rows as T[], hiddenByClan: 0, emptiedByClan: false };
  }
  const visible = rows.filter((row) => matchesClanScope(clanIdsOf(row), activeClanId));
  const hiddenByClan = rows.length - visible.length;
  return { visible, hiddenByClan, emptiedByClan: visible.length === 0 && hiddenByClan > 0 };
}

/** A row that names clan(s) — prefer `clans[]` so dual memberships stay visible. */
export const clanIdOfRow = (row: {
  clan?: { id: string } | null;
  clans?: Array<{ id: string } | null> | null;
}): string[] => {
  if (Array.isArray(row.clans) && row.clans.length) {
    return row.clans.map((c) => c?.id).filter((id): id is string => Boolean(id));
  }
  return row.clan?.id ? [row.clan.id] : [];
};

// ── Conversations ────────────────────────────────────────────────────────────

/**
 * A conversation's `clanIds` is the set of clans its OTHER participants
 * currently belong to — a proxy for "this thread is about that clan", and a
 * lossy one, which is why the unattributable case above matters most here.
 * Only mentors have a picker; the other portals pass straight through.
 */
export function scopeConversationsToClan<T extends Pick<ConversationSummary, 'clanIds'>>(
  conversations: T[],
  role: 'admin' | 'mentor' | 'mentee',
  activeClanId: string,
): ClanScopeResult<T> {
  // Mentors and mentees both pick a clan when dual-membered; admin stays unscoped.
  // Unattributable threads (empty clanIds) still show via matchesClanScope.
  if (role !== 'mentor' && role !== 'mentee') {
    return { visible: conversations, hiddenByClan: 0, emptiedByClan: false };
  }
  return scopeToClan(conversations, activeClanId, (c) => c.clanIds);
}

/** Unread total for what the user can actually see — what the sidebar badge counts. */
export function unreadCountForClan(
  conversations: Array<Pick<ConversationSummary, 'clanIds' | 'unreadCount'>>,
  activeClanId: string,
): number {
  return conversations
    .filter((c) => matchesClanScope(c.clanIds, activeClanId))
    .reduce((sum, c) => sum + (c.unreadCount || 0), 0);
}
