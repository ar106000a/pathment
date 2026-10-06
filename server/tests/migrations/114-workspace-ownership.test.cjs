const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const withPostgres = require('../helpers/privatePostgres.cjs');
const { up, TABLES } = require('../../scripts/migrations/114_workspace_model_ownership');
const { WORKSPACE_MODELS } = require('../../src/config/tenantOwnership');

test('migration 114 keeps its historical inventory when later tables are added', () => {
  assert.ok(Object.values(WORKSPACE_MODELS).includes('standing_clan_requests'));
  assert.ok(!TABLES.includes('standing_clan_requests'));
});

test('workspace ownership migration preserves legacy rows and follows existing parents', async () => {
  await withPostgres(async db => {
    const legacy = randomUUID(), second = randomUUID(), user = randomUUID(), program = randomUUID();
    await db.query(`CREATE TABLE organizations(id UUID PRIMARY KEY, slug TEXT UNIQUE);
      INSERT INTO organizations VALUES('${legacy}', 'devweekends'), ('${second}', 'second');
      CREATE TABLE programs(id UUID PRIMARY KEY, organization_id UUID NOT NULL REFERENCES organizations(id));
      INSERT INTO programs VALUES('${program}', '${second}')`);
    for (const table of TABLES) {
      const extra = table === 'assessments' ? ', program_id UUID REFERENCES programs(id)' :
        table === 'mentee_profiles' ? ', user_id UUID UNIQUE' : '';
      await db.query(`CREATE TABLE "${table}"(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), payload TEXT${extra});
        INSERT INTO "${table}"(payload) VALUES('preserve')`);
    }
    await db.query(`UPDATE assessments SET program_id='${program}'; UPDATE mentee_profiles SET user_id='${user}'`);
    await assert.rejects(up({ db, maintenance: false }), /requires/);
    await up({ db, maintenance: true });
    for (const table of TABLES) {
      const [[row]] = await db.query(`SELECT payload, organization_id FROM "${table}"`);
      assert.equal(row.payload, 'preserve');
      assert.equal(row.organization_id, table === 'assessments' ? second : legacy, table);
    }
    await assert.rejects(db.query("INSERT INTO activity_sessions(payload) VALUES('missing scope')"), /null/i);
    await db.query(`INSERT INTO mentee_profiles(user_id, organization_id) VALUES('${user}', '${second}')`);
    await assert.rejects(db.query(`INSERT INTO mentee_profiles(user_id, organization_id) VALUES('${user}', '${second}')`), /Validation/);
    await up({ db, maintenance: true });
    const [[count]] = await db.query('SELECT count(*)::int AS count FROM mentee_profiles');
    assert.equal(count.count, 2);
    const [defaults] = await db.query("SELECT column_default FROM information_schema.columns WHERE column_name='organization_id' AND table_name IN (:tables)", { replacements: { tables: TABLES } });
    assert.ok(defaults.every(row => row.column_default === null));
  });
});

test('unmarked partial ownership is rejected atomically', async () => {
  await withPostgres(async db => {
    await db.query("CREATE TABLE organizations(id UUID PRIMARY KEY, slug TEXT); INSERT INTO organizations VALUES(gen_random_uuid(),'devweekends')");
    for (const table of TABLES) await db.query(`CREATE TABLE "${table}"(id UUID PRIMARY KEY)`);
    await db.query(`ALTER TABLE "${TABLES[5]}" ADD COLUMN organization_id UUID`);
    await assert.rejects(up({ db, maintenance: true }), /Unexpected schema/);
    const [[row]] = await db.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE column_name='organization_id'");
    assert.equal(row.count, 1, 'earlier table alterations rolled back');
  });
});
