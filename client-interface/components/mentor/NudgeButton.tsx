'use client';

import { useState } from 'react';
import { Bell, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { mentorApi } from '@/lib/services/mentor-api';
import { extractApiErrorMessage } from '@/lib/utils/api-error';

/**
 * One nudge action, reused on every per-mentee surface (at-risk, My Mentees,
 * mentee detail, clan review). Variants: `outline` (default), `subtle`
 * (brand-tinted), `icon` (compact). Pass `stopPropagation` when it sits inside a
 * clickable card/row so the nudge doesn't also trigger navigation.
 */
export function NudgeButton({
  menteeId,
  menteeName,
  variant = 'outline',
  stopPropagation = false,
  disabled = false,
  className = '',
}: {
  menteeId: string;
  menteeName?: string;
  variant?: 'outline' | 'subtle' | 'icon';
  stopPropagation?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);

  const send = async (e: React.MouseEvent) => {
    if (stopPropagation) { e.preventDefault(); e.stopPropagation(); }
    if (busy || disabled) return;
    setBusy(true);
    try {
      await mentorApi.nudge(menteeId);
      toast.success(`Nudge sent${menteeName ? ` to ${menteeName.split(' ')[0]}` : ''}`);
    } catch (err) {
      toast.error(extractApiErrorMessage(err, 'Could not send the nudge'));
    } finally {
      setBusy(false);
    }
  };

  const title = disabled ? 'Completed programs are read-only' : 'Send a nudge';

  if (variant === 'icon') {
    return (
      <button onClick={send} disabled={busy || disabled} title={title} aria-label={title}
        className={`p-2 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-500/15 disabled:opacity-50 transition-colors ${className}`}>
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
      </button>
    );
  }

  const styles = variant === 'subtle'
    ? 'bg-brand-50 dark:bg-brand-500/15 text-brand-700 hover:bg-brand-100'
    : 'border border-slate-200 text-slate-700 hover:border-brand-300 hover:text-brand-700';

  return (
    <button onClick={send} disabled={busy || disabled} title={disabled ? 'Completed programs are read-only' : undefined}
      className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors ${styles} ${className}`}>
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}Nudge
    </button>
  );
}

export default NudgeButton;
