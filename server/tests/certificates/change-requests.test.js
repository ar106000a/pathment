'use strict';

/**
 * A mentor edits freely until an admin sends the certificate — and not after.
 *
 * Before approval a mentor's sign-off is their own working decision and they
 * should be able to correct it without ceremony. After issuance it is the
 * admin's call. But "you cannot change this" with no way forward is a dead end:
 * the mentor knows the mentee and is exactly who spots a mistake afterwards. So
 * they request, with a reason, and the admin decides in one press.
 */

const { models } = require('../../src/db');
const clanService = require('../../src/services/clanService');
const certificateService = require('../../src/services/certificateService');
const verification = require('../../src/services/certificateVerificationService');
const notificationOrchestrator = require('../../src/services/notificationOrchestrator');
const { cleanDb, createAdmin, createMentor, createMentee, createProgram } = require('../helpers/seed');

describe('changing a grade after approval', () => {
  let admin, lead, outsider, mentee, other, program, clan, template;

  beforeEach(async () => {
    await cleanDb();
    for (const model of ['CertificateReviewQuestion', 'CertificateClanApproval', 'CertificateVerification', 'CertificateInstance', 'CertificateTemplate']) {
      await models[model].destroy({ where: {}, force: true });
    }

    admin = await createAdmin({ email: 'admin@test.com' });
    lead = await createMentor({ email: 'lead@test.com' });
    outsider = await createMentor({ email: 'outsider@test.com' });
    mentee = await createMentee({ email: 'mentee@test.com' });
    other = await createMentee({ email: 'other@test.com' });

    program = await createProgram({ createdBy: admin.id });
    clan = await models.Clan.create({ programId: program.id, name: 'Static Stream', leadMentorId: lead.id, createdBy: admin.id });
    await clanService.addMember(clan.id, { userId: lead.id, role: 'lead_mentor' });
    for (const p of [mentee, other]) await clanService.addMember(clan.id, { userId: p.id, role: 'mentee' });

    template = await certificateService.createTemplate({
      name: 'Fellowship 2026 summer',
      config: [],
      criteria: [
        { id: 'bronze', name: 'Bronze', artworkUrl: 'https://cdn/b.png', layout: [] },
        { id: 'silver', name: 'Silver', artworkUrl: 'https://cdn/s.png', layout: [] }
      ],
      programId: program.id
    }, admin.id);
    await template.update({
      aiEvaluation: {
        results: [mentee, other].map((m) => ({ mentee_id: m.id, certificate_tier: 'bronze', match_score: 60 })),
        ranAt: new Date().toISOString()
      }
    });
    await verification.sendToClans(template.id, {}, admin);
    notificationOrchestrator.dispatch.mockClear();
  });

  const rowFor = (m) => models.CertificateVerification.findOne({
    where: { templateId: template.id, menteeId: m.id }
  });
  const issueFor = (m, tier = 'bronze') => models.CertificateInstance.create({
    organizationId: template.organizationId,
    templateId: template.id,
    menteeId: m.id,
    issuedBy: admin.id,
    tier,
    certificateNumber: `TEST-${m.id.slice(0, 8)}-${Date.now()}`
  });
  const dispatchesTo = (userId) => notificationOrchestrator.dispatch.mock.calls
    .map(([args]) => args)
    .filter((args) => (args.recipients || []).some((r) => r.userId === userId));

  describe('before an admin approves', () => {
    it('lets the mentor change their own sign-off freely', async () => {
      await verification.verify(template.id, mentee.id, {}, lead);
      const changed = await verification.verify(template.id, mentee.id,
        { finalTier: 'silver', reason: 'Carried the clan in August' }, lead);
      expect(changed.finalTier).toBe('silver');
      expect(changed.stage).toBe('mentor_verified');
    });

    it('refuses a change request — there is nothing to ask for', async () => {
      await verification.verify(template.id, mentee.id, {}, lead);
      await expect(verification.requestChange(template.id, mentee.id,
        { finalTier: 'silver', reason: 'Deserves more' }, lead))
        .rejects.toThrow(/not been approved yet/i);
    });
  });

  describe('once an admin approves, before an instance is issued', () => {
    beforeEach(async () => {
      await verification.verify(template.id, mentee.id, {}, lead);
      await verification.verify(template.id, mentee.id, {}, admin);
    });

    it('requires the mentor to request the change', async () => {
      await expect(verification.verify(template.id, mentee.id,
        { finalTier: 'silver', reason: 'Deserves more' }, lead))
        .rejects.toThrow(/Request a change/i);
      await expect(verification.requestChange(template.id, mentee.id,
        { finalTier: 'silver', reason: 'Deserves more' }, lead))
        .resolves.toMatchObject({ kind: 'change_request', requestedTier: 'silver' });
    });

    it('lets the admin approve the request without requiring an issued instance', async () => {
      const request = await verification.requestChange(template.id, mentee.id,
        { finalTier: 'silver', reason: 'Deserves more' }, lead);
      await expect(verification.resolveChangeRequest(request.id, { approve: true }, admin))
        .resolves.toMatchObject({ resolution: 'approved' });
      expect(await models.CertificateInstance.count({ where: { templateId: template.id, menteeId: mentee.id } })).toBe(0);
      expect(await rowFor(mentee)).toMatchObject({ finalTier: 'silver', stage: 'admin_approved' });
    });
  });

  describe('once an admin has sent the certificate', () => {
    beforeEach(async () => {
      await verification.verify(template.id, mentee.id, {}, lead);
      await verification.verify(template.id, mentee.id, {}, admin); // admin_approved
      await issueFor(mentee);
      notificationOrchestrator.dispatch.mockClear();
    });

    it('locks the mentor out, and says what to do instead', async () => {
      await expect(verification.verify(template.id, mentee.id,
        { finalTier: 'silver', reason: 'Deserves more' }, lead))
        .rejects.toThrow(/Request a change and an admin will decide/i);
      expect((await rowFor(mentee)).finalTier).toBe('bronze');
    });

    it('requires the admin to revoke before changing it directly', async () => {
      await expect(verification.verify(template.id, mentee.id,
        { finalTier: 'silver', reason: 'On reflection' }, admin)).rejects.toThrow(/Revoke it/i);
    });

    it('locks a mentor as soon as the clan is approved', async () => {
      await verification.verify(template.id, other.id, {}, lead);
      await verification.approveClan(template.id, clan.id, {}, admin);
      await expect(verification.verify(template.id, other.id,
        { finalTier: 'silver', reason: 'Deserves more' }, lead))
        .rejects.toThrow(/Request a change/i);
    });

    describe('so the mentor requests', () => {
      it('records what is wanted and why, and tells the admins', async () => {
        const req = await verification.requestChange(template.id, mentee.id,
          { finalTier: 'silver', reason: 'Ran the clan standups all summer' }, lead);
        expect(req).toMatchObject({
          kind: 'change_request',
          status: 'open',
          requestedTier: 'silver',
          requestedDecision: 'award'
        });
        expect(dispatchesTo(admin.id)).toHaveLength(1);
      });

      it('leaves the grade exactly as it was', async () => {
        await verification.requestChange(template.id, mentee.id,
          { finalTier: 'silver', reason: 'Deserves more' }, lead);
        const row = await rowFor(mentee);
        expect(row.finalTier).toBe('bronze');
        expect(row.stage).toBe('admin_approved');
      });

      it('needs a reason', async () => {
        await expect(verification.requestChange(template.id, mentee.id,
          { finalTier: 'silver', reason: '  ' }, lead)).rejects.toThrow(/Say why/i);
      });

      it('refuses a tier the template does not have', async () => {
        await expect(verification.requestChange(template.id, mentee.id,
          { finalTier: 'platinum', reason: 'Deserves more' }, lead)).rejects.toThrow();
      });

      it('refuses asking for the grade it already has', async () => {
        await expect(verification.requestChange(template.id, mentee.id,
          { finalTier: 'bronze', reason: 'No change really' }, lead))
          .rejects.toThrow(/already has/i);
      });

      it('allows only one open request per grade', async () => {
        await verification.requestChange(template.id, mentee.id, { finalTier: 'silver', reason: 'First' }, lead);
        await expect(verification.requestChange(template.id, mentee.id, { finalTier: 'silver', reason: 'Second' }, lead))
          .rejects.toThrow(/already have a change request open/i);
      });

      it('refuses a mentor with no claim on that mentee', async () => {
        await expect(verification.requestChange(template.id, mentee.id,
          { finalTier: 'silver', reason: 'Not mine' }, outsider)).rejects.toThrow();
      });

      it('tells an admin to just change it themselves', async () => {
        await expect(verification.requestChange(template.id, mentee.id,
          { finalTier: 'silver', reason: 'Why ask myself' }, admin))
          .rejects.toThrow(/nobody to ask/i);
      });
    });

    describe('and the admin decides', () => {
      let request;
      beforeEach(async () => {
        request = await verification.requestChange(template.id, mentee.id,
          { finalTier: 'silver', reason: 'Ran the standups' }, lead);
        notificationOrchestrator.dispatch.mockClear();
      });

      it('approving applies the change as the ADMIN\'s decision', async () => {
        const resolved = await verification.resolveChangeRequest(request.id, { approve: true }, admin);
        expect(resolved).toMatchObject({ status: 'answered', resolution: 'approved' });

        const row = await rowFor(mentee);
        expect(row.finalTier).toBe('silver');
        // It was the admin who made it, so the row must say so.
        expect(row.stage).toBe('admin_approved');
        expect(row.verifiedBy).toBe(admin.id);
      });

      it('declining leaves the grade alone and needs a reason', async () => {
        await expect(verification.resolveChangeRequest(request.id, { approve: false }, admin))
          .rejects.toThrow(/reason when declining/i);

        const resolved = await verification.resolveChangeRequest(request.id,
          { approve: false, note: 'Attendance does not support silver' }, admin);
        expect(resolved).toMatchObject({ resolution: 'declined', answer: 'Attendance does not support silver' });
        expect((await rowFor(mentee)).finalTier).toBe('bronze');
      });

      it('tells the mentor either way', async () => {
        await verification.resolveChangeRequest(request.id, { approve: true }, admin);
        expect(dispatchesTo(lead.id)).toHaveLength(1);
      });

      it('cannot be decided twice', async () => {
        await verification.resolveChangeRequest(request.id, { approve: true }, admin);
        await expect(verification.resolveChangeRequest(request.id, { approve: true }, admin))
          .rejects.toThrow(/already been decided/i);
      });

      it('refuses a mentor', async () => {
        await expect(verification.resolveChangeRequest(request.id, { approve: true }, lead))
          .rejects.toThrow(/Only an admin/i);
      });

      it('frees the mentee for another request once decided', async () => {
        await verification.resolveChangeRequest(request.id, { approve: false, note: 'No' }, admin);
        await expect(verification.requestChange(template.id, mentee.id,
          { decision: 'no_certificate', reason: 'Actually they withdrew' }, lead))
          .resolves.toMatchObject({ status: 'open' });
      });
    });
  });

  describe('the roster shows what is outstanding', () => {
    it('flags a change request separately from an admin question', async () => {
      await verification.verify(template.id, mentee.id, {}, lead);
      await verification.verify(template.id, mentee.id, {}, admin);
      await issueFor(mentee);
      await verification.requestChange(template.id, mentee.id, { finalTier: 'silver', reason: 'Deserves more' }, lead);

      await verification.verify(template.id, other.id, {}, lead);
      await verification.askMentor(template.id, other.id, 'Why bronze?', admin);

      const { rows } = await verification.listForReviewer(template.id, lead);
      const changed = rows.find((r) => r.menteeId === mentee.id);
      const questioned = rows.find((r) => r.menteeId === other.id);
      expect(changed).toMatchObject({ hasChangeRequest: true, hasOpenQuestion: false });
      expect(questioned).toMatchObject({ hasChangeRequest: false, hasOpenQuestion: true });

      const summary = await verification.summary(template.id);
      expect(summary).toMatchObject({ changeRequested: 1, questioned: 1 });
    });

    it('lets a question and a change request coexist on one mentee', async () => {
      await verification.verify(template.id, mentee.id, {}, lead);
      await verification.askMentor(template.id, mentee.id, 'Why bronze?', admin);
      await verification.verify(template.id, mentee.id, {}, admin);
      await issueFor(mentee);
      await expect(verification.requestChange(template.id, mentee.id,
        { finalTier: 'silver', reason: 'Deserves more' }, lead)).resolves.toMatchObject({ status: 'open' });
    });
  });

  describe('a mentor asking for the report', () => {
    it('records the request and tells the admins', async () => {
      const req = await verification.requestReport(template.id, { clanId: clan.id, note: 'For the ceremony' }, lead);
      expect(req).toMatchObject({ kind: 'report_request', status: 'open', clanId: clan.id });
      expect(dispatchesTo(admin.id)).toHaveLength(1);
    });

    it('refuses a clan the mentor does not mentor', async () => {
      await expect(verification.requestReport(template.id, { clanId: clan.id }, outsider))
        .rejects.toThrow(/only request the report for a clan you mentor/i);
    });

    it('allows only one open request per clan', async () => {
      await verification.requestReport(template.id, { clanId: clan.id }, lead);
      await expect(verification.requestReport(template.id, { clanId: clan.id }, lead))
        .rejects.toThrow(/already have a report request open/i);
    });

    it('tells an admin they already have it', async () => {
      await expect(verification.requestReport(template.id, {}, admin))
        .rejects.toThrow(/already have the report/i);
    });

    it('counts on the summary', async () => {
      await verification.requestReport(template.id, { clanId: clan.id }, lead);
      expect((await verification.summary(template.id)).reportRequests).toBe(1);
    });
  });
});
