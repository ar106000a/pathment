const { Sequelize } = require('sequelize');

const TENANT_TABLES = [
  'programs', 'role_assignments', 'custom_roles', 'system_settings', 'org_policies',
  'registration_invites', 'badges', 'documents', 'announcements', 'community_posts',
  'conversations', 'notifications', 'audit_logs', 'ai_connections', 'certificate_templates',
  'clans', 'clan_memberships', 'cohorts', 'enrollments', 'roadmaps', 'roadmap_tasks',
  'assigned_tasks', 'task_submissions', 'blockers', 'messages', 'conversation_participants',
  'points_history', 'user_badges', 'leaderboard_entries', 'certificate_instances',
  'certificate_verifications', 'certificate_clan_approvals', 'applications',
];

// Frozen legacy entitlements: do not derive these from the evolving public plans.
// New resource/feature keys require an explicit compatibility decision.
const LEGACY_DEVWEEKENDS_OVERRIDES = Object.freeze({
  limits: Object.freeze({
    members: -1, programs: -1, clans: -1, storageGb: -1, aiEvaluationsPerMonth: -1,
  }),
  features: Object.freeze({
    certificates: true, aiEvaluation: true, customBranding: true,
    // programCompletionStanding = standing-clan requests (paid). Program closeout is available on every plan.
    customDomain: true, advancedAnalytics: true, sso: true, programCompletionStanding: true,
  }),
});

const DEFAULT_PLANS = [
  {
    key: 'starter', name: 'Starter', monthly: 0, annual: 0, sort: 10,
    description: 'For a small mentorship community getting started.',
    limits: { members: 100, programs: 2, clans: 5, storageGb: 2, aiEvaluationsPerMonth: 100 },
    features: { certificates: true, aiEvaluation: true, customBranding: false, customDomain: false, advancedAnalytics: false, sso: false, programCompletionStanding: false },
  },
  {
    key: 'growth', name: 'Growth', monthly: 9900, annual: 99000, sort: 20,
    description: 'For growing fellowships running several programs and clans.',
    limits: { members: 1500, programs: 15, clans: 60, storageGb: 50, aiEvaluationsPerMonth: 5000 },
    features: { certificates: true, aiEvaluation: true, customBranding: true, customDomain: true, advancedAnalytics: true, sso: false, programCompletionStanding: true },
  },
  {
    key: 'scale', name: 'Scale', monthly: 29900, annual: 299000, sort: 30,
    description: 'For large organizations needing advanced controls and support.',
    limits: { members: -1, programs: -1, clans: -1, storageGb: 500, aiEvaluationsPerMonth: 50000 },
    features: { certificates: true, aiEvaluation: true, customBranding: true, customDomain: true, advancedAnalytics: true, sso: true, programCompletionStanding: true },
  },
];

async function tableExists(db, table, transaction) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=:table`,
    { replacements: { table }, type: Sequelize.QueryTypes.SELECT, transaction }
  );
  return Boolean(rows);
}

async function columnExists(db, table, column, transaction) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=:table AND column_name=:column`,
    { replacements: { table, column }, type: Sequelize.QueryTypes.SELECT, transaction }
  );
  return Boolean(rows);
}

