'use client';

import { useState } from 'react';
import { activityApi } from '@/lib/services/activity-api';
import { qk, useApiQuery, STALE } from '@/lib/query';
import { useClan } from '@/lib/context/ClanContext';
import type { ActivitySummary, DailySession, RecentEvent } from '@/lib/types/activity';

interface ActivityPayload {
  summary: ActivitySummary | null;
  dailySessions: DailySession[];
  recentEvents: RecentEvent[];
}

export interface UseMyActivityReturn extends ActivityPayload {
  loading: boolean;
  days: number;
  setDays: (d: number) => void;
  refetch: () => void;
}

const EMPTY: ActivityPayload = { summary: null, dailySessions: [], recentEvents: [] };

export function useMyActivity(): UseMyActivityReturn {
  const [days, setDays] = useState(7);
  const { menteeActiveClanId } = useClan();

  const { data, loading, refetch } = useApiQuery<ActivityPayload>({
    // Clan in the key so standing vs completed history do not share a cache entry.
    queryKey: [...qk.me.activity(days), menteeActiveClanId],
    queryFn: async () => {
      const res = await activityApi.getMySummary(days) as unknown as { data: ActivityPayload };
      const payload = res?.data;
      return {
        summary: payload?.summary ?? null,
        dailySessions: payload?.dailySessions ?? [],
        recentEvents: payload?.recentEvents ?? [],
      };
    },
    staleTime: STALE.short,
    refetchInterval: 5 * 60_000,
  });

  return { ...(data ?? EMPTY), loading, days, setDays, refetch };
}
