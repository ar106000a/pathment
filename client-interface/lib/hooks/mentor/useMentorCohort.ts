import { useMemo } from 'react';
import { mentorApi } from '@/lib/services/mentor-api';
import { useClan, ALL_CLANS } from '@/lib/context/ClanContext';
import { scopeToClan, clanIdOfRow } from '@/lib/utils/clan-scope';
import { qk, useApiQuery } from '@/lib/query';

export type CohortMomentum = 'up' | 'flat' | 'down';
export type CohortRisk = 'low' | 'watch' | 'high';

export interface CohortMentee {
  id: string;
  name: string;
  avatar: string;
  email: string;
  profilePictureUrl: string | null;
  program: string;
  level: string;
  week: number;
  totalWeeks: number;
  absoluteProgress: number;
  relativeProgress: number;
  onTimeRate: number;
  pendingApprovals: number;
  openBlockers: number;
  momentum: CohortMomentum;
  risk: CohortRisk;
  riskReason: string | null;
  /** Concrete rule-based "why" chips, e.g. "No activity in 6 days". */
  signals?: string[];
  avgRating: number;
  lastActive: string;
  /** Total tasks ever assigned. 0 = this mentee has never been given any work. */
  taskCount: number;
  /** Tasks actually completed — real output, used to effort-weight the leaderboard. */
  tasksCompleted: number;
  /** Sum of pointsAwarded on completed tasks — reflects difficulty of work done. */
  pointsEarned: number;
  /** Completed tasks split by difficulty band — drives leaderboard chips and AI brief. */
  tasksEasy: number;
  tasksMedium: number;
  tasksHard: number;
  sentiment: string;
  clan?: { id: string; name: string } | null;
  /** All active memberships in the mentor's clans (standing + cohort dual members). */
  clans?: Array<{ id: string; name: string | null }> | null;
  /** Joined the platform within the last ~10 days — show a "New" badge. */
  isNew?: boolean;
  joinedAt?: string | null;
  daysSinceJoined?: number | null;
}

export interface CohortTotals {
  mentees: number;
  pendingApprovals: number;
  openBlockers: number;
  atRisk: number;
  onTimeRate: number;
}

export interface UseMentorCohortReturn {
  cohort: CohortMentee[];
  totals: CohortTotals | null;
  loading: boolean;
  error: string | null;
  /** Mentees the sidebar clan picker is holding back from `cohort`. */
  hiddenByClan: number;
  refetch: () => Promise<void>;
}

const EMPTY_COHORT: CohortMentee[] = [];

export function useMentorCohort(): UseMentorCohortReturn {
  const { activeClanId } = useClan();

  const { data, loading, error, refetch } = useApiQuery<{ cohort: CohortMentee[]; totals: CohortTotals | null }>({
    // Clan is also sent via X-Active-Clan; key it so switching Standee ↔ cohort refetches.
    queryKey: [...qk.mentor.cohort, activeClanId],
    queryFn: async () => {
      const res = await mentorApi.getCohort();
      return { cohort: res?.data?.cohort ?? [], totals: res?.data?.totals ?? null };
    },
    errorMessage: 'Failed to load your cohort',
  });

  const allCohort = data?.cohort ?? EMPTY_COHORT;
  const rawTotals = data?.totals ?? null;

  // Scope to the active clan (multi-clan mentors). 'all' = the merged view.
  // One shared rule with the inbox, the approvals queue and the sidebar badges
  // — see lib/utils/clan-scope.
  const scoped = useMemo(
    () => scopeToClan(allCohort, activeClanId, clanIdOfRow),
    [allCohort, activeClanId]
  );
  const cohort = scoped.visible;
  /** Mentees the clan picker is holding back — lets the page avoid claiming there are none. */
  const hiddenByClan = scoped.hiddenByClan;

  // Recompute the summary totals for the scoped set so headline numbers match
  // what's on screen; the unscoped view keeps the server's totals as-is.
  const totals = useMemo<CohortTotals | null>(() => {
    if (activeClanId === ALL_CLANS) return rawTotals;
    if (!cohort.length && !allCohort.length) return rawTotals;
    return {
      mentees: cohort.length,
      pendingApprovals: cohort.reduce((n, m) => n + (m.pendingApprovals || 0), 0),
      openBlockers: cohort.reduce((n, m) => n + (m.openBlockers || 0), 0),
      atRisk: cohort.filter((m) => m.risk !== 'low').length,
      onTimeRate: cohort.length ? Math.round(cohort.reduce((n, m) => n + (m.onTimeRate || 0), 0) / cohort.length) : 0,
    };
  }, [cohort, allCohort, activeClanId, rawTotals]);

  return { cohort, totals, hiddenByClan, loading, error, refetch };
}
