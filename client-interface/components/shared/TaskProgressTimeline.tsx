'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, PenLine, Trash2 } from 'lucide-react';

import { menteeApi, type TaskProgress, type TaskProgressDay } from '@/lib/services/mentee-api';
import { mentorApi } from '@/lib/services/mentor-api';
import { extractApiErrorMessage } from '@/lib/utils/api-error';

/** "Mon 24" — short enough for a dense timeline, unambiguous enough to scan. */
const dayLabel = (dateKey: string) => {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
};

/**
 * TaskProgressTimeline — a mentee's day-by-day notes on one task.
 *
 * One component, two readers. The mentee gets a box to write in; the mentor gets
 * the same timeline read only, so both are looking at exactly the same thing
 * during a review rather than two versions of the truth.
 *
 * The empty days are rendered, not collapsed. A four day task with two filled
 * days and two hollow ones tells a mentor something a status field never will,
 * and hiding the gaps would throw away the only signal this feature exists for.
 */
export function TaskProgressTimeline({
  taskId, mode, className = '', readOnly = false,
}: {
  taskId: string;
  /** 'mentee' can write; 'mentor' is read only. */
  mode: 'mentee' | 'mentor';
  /** Frozen/closed cohort — hide write controls even in mentee mode. */
  readOnly?: boolean;
  className?: string;
}) {
  const canWrite = mode === 'mentee' && !readOnly;
  const [data, setData] = useState<TaskProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyDay, setBusyDay] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = mode === 'mentee'
        ? await menteeApi.getTaskProgress(taskId)
        : await mentorApi.getTaskProgress(taskId) as { data?: TaskProgress };
      const next = (res as { data?: TaskProgress })?.data ?? null;
      setData(next);
      // Prefill today's box so editing feels like editing, not overwriting blind.
      const today = next?.days.find((d) => d.isToday);
      setNote(today?.entry?.note ?? '');
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [taskId, mode]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!canWrite) return;
    const text = note.trim();
    if (!text) { toast.error('Write a line about what you did'); return; }
    setSaving(true);
    try {
      await menteeApi.logTaskProgress(taskId, text);
      toast.success('Progress saved');
      await load();
    } catch (e) {
      toast.error(extractApiErrorMessage(e, 'Could not save your progress'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (dateKey: string) => {
    if (!canWrite) return;
    setBusyDay(dateKey);
    try {
      await menteeApi.removeTaskProgress(taskId, dateKey);
      await load();
    } catch (e) {
      toast.error(extractApiErrorMessage(e, 'Could not remove that day'));
    } finally {
      setBusyDay(null);
    }
  };

  if (loading) {
    return (
      <div className={`rounded-2xl border border-slate-200 bg-card p-6 flex justify-center ${className}`}>
        <Loader2 className="w-5 h-5 animate-spin text-brand-600" />
      </div>
    );
  }
  if (!data) return null;

  const past = data.days.filter((d) => !d.isFuture);
  // Nothing to show a mentor on a task that was never started.
  if (mode === 'mentor' && data.summary.loggedDays === 0) {
    return (
      <div className={`rounded-2xl border border-slate-200 bg-card p-5 ${className}`}>
        <h3 className="text-sm font-medium text-slate-900 mb-1">Progress</h3>
        <p className="text-sm text-slate-500">Nothing logged on this task yet.</p>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border border-slate-200 bg-card ${className}`}>
      <div className="flex items-center justify-between gap-2 px-5 py-4 border-b border-slate-200">
        <h3 className="text-sm font-medium text-slate-900 inline-flex items-center gap-1.5">
          <PenLine className="w-4 h-4 text-brand-600" /> Progress
        </h3>
        <span className="text-xs text-slate-500 tabular-nums">{data.summary.label}</span>
      </div>

      <div className="px-5 py-4">
        <ol className="space-y-0">
          {past.map((day, i) => (
            <DayRow
              key={day.dateKey}
              day={day}
              isLast={i === past.length - 1}
              canEdit={canWrite}
              busy={busyDay === day.dateKey}
              onRemove={() => remove(day.dateKey)}
            />
          ))}
        </ol>

        {canWrite && (
          <div className="mt-4">
            <label htmlFor={`progress-${taskId}`} className="sr-only">What did you do today?</label>
            <textarea
              id={`progress-${taskId}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="What did you do today?"
              className="w-full rounded-xl border border-slate-200 bg-card px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-xs text-slate-400">
                Your mentor can see this. Being stuck is worth writing down.
              </p>
              <button
                onClick={save}
                disabled={saving || !note.trim()}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save
              </button>
            </div>
          </div>
        )}
        {mode === 'mentee' && readOnly && (
          <p className="mt-4 text-xs text-slate-500">Completed programs are read-only.</p>
        )}
      </div>
    </div>
  );
}

/** One day. Filled days get a solid marker, empty days a hollow one. */
function DayRow({ day, isLast, canEdit, busy, onRemove }: {
  day: TaskProgressDay;
  isLast: boolean;
  canEdit: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const filled = !!day.entry;
  return (
    <li className="flex gap-3 group">
      <div className="flex flex-col items-center shrink-0">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2.5 w-2.5 rounded-full border-2 ${
            filled ? 'bg-brand-600 border-brand-600' : 'bg-transparent border-slate-300'
          }`}
        />
        {!isLast && <span className="w-px flex-1 bg-slate-200 my-1" />}
      </div>

      <div className={`min-w-0 flex-1 ${isLast ? 'pb-0' : 'pb-4'}`}>
        <div className="flex items-center gap-2">
          <p className={`text-xs font-medium ${filled ? 'text-slate-700' : 'text-slate-400'}`}>
            {dayLabel(day.dateKey)}
            {day.isToday && <span className="ml-1.5 text-brand-600">today</span>}
          </p>
          {canEdit && filled && (
            <button
              onClick={onRemove}
              disabled={busy}
              aria-label={`Remove progress for ${dayLabel(day.dateKey)}`}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded text-slate-300 hover:text-red-600 transition-opacity disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            </button>
          )}
        </div>
        {filled ? (
          <p className="mt-0.5 text-sm text-slate-600 whitespace-pre-wrap">{day.entry!.note}</p>
        ) : (
          <p className="mt-0.5 text-sm text-slate-300 italic">nothing logged</p>
        )}
      </div>
    </li>
  );
}
