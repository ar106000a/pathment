const { sequelize } = require('../../src/db');
const { programMentorCounts } = require('../../src/services/programMentorCounts');
const { setDefaultRequestContext } = require('../../src/utils/auditContext');
beforeAll(() => setDefaultRequestContext({ organizationId: 'test-org' }));
afterAll(() => sequelize.close());
test('counts distinct leads, co-mentors and legacy matches without cross-program or inactive membership inflation', async () => {
  await sequelize.transaction(async transaction => {
    // Connection-local fixtures shadow public tables and vanish at commit.
    await sequelize.query(`
      CREATE TEMP TABLE clans (id text, organization_id text, program_id text, lead_mentor_id text, status text, kind text) ON COMMIT DROP;
      CREATE TEMP TABLE clan_memberships (clan_id text, organization_id text, user_id text, role text, status text) ON COMMIT DROP;
      CREATE TEMP TABLE enrollments (id text, organization_id text, program_id text) ON COMMIT DROP;
      CREATE TEMP TABLE mentor_mentee_matches (organization_id text, mentor_id text, enrollment_id text, status text) ON COMMIT DROP;
      INSERT INTO clans VALUES ('c1','test-org','p1','lead','active','cohort'),('c2','test-org','p1','lead','active','cohort'),('c3','test-org','p2','other','active','cohort'),('old','test-org','p1','archived-lead','archived','cohort');
      INSERT INTO clan_memberships VALUES ('c1','test-org','lead','lead_mentor','active'),('c1','test-org','co','co_mentor','active'),('c2','test-org','co','co_mentor','active'),('c1','test-org','paused','co_mentor','paused'),('c1','test-org','learner','mentee','active'),('old','test-org','old-co','co_mentor','active');
      INSERT INTO enrollments VALUES ('e1','test-org','p1'),('e2','test-org','p2');
      INSERT INTO mentor_mentee_matches VALUES ('test-org','legacy','e1','active'),('test-org','lead','e1','active'),('test-org','ended','e1','completed'),('test-org','other','e2','active');
    `, {transaction});
    const counts = await programMentorCounts(['p1','p2'], transaction);
    expect(counts.get('p1')).toBe(3);
    expect(counts.get('p2')).toBe(1);
    expect(await programMentorCounts([],transaction)).toEqual(new Map());
  });
});
