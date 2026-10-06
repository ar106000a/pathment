"use client";

import {
  OrganizationCharts,
  type OrganizationSummary,
} from "@/components/admin/OrganizationCharts";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Users,
  Users2,
  ClipboardCheck,
  Flag,
  ArrowUpRight,
  Loader2,
  Search,
  CheckCircle2,
  Archive,
  Layers3,
  Radio,
} from "lucide-react";
import {
  useClanHealth,
  type AtRiskMentee,
  type ProgramHealth,
} from "@/lib/hooks/admin";
import { usePermissions } from "@/lib/hooks/usePermissions";
import { AnnouncementsCard } from "@/components/shared/AnnouncementsCard";
import { Avatar } from "@/components/shared/Avatar";
import { MetricTile } from "@/components/shared/MetricTile";

import {
  filterClanQueue,
  CLAN_PAGE_SIZE as PAGE_SIZE,
  type Queue,
} from "@/lib/utils/admin-clan-queue";

const LIVE_SCOPE = "live";
const ALL_SCOPE = "all";

function isLiveProgram(program: ProgramHealth) {
  return program.status === "published";
}

function weightedAverage(
  programs: ProgramHealth[],
  field: "avgCompletion" | "avgOnTime",
) {
  const total = programs.reduce(
    (sum, program) => sum + program.memberCount,
    0,
  );
  if (!total) return 0;
  return Math.round(
    programs.reduce(
      (sum, program) => sum + program[field] * program.memberCount,
      0,
    ) / total,
  );
}

function combineSummaries(
  programs: ProgramHealth[],
  fallback?: OrganizationSummary,
): OrganizationSummary | undefined {
  const summaries = programs
    .map((program) => program.summary)
    .filter(Boolean);
  if (!summaries.length) return fallback;

  const labels = summaries[0].completion.map((bucket) => bucket.label);
  return {
    risk: summaries.reduce(
      (totals, current) => ({
        high: totals.high + current.risk.high,
        watch: totals.watch + current.risk.watch,
        low: totals.low + current.risk.low,
      }),
      { high: 0, watch: 0, low: 0 },
    ),
    completion: labels.map((label, index) => ({
      label,
      count: summaries.reduce(
        (sum, current) => sum + (current.completion[index]?.count ?? 0),
        0,
      ),
    })),
  };
}

function scopedPriorityMentees(
  programs: ProgramHealth[],
  fallback: AtRiskMentee[],
) {
  const candidates = programs.flatMap(
    (program) => program.priorityMentees ?? [],
  );
  const source = candidates.length ? candidates : fallback;
  const unique = new Map<string, AtRiskMentee>();
  for (const mentee of source) {
    const existing = unique.get(mentee.id);
    if (
      !existing ||
      (mentee.risk === "high" && existing.risk !== "high") ||
      mentee.absoluteProgress < existing.absoluteProgress
    ) {
      unique.set(mentee.id, mentee);
    }
  }
  return [...unique.values()]
    .sort(
      (a, b) =>
        Number(b.risk === "high") - Number(a.risk === "high") ||
        a.absoluteProgress - b.absoluteProgress,
    )
    .slice(0, 5);
}

