'use client';

import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { messagingApi } from '@/lib/services/messaging-api';
import { mentorApi } from '@/lib/services/mentor-api';
import { acquireSocket } from '@/lib/services/socket-client';
import { APPROVALS_CHANGED } from '@/lib/utils/approvals-badge';
import { qk, useApiQuery, STALE } from '@/lib/query';
import { unreadCountForClan } from '@/lib/utils/clan-scope';
import { ALL_CLANS } from '@/lib/context/ClanContext';
import type { ConversationSummary } from '@/lib/types/messaging';

export interface ApprovalCounts { total: number; byClan: Record<string, number> }

const NO_COUNTS: ApprovalCounts = { total: 0, byClan: {} };

type BadgeConversation = Pick<ConversationSummary, 'clanIds' | 'unreadCount'>;
const NO_CONVERSATIONS: BadgeConversation[] = [];

/**
 * The sidebar's unread-message and approvals badges.
 *
 * Both are cached and invalidated by events (socket, APPROVALS_CHANGED) rather
 * than refetched on navigation, which is what used to make every route change
 * cost two requests.
 */
export function useNavBadges({
  userId,
  isMentor,
  portal,
  activeClanId,
  menteeActiveClanId = ALL_CLANS,
}: { userId?: string; isMentor: boolean; portal: string; activeClanId: string; menteeActiveClanId?: string }) {
  const client = useQueryClient();

  // Cache the conversations, derive the badge from them. The badge has to count
  // what the inbox will actually SHOW, which for a mentor means honouring the
  // sidebar's clan picker — it already counts the approvals queue that way. A
  // badge counting more than the list can display is how a mentor ends up
  // staring at "No conversations yet" next to a red 1.
  const { data: conversations = NO_CONVERSATIONS } = useApiQuery<BadgeConversation[]>({
    queryKey: qk.messaging.unreadCount(portal),
    queryFn: () => messagingApi.listConversations(50),
    enabled: !!userId,
    staleTime: STALE.short,
  });

  const messageClanId = portal === 'mentee' ? (menteeActiveClanId || ALL_CLANS) : (isMentor ? activeClanId : ALL_CLANS);
  const unreadMessageCount = useMemo(
    () => unreadCountForClan(conversations, messageClanId),
    [conversations, messageClanId]
  );

  const { data: approvalCounts = NO_COUNTS } = useMentorApprovalCounts(!!userId && isMentor);

  useEffect(() => {
    if (!isMentor) return;
    const onChanged = () => client.invalidateQueries({ queryKey: qk.mentor.approvalsCount });
    window.addEventListener(APPROVALS_CHANGED, onChanged);
    return () => window.removeEventListener(APPROVALS_CHANGED, onChanged);
  }, [isMentor, client]);

  useEffect(() => {
    if (!userId) return;
    const socket = acquireSocket();
    if (!socket) return;

    const onNotification = (data: { type?: string }) => {
      if (data?.type === 'message') client.invalidateQueries({ queryKey: qk.messaging.unreadCount(portal) });
      else if (data?.type === 'task') client.invalidateQueries({ queryKey: qk.mentor.approvalsCount });
    };
    const onUnreadCount = () => client.invalidateQueries({ queryKey: qk.messaging.unreadCount(portal) });

    socket.on('notification:new', onNotification);
    socket.on('message:unread-count', onUnreadCount);
    return () => {
      socket.off('notification:new', onNotification);
      socket.off('message:unread-count', onUnreadCount);
    };
  }, [userId, client, portal]);

  return { unreadMessageCount, approvalCounts };
}

/** Shared lightweight count: cockpit and sidebar use the same approval scope. */
export function useMentorApprovalCounts(enabled: boolean) {
  return useApiQuery<ApprovalCounts>({
    queryKey: qk.mentor.approvalsCount,
    queryFn: async () => {
      const r = await mentorApi.getApprovalsCount() as { data?: ApprovalCounts };
      return { total: r?.data?.total ?? 0, byClan: r?.data?.byClan ?? {} };
    },
    enabled,
    staleTime: STALE.short,
  });
}
