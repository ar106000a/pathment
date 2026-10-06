'use client';

import { useEffect, useState } from 'react';
import { ArrowRightLeft, Sparkles } from 'lucide-react';

import { MoveMenteeDrawer } from '@/components/mentor/MoveMenteeDrawer';
import { ComingSoon } from '@/components/shared/ComingSoon';
import { mentorApi, type TransferConfig } from '@/lib/services/mentor-api';
import { usePermissions } from '@/lib/hooks/usePermissions';
import { PERMISSIONS } from '@/lib/config/permissions';

/**
 * MoveMenteeButton — the single entry point to "move this mentee to another
 * clan", used from the mentee's profile and from the cohort-review panel.
 *
 * It owns the release gate so no caller has to think about it:
 *   - before the release date → a button that opens a "Coming soon" teaser
 *     (mentors get to anticipate the feature instead of never noticing it), and
 *     the server refuses the write anyway.
 *   - for a week after release → the same button with a "New" dot, so people
 *     spot a capability that wasn't there yesterday.
 *   - after that → just a button.
 *
 * Hidden entirely for anyone without `mentee.transfer` (a co-mentor whose lead
 * turned it off), so nobody is offered an action they'd be refused.
 */
export function MoveMenteeButton({
  menteeId, menteeName, variant = 'button', className = '', onMoved, disabled = false,
}: {
  menteeId: string;
  menteeName?: string;
  /** 'button' = bordered action; 'compact' = inline text; 'icon' = icon-only
   *  (for tight action rows like the cohort-review mentee card). */
  variant?: 'button' | 'compact' | 'icon';
  /** Extra classes so the button matches the action row it sits in. */
  className?: string;
  onMoved?: () => void;
  disabled?: boolean;
}) {
  const { can, loading: permsLoading } = usePermissions();
  const [config, setConfig] = useState<TransferConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [teasing, setTeasing] = useState(false);

  useEffect(() => {
    let alive = true;
    mentorApi.transfers.config()
      .then((r) => { if (alive) setConfig(r.data ?? null); })
      .catch(() => { /* no config → render nothing rather than a broken action */ });
    return () => { alive = false; };
  }, []);

  // Wait for permissions before deciding — rendering then yanking the button is
  // worse than a beat of nothing.
  if (permsLoading || !can(PERMISSIONS.MENTEE_TRANSFER) || !config) return null;

  const label = 'Move to another clan';
  const onClick = () => {
    if (disabled) return;
    if (config.enabled) setOpen(true);
    else setTeasing(true);
  };

  return (
    <>
      {variant === 'icon' ? (
        <button
          onClick={onClick}
          disabled={disabled}
          title={disabled ? 'Completed programs are read-only' : label}
          aria-label={label}
          className={`relative p-1.5 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 disabled:opacity-50 ${className}`}
        >
          <ArrowRightLeft className="w-4 h-4" />
          {config.isNew && <NewDot />}
        </button>
      ) : variant === 'compact' ? (
        <button
          onClick={onClick}
          disabled={disabled}
          className={`relative inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-brand-700 disabled:opacity-50 ${className}`}
        >
          <ArrowRightLeft className="w-3.5 h-3.5" /> {label}
          {config.isNew && <NewDot />}
        </button>
      ) : (
        <button
          onClick={onClick}
          disabled={disabled}
          title={disabled ? 'Completed programs are read-only' : undefined}
          className={`relative inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-card px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:border-brand-300 hover:bg-slate-50 hover:text-brand-700 disabled:opacity-50 ${className}`}
        >
          <ArrowRightLeft className="w-4 h-4" /> {label}
          {config.isNew && <NewBadge />}
        </button>
      )}

      {open && config.enabled && (
        <MoveMenteeDrawer
          menteeId={menteeId}
          menteeName={menteeName}
          onClose={() => setOpen(false)}
          onSent={onMoved}
        />
      )}

      {teasing && !config.enabled && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setTeasing(false)}>
          <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <ComingSoon
              title="Move a mentee to another clan"
              description={`Hand a mentee to the mentor who fits them best — you pick the clan, their lead mentor accepts, and the move happens exactly as an admin move would. Available ${formatRelease(config.releaseAt)}.`}
              icon={<ArrowRightLeft className="h-5 w-5" />}
              features={[
                { icon: <Sparkles className="h-3 w-3 text-brand-500" />, label: 'No admin needed' },
                { icon: <Sparkles className="h-3 w-3 text-brand-500" />, label: 'They accept or decline' },
                { icon: <Sparkles className="h-3 w-3 text-brand-500" />, label: 'Progress moves with them' },
              ]}
            />
            <button
              onClick={() => setTeasing(false)}
              className="mt-3 w-full rounded-lg border border-slate-200 bg-card px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** "New" for the week after release — enough to notice, not enough to nag. */
function NewBadge() {
  return (
    <span className="ml-0.5 inline-flex items-center rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
      New
    </span>
  );
}
function NewDot() {
  return <span className="absolute -right-1.5 -top-1 h-1.5 w-1.5 rounded-full bg-brand-600" aria-label="New feature" />;
}

/** "on 10 Aug" — a date a mentor can hold in their head. */
function formatRelease(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'soon';
  const today = new Date();
  const days = Math.ceil((d.getTime() - today.getTime()) / 86_400_000);
  if (days <= 0) return 'now';
  if (days === 1) return 'tomorrow';
  return `on ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}
