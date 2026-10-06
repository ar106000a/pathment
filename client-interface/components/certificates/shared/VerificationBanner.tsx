'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock, Loader2, Search, Users } from 'lucide-react';
import { certificatesApi } from '@/lib/services/certificates-api';
import { extractApiErrorMessage } from '@/lib/utils/api-error';
import { useConfirm } from '@/lib/context/ConfirmContext';
import type { CertificateReviewMode } from './CertificateReviewDrawer';

/**
 * The admin's side of a certificate review round.
 *
 * The mentor's side used to live here too, as a queue of its own. It moved into
 * the issuance roster on /mentor/certificates: reviewing a grade and issuing it
 * are the same people in the same table, and keeping them apart made a mentor
 * read one list while acting on another.
 */

/**
 * The admin's view of the round: who has signed off, who has not, what changed.
 *
 * Deliberately never blocks issuing. The admin is told the state and decides —
 * a gate here would strand a cohort behind one mentor who is on leave, which is
 * a worse failure than issuing a grade nobody contested.
 */
export function VerificationBanner({
  templateId, refreshKey, onIssueAnyway, onViewClan,
}: {
  templateId: string;
  refreshKey?: number;
  onIssueAnyway?: () => void;
  onViewClan?: (clanId: string | null, clanName: string, mode: CertificateReviewMode) => void;
}) {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof certificatesApi.getVerificationSummary>>['data'] | null>(null);
  const [reminding, setReminding] = useState(false);
  const [approvingClanId, setApprovingClanId] = useState<string | null>(null);
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [bucket, setBucket] = useState<'action' | 'approved' | 'all'>('action');

  const reload = useCallback(async () => {
    const res = await certificatesApi.getVerificationSummary(templateId);
    if (res.success) setSummary(res.data);
  }, [templateId]);

  /**
   * Release a clan. `verified` is false when the admin is approving before the
   * mentors have finished — permitted, but worth confirming so it is a choice
   * rather than a misread of the row.
   */
  const approve = async (clanId: string, verified: boolean) => {
    if (!verified) {
      const ok = await confirm({
        title: 'Approve before the review is finished?',
        description: 'This clan\'s mentors have not signed off every grade yet. Approving now finalizes the current decisions and locks direct mentor edits. Future corrections require an admin-approved change request.',
        confirmLabel: 'Approve anyway',
      });
      if (!ok) return;
    }
    try {
      setApprovingClanId(clanId);
      const res = await certificatesApi.approveClan(templateId, clanId);
      toast.success(res.message || 'Clan approved');
      await reload();
    } catch (err) {
      toast.error(extractApiErrorMessage(err, 'Could not approve that clan'));
    } finally {
      setApprovingClanId(null);
    }
  };

  useEffect(() => {
    let alive = true;
    certificatesApi.getVerificationSummary(templateId)
      .then((res) => { if (alive && res.success) setSummary(res.data); })
      .catch(() => { /* the banner is advisory; its absence must not break the page */ });
    return () => { alive = false; };
  }, [templateId, refreshKey]);

  if (!summary || summary.total === 0) return null;

  const remind = async () => {
    try {
      setReminding(true);
      const res = await certificatesApi.remindReviewers(templateId);
      toast.success(res.message || 'Mentors reminded');
    } catch (err) {
      toast.error(extractApiErrorMessage(err, 'Could not send the reminder'));
    } finally {
      setReminding(false);
    }
  };

  const realClans = summary.clans.filter((c) => Boolean(c.clanId));
  const unassigned = summary.clans.find((c) => !c.clanId);
  // Everything checked AND everything released is the only truly finished
  // state. "All verified" on its own still needs the admin to act, so it must
  // not look like a green light — that is what hid the approve buttons at
  // exactly the moment they were wanted.
  const settled = summary.allVerified && summary.awaitingApproval === 0;

  /**
   * Which bucket a clan is in. These are three different jobs, not three
   * shades of one: chase the mentors, press approve, or nothing at all.
   */
  const bucketOf = (c: typeof summary.clans[number]) =>
    c.pending > 0 ? 'blocked' : c.approved ? 'approved' : 'ready';

  const counts = {
    blocked: realClans.filter(c => bucketOf(c) === 'blocked').length,
    ready: realClans.filter(c => bucketOf(c) === 'ready').length,
    approved: realClans.filter(c => bucketOf(c) === 'approved').length,
  };

  /**
   * The list was alphabetical and paged six at a time, so with 28 clans the
   * ones actually holding the cohort up were scattered across five pages among
   * clans that were already finished. Ordered by what is owed instead: the
   * clans blocking everything first, most outstanding at the top, then the ones
   * waiting on a press of Approve, then the settled ones.
   */
  const RANK = { blocked: 0, ready: 1, approved: 2 } as const;
  const matching = realClans
    .filter(c => c.clanName.toLowerCase().includes(search.toLowerCase()))
    .filter(c => bucket === 'all' || (bucket === 'action' ? bucketOf(c) !== 'approved' : bucketOf(c) === 'approved'))
    .sort((a, b) => {
      const byBucket = RANK[bucketOf(a)] - RANK[bucketOf(b)];
      if (byBucket !== 0) return byBucket;
      if (a.pending !== b.pending) return b.pending - a.pending;
      return a.clanName.localeCompare(b.clanName);
    });
  const pages = Math.max(1, Math.ceil(matching.length / 8));
  const current = Math.min(page, pages);
  const visibleClans = matching.slice((current - 1) * 8, current * 8);
  return (
    <section className={`overflow-hidden rounded-2xl border ${
      settled ? 'border-emerald-500/20' : 'border-border'
    }`}>
      <div className={`flex flex-col gap-4 border-b px-4 py-4 sm:px-5 ${settled ? 'bg-emerald-500/5' : 'bg-muted/20'}`}>
        <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
          <div className="flex min-w-0 items-start gap-3">
            <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${settled ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'}`}>
              {settled ? <CheckCircle2 className="h-4 w-4" /> : <Users className="h-4 w-4" />}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold text-foreground">Clan review & approval</h3>
                {summary.overdue && <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-600">Overdue</span>}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {settled
                  ? `All ${summary.total} decisions are reviewed and approved.`
                  : counts.ready > 0
                    ? `${counts.ready} clan${counts.ready === 1 ? ' is' : 's are'} ready for your approval.`
                    : `${counts.blocked} clan${counts.blocked === 1 ? ' is' : 's are'} still waiting on mentor sign-off.`}
                {' '}Approval locks direct mentor edits.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={remind}
              disabled={reminding || counts.blocked === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-[11px] font-bold text-foreground transition-colors hover:border-brand-500/40 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {reminding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
              {counts.blocked === 0 ? 'No reminders needed' : `Remind ${counts.blocked} clan${counts.blocked === 1 ? '' : 's'}`}
            </button>
            {onIssueAnyway && !settled && (
              <button type="button" onClick={onIssueAnyway} className="rounded-xl px-3 py-2 text-[11px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground">
                Skip to recipients
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SummaryMetric label="Awaiting mentors" value={counts.blocked} tone="amber" />
          <SummaryMetric label="Ready to approve" value={counts.ready} tone="brand" />
          <SummaryMetric label="Approved clans" value={counts.approved} tone="emerald" />
          <SummaryMetric label="People reviewed" value={`${summary.verified}/${summary.total}`} tone="neutral" />
        </div>
      </div>

      <div className="bg-card px-4 py-3 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-1 rounded-xl bg-muted/60 p-1">
            {([
              ['action', `Needs action ${counts.blocked + counts.ready}`],
              ['approved', `Approved ${counts.approved}`],
              ['all', `All ${realClans.length}`],
            ] as const).map(([key, label]) => (
              <button key={key} type="button" onClick={() => { setBucket(key); setPage(1); }} className={`rounded-lg px-3 py-1.5 text-[11px] font-bold transition-colors ${bucket === key ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}>
                {label}
              </button>
            ))}
          </div>
          <label className="relative block sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input aria-label="Search certificate clan approvals" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Find a clan…" className="w-full rounded-xl border border-border bg-background py-2 pl-9 pr-3 text-xs outline-none transition-colors focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/10" />
          </label>
        </div>

        {unassigned && unassigned.total > 0 && (bucket === 'action' || bucket === 'all') && (
          <div className="mt-3 flex flex-col gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-3.5 py-3 sm:flex-row sm:items-center">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-foreground">No clan <span className="font-medium text-muted-foreground">· {unassigned.total} mentees</span></p>
              <p className="text-[11px] text-muted-foreground">No mentor owns these reviews; an admin needs to handle them.</p>
            </div>
            {onViewClan && <button type="button" onClick={() => onViewClan(null, 'No clan', unassigned.pending > 0 ? 'pending' : 'all')} className="inline-flex items-center justify-center gap-1 rounded-lg bg-foreground px-3 py-2 text-[11px] font-bold text-background hover:opacity-90">Review {unassigned.pending || unassigned.total}<ChevronRight className="h-3 w-3" /></button>}
          </div>
        )}

        <div className="mt-3 overflow-hidden rounded-xl border border-border">
          <div className="hidden grid-cols-[minmax(0,1fr)_110px_110px_150px] items-center gap-3 border-b bg-muted/40 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:grid">
            <span>Clan</span><span>Progress</span><span>Changes</span><span className="text-right">Next action</span>
          </div>
          <ul className="divide-y divide-border">
            {visibleClans.map((clan) => {
              const percent = clan.total ? Math.round((clan.verified / clan.total) * 100) : 0;
              const state = bucketOf(clan);
              return (
                <li key={clan.clanId || clan.clanName} className="grid gap-3 px-4 py-3 transition-colors hover:bg-muted/20 md:grid-cols-[minmax(0,1fr)_110px_110px_150px] md:items-center">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-xs font-bold text-foreground">{clan.clanName}</p>
                      {state === 'blocked' && <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[9px] font-bold text-amber-700 dark:text-amber-400">Waiting</span>}
                      {state === 'ready' && <span className="shrink-0 rounded-full bg-brand-500/10 px-2 py-0.5 text-[9px] font-bold text-brand-700 dark:text-brand-400">Ready</span>}
                      {state === 'approved' && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-bold text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-2.5 w-2.5" />Approved</span>}
                    </div>
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${state === 'approved' ? 'bg-emerald-500' : state === 'ready' ? 'bg-brand-500' : 'bg-amber-500'}`} style={{ width: `${percent}%` }} /></div>
                  </div>
                  <div>
                    {onViewClan ? (
                      <button type="button" onClick={() => onViewClan(clan.clanId, clan.clanName, 'all')} className="group text-left text-[11px] font-bold text-foreground hover:text-brand-600" title="Open review details">
                        {clan.verified}/{clan.total} reviewed <ChevronRight className="inline h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                      </button>
                    ) : <span className="text-[11px] font-bold">{clan.verified}/{clan.total} reviewed</span>}
                    <p className="text-[10px] text-muted-foreground">{percent}% complete</p>
                  </div>
                  <div>
                    {(clan.overridden + (clan.changeRequests ?? 0)) > 0 && onViewClan ? <button type="button" onClick={() => onViewClan(clan.clanId, clan.clanName, 'changed')} className="text-[11px] font-bold text-violet-600 hover:underline">{clan.overridden + (clan.changeRequests ?? 0)} change{clan.overridden + (clan.changeRequests ?? 0) === 1 ? '' : 's'}</button> : <span className="text-[11px] text-muted-foreground">No changes</span>}
                    {!!clan.changeRequests && <p className="text-[10px] font-medium text-amber-600">{clan.changeRequests} awaiting admin</p>}
                    {!!clan.noCertificate && <p className="text-[10px] text-muted-foreground">{clan.noCertificate} no certificate</p>}
                  </div>
                  <div className="flex justify-start md:justify-end">
                    {clan.clanId && !clan.approved ? (
                      state === 'ready' ? (
                        <button type="button" onClick={() => approve(clan.clanId!, true)} disabled={approvingClanId === clan.clanId} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-brand-700 disabled:opacity-50 md:w-auto">
                          {approvingClanId === clan.clanId ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}Approve clan
                        </button>
                      ) : (
                        <div className="flex w-full items-center gap-1 md:w-auto">
                          <button type="button" onClick={() => onViewClan?.(clan.clanId, clan.clanName, 'pending')} className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-border px-3 py-2 text-[11px] font-bold text-foreground hover:border-brand-500/40">Review {clan.pending}<ChevronRight className="h-3 w-3" /></button>
                          <button type="button" onClick={() => approve(clan.clanId!, false)} disabled={approvingClanId === clan.clanId} className="rounded-lg px-2 py-2 text-[10px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground" title="Approve before mentor review is complete">Approve early</button>
                        </div>
                      )
                    ) : onViewClan && (
                      <button type="button" onClick={() => onViewClan(clan.clanId, clan.clanName, 'all')} className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-[11px] font-bold text-brand-600 hover:bg-brand-500/10">View review<ChevronRight className="h-3 w-3" /></button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {!matching.length && <div className="px-4 py-10 text-center"><p className="text-sm font-semibold text-foreground">{search ? 'No matching clans' : bucket === 'action' ? 'No clans need action' : bucket === 'approved' ? 'No clans approved yet' : 'No clans found'}</p><p className="mt-1 text-xs text-muted-foreground">{search ? 'Try a different clan name.' : 'This list will update as reviews come in.'}</p></div>}
        </div>

        {pages > 1 && (
          <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Showing {(current - 1) * 8 + 1}–{Math.min(current * 8, matching.length)} of {matching.length}</span>
            <div className="flex items-center gap-1">
              <button type="button" aria-label="Previous page" disabled={current === 1} onClick={() => setPage(current - 1)} className="rounded-lg border p-2 text-foreground hover:bg-muted disabled:opacity-35"><ChevronLeft className="h-3.5 w-3.5" /></button>
              <span className="px-2 font-semibold text-foreground">{current} / {pages}</span>
              <button type="button" aria-label="Next page" disabled={current === pages} onClick={() => setPage(current + 1)} className="rounded-lg border p-2 text-foreground hover:bg-muted disabled:opacity-35"><ChevronRight className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function SummaryMetric({ label, value, tone }: { label: string; value: number | string; tone: 'amber' | 'brand' | 'emerald' | 'neutral' }) {
  const tones = {
    amber: 'border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-400',
    brand: 'border-brand-500/20 bg-brand-500/5 text-brand-700 dark:text-brand-400',
    emerald: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400',
    neutral: 'border-border bg-card text-foreground',
  };
  return <div className={`rounded-xl border px-3 py-2 ${tones[tone]}`}><p className="text-lg font-bold leading-none">{value}</p><p className="mt-1 text-[10px] font-semibold text-muted-foreground">{label}</p></div>;
}
