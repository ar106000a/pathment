'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { TrendingUp, Plus, Loader2, ArrowRight, Crown, Check, Sparkles, Activity, Clock, AlertTriangle } from 'lucide-react';
import { useMentorPromotions, useMentorCohort, type PromotionCandidate, type PromotionStage } from '@/lib/hooks/mentor';
import { Drawer } from '@/components/shared/Drawer';
import { useAuth } from '@/lib/context/AuthContext';
import { mentorApi } from '@/lib/services/mentor-api';
import { useClan } from '@/lib/context/ClanContext';
import { extractApiErrorMessage } from '@/lib/utils/api-error';

const STAGES: { key: PromotionStage; label: string }[] = [
  { key: 'nominated', label: 'Nominated' },
  { key: 'interview', label: 'Interview' },
  { key: 'approved', label: 'Approved' },
  { key: 'promoted', label: 'Promoted' },
];

const NEXT_STAGE: Record<PromotionStage, PromotionStage | null> = {
  nominated: 'interview', interview: 'approved', approved: 'promoted', promoted: null, rejected: null,
};

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex-1">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs text-slate-500">{label}</span>
        <span className="text-xs font-semibold text-slate-700 tabular-nums">{value}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

const AVAILABILITY_OPTIONS = ['2 hours / week', '5 hours / week', '10+ hours / week', 'Flexible'];

function MiniBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[11px] text-slate-500">{label}</span>
        <span className="text-[11px] font-semibold text-slate-700 tabular-nums">{value}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden"><div className="h-full rounded-full bg-brand-500" style={{ width: `${value}%` }} /></div>
    </div>
  );
}

