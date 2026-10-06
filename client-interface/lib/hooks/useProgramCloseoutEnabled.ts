'use client';

import { useOrganization } from '@/lib/context/OrganizationContext';

/** Plan feature key for standing-clan requests (paid plans only). Program closeout is available on every plan. */
export const PROGRAM_COMPLETION_STANDING_FEATURE = 'programCompletionStanding';

/**
 * True when the current workspace plan includes standing-clan requests.
 * Starter and other free (monthly & annual 0) plans are excluded.
 */
export function useProgramCloseoutEnabled(): boolean {
  const { overview } = useOrganization();
  const plan = overview?.subscription?.plan;
  if (!plan) return false;
  const flagged = plan.features?.[PROGRAM_COMPLETION_STANDING_FEATURE];
  if (typeof flagged === 'boolean') return flagged;
  return Number(plan.monthlyPriceCents || 0) > 0 || Number(plan.annualPriceCents || 0) > 0;
}
