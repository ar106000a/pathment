"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Flag, CheckCircle2, Plus, Loader2, Link2, Trash2 } from "lucide-react";
import { useAuth } from "@/lib/context/AuthContext";
import { useConfirm } from "@/lib/context/ConfirmContext";
import { frictionApi } from "@/lib/services/friction-api";
import { taskApi } from "@/lib/services/task-api";
import { Drawer } from "@/components/shared/Drawer";
import { useClan, isHistoricalCohortClan } from "@/lib/context/ClanContext";

interface Blocker {
  id: string;
  title: string;
  category: string;
  severity: "low" | "medium" | "high";
  status: "open" | "resolved";
  openedAt: string;
  resolvedAt?: string | null;
  assignedTaskId?: string | null;
}
interface TaskOpt {
  id: string;
  title: string;
}

const CATEGORIES = ["technical", "knowledge", "access", "personal"];
const SEVERITIES: Blocker["severity"][] = ["low", "medium", "high"];
const SEVERITY_CLASS: Record<string, string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-slate-100 text-slate-600",
};

const daysOpen = (iso: string) =>
  Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));

// Mentees can only delete a blocker within this window of logging it (to undo an
// accident). After that it's part of the record — they Resolve it instead. Kept
// in sync with the server's DELETE_WINDOW_MS.
const DELETE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours
const withinDeleteWindow = (iso: string) =>
  Date.now() - new Date(iso).getTime() < DELETE_WINDOW_MS;

