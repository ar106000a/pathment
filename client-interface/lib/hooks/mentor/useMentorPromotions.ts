'use client';

import { mentorApi } from '@/lib/services/mentor-api';
import { qk, useApiQuery } from '@/lib/query';
import { useClan } from '@/lib/context/ClanContext';

export type PromotionStage = 'nominated' | 'interview' | 'approved' | 'promoted' | 'rejected';

export interface PromotionCandidate {
  id: string;
  menteeId: string;
  stage: PromotionStage;
  name: string;
  avatar: string;
  program: string | null;
  level: string | null;
  absoluteProgress: number;
  onTimeRate: number;
  readiness: number;
  willingness: number;
  motivation: string | null;
  strengths: string | null;
  availability: string | null;
  /** Clan the mentor nominated from — used when promoting to co-mentor. */
  targetClanId?: string | null;
  targetClanName?: string | null;
  // Decision-support context for the interview drawer.
  lastActive?: string | null;
  momentum?: 'up' | 'steady' | 'down' | null;
  openBlockers?: number;
  signals?: string[];
  traits?: { resilience: number; communication: number; consistency: number };
  suggestedStrengths?: string[];
}

export interface UseMentorPromotionsReturn {
  candidates: PromotionCandidate[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const EMPTY: PromotionCandidate[] = [];

export function useMentorPromotions(): UseMentorPromotionsReturn {
  const { activeClanId } = useClan();
  const { data, loading, error, refetch } = useApiQuery<PromotionCandidate[]>({
    queryKey: [...qk.mentor.promotions, activeClanId],
    queryFn: async () => (await mentorApi.listPromotions())?.data?.candidates ?? [],
    errorMessage: 'Failed to load promotion candidates',
  });

  return { candidates: data ?? EMPTY, loading, error, refetch };
}
