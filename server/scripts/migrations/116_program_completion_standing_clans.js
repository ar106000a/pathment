const sequelize = require('./_db');

/**
 * Program closeout + standing clans (slim schema).
 * - Close marker: programs.closed_at only (no closure/snapshot history tables).
 * - Standing work: enrollment_id nullable on assigned_tasks (standing clans have no enrollment);
 *   cohort vs standing is decided by clans.kind + application rules, not a denormalized column.
 * - Standing-clan plan flag (programCompletionStanding) lives on plans via migration 110;
 *   entitlement also falls back to paid price. Program closeout is available on every plan.
 */
async function up() {
  await sequelize.transaction(async transaction => {
    const q = sql => sequelize.query(sql, { transaction });

    await q(`ALTER TABLE clans ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'cohort';
      ALTER TABLE clans ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;
      ALTER TABLE programs ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;`);

    // Standing-clan tasks have no program enrollment; cohort tasks still carry enrollment_id.
    await q(`ALTER TABLE assigned_tasks ALTER COLUMN enrollment_id DROP NOT NULL`);

    for (const table of ['blockers', 'delay_events']) {
      await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS clan_id UUID REFERENCES clans(id);
        UPDATE ${table} f SET clan_id = t.clan_id FROM assigned_tasks t
        WHERE f.assigned_task_id = t.id AND f.organization_id = t.organization_id AND f.clan_id IS NULL;
        UPDATE ${table} f SET clan_id = m.clan_id FROM (
          SELECT organization_id, user_id, MIN(clan_id::text)::uuid AS clan_id FROM clan_memberships
          WHERE role = 'mentee' AND status IN ('active','paused') GROUP BY organization_id, user_id HAVING COUNT(DISTINCT clan_id) = 1
        ) m WHERE f.mentee_id = m.user_id AND f.organization_id = m.organization_id AND f.clan_id IS NULL;`);
    }

    // Only index that enforces a real invariant: one pending standing request per mentor+program.
    await q(`CREATE TABLE IF NOT EXISTS standing_clan_requests (
      id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES organizations(id),
      program_id UUID NOT NULL REFERENCES programs(id), mentor_id UUID NOT NULL REFERENCES users(id),
      name VARCHAR(150) NOT NULL, description TEXT, status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      reviewed_by UUID REFERENCES users(id), reviewed_at TIMESTAMPTZ, decision_note TEXT,
      created_clan_id UUID REFERENCES clans(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(organization_id, created_clan_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS standing_request_pending_unique ON standing_clan_requests(organization_id, mentor_id, program_id) WHERE status='pending';`);
  });
}

module.exports = { up };
if (require.main === module) up().then(() => sequelize.close()).catch(error => { console.error(error.message); process.exitCode = 1; });