function BlockerRow({
  b,
  onResolve,
  onDelete,
  busy,
  deleting,
  readOnly = false,
}: {
  b: Blocker;
  onResolve: () => void;
  onDelete: () => void;
  busy: boolean;
  deleting: boolean;
  readOnly?: boolean;
}) {
  const resolved = b.status === "resolved";
  const canDelete = withinDeleteWindow(b.openedAt);
  const HISTORICAL_TITLE = "Completed programs are read-only";
  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${resolved ? "border-emerald-200 text-emerald-600" : "border-slate-200 text-slate-400"}`}
      >
        {resolved ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <Flag className="h-4 w-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={`text-sm font-medium ${resolved ? "text-slate-400 line-through" : "text-slate-900"}`}
        >
          {b.title}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 capitalize">
            {b.category}
          </span>
          <span
            className={`px-2 py-0.5 rounded-full capitalize ${SEVERITY_CLASS[b.severity]}`}
          >
            {b.severity}
          </span>
          <span className="text-slate-300">·</span>
          <span>
            {resolved
              ? "Cleared"
              : `Open ${daysOpen(b.openedAt)} day${daysOpen(b.openedAt) === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {!resolved && (
          <button
            onClick={onResolve}
            disabled={busy || readOnly}
            title={readOnly ? HISTORICAL_TITLE : undefined}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 text-slate-600 text-xs font-medium hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5" />
            )}
            Mark resolved
          </button>
        )}
        {canDelete && (
          <button
            onClick={onDelete}
            disabled={deleting || readOnly}
            title={readOnly ? HISTORICAL_TITLE : "Delete this roadblock (within 6h of logging)"}
            aria-label="Delete roadblock"
            className="grid h-7 w-7 place-items-center rounded-lg border border-slate-200 text-slate-400 hover:border-red-200 hover:text-red-600 disabled:opacity-50"
          >
            {deleting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

export default function MenteeBlockers() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const { menteeClans, menteeActiveClanId } = useClan();
  const historical = isHistoricalCohortClan(
    menteeClans.find((c) => c.id === menteeActiveClanId),
  );
  const HISTORICAL_TITLE = "Completed programs are read-only";
  const [blockers, setBlockers] = useState<Blocker[]>([]);
  const [tasks, setTasks] = useState<TaskOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Ask for THIS person's roadblocks by name. Asking for "mine" without saying
  // whose returned the union of every mentee the caller can see, so somebody who
  // mentors a clan and learns in another opened their own Roadblocks page and
  // found their mentees' roadblocks on it. The portal header scopes this too
  // (lib/services/portal-scope.ts); naming the id makes the page's contract
  // independent of that.
  const fetchAll = useCallback(async () => {
    if (!user?.id) return;
    try {
      setLoading(true);
      const res: any = await frictionApi.listBlockers(user.id);
      setBlockers(res?.data?.blockers ?? []);
    } catch {
      toast.error("Could not load roadblocks");
    } finally {
      setLoading(false);
    }
  }, [user?.id, menteeActiveClanId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);
  useEffect(() => {
    if (!user?.id) return;
    taskApi
      .getMenteeTasks(user.id)
      .then((r: any) => {
        const list = (r?.data?.tasks ?? []).filter(
          (t: any) => !["completed", "cancelled"].includes(t.status),
        );
        setTasks(
          list.map((t: any) => ({
            id: t.id,
            title: t.roadmapTask?.title || t.title || "Task",
          })),
        );
      })
      .catch(() => setTasks([]));
  }, [user?.id, menteeActiveClanId]);

  const resolve = async (id: string) => {
    try {
      setBusy(id);
      await frictionApi.resolveBlocker(id);
      await fetchAll();
    } catch {
      toast.error("Could not resolve");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (b: Blocker) => {
    const ok = await confirm({
      title: "Delete this roadblock?",
      description: `"${b.title}" will be removed for good. This can't be undone.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    try {
      setDeleting(b.id);
      await frictionApi.deleteBlocker(b.id);
      await fetchAll();
      toast.success("Blocker deleted");
    } catch {
      toast.error("Could not delete the roadblock");
    } finally {
      setDeleting(null);
    }
  };

  const open = blockers.filter((b) => b.status === "open");
  const resolved = blockers.filter((b) => b.status === "resolved");

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="mentee-page-heading flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-slate-900 mb-1 flex items-center gap-2">
            <Flag className="w-5 h-5 text-brand-600" /> Roadblocks
          </h1>
          <p className="text-slate-600">
            What&apos;s slowing you down. Your mentor can see these and help you
            clear them.
          </p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          disabled={historical}
          title={historical ? HISTORICAL_TITLE : undefined}
          className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 shrink-0 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" /> Add roadblock
        </button>
      </div>

      {!loading && blockers.length > 0 && (
        <div className="grid grid-cols-2 gap-4" aria-label="Roadblock summary">
          <div className="rounded-2xl border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">Still need support</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums text-amber-700 dark:text-amber-300">
              {open.length}
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">Cleared together</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums text-brand-700 dark:text-brand-300">
              {resolved.length}
            </p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-7 h-7 animate-spin text-brand-600" />
        </div>
      ) : blockers.length === 0 ? (
        <div className="bg-card rounded-2xl border border-slate-200 py-14 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-xl border border-emerald-200 text-emerald-600 mx-auto mb-3">
            <CheckCircle2 className="w-6 h-6" />
          </span>
          <p className="text-slate-700 font-medium">
            No roadblocks right now. Clear runway.
          </p>
          <p className="text-slate-500 text-sm mt-1 max-w-sm mx-auto">
            If anything starts to slow you down, log it here. Flagging early
            helps your mentor support you.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {open.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                Open
              </p>
              <div className="bg-card rounded-2xl border border-slate-200 divide-y divide-slate-100">
                {open.map((b) => (
                  <BlockerRow
                    key={b.id}
                    b={b}
                    onResolve={() => resolve(b.id)}
                    onDelete={() => remove(b)}
                    busy={busy === b.id}
                    deleting={deleting === b.id}
                    readOnly={historical}
                  />
                ))}
              </div>
            </div>
          )}
          {resolved.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                Resolved
              </p>
              <div className="bg-card rounded-2xl border border-slate-200 divide-y divide-slate-100">
                {resolved.map((b) => (
                  <BlockerRow
                    key={b.id}
                    b={b}
                    onResolve={() => {}}
                    onDelete={() => remove(b)}
                    busy={false}
                    deleting={deleting === b.id}
                    readOnly={historical}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {addOpen && user?.id && (
        <AddBlockerModal
          menteeId={user.id}
          tasks={tasks}
          onClose={() => setAddOpen(false)}
          onAdded={async () => {
            setAddOpen(false);
            await fetchAll();
          }}
        />
      )}
    </div>
  );
}

function AddBlockerModal({
  menteeId,
  tasks,
  onClose,
  onAdded,
}: {
  menteeId: string;
  tasks: TaskOpt[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("technical");
  const [severity, setSeverity] = useState<Blocker["severity"]>("medium");
  const [taskId, setTaskId] = useState("");
  const [saving, setSaving] = useState(false);
  const field =
    "w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";

  const submit = async () => {
    if (!title.trim()) {
      toast.error("Describe what is blocking you");
      return;
    }
    try {
      setSaving(true);
      await frictionApi.createBlocker({
        menteeId,
        title: title.trim(),
        category,
        severity,
        assignedTaskId: taskId || undefined,
      });
      toast.success("Roadblock logged");
      onAdded();
    } catch {
      toast.error("Could not log roadblock");
    } finally {
      setSaving(false);
    }
  };

  const seg = (active: boolean) =>
    `px-3 py-1.5 rounded-lg border text-sm font-medium capitalize ${active ? "border-brand-400 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-600 hover:border-slate-300"}`;

  return (
    <Drawer
      open
      onClose={onClose}
      title="Log a roadblock"
      subtitle="What's slowing you down - your mentor can see this and help."
      footer={
        <>
          <button
            onClick={onClose}
            className="px-4 py-2 border border-slate-200 text-slate-700 rounded-xl text-sm hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-sm inline-flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            Log roadblock
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            What&apos;s blocking you?
          </label>
          <textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            rows={2}
            placeholder="e.g. Stuck on the JWT refresh flow"
            className={`${field} resize-none`}
            autoFocus
          />
        </div>
        {tasks.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center gap-1">
              <Link2 className="w-3.5 h-3.5 text-slate-400" />
              Which task?{" "}
              <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <select
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              className={field}
            >
              <option value="">General - not task-specific</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Category
          </label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={seg(category === c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Severity
          </label>
          <div className="flex gap-2">
            {SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSeverity(s)}
                className={seg(severity === s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Drawer>
  );
}