async function addOrganizationColumn(db, table, defaultOrgId, transaction) {
  if (!await tableExists(db, table, transaction)) return;
  // PostgreSQL 11+ stores a constant ADD COLUMN default as missing-value
  // metadata instead of rewriting every existing row. Large audit tables would
  // otherwise double in size during backfill and exceed small Heroku plans.
  // Drop the write default in the same transaction: old rows retain ownership,
  // while future writes still have to supply an explicit workspace.
  if (await columnExists(db, table, 'organization_id', transaction)) {
    throw new Error(`Migration 110: ${table} already has organization_id; manual reconciliation required.`);
  }
  await db.query(`ALTER TABLE "${table}" ADD COLUMN organization_id UUID NOT NULL DEFAULT CAST(:id AS uuid)`, {
    replacements: { id: defaultOrgId }, transaction,
  });
  await db.query(`ALTER TABLE "${table}" ALTER COLUMN organization_id DROP DEFAULT`, { transaction });
  await db.query(`CREATE INDEX IF NOT EXISTS "${table}_organization_id_idx" ON "${table}" (organization_id)`, { transaction });
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${table}_organization_id_fkey' AND conrelid='public.${table}'::regclass) THEN
      ALTER TABLE "${table}" ADD CONSTRAINT "${table}_organization_id_fkey"
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
    END IF;
  END $$`, { transaction });
}

// This is a one-time conversion of a single-tenant database, not a repair job.
// No default organization is installed: every writer after cutover must scope data.
async function up({ db, maintenance = process.env.MIGRATION_110_MAINTENANCE === 'true' } = {}) {
  if (!maintenance) {
    throw new Error('Migration 110 requires MIGRATION_110_MAINTENANCE=true after stopping all legacy writers.');
  }
  for (const configuredSlug of [process.env.DEFAULT_ORGANIZATION_SLUG, process.env.TENANT_SLUG]) {
    if (configuredSlug && configuredSlug.trim().toLowerCase() !== 'devweekends') {
      throw new Error('Migration 110 converts existing DevWeekends data only; conflicting organization slug.');
    }
  }
  db = db || require('./_db');
  const slug = 'devweekends';
  const name = 'Dev Weekends';

  await db.transaction(async transaction => {
    // Bound both lock waits and individual statements; all changes roll back on failure.
    await db.query(`SET LOCAL search_path TO public`, { transaction });
    await db.query(`SET LOCAL lock_timeout = '5s'`, { transaction });
    await db.query(`SET LOCAL statement_timeout = '15min'`, { transaction });
    await db.query(`SELECT pg_advisory_xact_lock(110, 20260923)`, { transaction });
    await db.query(`CREATE TABLE IF NOT EXISTS migration_110_completion (
      singleton BOOLEAN PRIMARY KEY CHECK (singleton),
      organization_id UUID NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`, { transaction });
    const [completed] = await db.query(`SELECT organization_id FROM migration_110_completion WHERE singleton`, { transaction });
    if (completed.length) return;

    // Without a completion marker, existing tenant state has unknown provenance.
    // In particular, never "repair" the original migration by sweeping users again.
    if (await tableExists(db, 'organizations', transaction)) {
      const [existing] = await db.query(`SELECT 1 FROM organizations LIMIT 1`, { transaction });
      if (existing.length) throw new Error('Migration 110: existing organizations without completion marker; manual reconciliation required.');
    }
    for (const table of TENANT_TABLES) {
      if (await columnExists(db, table, 'organization_id', transaction)) {
        throw new Error(`Migration 110: ${table} already has organization_id; manual reconciliation required.`);
      }
    }
    // Acquire write-blocking DDL locks before taking the legacy snapshot. These
    // locks last until commit; run in a scheduled outage, not during live traffic.
    const existingTables = ['users'];
    for (const table of TENANT_TABLES) {
      if (await tableExists(db, table, transaction)) existingTables.push(table);
    }
    await db.query(`LOCK TABLE ${existingTables.map(table => `"${table}"`).join(', ')} IN ACCESS EXCLUSIVE MODE`, { transaction });
    await db.query(`CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(160) NOT NULL,
      slug VARCHAR(63) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      logo_url TEXT,
      primary_color VARCHAR(20) NOT NULL DEFAULT '#4f46e5',
      timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      CONSTRAINT organizations_status_check CHECK (status IN ('trial','active','past_due','suspended','archived'))
    )`, { transaction });
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_lower_uniq ON organizations (lower(slug)) WHERE deleted_at IS NULL`, { transaction });

    await db.query(`CREATE TABLE IF NOT EXISTS organization_memberships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL DEFAULT 'member',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      joined_at TIMESTAMPTZ,
      invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT organization_memberships_role_check CHECK (role IN ('owner','admin','member','guest')),
      CONSTRAINT organization_memberships_status_check CHECK (status IN ('invited','active','suspended','left')),
      UNIQUE (organization_id, user_id)
    )`, { transaction });
    await db.query(`CREATE INDEX IF NOT EXISTS organization_memberships_user_status_idx ON organization_memberships (user_id, status)`, { transaction });

    await db.query(`CREATE TABLE IF NOT EXISTS plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), key VARCHAR(40) NOT NULL UNIQUE,
      name VARCHAR(80) NOT NULL, description TEXT,
      monthly_price_cents INTEGER NOT NULL DEFAULT 0, annual_price_cents INTEGER NOT NULL DEFAULT 0,
      currency VARCHAR(3) NOT NULL DEFAULT 'USD', limits JSONB NOT NULL DEFAULT '{}'::jsonb,
      features JSONB NOT NULL DEFAULT '{}'::jsonb, active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`, { transaction });

    await db.query(`CREATE TABLE IF NOT EXISTS organization_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
      plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
      status VARCHAR(24) NOT NULL DEFAULT 'trialing', billing_interval VARCHAR(12) NOT NULL DEFAULT 'monthly',
      provider VARCHAR(30), provider_customer_id VARCHAR(255), provider_subscription_id VARCHAR(255),
      requested_plan_id UUID REFERENCES plans(id) ON DELETE SET NULL, requested_at TIMESTAMPTZ,
      trial_ends_at TIMESTAMPTZ, current_period_start TIMESTAMPTZ, current_period_end TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE, overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT organization_subscriptions_status_check CHECK (status IN ('trialing','active','past_due','paused','cancelled')),
      CONSTRAINT organization_subscriptions_interval_check CHECK (billing_interval IN ('monthly','annual'))
    )`, { transaction });

    await db.query(`CREATE TABLE IF NOT EXISTS organization_domains (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      hostname VARCHAR(255) NOT NULL UNIQUE, status VARCHAR(20) NOT NULL DEFAULT 'pending',
      is_primary BOOLEAN NOT NULL DEFAULT FALSE, verification_token VARCHAR(120), verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT organization_domains_status_check CHECK (status IN ('pending','verified','disabled'))
    )`, { transaction });

    for (const plan of DEFAULT_PLANS) {
      await db.query(`INSERT INTO plans
        (key,name,description,monthly_price_cents,annual_price_cents,currency,limits,features,sort_order)
        VALUES (:key,:name,:description,:monthly,:annual,'USD',CAST(:limits AS jsonb),CAST(:features AS jsonb),:sort)
        ON CONFLICT (key) DO NOTHING`, {
        replacements: { ...plan, limits: JSON.stringify(plan.limits), features: JSON.stringify(plan.features) }, transaction,
      });
    }

    const [organizations] = await db.query(`INSERT INTO organizations (name,slug,status)
      VALUES (:name,:slug,'active') ON CONFLICT DO NOTHING RETURNING id`, {
      replacements: { name, slug }, transaction,
    });
    let defaultOrgId = organizations[0]?.id;
    if (!defaultOrgId) {
      const [rows] = await db.query(`SELECT id FROM organizations WHERE lower(slug)=lower(:slug) AND deleted_at IS NULL LIMIT 1`, {
        replacements: { slug }, transaction,
      });
      defaultOrgId = rows[0].id;
    }

    await db.query(`INSERT INTO organization_memberships (organization_id,user_id,role,status,joined_at)
      SELECT :id, id, CASE WHEN role='admin' THEN 'owner' ELSE 'member' END, 'active', NOW()
      FROM users ON CONFLICT (organization_id,user_id) DO NOTHING`, { replacements: { id: defaultOrgId }, transaction });
    await db.query(`INSERT INTO organization_subscriptions
      (organization_id,plan_id,status,billing_interval,current_period_start,overrides)
      SELECT :id,id,'active','monthly',NOW(),CAST(:overrides AS jsonb) FROM plans WHERE key='growth'
      ON CONFLICT (organization_id) DO NOTHING`, {
      replacements: { id: defaultOrgId, overrides: JSON.stringify(LEGACY_DEVWEEKENDS_OVERRIDES) }, transaction,
    });

    // Core business records carry the tenant explicitly so direct lookups,
    // background jobs, and joins can enforce the same workspace boundary.
    for (const table of TENANT_TABLES) await addOrganizationColumn(db, table, defaultOrgId, transaction);

    // Previously global keys can now repeat in different organizations.
    await db.query(`ALTER TABLE system_settings DROP CONSTRAINT IF EXISTS system_settings_setting_key_key`, { transaction });
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS system_settings_org_key_uniq ON system_settings (organization_id, setting_key)`, { transaction });
    await db.query(`ALTER TABLE custom_roles DROP CONSTRAINT IF EXISTS custom_roles_key_key`, { transaction });
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS custom_roles_org_key_uniq ON custom_roles (organization_id, key)`, { transaction });
    await db.query(`ALTER TABLE badges DROP CONSTRAINT IF EXISTS badges_name_key`, { transaction });
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS badges_org_name_lower_uniq ON badges (organization_id, lower(name))`, { transaction });
    await db.query(`ALTER TABLE role_assignments DROP CONSTRAINT IF EXISTS role_assignments_user_id_role_scope_type_scope_id_key`, { transaction });
    await db.query(`DROP INDEX IF EXISTS role_assignments_user_id_role_scope_type_scope_id`, { transaction });
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS role_assignments_org_grant_uniq
      ON role_assignments (organization_id,user_id,role,scope_type,COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'::uuid))`, { transaction });
    await db.query(`INSERT INTO migration_110_completion (singleton, organization_id) VALUES (TRUE, :id)`, {
      replacements: { id: defaultOrgId }, transaction,
    });
  });
}

async function down() {
  throw new Error('No automatic rollback: organization ownership and subscription data cannot be safely collapsed.');
}

module.exports = { up, down, DEFAULT_PLANS, TENANT_TABLES };
if (require.main === module) {
  let db;
  Promise.resolve().then(async () => {
    if (process.argv.includes('--rollback')) return down();
    if (process.env.MIGRATION_110_MAINTENANCE !== 'true') return up();
    db = require('./_db');
    await up({ db });
  }).catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => db?.close());
}
