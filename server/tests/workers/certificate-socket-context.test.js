jest.mock('../../src/db', () => ({
  models: {
    Organization: { findAll: jest.fn(async () => [{ id: 'owner-org', slug: 'owner' }]) },
    CertificateTemplate: { findByPk: jest.fn() },
    CertificateInstance: { findAll: jest.fn() },
    CertificateVerification: { findAll: jest.fn() },
    CertificateClanApproval: { findAll: jest.fn() },
    AIEvaluationQueue: { findOne: jest.fn(), findAll: jest.fn() },
    User: { findAll: jest.fn(), findByPk: jest.fn() },
  },
  sequelize: { transaction: jest.fn(fn => fn({ LOCK: { UPDATE: 'UPDATE' } })),
    query: jest.fn(), fn: jest.fn(), col: jest.fn(), QueryTypes: { SELECT: 'SELECT' } },
}));
jest.mock('../../src/services/certificateService', () => ({
  evaluateBatchMentees: jest.fn(), buildFallbackResult: jest.fn(() => ({ _failed: true })),
}));
jest.mock('../../src/services/certificateEvaluationStore', () => ({ saveResults: jest.fn() }));
jest.mock('../../src/utils/certificateUtils', () => ({ enrichEvaluationResults: jest.fn(async x => x) }));
jest.mock('../../src/services/organizationService', () => ({ assertMembership: jest.fn(), workspaceCreationEnabled: () => true, defaultSlug: () => 'devweekends' }));
jest.mock('../../src/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { models, sequelize } = require('../../src/db');
const service = require('../../src/services/certificateService');
const { emitToUser } = require('../../src/socket');
const { assertMembership } = require('../../src/services/organizationService');
const { runWithRequestContext, getRequestContext } = require('../../src/utils/auditContext');
const { tickAIEval } = require('../../src/workers/certificateWorker');
let job, events;
beforeEach(() => {
  jest.clearAllMocks();
  job = { organizationId: 'owner-org', runId: 'run', templateId: 'template', triggeredBy: 'admin', menteeId: 'mentee', attempts: 2, save: jest.fn() };
  models.AIEvaluationQueue.findOne.mockReset().mockResolvedValueOnce({ runId: 'run', templateId: 'template', triggeredBy: 'admin' }).mockResolvedValue(null);
  models.AIEvaluationQueue.findAll.mockImplementation(async options => {
    if (options.group) return [{ status: 'completed', count: 1 }];
    return [job];
  });
  models.CertificateTemplate.findByPk.mockResolvedValue({ id: 'template', organizationId: 'owner-org' });
  models.CertificateInstance.findAll.mockResolvedValue([]);
  models.CertificateVerification.findAll.mockResolvedValue([]);
  models.CertificateClanApproval.findAll.mockResolvedValue([]);
  models.User.findAll.mockResolvedValue([]);
  models.User.findByPk.mockResolvedValue(null);
  sequelize.query.mockResolvedValue([{ completedCount: 1, totalCount: 1 }]);
  service.evaluateBatchMentees.mockResolvedValue([{ menteeId: 'mentee', result: { score: 1 } }]);
  assertMembership.mockResolvedValue({ status: 'active' });
  events = [];
  emitToUser.mockImplementation((userId, event) => events.push({ userId, event, context: { ...getRequestContext() } }));
});
test('context-free worker progress and completion use persisted template ownership', async () => {
  await tickAIEval();
  expect(events.map(e => e.event)).toEqual(['ai-eval:progress', 'ai-eval:complete']);
  for (const event of events) expect(event.context).toEqual({ organizationId: 'owner-org', userId: 'admin' });
  expect(assertMembership).toHaveBeenCalledWith('admin', 'owner-org');
  expect(getRequestContext()).toEqual({});
});
test('failed evaluation emits in template context rather than ambient tenant', async () => {
  service.evaluateBatchMentees.mockRejectedValueOnce(new Error('evaluation failed'));
  await runWithRequestContext({ organizationId: 'wrong-org' }, () => tickAIEval());
  expect(events).toEqual([{ userId: 'admin', event: 'ai-eval:progress', context: { organizationId: 'owner-org', userId: 'admin' } }]);
  expect(models.CertificateTemplate.findByPk).toHaveBeenCalledWith('template', {
    attributes: ['organizationId'], skipOrganizationScope: true,
  });
});
test('missing persisted ownership never falls back to a default tenant', async () => {
  models.CertificateTemplate.findByPk.mockResolvedValue({ id: 'template' });
  await tickAIEval();
  expect(emitToUser).not.toHaveBeenCalled();
  expect(service.evaluateBatchMentees).not.toHaveBeenCalled();
});
test('revoked recipient receives no progress and does not cause job retry', async () => {
  assertMembership.mockResolvedValueOnce({ status: 'active' }).mockResolvedValueOnce({ status: 'active' })
    .mockRejectedValueOnce(new Error('revoked')).mockRejectedValueOnce(new Error('revoked'));
  await tickAIEval();
  expect(emitToUser).not.toHaveBeenCalled();
  expect(job.status).toBe('completed');
});