// Interview drawer — decision support: the mentee's real signals up top, an
// AI draft grounded in those numbers, quick-add strength chips, and a clear
// availability picker. The mentor edits, then approves.
function InterviewModal({ candidate, onClose, onSaved }: { candidate: PromotionCandidate; onClose: () => void; onSaved: () => void }) {
  const [motivation, setMotivation] = useState(candidate.motivation ?? '');
  const [strengths, setStrengths] = useState(candidate.strengths ?? '');
  const [availability, setAvailability] = useState(candidate.availability ?? '');
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const traits = candidate.traits;
  const driverChips = useMemo(() => {
    const out: string[] = [];
    if (candidate.absoluteProgress >= 50) out.push(`${candidate.absoluteProgress}% progress`);
    if (candidate.onTimeRate >= 80) out.push(`${candidate.onTimeRate}% on-time`);
    if (traits && traits.resilience >= 60) out.push('resilient');
    if (traits && traits.communication >= 60) out.push('communicates well');
    return out;
  }, [candidate, traits]);

  const draftWithAi = async () => {
    setDrafting(true);
    try {
      const r = await mentorApi.draftPromotion(candidate.id);
      const d = (r as any)?.data ?? r; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (d?.motivation) setMotivation(d.motivation);
      if (d?.strengths) setStrengths(d.strengths);
      toast.success('Drafted from this mentee\'s stats — edit as you like');
    } catch { toast.error('Could not draft right now'); }
    finally { setDrafting(false); }
  };

  const addStrength = (s: string) => {
    setStrengths((cur) => {
      if (cur.toLowerCase().includes(s.toLowerCase())) return cur;
      return cur.trim() ? `${cur.trim().replace(/\.?$/, '')}. ${s}` : s;
    });
  };

  const save = async (advance: boolean) => {
    try {
      setSaving(true);
      await mentorApi.advancePromotion(candidate.id, {
        motivation, strengths, availability,
        ...(advance ? { stage: 'approved' } : {}),
      });
      toast.success(advance ? 'Approved — sent to admin for final promotion' : 'Saved');
      onSaved(); onClose();
    } catch { toast.error('Could not save'); }
    finally { setSaving(false); }
  };

  const field = 'w-full border border-slate-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';
  const remaining = (candidate.suggestedStrengths ?? []).filter((s) => !strengths.toLowerCase().includes(s.toLowerCase()));

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Interview · ${candidate.name}`}
      subtitle="Capture the promotion interview and decide."
      footer={
        <>
          <button onClick={() => save(false)} disabled={saving} className="px-4 py-2 border border-slate-200 text-slate-700 rounded-xl text-sm hover:bg-slate-50 disabled:opacity-50">Save</button>
          <button onClick={() => save(true)} disabled={saving} className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-sm inline-flex items-center gap-2 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}Approve
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Context panel — the real signals to decide on */}
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 dark:bg-slate-800/40 p-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <MiniBar label="Readiness" value={candidate.readiness} />
            <MiniBar label="Willingness" value={candidate.willingness} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" />{candidate.absoluteProgress}% progress</span>
            <span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{candidate.onTimeRate}% on-time</span>
            {candidate.lastActive && <span className="inline-flex items-center gap-1"><Activity className="w-3.5 h-3.5" />active {candidate.lastActive}</span>}
            {(candidate.openBlockers ?? 0) > 0 && <span className="inline-flex items-center gap-1 text-amber-600"><AlertTriangle className="w-3.5 h-3.5" />{candidate.openBlockers} roadblock{candidate.openBlockers === 1 ? '' : 's'}</span>}
          </div>
          {driverChips.length > 0 && (
            <p className="text-[11px] text-slate-400">Why they&apos;re a candidate: {driverChips.join(' · ')}</p>
          )}
        </div>

        {/* AI draft */}
        <button type="button" onClick={draftWithAi} disabled={drafting}
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-brand-200 bg-brand-50 dark:bg-brand-500/15 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50">
          {drafting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          Draft with AI from {candidate.name.split(' ')[0]}&apos;s stats
        </button>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Motivation</label>
          <textarea value={motivation} onChange={(e) => setMotivation(e.target.value)} rows={3}
            placeholder="Why is this mentee ready to help lead? What have they shown?" className={`${field} resize-none`} autoFocus />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Strengths</label>
          <textarea value={strengths} onChange={(e) => setStrengths(e.target.value)} rows={3}
            placeholder="Concrete strengths — reliability, communication, ownership…" className={`${field} resize-none`} />
          {remaining.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {remaining.map((s) => (
                <button key={s} type="button" onClick={() => addStrength(s)}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:border-brand-300 hover:text-brand-700">
                  <Plus className="w-3 h-3" />{s}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Availability</label>
          <select value={AVAILABILITY_OPTIONS.includes(availability) ? availability : ''} onChange={(e) => setAvailability(e.target.value)} className={field}>
            <option value="">Select expected availability…</option>
            {AVAILABILITY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      </div>
    </Drawer>
  );
}

export default function MentorPromotions() {
  const { activeClanId } = useClan();
  const { candidates, loading, error, refetch } = useMentorPromotions();
  const { cohort } = useMentorCohort();
  const { availableRoles } = useAuth();
  const isAdmin = availableRoles.includes('admin');

  const [nominating, setNominating] = useState(false);
  const [pickMentee, setPickMentee] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [interviewing, setInterviewing] = useState<PromotionCandidate | null>(null);

  useEffect(() => {
    setNominating(false);
    setPickMentee('');
    setInterviewing(null);
    setBusy(null);
  }, [activeClanId]);

  const nomineeIds = useMemo(() => new Set(candidates.map((c) => c.menteeId)), [candidates]);
  const eligible = cohort.filter((m) => !nomineeIds.has(m.id));

  const nominate = async () => {
    if (!pickMentee) { toast.error('Pick a mentee'); return; }
    try {
      setBusy('nominate');
      await mentorApi.nominate(pickMentee);
      toast.success('Nominated');
      setNominating(false); setPickMentee('');
      refetch();
    } catch (error) { toast.error(extractApiErrorMessage(error, 'Could not nominate')); }
    finally { setBusy(null); }
  };

  const advance = async (c: PromotionCandidate) => {
    const next = NEXT_STAGE[c.stage];
    if (!next) return;
    if (c.stage === 'nominated') { setInterviewing(c); return; }
    if (next === 'promoted') {
      if (!isAdmin) { toast.error('Only an admin can finalise a promotion'); return; }
      try { setBusy(c.id); await mentorApi.promote(c.id, c.targetClanId || undefined); toast.success(`${c.name.split(' ')[0]} promoted to co-mentor`); refetch(); }
      catch (error) { toast.error(extractApiErrorMessage(error, 'Could not promote')); }
      finally { setBusy(null); }
      return;
    }
    try { setBusy(c.id); await mentorApi.advancePromotion(c.id, { stage: next }); refetch(); }
    catch { toast.error('Could not update'); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-slate-900 mb-2">Promotions</h1>
          <p className="text-slate-600">Nominate strong mentees to become co-mentors. Final promotion is approved by an admin.</p>
        </div>
        <button onClick={() => setNominating(true)} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 shrink-0">
          <Plus className="w-4 h-4" />Nominate
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-brand-600" /></div>
      ) : error ? (
        <div className="bg-card rounded-2xl border border-slate-200 py-16 text-center">
          <p className="text-slate-600 mb-3">{error}</p>
          <button onClick={refetch} className="text-brand-600 hover:text-brand-700 text-sm font-medium">Try again</button>
        </div>
      ) : candidates.length === 0 ? (
        <div className="bg-card rounded-2xl border border-slate-200 py-16 text-center">
          <TrendingUp className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-600">No candidates yet. Nominate a mentee who&apos;s ready to give back.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {candidates.map((c) => {
            const stageLabel = STAGES.find((s) => s.key === c.stage)?.label ?? c.stage;
            const next = NEXT_STAGE[c.stage];
            const ctaLabel = c.stage === 'nominated' ? 'Interview' : c.stage === 'interview' ? 'Mark approved' : c.stage === 'approved' ? 'Promote' : null;
            return (
              <div key={c.id} className="bg-card rounded-2xl border border-slate-200 p-5">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 bg-brand-100 rounded-full flex items-center justify-center shrink-0">
                    <span className="text-brand-700 text-xs font-medium">{c.avatar}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-900 truncate">{c.name}</p>
                    <p className="text-xs text-slate-500">{c.level || c.program || ''}</p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${c.stage === 'promoted' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{stageLabel}</span>
                </div>

                <div className="flex gap-3 mt-4">
                  <Bar label="Readiness" value={c.readiness} />
                  <Bar label="Willingness" value={c.willingness} />
                </div>
                <div className="flex items-center gap-3 mt-3 text-xs text-slate-500">
                  <span>{c.absoluteProgress}% progress</span><span>·</span><span>{c.onTimeRate}% on-time</span>
                </div>

                {c.stage !== 'promoted' && ctaLabel && (
                  <button onClick={() => advance(c)} disabled={busy === c.id || (c.stage === 'approved' && !isAdmin)}
                    className="mt-4 w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50">
                    {busy === c.id ? <Loader2 className="w-4 h-4 animate-spin" /> : c.stage === 'approved' ? <Crown className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />}
                    {c.stage === 'approved' && !isAdmin ? 'Awaiting admin' : ctaLabel}
                  </button>
                )}
                {c.stage === 'promoted' && (
                  <div className="mt-4 inline-flex items-center gap-1.5 text-sm text-emerald-700"><Crown className="w-4 h-4" />Now a co-mentor</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Nominate drawer */}
      <Drawer
        open={nominating}
        onClose={() => setNominating(false)}
        title="Nominate a mentee"
        subtitle="Put a mentee forward for promotion review."
        width="sm"
        footer={
          <>
            <button onClick={() => setNominating(false)} className="px-4 py-2 border border-slate-200 text-slate-700 rounded-xl text-sm hover:bg-slate-50">Cancel</button>
            <button onClick={nominate} disabled={busy === 'nominate' || !pickMentee} className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-sm inline-flex items-center gap-2 disabled:opacity-50">
              {busy === 'nominate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}Nominate
            </button>
          </>
        }
      >
        {eligible.length === 0 ? (
          <p className="text-sm text-slate-500">Everyone in your cohort is already nominated.</p>
        ) : (
          <>
            <label className="block text-sm font-medium text-slate-700 mb-1">Mentee</label>
            <select value={pickMentee} onChange={(e) => setPickMentee(e.target.value)}
              className="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm bg-card focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="">Select a mentee</option>
              {eligible.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </>
        )}
      </Drawer>

      {interviewing && <InterviewModal candidate={interviewing} onClose={() => setInterviewing(null)} onSaved={refetch} />}
    </div>
  );
}
