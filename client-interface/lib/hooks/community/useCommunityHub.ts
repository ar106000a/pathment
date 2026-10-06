import { useState, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { communityApi, type ScopeType, type PostType, type ReactionType, type CreatePostInput } from '@/lib/services/community-api';
import { qk, useApiQuery, STALE } from '@/lib/query';
import { useClan, ALL_CLANS } from '@/lib/context/ClanContext';

export interface CommunitySpace {
  readOnly?: boolean;
  key: string;
  type: ScopeType;
  id: string | null;
  name: string;
  subtitle?: string;
  role?: string;
  isModerator?: boolean;
}

export interface CommunityPost {
  id: string;
  type: PostType;
  scopeType: ScopeType;
  scopeId: string | null;
  title: string | null;
  body: string;
  tags: string[];
  linkUrl: string | null;
  attachments: { url?: string; name?: string; kind?: string }[];
  at: string;
  editedAt: string | null;
  pinned: boolean;
  resolved: boolean;
  acceptedCommentId: string | null;
  commentCount: number;
  author: { id: string; name: string; avatar: string; avatarUrl?: string | null };
  recipient: { id: string; name: string } | null;
  reactions: Record<ReactionType, number>;
  myReactions: ReactionType[];
  mine: boolean;
}

export interface CommunityComment {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  at: string;
  editedAt: string | null;
  accepted: boolean;
  author: { id: string; name: string; avatar: string; avatarUrl?: string | null };
  mine: boolean;
}

export interface CommunityStats { given: number; cheersReceived: number; posts: number; openQuestions: number }
export interface CommunityPerson { id: string; name: string }
export interface CommunityMember { id: string; name: string; avatar: string; avatarUrl?: string | null; role: string }
export interface LeaderboardEntry { rank: number; userId: string; name: string; avatar?: string; avatarUrl?: string | null; points: number; tier: string; mine?: boolean }
export interface LeaderboardSelf { rank: number | null; userId: string; name: string; points: number; tier: string }

interface FeedData {
  feed: CommunityPost[];
  shoutouts: CommunityPost[];
  stats: CommunityStats | null;
}
interface LeaderboardData {
  leaderboard: LeaderboardEntry[];
  me: LeaderboardSelf | null;
}

const NO_FEED: FeedData = { feed: [], shoutouts: [], stats: null };
const NO_LEADERBOARD: LeaderboardData = { leaderboard: [], me: null };
const NO_SPACES: CommunitySpace[] = [];
const NO_PEOPLE: CommunityPerson[] = [];
const NO_MEMBERS: CommunityMember[] = [];

export function useCommunityHub() {
  const [spaceOverride, setActiveKey] = useState<string | null>(null);
  const [lbPeriod, setLbPeriod] = useState<'week' | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<PostType | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const spacesQuery = useApiQuery<CommunitySpace[]>({
    queryKey: qk.community.spaces,
    queryFn: async () => (await communityApi.spaces())?.data?.spaces ?? [],
    staleTime: STALE.long,
    errorMessage: 'Failed to load your community spaces',
  });

  const spaces = spacesQuery.data ?? NO_SPACES;
  const loadingSpaces = spacesQuery.loading;

  // Follow the global clan selector when it points at a specific clan; an
  // explicit pick in this page wins. Derived, so no effect can fall out of step.
  const { activeClanId } = useClan();
  const activeKey = useMemo(() => {
    if (spaceOverride && spaces.some((s) => s.key === spaceOverride)) return spaceOverride;
    const clanKey = `clan:${activeClanId}`;
    if (activeClanId !== ALL_CLANS && spaces.some((s) => s.key === clanKey)) return clanKey;
    // Clan-first, else the first space we have.
    return spaces.find((s) => s.type === 'clan')?.key || spaces[0]?.key || null;
  }, [spaceOverride, spaces, activeClanId]);

  const active = useMemo(() => spaces.find((s) => s.key === activeKey) || null, [spaces, activeKey]);
  const scope = { type: active?.type ?? '', id: active?.id ?? '' };

  const feedQuery = useApiQuery<FeedData>({
    queryKey: qk.community.feed({ ...scope, type: typeFilter, tag: tagFilter, q: query || null }),
    queryFn: async () => {
      const res = await communityApi.feed({
        scopeType: active!.type,
        scopeId: active!.id,
        type: typeFilter,
        tag: tagFilter,
        q: query || null,
      });
      return {
        feed: res?.data?.feed ?? [],
        shoutouts: res?.data?.shoutouts ?? [],
        stats: res?.data?.stats ?? null,
      };
    },
    enabled: !!active,
    staleTime: STALE.short,
    errorMessage: 'Failed to load the feed',
  });

  const peopleQuery = useApiQuery<CommunityPerson[]>({
    queryKey: qk.community.people(scope.type, scope.id),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: async () => ((await communityApi.people(active!.type, active!.id)) as any)?.data?.people ?? [],
    enabled: !!active,
  });

  const membersQuery = useApiQuery<CommunityMember[]>({
    queryKey: qk.community.members(scope.type, scope.id),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: async () => ((await communityApi.members(active!.type, active!.id)) as any)?.data?.members ?? [],
    enabled: !!active,
  });

  const leaderboardQuery = useApiQuery<LeaderboardData>({
    queryKey: qk.community.leaderboard(scope.type, scope.id, lbPeriod),
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await communityApi.leaderboard(active!.type, active!.id, lbPeriod);
      return { leaderboard: r?.data?.leaderboard ?? [], me: r?.data?.me ?? null };
    },
    enabled: !!active,
    staleTime: STALE.short,
  });

  const { feed, shoutouts, stats } = feedQuery.data ?? NO_FEED;
  const { leaderboard, me: myRank } = leaderboardQuery.data ?? NO_LEADERBOARD;
  const people = peopleQuery.data ?? NO_PEOPLE;
  const members = membersQuery.data ?? NO_MEMBERS;
  const loadingFeed = feedQuery.loading;
  const error = spacesQuery.error ?? feedQuery.error;
  const fetchFeed = feedQuery.refetch;
  const fetchLeaderboard = leaderboardQuery.refetch;

  const createPost = useCallback(async (input: Omit<CreatePostInput, 'scopeType' | 'scopeId'>) => {
    if (!active) return false;
    try {
      await communityApi.createPost({ ...input, scopeType: active.type, scopeId: active.id });
      toast.success('Posted');
      await fetchFeed();
      return true;
    } catch {
      toast.error('Could not post');
      return false;
    }
  }, [active, fetchFeed]);

  const react = useCallback(async (id: string, type: ReactionType) => {
    try { await communityApi.react(id, type); await fetchFeed(); } catch { toast.error('Could not react'); }
  }, [fetchFeed]);

  const deletePost = useCallback(async (id: string) => {
    try { await communityApi.deletePost(id); toast.success('Removed'); await fetchFeed(); } catch { toast.error('Could not remove'); }
  }, [fetchFeed]);

  const pin = useCallback(async (id: string, pinned: boolean) => {
    try { await communityApi.pin(id, pinned); await fetchFeed(); } catch { toast.error('Could not update pin'); }
  }, [fetchFeed]);

  const acceptAnswer = useCallback(async (postId: string, commentId: string) => {
    try { await communityApi.acceptAnswer(postId, commentId); toast.success('Answer accepted'); await fetchFeed(); } catch { toast.error('Could not accept'); }
  }, [fetchFeed]);

  const report = useCallback(async (targetType: 'post' | 'comment', targetId: string, reason?: string) => {
    try { await communityApi.report({ targetType, targetId, reason }); toast.success('Reported to moderators'); } catch { toast.error('Could not report'); }
  }, []);

  const refetch = useCallback(async () => {
    await fetchFeed();
    fetchLeaderboard();
  }, [fetchFeed, fetchLeaderboard]);

  return {
    spaces, active, activeKey, setActiveKey,
    feed, shoutouts, stats, people, members,
    leaderboard, myRank, lbPeriod, setLbPeriod,
    typeFilter, setTypeFilter, tagFilter, setTagFilter, query, setQuery,
    loadingSpaces, loadingFeed, error,
    refetch,
    createPost, react, deletePost, pin, acceptAnswer, report,
  };
}
