const { models } = require('../../src/db');
const service = require('../../src/services/certificateService');
const verification = require('../../src/services/certificateVerificationService');
const clans = require('../../src/services/clanService');
const { preCheckHardConstraints } = require('../../src/utils/certificateUtils');
const { cleanDb, createAdmin, createMentor, createMentee, createProgram, authHeader } = require('../helpers/seed');

describe('explicit No certificate decisions', () => {
  let admin, mentor, coMentor, outsider, mentee, peer, clan, template;
  const inWorkspace = fn => () => require('../../src/utils/auditContext').runWithRequestContext({ organizationId: clan.organizationId, workspaceJob: true }, fn);
  const reason = 'Required roadmap projects were not completed during this fellowship.';
  const decline = (user = mentor, explanation = reason) => verification.verify(template.id, mentee.id,
    { decision: 'no_certificate', finalTier: null, reason: explanation }, user);
  const issue = (user, ids = [mentee.id, peer.id]) => service.issueCertificates({ templateId: template.id,
    recipients: ids.map(menteeId => ({ menteeId, tier: 'silver' })) }, user.id, user);

  beforeAll(async () => {
    await cleanDb();
    admin = await createAdmin({ email: 'no-award-admin@test.com' }); mentor = await createMentor({ email: 'no-award-lead@test.com' }); outsider = await createMentor({ email: 'no-award-outsider@test.com' });
    coMentor = await createMentee({ email: 'co-reviewer@test.com' });
    mentee = await createMentee({ email: 'not-awarded@test.com' }); peer = await createMentee({ email: 'awarded@test.com' });
    const program = await createProgram({ createdBy: admin.id });
    clan = await models.Clan.create({ name: 'Review team', programId: program.id, leadMentorId: mentor.id, createdBy: admin.id });
    for (const [user, role] of [[mentor, 'lead_mentor'], [coMentor, 'co_mentor'], [mentee, 'mentee'], [peer, 'mentee']]) {
      await clans.addMember(clan.id, { userId: user.id, role });
    }
    template = await service.createTemplate({ name: 'No award review', programId: program.id, config: [],
      criteria: [{ id: 'silver', name: 'Silver', minCompletionRate: 70 }] }, admin.id);
  });
  beforeEach(async () => {
    // Keep people/program fixtures; reset only this feature's mutable records.
    await models.CertificateInstance.destroy({ where: { templateId: template.id } });
    await models.CertificateClanApproval.destroy({ where: { templateId: template.id } });
    await models.CertificateVerification.destroy({ where: { templateId: template.id } });
    await verification.open(template.id, [mentee, peer].map(m => ({ mentee_id: m.id, certificate_tier: 'silver', match_score: 80 })), { notify: false });
  });

  it('requires a reason, an explicit decision, and clan permission', inWorkspace(async () => {
    await expect(decline(mentor, '  ')).rejects.toThrow(/reason/i);
    await expect(decline(outsider)).rejects.toThrow();
    await expect(verification.verify(template.id, mentee.id, { decision: 'no_certificate', finalTier: 'silver', reason }, mentor)).rejects.toThrow(/tier/i);
    const row = await decline(coMentor);
    expect(row).toMatchObject({ decision: 'no_certificate', finalTier: null, aiTier: 'silver', status: 'verified', overridden: true, overrideReason: reason });
    expect(row.decisionHistory).toHaveLength(1);
  }));

  it('counts as verified, waits for approval, and excludes recipients for both roles and legacy issuance', inWorkspace(async () => {
    await decline();
    await verification.verify(template.id, peer.id, {}, mentor);
    expect((await verification.summary(template.id)).allVerified).toBe(true);
    await expect(issue(mentor)).rejects.toThrow(/not been approved/i);
    await verification.approveClan(template.id, clan.id, {}, admin);
    expect(await issue(mentor)).toMatchObject({ count: 1, skippedNoCertificate: 1 });
    expect(await issue(admin)).toMatchObject({ count: 0, skippedNoCertificate: 1 });
    expect(await service.issueCertificates({ templateId: template.id, menteeIds: [mentee.id], tier: 'silver' }, admin.id, admin)).toMatchObject({ count: 0, skippedNoCertificate: 1 });
    expect(await models.CertificateInstance.count({ where: { menteeId: mentee.id } })).toBe(0);
    const [recipient] = (await service.getQualification(template.id, null, mentor)).participation.filter(m => m.id === mentee.id);
    expect(recipient).toMatchObject({ assignedTier: null, assignedDecision: 'no_certificate' });
  }));

  it('locks mentor decisions after approval while allowing an audited admin correction', inWorkspace(async () => {
    await decline();
    await verification.verify(template.id, peer.id, {}, mentor);
    await verification.approveClan(template.id, clan.id, {}, admin);
    await expect(verification.verify(template.id, mentee.id, { decision: 'award', finalTier: 'silver', reason: 'Late work was reviewed and accepted.' }, mentor)).rejects.toThrow(/request a change/i);
    const updated = await verification.verify(template.id, mentee.id, { decision: 'award', finalTier: 'silver', reason: 'Late work was reviewed and accepted.' }, admin);
    expect(updated.decisionHistory).toHaveLength(2);
    expect(await models.CertificateClanApproval.count({ where: { templateId: template.id } })).toBe(1);
    expect((await issue(mentor)).count).toBe(2);
    await expect(decline()).rejects.toThrow(/request a change/i);
    await verification.open(template.id, [{ mentee_id: mentee.id, decision: 'no_certificate', certificate_tier: null, reasoning: reason }], { notify: false });
    expect((await models.CertificateVerification.findOne({ where: { templateId: template.id, menteeId: mentee.id } })).decision).toBe('award');
  }));

  it('preserves No certificate when admin resends the round', inWorkspace(async () => {
    await decline();
    await verification.open(template.id, [{ mentee_id: mentee.id, certificate_tier: 'silver' }], { notify: false });
    const row = await models.CertificateVerification.findOne({ where: { templateId: template.id, menteeId: mentee.id } });
    expect(row.decision).toBe('no_certificate');
    expect(row.overrideReason).toBe(reason);
  }));

  it('supports an AI No certificate recommendation without treating a failed evaluation as a decision', inWorkspace(async () => {
    const payload = { mentee_id: mentee.id, normalized_score: 20, completion_rate: 10, on_time_rate: 20, blockers: { open: 0 } };
    const check = preCheckHardConstraints(payload, template.criteria);
    expect(check.maxEligibleTier).toBeNull();
    const [evaluation] = await service.parseBatchAIResponse(JSON.stringify([{ mentee_id: mentee.id, certificate_tier: 'silver', reasoning: 'Insufficient completion.' }]), template.criteria,
      [{ menteeId: mentee.id, menteePayload: payload, preCheck: check }]);
    expect(evaluation.result).toMatchObject({ decision: 'no_certificate', certificate_tier: null, is_eligible: false, hard_constraints_check: { completion_rate_ok: false } });
    await verification.open(template.id, [evaluation.result], { notify: false });
    await expect(verification.verify(template.id, mentee.id, {}, mentor)).rejects.toThrow(/reason/i);
    expect(await decline()).toMatchObject({ decision: 'no_certificate', overridden: false });
    const failure = service.buildFallbackResult(payload, check);
    expect(failure).toMatchObject({ _failed: true, decision: 'undecided', certificate_tier: null });
    expect(await verification.open(template.id, [failure], { notify: false })).toMatchObject({ created: 0, updated: 0 });
  }));

  it('requires a reason to upgrade an AI No certificate recommendation', inWorkspace(async () => {
    await verification.open(template.id, [{ mentee_id: mentee.id, decision: 'no_certificate', certificate_tier: null, reasoning: reason }], { notify: false });
    await expect(verification.verify(template.id, mentee.id, { decision: 'award', finalTier: 'silver' }, mentor)).rejects.toThrow(/reason/i);
    expect(await verification.verify(template.id, mentee.id, { decision: 'award', finalTier: 'silver', reason: 'Reviewed the missing submissions and confirmed completion.' }, mentor)).toMatchObject({ decision: 'award', overridden: true });
  }));
  it('rolls back the whole batch when any decision is invalid', inWorkspace(async () => {
    await expect(verification.verifyMany(template.id, [
      { menteeId: peer.id, decision: 'award', finalTier: 'silver' },
      { menteeId: mentee.id, decision: 'no_certificate' }
    ], mentor)).rejects.toThrow(/reason/i);
    expect(await models.CertificateVerification.count({ where: { templateId: template.id, status: 'verified' } })).toBe(0);
  }));

  it('exposes the saved decision, reason, and audit record through the reviewer APIs', inWorkspace(async () => {
    const request = require('supertest');
    const app = require('../../src/index');
    const url = `/api/certificates/templates/${template.id}/verifications/${mentee.id}`;
    const response = await request(app).post(url).set('Authorization', authHeader(coMentor))
      .send({ decision: 'no_certificate', finalTier: null, reason });
    expect(response.status).toBe(200);
    expect(response.body.data.verification).toMatchObject({ decision: 'no_certificate', finalTier: null });
    const evidence = await service.getMenteeEvidence(template.id, mentee.id, admin);
    expect(evidence.verification).toMatchObject({ decision: 'no_certificate', overrideReason: reason });
    expect(evidence.verification.decisionHistory[0].by).toBe(coMentor.id);
    await expect(service.getMenteeEvidence(template.id, mentee.id, mentee)).rejects.toThrow(/not been published/i);
  }));

  it('never races into both an issued certificate and a No certificate decision', inWorkspace(async () => {
    await verification.verify(template.id, mentee.id, {}, mentor);
    await verification.verify(template.id, peer.id, {}, mentor);
    await verification.approveClan(template.id, clan.id, {}, admin);
    await Promise.allSettled([decline(), issue(admin, [mentee.id])]);
    const row = await models.CertificateVerification.findOne({ where: { templateId: template.id, menteeId: mentee.id } });
    const issued = await models.CertificateInstance.count({ where: { templateId: template.id, menteeId: mentee.id } });
    expect(row.decision === 'no_certificate' && issued > 0).toBe(false);
  }));

  it('treats missing AI rule evidence as a failed evaluation, not No certificate', inWorkspace(async () => {
    const criteria = [{ id: 'silver', name: 'Silver', customRule: 'Delivered a reviewed final project' }];
    const payload = { mentee_id: mentee.id, normalized_score: 80, completion_rate: 90, on_time_rate: 80, blockers: {} };
    const [evaluation] = await service.parseBatchAIResponse(JSON.stringify([{ mentee_id: mentee.id, certificate_tier: null }]), criteria,
      [{ menteeId: mentee.id, menteePayload: payload }]);
    expect(evaluation.result).toMatchObject({ _failed: true, decision: 'undecided' });
  }));

  it('requires evidence before a passed custom rule can award its tier', inWorkspace(async () => {
    const criteria = [{ id: 'silver', name: 'Silver', customRule: 'Delivered a reviewed final project' }];
    const payload = { mentee_id: mentee.id, normalized_score: 80, completion_rate: 90, on_time_rate: 80, blockers: {} };
    const [evaluation] = await service.parseBatchAIResponse(JSON.stringify([{
      mentee_id: mentee.id,
      certificate_tier: 'silver',
      custom_rules_check: [{ tier_id: 'silver', rule: criteria[0].customRule, passed: true, evidence: '' }]
    }]), criteria, [{ menteeId: mentee.id, menteePayload: payload }]);
    expect(evaluation.result).toMatchObject({ decision: 'no_certificate', certificate_tier: null });
    expect(evaluation.result.tier_checks[0]).toMatchObject({ custom_rule_passed: false });
  }));

  it('applies custom AI rules only to their own certificate tier', inWorkspace(async () => {
    const criteria = [
      { id: 'gold', name: 'Gold', priority: 2, customRule: 'Led the final project' },
      { id: 'silver', name: 'Silver', priority: 1, customRule: 'Delivered a reviewed final project' }
    ];
    const payload = { mentee_id: mentee.id, normalized_score: 90, completion_rate: 95, on_time_rate: 90, blockers: {} };
    const [evaluation] = await service.parseBatchAIResponse(JSON.stringify([{
      mentee_id: mentee.id,
      certificate_tier: 'silver',
      custom_rules_check: [
        { tier_id: 'gold', rule: criteria[0].customRule, passed: false, evidence: 'No leadership evidence.' },
        { tier_id: 'silver', rule: criteria[1].customRule, passed: true, evidence: 'Approved final-project submission and mentor feedback.' }
      ]
    }]), criteria, [{ menteeId: mentee.id, menteePayload: payload }]);
    expect(evaluation.result).toMatchObject({ decision: 'award', certificate_tier: 'silver' });
  }));

  it('requires direct AI evidence for every configured certificate checklist item', inWorkspace(async () => {
    const criteria = [{ id: 'silver', name: 'Silver', reviewChecklist: ['Completed the multi-vendor project'] }];
    const payload = { mentee_id: mentee.id, normalized_score: 90, completion_rate: 95, on_time_rate: 90, blockers: {} };
    const batch = [{ menteeId: mentee.id, menteePayload: payload }];

    const [missing] = await service.parseBatchAIResponse(JSON.stringify([{
      mentee_id: mentee.id, certificate_tier: 'silver'
    }]), criteria, batch);
    expect(missing.result).toMatchObject({ _failed: true, decision: 'undecided' });

    const [proven] = await service.parseBatchAIResponse(JSON.stringify([{
      mentee_id: mentee.id,
      certificate_tier: 'silver',
      criteria_checks: [{ tier_id: 'silver', item: criteria[0].reviewChecklist[0], passed: true, evidence: 'Approved multi-vendor submission and mentor feedback.' }]
    }]), criteria, batch);
    expect(proven.result).toMatchObject({ decision: 'award', certificate_tier: 'silver' });
    expect(proven.result.tier_checks[0]).toMatchObject({ checklist_passed: true });
  }));

  it('requires every configured mentor checklist item before sign-off', inWorkspace(async () => {
    const originalCriteria = template.criteria;
    const item = 'Completed the multi-vendor project';
    try {
      await template.update({ criteria: [{ id: 'silver', name: 'Silver', reviewChecklist: [item] }] });
      await expect(verification.verify(template.id, mentee.id, {}, mentor)).rejects.toThrow(/confirm every checklist item/i);
      const saved = await verification.verify(template.id, mentee.id, { criteriaChecks: [item] }, mentor);
      expect(saved.criteriaChecks).toEqual([item]);
    } finally {
      await template.update({ criteria: originalCriteria });
    }
  }));

  it('does not issue an AI No certificate recommendation before a review round exists', inWorkspace(async () => {
    await models.CertificateVerification.destroy({ where: { templateId: template.id, menteeId: mentee.id } });
    await template.update({ aiEvaluation: { results: [{ mentee_id: mentee.id, decision: 'no_certificate', certificate_tier: null }] } });
    expect(await issue(admin, [mentee.id])).toMatchObject({ count: 0, skippedNoCertificate: 1 });
    await template.update({ aiEvaluation: null });
  }));

});
