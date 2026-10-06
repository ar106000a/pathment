'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Loader2, X } from 'lucide-react';
import { Drawer } from './Drawer';
import { completionApi, type StandingRequest } from '@/lib/services/program-completion-api';
import { extractApiErrorMessage } from '@/lib/utils/api-error';
import { qk } from '@/lib/query';
import { useProgramCloseoutEnabled } from '@/lib/hooks/useProgramCloseoutEnabled';

const button = 'inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50';
const field = 'mt-2 w-full rounded-xl border border-border bg-card p-3 text-sm outline-none focus:ring-2 focus:ring-brand-500';
export const STANDING_CLAN_UPGRADE_COPY = 'Standing clan requests are available on Growth and Scale plans.';

/** Only reject opens this drawer. Approve runs immediately from the buttons. */
export type StandingClanReview = {
  row: StandingRequest;
  decision: 'rejected';
};

/** Shared API call for both one-click approve and reject-with-note. */
async function decideStandingRequest(
  row: StandingRequest,
  decision: 'approved' | 'rejected',
  note: string,
) {
  await completionApi.decide(row.id, decision, note);
}

/**
 * Reject drawer only.
 * Optional note is sent to the mentor in their rejection notification.
 */
export function StandingClanDecisionDrawer({
  review,
  onClose,
  onDecided,
  zClass,
}: {
  review: StandingClanReview | null;
  onClose: () => void;
  onDecided?: () => void;
  /** Stack above the notification drawer when deciding from the bell. */
  zClass?: string;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const reviewId = review?.row.id;

  useEffect(() => {
    if (reviewId) setNote('');
  }, [reviewId]);

  const reject = async () => {
    if (!review) return;
    setBusy(true);
    try {
      await decideStandingRequest(review.row, 'rejected', note.trim());
      toast.success('Request rejected');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: qk.clan.all });
      onClose();
      onDecided?.();
    } catch (e) {
      toast.error(extractApiErrorMessage(e, 'Could not reject request'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={!!review}
      onClose={() => {
        if (!busy) {
          setNote('');
          onClose();
        }
      }}
      zClass={zClass}
      title="Reject request"
      subtitle={review?.row.name}
      footer={
        <button
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy}
          onClick={reject}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
          {busy ? 'Saving…' : 'Reject request'}
        </button>
      }
    >
      {/* Optional — if filled, the mentor sees this as the rejection reason. */}
      <p className="mb-4 text-sm text-slate-600">
        Optionally tell the mentor why this request was rejected. They will see the note in their notification.
      </p>
      <label className="text-sm font-medium">
        Rejection reason <span className="font-normal text-slate-400">(optional)</span>
        <textarea
          value={note}
          maxLength={4000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Please clarify the proposed mentoring work"
          className={`${field} min-h-24`}
        />
      </label>
    </Drawer>
  );
}

/**
 * Approve / Reject controls used on standing-request notification cards.
 * - Approve: creates the clan immediately (no note step).
 * - Reject: opens StandingClanDecisionDrawer for an optional reason.
 */
export function StandingClanDecisionButtons({
  row,
  disabled,
  title,
  onReview,
  onDecided,
}: {
  row: StandingRequest;
  disabled?: boolean;
  title?: string;
  /** Opens the reject drawer. */
  onReview: (review: StandingClanReview) => void;
  /** Refresh lists after a successful approve. */
  onDecided?: () => void;
}) {
  const closeoutEnabled = useProgramCloseoutEnabled();
  const queryClient = useQueryClient();
  const [approving, setApproving] = useState(false);

  // One click — no confirmation drawer.
  const approve = async () => {
    if (!closeoutEnabled) {
      toast.error(STANDING_CLAN_UPGRADE_COPY);
      return;
    }
    setApproving(true);
    try {
      await decideStandingRequest(row, 'approved', '');
      toast.success('Fresh standing clan created with an empty mentee roster');
      await queryClient.invalidateQueries({ queryKey: qk.clan.all });
      onDecided?.();
    } catch (e) {
      toast.error(extractApiErrorMessage(e, 'Could not approve request'));
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="flex gap-2">
      <button
        type="button"
        className={button}
        disabled={disabled || approving}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          void approve();
        }}
      >
        {approving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
        {approving ? 'Approving…' : 'Approve'}
      </button>
      <button
        type="button"
        className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm font-semibold text-muted-foreground hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 dark:hover:border-red-900 dark:hover:bg-red-950/30 dark:hover:text-red-300"
        disabled={approving}
        onClick={(e) => {
          e.stopPropagation();
          // Opens the reject drawer (optional note for the mentor).
          onReview({ row, decision: 'rejected' });
        }}
      >
        <X className="h-4 w-4" aria-hidden />
        Reject
      </button>
    </div>
  );
}
