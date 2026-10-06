'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Search, Sparkles, UserRoundSearch } from 'lucide-react';
import { Drawer } from '@/components/shared/Drawer';
import { Avatar } from '@/components/shared/Avatar';
import { NO_CERTIFICATE, reviewSelection } from '@/lib/utils/certificate-decision';
import { reviewStage, type StageTone } from '@/lib/utils/certificate-review-stage';
import type { CertificateVerification } from '@/lib/services/certificates-api';

export type CertificateReviewMode = 'all' | 'changed' | 'pending';

interface CertificateReviewDrawerProps {
  open: boolean;
  clanId: string | null;
  clanName: string;
  mode: CertificateReviewMode;
  rows: CertificateVerification[];
  tierName: (tierId: string) => string;
  onClose: () => void;
  onInspect: (menteeId: string) => void;
}

/**
 * Review records are the source of truth for this drawer. They are deliberately
 * not joined back through the qualification roster: an override must remain
 * inspectable even when a recipient is paused, unassigned, or omitted from a
 * later qualification calculation.
 */
export function CertificateReviewDrawer({
  open, clanId, clanName, mode, rows, tierName, onClose, onInspect,
}: CertificateReviewDrawerProps) {
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if ((row.clanId ?? null) !== clanId) return false;
      if (mode === 'changed' && !row.overridden) return false;
      if (mode === 'pending' && row.status === 'verified') return false;
      if (!query) return true;
      const person = row.mentee;
      return `${person?.firstName || ''} ${person?.lastName || ''} ${person?.email || ''}`
        .toLowerCase().includes(query);
    });
  }, [clanId, mode, rows, search]);

  const title = mode === 'changed'
    ? `Changes · ${clanName}`
    : mode === 'pending'
      ? `Awaiting review · ${clanName}`
      : `Certificate review · ${clanName}`;

  return (
    <Drawer open={open} onClose={onClose} title={title} subtitle={`${visible.length} decision${visible.length === 1 ? '' : 's'}`} width="lg">
      <div className="space-y-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a mentee…"
            className="w-full rounded-xl border border-border bg-background py-2.5 pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border px-5 py-12 text-center">
            <UserRoundSearch className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm font-semibold text-foreground">No review records match this view</p>
            <p className="mt-1 text-xs text-muted-foreground">Clear the search or open another review state.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((row) => {
              const person = row.mentee;
              const name = `${person?.firstName || ''} ${person?.lastName || ''}`.trim() || 'Unknown mentee';
              const aiTier = row.aiDecision === 'no_certificate' ? NO_CERTIFICATE : row.aiTier || '';
              const finalTier = reviewSelection(row);
              return (
                <article key={row.id} className="rounded-2xl border border-border bg-card p-4 shadow-xs">
                  <div className="flex items-start gap-3">
                    <Avatar src={person?.profilePictureUrl} name={name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-foreground">{name}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{person?.email || 'Email unavailable'}</p>
                        </div>
                        <ReviewStatus row={row} />
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                        <span className="inline-flex items-center gap-1 rounded-lg bg-violet-500/10 px-2 py-1 font-medium text-violet-700 dark:text-violet-300">
                          <Sparkles className="h-3 w-3" /> AI: {tierName(aiTier)}
                        </span>
                        <span className="text-muted-foreground">→</span>
                        <span className="rounded-lg bg-brand-500/10 px-2 py-1 font-semibold text-brand-700 dark:text-brand-300">
                          Final: {tierName(finalTier)}
                        </span>
                      </div>

                      {row.status === 'verified' && (
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          {row.verifiedBy ? `Reviewed by ${row.verifiedBy}` : 'Reviewed by a mentor'}
                          {row.verifiedAt ? ` · ${new Date(row.verifiedAt).toLocaleString()}` : ''}
                        </p>
                      )}

                      {(row.criteriaChecks?.length ?? 0) > 0 && (
                        <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {row.criteriaChecks.length} certificate check{row.criteriaChecks.length === 1 ? '' : 's'} confirmed
                        </div>
                      )}

                      {row.overridden && (
                        <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">Mentor reasoning</p>
                          <p className="mt-1 text-xs leading-relaxed text-foreground">{row.overrideReason || 'No reason was recorded.'}</p>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => onInspect(row.menteeId)}
                        className="mt-3 text-xs font-semibold text-brand-600 hover:underline"
                      >
                        View evidence and work details
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </Drawer>
  );
}

/**
 * The badge said "Signed off" for a mentor's check and for an admin's approval
 * alike, so an admin could not see which of four hundred rows was their own
 * decision. It now names the stage the row is actually at.
 */
const STAGE_BADGE: Record<StageTone, string> = {
  neutral:  'bg-muted text-muted-foreground',
  waiting:  'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  progress: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  done:     'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
};

function ReviewStatus({ row }: { row: CertificateVerification }) {
  const stage = reviewStage(row);
  // A changed grade is worth flagging over the stage: it is the one thing on
  // this row somebody may need to argue with.
  if (row.status === 'verified' && row.overridden) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-700 dark:text-amber-400"><AlertTriangle className="h-3 w-3" /> Changed</span>;
  }
  const Icon = stage.tone === 'done' ? CheckCircle2 : Clock;
  return (
    <span
      title={stage.description}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold ${STAGE_BADGE[stage.tone]}`}
    >
      <Icon className="h-3 w-3" /> {stage.label}
    </span>
  );
}
