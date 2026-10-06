// Standalone node:test suite: owns a temporary PostgreSQL cluster and private
// Unix socket. Never imports app setup, dotenv, _db, or uses DATABASE_URL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Sequelize } = require('sequelize');
const { up, TENANT_TABLES } = require('../../scripts/migrations/110_multi_tenant_foundation');

const bin = process.env.MIGRATION_TEST_PG_BIN || '/usr/lib/postgresql/16/bin';
const run = (name, args) => execFileSync(path.join(bin, name), args, { stdio: 'pipe' });

test('migration 110 safety in an exclusively owned PostgreSQL cluster', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'migration110-'));
  const data = path.join(dir, 'data');
  let db;
  let started = false;
  const saved = [process.env.DEFAULT_ORGANIZATION_SLUG, process.env.TENANT_SLUG];
  delete process.env.DEFAULT_ORGANIZATION_SLUG;
  delete process.env.TENANT_SLUG;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'migration_test', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', path.join(dir, 'postgres.log'), '-o', `-F -k ${dir} -h ''`, '-w', 'start']);
    started = true;
    db = new Sequelize('postgres', 'migration_test', '', { dialect: 'postgres', host: dir, logging: false });
    const query = sql => db.query(sql);
    const rows = async sql => (await query(sql))[0];
    await query(`CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), role TEXT);
      INSERT INTO users (role) SELECT CASE WHEN n=1 THEN 'admin' ELSE 'mentee' END FROM generate_series(1,1601) n`);
    for (const table of TENANT_TABLES) {
      const extra = {
        system_settings: ', setting_key TEXT UNIQUE', custom_roles: ', key TEXT UNIQUE', badges: ', name TEXT UNIQUE',
        role_assignments: ', user_id UUID, role TEXT, scope_type TEXT, scope_id UUID',
      }[table] || '';
      await query(`CREATE TABLE "${table}" (id UUID PRIMARY KEY DEFAULT gen_random_uuid() ${extra}); INSERT INTO "${table}" DEFAULT VALUES`);
    }
    await t.test('requires maintenance acknowledgement without connecting', async () => {
      await assert.rejects(up({ db: { transaction() { throw Error('connected'); } }, maintenance: false }), /requires MIGRATION/);
    });
    await t.test('rejects conflicting slug', async () => {
      process.env.TENANT_SLUG = 'another-tenant';
      await assert.rejects(up({ db, maintenance: true }), /conflicting/);
      delete process.env.TENANT_SLUG;
    });
    await t.test('refuses preexisting tenant columns without overwriting them', async () => {
      await query('ALTER TABLE programs ADD COLUMN organization_id UUID');
      await assert.rejects(up({ db, maintenance: true }), /already has organization_id/);
      await query('ALTER TABLE programs DROP COLUMN organization_id');
    });
    await t.test('lock contention aborts and rolls back completion table', async () => {
      const blocker = await db.transaction();
      try {
        await db.query('LOCK TABLE users IN ROW EXCLUSIVE MODE', { transaction: blocker });
        await assert.rejects(up({ db, maintenance: true }), /lock timeout/);
        assert.equal((await rows("SELECT to_regclass('migration_110_completion') AS name"))[0].name, null);
      } finally { await blocker.rollback(); }
    });
    await t.test('late uniqueness failure rolls back backfill and allows retry', async () => {
      await query("INSERT INTO badges (name) VALUES ('Duplicate'), ('duplicate')");
      await assert.rejects(up({ db, maintenance: true }), error => error.original?.constraint === 'badges_org_name_lower_uniq');
      assert.equal((await rows("SELECT to_regclass('organizations') AS name"))[0].name, null);
      assert.equal((await rows("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='programs' AND column_name='organization_id'"))[0].n, 0);
      await query("DELETE FROM badges WHERE name='duplicate'");
    });
    let org;
    await t.test('concurrent runs backfill every table and all 1601 users once', async () => {
      // A real production audit log can exceed the storage headroom available
      // for an UPDATE backfill. Ownership must not expand the existing heap.
      await query(`ALTER TABLE audit_logs ADD COLUMN payload TEXT;
        INSERT INTO audit_logs (payload) SELECT repeat('audit record ', 80) FROM generate_series(1, 10000)`);
      const heapBefore = (await rows("SELECT pg_relation_size('audit_logs')::text AS bytes"))[0].bytes;
      await Promise.all([up({ db, maintenance: true }), up({ db, maintenance: true })]);
      assert.equal((await rows("SELECT pg_relation_size('audit_logs')::text AS bytes"))[0].bytes, heapBefore,
        'Backfill must not rewrite or duplicate the audit log heap');
      assert.equal((await rows("SELECT column_default FROM information_schema.columns WHERE table_name='audit_logs' AND column_name='organization_id'"))[0].column_default, null,
        'New writes must not silently inherit DevWeekends');
      org = (await rows('SELECT id FROM organizations'))[0].id;
      assert.equal((await rows('SELECT count(*)::int AS n FROM organization_memberships'))[0].n, 1601);
      assert.equal((await rows("SELECT count(*)::int AS n FROM organization_memberships WHERE role='owner'"))[0].n, 1);
      for (const table of TENANT_TABLES) {
        assert.ok((await rows(`SELECT organization_id FROM "${table}"`)).every(row => row.organization_id === org));
      }
      assert.deepEqual((await rows('SELECT overrides FROM organization_subscriptions'))[0].overrides, {
        limits: { members: -1, programs: -1, clans: -1, storageGb: -1, aiEvaluationsPerMonth: -1 },
        features: { certificates: true, aiEvaluation: true, customBranding: true,
          customDomain: true, advancedAnalytics: true, sso: true, programCompletionStanding: true },
      });
      const growth = (await rows("SELECT limits, features FROM plans WHERE key='growth'"))[0];
      assert.deepEqual(growth.limits, {
        members: 1500, programs: 15, clans: 60, storageGb: 50, aiEvaluationsPerMonth: 5000,
      });
      assert.equal(growth.features.sso, false);
    });
    await t.test('legacy writes fail closed and scoped writes enforce foreign keys', async () => {
      await assert.rejects(query('INSERT INTO programs DEFAULT VALUES'), /not-null constraint/);
      await assert.rejects(query("INSERT INTO programs (organization_id) VALUES (gen_random_uuid())"), /foreign key constraint/);
      await query(`INSERT INTO programs (organization_id) VALUES ('${org}')`);
    });
    await t.test('reruns leave future tenant users, subscriptions and plans untouched', async () => {
      await query(`INSERT INTO organizations (name,slug) VALUES ('Other','other');
        INSERT INTO users (role) VALUES ('admin');
        INSERT INTO organization_memberships (organization_id,user_id)
          SELECT o.id,u.id FROM organizations o CROSS JOIN users u WHERE o.slug='other'
          AND NOT EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id=u.id);
        UPDATE plans SET limits='{"members":42}' WHERE key='growth';
        UPDATE organization_subscriptions SET overrides='{"limits":{"members":9999}}';
        INSERT INTO programs (organization_id) SELECT id FROM organizations WHERE slug='other'`);
      await query(`INSERT INTO badges (name,organization_id) SELECT 'Duplicate',id FROM organizations WHERE slug='other'`);
      await assert.rejects(query(`INSERT INTO badges (name,organization_id) VALUES ('DUPLICATE','${org}')`), error => error.original?.constraint === 'badges_org_name_lower_uniq');
      await up({ db, maintenance: true });
      assert.equal((await rows(`SELECT count(*)::int AS n FROM organization_memberships WHERE organization_id='${org}'`))[0].n, 1601);
      assert.equal((await rows("SELECT limits FROM plans WHERE key='growth'"))[0].limits.members, 42);
      assert.equal((await rows('SELECT overrides FROM organization_subscriptions'))[0].overrides.limits.members, 9999);
      assert.equal((await rows(`SELECT count(*)::int AS n FROM programs WHERE organization_id <> '${org}'`))[0].n, 1);
    });
    await t.test('unmarked earlier migration fails without sweeping users', async () => {
      await query('DELETE FROM migration_110_completion');
      await assert.rejects(up({ db, maintenance: true }), /manual reconciliation/);
      assert.equal((await rows(`SELECT count(*)::int AS n FROM organization_memberships WHERE organization_id='${org}'`))[0].n, 1601);
    });
  } finally {
    if (db) await db.close();
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
    ['DEFAULT_ORGANIZATION_SLUG', 'TENANT_SLUG'].forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    });
  }
});
