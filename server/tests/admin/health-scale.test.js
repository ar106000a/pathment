jest.mock('../../src/db', () => ({ models: { ClanMembership: { findAll: jest.fn() }, DelayEvent: { findAll: jest.fn() } } }));
jest.mock('../../src/services/clanService', () => ({ listClans: jest.fn() }));
jest.mock('../../src/services/cohortService', () => ({ preloadMenteeData: jest.fn(), buildMenteeRow: jest.fn() }));
const { models } = require('../../src/db');
const clans = require('../../src/services/clanService');
const cohort = require('../../src/services/cohortService');
const health = require('../../src/services/clanHealthService');
const { setDefaultRequestContext } = require('../../src/utils/auditContext');

beforeAll(() => setDefaultRequestContext({ organizationId: 'scale-org' }));

test('30,000 mentees: bounded batches, unique org totals, shared snapshot, paginated follow-ups', async () => {
  const clanRows = Array.from({length:70}, (_, i) => ({id:`c${i}`,name:`Clan ${i}`,programId:'p',program:{id:'p',name:'Program'},leadMentor:null}));
  clans.listClans.mockResolvedValue(clanRows);
  const memberships = Array.from({length:30000}, (_, i) => ({clanId:`c${i%70}`,userId:`u${i}`,role:'mentee'}));
  memberships.push({clanId:'c1',userId:'u0',role:'mentee'}); // multi-clan mentee counts once org-wide
  models.ClanMembership.findAll.mockResolvedValue(memberships);
  cohort.preloadMenteeData.mockResolvedValue({});
  cohort.buildMenteeRow.mockImplementation(async id => ({id,name:id,email:`${id}@example.test`,risk:'high',riskReason:'Needs support',absoluteProgress:Number(id.slice(1))%100,relativeProgress:50,onTimeRate:80,pendingApprovals:1,openBlockers:0,completedTasks:[{large:'task history'}]}));
  const [snapshot, queue] = await Promise.all([health.programHealth(['p']),health.followUps({page:2,limit:20},['p'])]);
  expect(snapshot.kpis.activeMentees).toBe(30000);
  expect(snapshot.kpis.atRisk).toBe(30000);
  expect(snapshot.summary.completion.reduce((sum,bucket)=>sum+bucket.count,0)).toBe(30000);
  expect(snapshot.atRiskMentees).toHaveLength(12);
  expect(queue.rows).toHaveLength(20);
  expect(queue.pages).toBe(1500);
  expect(queue.total).toBe(30000);
  // Each clan is a separate scoring peer group, so its own batches are loaded.
  expect(cohort.preloadMenteeData).toHaveBeenCalledTimes(210);
  expect(cohort.preloadMenteeData.mock.calls.every(([ids])=>ids.length<=200)).toBe(true);
  expect(clans.listClans).toHaveBeenCalledTimes(1);
  expect(queue.rows.every(row=>!('completedTasks' in row))).toBe(true);
  const filtered = await health.followUps({clanId:'c0',search:'u0',limit:50},['p']);
  expect(filtered.rows.map(row=>row.id)).toEqual(['u0']);
  expect(cohort.preloadMenteeData).toHaveBeenCalledTimes(210);
});

test('program scopes never reuse an organization snapshot', async () => {
  clans.listClans.mockResolvedValue([]);
  const result = await health.programHealth([]);
  expect(result.kpis.activeMentees).toBe(0);
  expect(clans.listClans).toHaveBeenLastCalledWith({programIds:[]});
});