export default function AdminDashboardPage() {
  const { kpis, programs, atRiskMentees, loading, error, refetch, summary } =
    useClanHealth();
  const { can } = usePermissions();
  const [queue, setQueue] = useState<Queue>("attention");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState(LIVE_SCOPE);
  const [page, setPage] = useState(1);
  const orderedPrograms = useMemo(
    () =>
      [...programs].sort((a, b) => {
        const liveDifference = Number(isLiveProgram(b)) - Number(isLiveProgram(a));
        if (liveDifference) return liveDifference;
        const closedDifference =
          new Date(b.closedAt || 0).getTime() -
          new Date(a.closedAt || 0).getTime();
        return closedDifference || a.name.localeCompare(b.name);
      }),
    [programs],
  );
  const livePrograms = useMemo(
    () => orderedPrograms.filter(isLiveProgram),
    [orderedPrograms],
  );

  // A completed-only organization should open on its most recently closed
  // program, not an empty "live" dashboard. Derive that fallback during render
  // so loading data does not trigger a corrective state-update effect.
  const effectiveScope =
    scope === LIVE_SCOPE && !livePrograms.length && orderedPrograms.length
      ? orderedPrograms[0].id
      : scope !== LIVE_SCOPE &&
          scope !== ALL_SCOPE &&
          !programs.some((program) => program.id === scope)
        ? livePrograms.length
          ? LIVE_SCOPE
          : (orderedPrograms[0]?.id ?? ALL_SCOPE)
        : scope;

  const scopedPrograms = useMemo(() => {
    if (effectiveScope === ALL_SCOPE) return orderedPrograms;
    if (effectiveScope === LIVE_SCOPE) return livePrograms;
    return orderedPrograms.filter((program) => program.id === effectiveScope);
  }, [effectiveScope, livePrograms, orderedPrograms]);

  const clans = useMemo(
    () =>
      scopedPrograms.flatMap((program) =>
        program.clans.map((clan) => ({
          ...clan,
          programName: program.name,
          programId: program.id,
        })),
      ),
    [scopedPrograms],
  );
  const attention = clans.filter((clan) => clan.status !== "green");
  const pending = clans.reduce((sum, clan) => sum + clan.pendingApprovals, 0);
  const blockers = clans.reduce((sum, clan) => sum + clan.openBlockers, 0);
  const filtered = useMemo(
    () => filterClanQueue(clans, { programId: "", query, queue }),
    [clans, query, queue],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const selectQueue = (next: Queue) => {
    setQueue(next);
    setPage(1);
  };
  const scopedMentees = scopedPrograms.reduce(
    (sum, program) => sum + program.memberCount,
    0,
  );
  const scopedAtRisk = scopedPrograms.reduce(
    (sum, program) => sum + program.atRisk,
    0,
  );
  const scopedKpis = {
    programs: scopedPrograms.length,
    clans: clans.length,
    activeMentees:
      effectiveScope === ALL_SCOPE
        ? (kpis?.activeMentees ?? scopedMentees)
        : scopedMentees,
    avgCompletion:
      effectiveScope === ALL_SCOPE
        ? (kpis?.avgCompletion ?? weightedAverage(scopedPrograms, "avgCompletion"))
        : weightedAverage(scopedPrograms, "avgCompletion"),
    avgOnTime:
      effectiveScope === ALL_SCOPE
        ? (kpis?.avgOnTime ?? weightedAverage(scopedPrograms, "avgOnTime"))
        : weightedAverage(scopedPrograms, "avgOnTime"),
    atRisk:
      effectiveScope === ALL_SCOPE
        ? (kpis?.atRisk ?? scopedAtRisk)
        : scopedAtRisk,
  };
  const scopedSummary = combineSummaries(
    scopedPrograms,
    effectiveScope === ALL_SCOPE ? summary : undefined,
  );
  const priorityMentees = scopedPriorityMentees(
    scopedPrograms,
    effectiveScope === ALL_SCOPE ? atRiskMentees : [],
  );
  const selectedProgram =
    effectiveScope === LIVE_SCOPE || effectiveScope === ALL_SCOPE
      ? null
      : scopedPrograms[0] ?? null;
  const historicalScope =
    scopedPrograms.length > 0 &&
    scopedPrograms.every(
      (program) =>
        program.status === "completed" || program.status === "archived",
    );
  const scopeLabel = selectedProgram
    ? selectedProgram.name
    : effectiveScope === LIVE_SCOPE
      ? "All live programs"
      : "All programs";

  if (loading)
    return (
      <div className="flex justify-center py-24" role="status">
        <Loader2 className="h-7 w-7 animate-spin text-brand-600" />
        <span className="sr-only">Loading organization overview</span>
      </div>
    );
  if (error)
    return (
      <div className="admin-page-heading">
        <div>
          <h1>Overview unavailable</h1>
          <p className="mt-2 text-muted-foreground">{error}</p>
        </div>
        <button
          onClick={refetch}
          className="rounded-xl bg-brand-600 px-4 py-2 text-white"
        >
          Try again
        </button>
      </div>
    );

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
            <Layers3 className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">
              Dashboard scope
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {historicalScope
                ? "Historical snapshot from the program close date."
                : effectiveScope === ALL_SCOPE
                  ? "Organization roll-up across live and completed programs."
                  : "Live operational data; completed programs stay out of current stats."}
            </p>
          </div>
        </div>
        <label className="min-w-64 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Program view
          <select
            aria-label="Dashboard program scope"
            value={effectiveScope}
            onChange={(event) => {
              setScope(event.target.value);
              setPage(1);
            }}
            className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-medium normal-case tracking-normal text-foreground outline-none focus:ring-2 focus:ring-brand-500"
          >
            {livePrograms.length || !programs.length ? (
              <option value={LIVE_SCOPE}>
                {programs.length ? "All live programs" : "No programs yet"}
              </option>
            ) : null}
            <option value={ALL_SCOPE}>All programs · live + history</option>
            <optgroup label="Programs">
              {orderedPrograms.map((program) => (
                <option key={program.id} value={program.id}>
                  {program.name} · {program.status === "completed" ? "Completed" : program.status === "published" ? "Live" : program.status || "Unassigned"}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
      </section>

      <header className="admin-overview-hero flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-widest">
            {historicalScope ? (
              <Archive className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Radio className="h-3.5 w-3.5" aria-hidden />
            )}
            {historicalScope ? "Historical snapshot" : "Operational overview"}
          </p>
          <h1>{scopeLabel}</h1>
          <p className="mt-2">
            {scopedKpis.programs} program
            {scopedKpis.programs === 1 ? "" : "s"} ·{" "}
            {scopedKpis.clans} clan{scopedKpis.clans === 1 ? "" : "s"} ·{" "}
            {scopedKpis.avgOnTime}% on-time delivery
          </p>
        </div>
        {can("intake.manage") && (
          <Link
            href="/admin/cohorts"
            className="inline-flex items-center gap-2 rounded-xl border border-white/30 bg-white/10 px-4 py-3 text-sm font-medium text-white hover:bg-white/20"
          >
            Manage admissions <ArrowUpRight className="h-4 w-4" />
          </Link>
        )}
      </header>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <div>
          <MetricTile
            label={effectiveScope === ALL_SCOPE ? "Distinct mentees" : historicalScope ? "Mentees at close" : "Active mentees"}
            value={scopedKpis.activeMentees}
            icon={Users}
            tone={0}
            hint={`${scopedKpis.avgCompletion}% average completion`}
            compact
          />
        </div>
        <a href="#clan-queue" onClick={() => selectQueue("attention")}>
          <MetricTile
            label="Clans needing support"
            value={attention.length}
            icon={Users2}
            tone={3}
            hint="Review priority clans →"
            compact
          />
        </a>
        <a href="#clan-queue" onClick={() => selectQueue("reviews")}>
          <MetricTile
            label="Pending approvals"
            value={pending}
            icon={ClipboardCheck}
            tone={1}
            hint="Find the responsible clan →"
            compact
          />
        </a>
        <a href="#clan-queue" onClick={() => selectQueue("blockers")}>
          <MetricTile
            label="Open roadblocks"
            value={blockers}
            icon={Flag}
            tone={2}
            hint="See where support is needed →"
            compact
          />
        </a>
      </div>
      <OrganizationCharts
        summary={scopedSummary}
        scopeLabel={scopeLabel}
        historical={historicalScope}
        programId={selectedProgram?.id}
      />
      <section
        id="clan-queue"
        className="scroll-mt-6 rounded-3xl border border-border bg-card overflow-hidden"
      >
        <div className="p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap justify-between items-center gap-3">
            <div>
              <h2 className="text-lg">Clan priorities</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {historicalScope
                  ? `Final clan health recorded for ${scopeLabel}.`
                  : "Highest concern first. Review a focused list, then open a clan to act."}
              </p>
            </div>
            {can("clan.create") && (
              <Link
                href="/admin/clans"
                className="text-sm font-medium text-brand-700 dark:text-brand-300"
              >
                Manage all clans →
              </Link>
            )}
          </div>
          <div
            className="flex flex-wrap gap-2"
            aria-label="Clan priority filters"
          >
            {(
              [
                ["attention", "Needs attention"],
                ["reviews", "Pending approvals"],
                ["blockers", "Roadblocks"],
                ["all", "All clans"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                aria-pressed={queue === id}
                onClick={() => selectQueue(id)}
                className={`rounded-full px-4 py-2 text-sm font-medium ${queue === id ? "bg-brand-600 text-white" : "bg-muted text-muted-foreground hover:text-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div>
            <label className="relative block w-full">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <input
                aria-label="Search clans or lead mentors"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Search clans or lead mentors…"
                className="w-full rounded-xl border border-border bg-card py-2.5 pl-9 pr-3 text-sm"
              />
            </label>
          </div>
        </div>
        {visible.length ? (
          <div className="overflow-x-auto">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Clan & lead mentor</th>
                  <th>Status</th>
                  <th>Mentees</th>
                  <th>Approvals</th>
                  <th>Roadblocks</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((clan) => (
                  <tr key={clan.id}>
                    <td>
                      <div className="font-semibold">
                        {can("clan.create") ? (
                          <Link
                            className="text-brand-700 dark:text-brand-300 hover:underline"
                            href={`/admin/clans?clan=${clan.id}`}
                          >
                            {clan.name}
                          </Link>
                        ) : (
                          clan.name
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {clan.leadMentor?.name || "No lead mentor assigned"} ·{" "}
                        {clan.programName}
                      </p>
                    </td>
                    <td>
                      <span
                        className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${clan.status === "red" ? "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300" : clan.status === "amber" ? "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"}`}
                      >
                        {clan.statusLabel}
                      </span>
                      <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                        {clan.statusReason}
                      </p>
                    </td>
                    <td className="tabular-nums">{clan.memberCount}</td>
                    <td className="tabular-nums">{clan.pendingApprovals}</td>
                    <td className="tabular-nums">{clan.openBlockers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-10 text-center">
            <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-brand-600" />
            <p className="font-medium">No clans in this view</p>
            <p className="text-sm text-muted-foreground mt-1">
              Try another filter or search to explore the rest of your
              organization.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-4 text-sm">
          <span className="text-muted-foreground">
            {filtered.length
              ? `${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filtered.length)} of ${filtered.length} clans`
              : "0 clans"}
          </span>
          <div className="flex gap-2">
            <button
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
              className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              disabled={currentPage === pages}
              onClick={() => setPage(currentPage + 1)}
              className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </section>
      {priorityMentees.length > 0 && (
        <section className="rounded-3xl border border-border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg">
                {historicalScope
                  ? "Mentees who needed support at close"
                  : "Mentees to follow up with"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Five priority cases in {scopeLabel}
                {!historicalScope
                  ? " · open the full queue to filter by clan or urgency"
                  : " · preserved for historical context"}
                {" · "}
                {scopedKpis.atRisk} mentee{scopedKpis.atRisk === 1 ? "" : "s"} flagged.
              </p>
            </div>
            {can("user.manage") && !historicalScope && (
              <Link
                href={selectedProgram ? `/admin/follow-ups?programId=${selectedProgram.id}` : "/admin/follow-ups"}
                className="text-sm font-medium text-brand-700 dark:text-brand-300"
              >
                Browse all follow-ups →
              </Link>
            )}
          </div>
          <div className="divide-y divide-border">
            {priorityMentees.map((mentee) => (
              <div key={mentee.id} className="flex gap-3 py-4 items-center">
                <Avatar
                  name={mentee.name}
                  src={mentee.avatarUrl}
                  initials={mentee.avatar}
                  size="md"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">
                    {can("user.manage") ? (
                      <Link
                        href={`/admin/mentees/${mentee.id}`}
                        className="hover:underline"
                      >
                        {mentee.name}
                      </Link>
                    ) : (
                      mentee.name
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {mentee.riskReason}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {mentee.absoluteProgress}% complete
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {can("community.moderate") && (
        <AnnouncementsCard href="/admin/announcements" limit={2} />
      )}
    </div>
  );
}
