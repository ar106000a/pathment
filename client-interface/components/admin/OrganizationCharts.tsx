import Link from "next/link";

export interface OrganizationSummary {
  risk: { high: number; watch: number; low: number };
  completion: { label: string; count: number }[];
}

/** Aggregated counts stay readable whether the organization has 30 or 30,000 people. */
export function OrganizationCharts({
  summary,
  scopeLabel = "Organization",
  historical = false,
  programId,
}: {
  summary?: OrganizationSummary;
  scopeLabel?: string;
  historical?: boolean;
  programId?: string;
}) {
  if (!summary) return null;
  const total = Object.values(summary.risk).reduce(
    (sum, count) => sum + count,
    0,
  );
  const max = Math.max(1, ...summary.completion.map((bucket) => bucket.count));
  const riskGroups = [
    {
      key: "high",
      label: "High priority",
      color: "bg-rose-500",
      count: summary.risk.high,
    },
    {
      key: "watch",
      label: "Needs follow-up",
      color: "bg-amber-400",
      count: summary.risk.watch,
    },
    {
      key: "low",
      label: "On track",
      color: "bg-teal-500",
      count: summary.risk.low,
    },
  ];
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <section className="rounded-3xl border border-border bg-card p-6">
        <h2 className="text-lg">Where support is needed</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {total.toLocaleString()} mentees in {scopeLabel} · {historical ? "at program close" : "current snapshot"}
        </p>
        <div
          className="my-6 flex h-7 overflow-hidden rounded-full bg-muted"
          aria-hidden="true"
        >
          {riskGroups.map((group) => (
            <div
              key={group.key}
              className={group.color}
              style={{ width: `${total ? (group.count / total) * 100 : 0}%` }}
            />
          ))}
        </div>
        <ul className="space-y-3">
          {riskGroups.map((group) => (
            <li
              key={group.key}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${group.color}`} />
                {group.key === "low" || historical ? (
                  group.label
                ) : (
                  <Link
                    className="hover:underline"
                    href={`/admin/follow-ups?risk=${group.key}${programId ? `&programId=${encodeURIComponent(programId)}` : ""}`}
                  >
                    {group.label} →
                  </Link>
                )}
              </span>
              <span className="font-semibold tabular-nums">
                {group.count.toLocaleString()}{" "}
                <span className="font-normal text-muted-foreground">
                  ({total ? Math.round((group.count / total) * 100) : 0}%)
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="rounded-3xl border border-border bg-card p-6">
        <h2 className="text-lg">Completion distribution</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Mentees grouped by completed work, not a time trend.
        </p>
        <ul className="mt-5 space-y-3">
          {summary.completion.map((bucket) => (
            <li
              key={bucket.label}
              className="grid grid-cols-[4.5rem_1fr_4rem] items-center gap-3 text-xs"
            >
              <span className="text-muted-foreground">{bucket.label}</span>
              <div className="h-5 rounded-md bg-muted" aria-hidden="true">
                <div
                  className="h-full rounded-md bg-teal-500"
                  style={{ width: `${(bucket.count / max) * 100}%` }}
                />
              </div>
              <span className="text-right font-semibold tabular-nums">
                {bucket.count.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
