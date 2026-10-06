# Program completion and standing clans — implementation status

Status at this checkpoint: core workflows plus the previously listed remaining implementation items are in the working tree. Production deployment and full browser walkthrough are still outstanding.

This report distinguishes implemented code from behavior that has been verified. No production deployment or production database migration has been performed.

## Requirement coverage

| Requirement | Current status | What exists / what remains |
| --- | --- | --- |
| End date versus formal close | Implemented | The end date is checked in the organization's timezone. Admin close is a separate action; reaching the date does not issue certificates or create clans. |
| Final enrollment outcomes | Implemented | Verified awards become `certified`. Verified `no_certificate` becomes `completed_uncertified`, or stays `dropped` if already dropped. Verified `inactive` drops an active enrollment on close. |
| Immutable final snapshots | Implemented | Each close stores the score, components, weights, completion, on-time rate, attendance, completed tasks, eligible cohort rank, decision evidence and compact roster report. Snapshots are protected against updates and deletion. |
| Retry-safe close | Implemented and tested | Concurrent close calls return the same close record and do not duplicate snapshots. |
| Complete program/cohorts and freeze cohort clans | Implemented and tested | Close updates statuses and freezes cohort clans. ORM guards and database triggers protect historical writes. |
| Community behavior | Implemented | Cohort/clan communities become read-only; program community remains open. The UI hides historical post/reply/delete controls and disables reactions. Browser verification remains. |
| Separate clan kinds | Implemented | Existing clans default to `cohort`; approved new clans use `standing`. Kind conversion is blocked. |
| Mentor request/admin decision | Implemented and tested | Eligible mentors request after formal close. Admin approval creates one fresh standing clan. |
| Mentor-selected membership | Implemented and tested | Mentors select organization mentees without transferring memberships or creating enrollments. |
| Ongoing standing-clan work | Implemented in core services | Custom tasks, recurring work, blockers and logs use actual clan context. |
| Standing activity reports | Implemented | Last 30 days, this quarter and since joining. |
| Exclusion from program results | Implemented | Mentor cohort, period/AI reports and mentee profile aggregation accept active-clan scope; standing work stays out of program results; closed programs use saved snapshots where available. |
| Historical navigation | Implemented, browser verification remaining | Clan picker labels, historical banners, and write-control disables on dashboard, mentees, review, assign, approvals, schedules and move-mentee. |
| Reopen/reclose audit | Implemented and tested | Reopen requires a reason; previous snapshots remain; standing clans survive. |
| Detailed results | Implemented | Results table includes a per-mentee detail drawer (score parts + decision evidence). CSV export includes component scores/weights and decision fields. |
| Cross-clan authorization | Implemented | Profile and friction reads/writes respect selected clan; friction mutations require access to the record's clan, not only shared mentee access. |

## Remaining verification / rollout work

1. **Browser end-to-end walkthrough** of admin close/reopen, mentor historical vs standing switching, schedule/calendar journeys, and full submission/review flows.
2. **Rerun** admin-program, clan-permission and multi-clan regression suites after the latest service changes.
3. **Apply migration `117_certificate_inactive_decision`** (and any earlier completion migrations) to non-test environments when ready; verify ambiguous legacy blocker/delay clan backfills and programs marked completed without a formal close.
4. **Actual email delivery** remains unverified (tests logged an email-mock limitation).

## Implemented backend work (latest additions)

- Clan-scoped `getCohort`, `getPeriodActivity`, `generateReportSummary` and `getMenteeDetail` via `X-Active-Clan` / `requestedClanId`.
- Standing clans use direct clan task filters; cohort/all views keep standing work out of program metrics.
- Explicit certificate decision `inactive` → enrollment outcome `dropped` on close (migration 117).
- Friction resolve/accept/reject/delete assert access to the record's clan.
- `canViewMentee` accepts optional `clanId` so profile access cannot ride another shared clan.

## Implemented frontend work (latest additions)

- `isHistoricalCohortClan` helper; write buttons disabled on historical cohort clans across mentor cockpit, mentees, review, assign drawer, approvals grading, schedules and move-mentee.
- Program completion panel: mentee detail drawer and richer CSV (score components + decision).
- Certificate review UI: Inactive (drop enrollment) decision option.

## Verification status

| Check | Result at this checkpoint |
| --- | --- |
| Latest completion/standing integration suite | Previously passed 18/18; inactive classification test added — rerun required after this pass |
| Frontend TypeScript check | Rerun required after this pass |
| Migration 116 (completion/standing) | Applied to the test database earlier |
| Migration 117 (inactive decision) | Added; apply before using inactive decisions |
| Migration 118 (plan feature flag) | Added; gates closeout/standing to Growth/Scale |
| Browser/end-to-end walkthrough | Not performed |
| Production deployment/migration | Not performed |

All feature changes remain in the local working tree. This report records a work-in-progress checkpoint, not a release sign-off.
