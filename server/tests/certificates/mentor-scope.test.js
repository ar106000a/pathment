'use strict';

/**
 * A mentor sees and grades THEIR mentees. Nobody else's.
 *
 * Every scope decision in this service used to be made from `user.role` — the
 * column recording what an account was CREATED as, not what the person does
 * now. A co-mentor promoted from a mentee account still reads 'mentee' there,
 * so `userRole !== 'mentor'` fell through to the unrestricted branch and the
 * AI evaluation they kicked off graded the whole organisation: the progress bar
 * read "0 / 623" for someone responsible for a dozen people.
 *
 * Scope is derived from the permission they actually hold at a clan now, and
 * the default is CLOSED: no clans means no mentees, never everybody.
 */

const { models } = require('../../src/db');
const clanService = require('../../src/services/clanService');
const certificateService = require('../../src/services/certificateService');
const verification = require('../../src/services/certificateVerificationService');
const { cleanDb, createAdmin, createMentor, createMentee, createProgram } = require('../helpers/seed');

const ids = (rows) => rows.map((r) => r.id).sort();

describe('certificate scope for mentors and co-mentors', () => {
  let admin, lead, promotedCoMentor, myMentee, otherMentee, outsider;
  let program, myClan, otherClan, template;

  beforeEach(async () => {
    await cleanDb();
    await models.CertificateTemplate.destroy({ where: {}, force: true });

    admin = await createAdmin({ email: 'cert-admin@test.com' });
    lead = await createMentor({ email: 'lead@test.com' });
    // The account that broke everything: created as a mentee, now co-mentors.
    promotedCoMentor = await createMentee({ email: 'promoted@test.com' });
    myMentee = await createMentee({ email: 'my-mentee@test.com' });
    otherMentee = await createMentee({ email: 'other-mentee@test.com' });
    outsider = await createMentor({ email: 'outsider@test.com' });

    program = await createProgram({ createdBy: admin.id });
    myClan = await models.Clan.create({
      programId: program.id, name: 'Viral Loop', leadMentorId: lead.id, createdBy: admin.id
    });
    otherClan = await models.Clan.create({
      programId: program.id, name: 'Core Team', leadMentorId: outsider.id, createdBy: admin.id
    });

    await clanService.addMember(myClan.id, { userId: lead.id, role: 'lead_mentor' });
    await clanService.addMember(myClan.id, { userId: promotedCoMentor.id, role: 'co_mentor' });
    await clanService.addMember(myClan.id, { userId: myMentee.id, role: 'mentee' });

    await clanService.addMember(otherClan.id, { userId: outsider.id, role: 'lead_mentor' });
    await clanService.addMember(otherClan.id, { userId: otherMentee.id, role: 'mentee' });

    template = await certificateService.createTemplate(
      { name: 'Fellowship', config: [], criteria: [{ id: 'participation', name: 'Participation' }], programId: program.id },
      admin.id
    );
  });

  describe('who a run is allowed to grade', () => {
    it('gives a lead mentor only their own clan', async () => {
      const { activeMentees } = await certificateService.getScopedMenteesForTemplate(program.id, lead);
      expect(ids(activeMentees)).toEqual([myMentee.id]);
    });

    it('gives a co-mentor promoted from a mentee their clan, NOT the whole programme', async () => {
      const { activeMentees } = await certificateService.getScopedMenteesForTemplate(program.id, promotedCoMentor);
      expect(ids(activeMentees)).toEqual([myMentee.id]);
      expect(ids(activeMentees)).not.toContain(otherMentee.id);
    });

    it('gives an admin the whole programme', async () => {
      const { activeMentees } = await certificateService.getScopedMenteesForTemplate(program.id, admin);
      expect(ids(activeMentees).length).toBeGreaterThanOrEqual(2);
      expect(ids(activeMentees)).toEqual(expect.arrayContaining([myMentee.id, otherMentee.id]));
    });

    it('gives somebody who mentors nothing NOBODY — not everybody', async () => {
      const stranger = await createMentor({ email: 'stranger@test.com' });
      const { activeMentees } = await certificateService.getScopedMenteesForTemplate(program.id, stranger);
      expect(activeMentees).toEqual([]);
    });

    it('honours the sidebar clan picker', async () => {
      const scoped = await certificateService.getScopedMenteesForTemplate(
        program.id, lead, { clanId: otherClan.id }
      );
      expect(scoped.activeMentees).toEqual([]);
    });
  });

  describe('AI evaluation', () => {
    it('queues only the mentor\'s own mentees', async () => {
      const res = await certificateService.runAIEvaluation(template.id, null, lead);
      expect(res.total).toBe(1);
    });

    it('queues only their own for a promoted co-mentor', async () => {
      const res = await certificateService.runAIEvaluation(template.id, null, promotedCoMentor);
      expect(res.total).toBe(1);
    });

    it('cannot be widened by passing somebody else\'s mentorId', async () => {
      // The query param is an ADMIN convenience. It must never grant reach.
      const res = await certificateService.runAIEvaluation(template.id, outsider.id, lead);
      expect(res.total).toBe(1);
    });

    it('queues the whole programme for an admin', async () => {
      const res = await certificateService.runAIEvaluation(template.id, null, admin);
      expect(res.total).toBeGreaterThanOrEqual(2);
    });

    it('queues only the admin-selected mentees and ignores out-of-scope ids', async () => {
      const res = await certificateService.runAIEvaluation(template.id, null, admin, {
        menteeIds: [myMentee.id, 'not-a-real-or-scoped-user']
      });
      expect(res.total).toBe(1);
      const queued = await models.AIEvaluationQueue.findAll({ where: { runId: res.runId }, raw: true });
      expect(queued.map((row) => row.menteeId)).toEqual([myMentee.id]);
    });
  });

  describe('issuing', () => {
    const issue = (user, menteeId) => certificateService.issueCertificates(
      { templateId: template.id, recipients: [{ menteeId, tier: 'participation' }] },
      user.id,
      user
    );

    it('lets a mentor issue to their own mentee once the clan is approved', async () => {
      // Sending is gated on the admin releasing the clan — this suite is about
      // SCOPE, so the release is set up here rather than being what is tested.
      // The gate itself has its own suite (clan-approval.test.js).
      await verification.approveClan(template.id, myClan.id, {}, admin);
      const res = await issue(lead, myMentee.id);
      expect(res.count).toBe(1);
    });

    it('refuses a mentee named in the request body who is not theirs', async () => {
      // Issuing is a write and the recipient list is client-supplied; nothing
      // checked it before, so any mentee id in the org could be named.
      await expect(issue(lead, otherMentee.id)).rejects.toThrow(/only issue certificates to mentees in your clan/i);
      expect(await models.CertificateInstance.count()).toBe(0);
    });

    it('refuses for a promoted co-mentor too', async () => {
      await expect(issue(promotedCoMentor, otherMentee.id)).rejects.toThrow(/only issue/i);
    });

    it('lets an admin issue to anyone in the programme', async () => {
      const res = await issue(admin, otherMentee.id);
      expect(res.count).toBe(1);
    });
  });

  describe('revoking a single certificate', () => {
    let otherInstance;

    beforeEach(async () => {
      otherInstance = await models.CertificateInstance.create({
        templateId: template.id, menteeId: otherMentee.id, issuedBy: admin.id, tier: 'participation'
      });
    });

    it('refuses a lead mentor because revocation is an admin action', async () => {
      await expect(certificateService.deleteCertificateInstance(otherInstance.id, lead))
        .rejects.toThrow(/only an admin can revoke/i);
    });

    it('refuses a promoted co-mentor too', async () => {
      await expect(certificateService.deleteCertificateInstance(otherInstance.id, promotedCoMentor))
        .rejects.toThrow(/only an admin can revoke/i);
      expect(await models.CertificateInstance.findByPk(otherInstance.id)).not.toBeNull();
    });

    it('does not let a lead mentor revoke even within their own clan', async () => {
      await expect(certificateService.deleteCertificateInstance(otherInstance.id, outsider))
        .rejects.toThrow(/only an admin can revoke/i);
    });

    it('lets an admin revoke it', async () => {
      await expect(certificateService.deleteCertificateInstance(otherInstance.id, admin)).resolves.toBe(true);
    });
  });

  describe('reading a mentee\'s certificates', () => {
    it('lets a promoted co-mentor read their own clan\'s mentee', async () => {
      await expect(certificateService.listMenteeCertificates(myMentee.id, promotedCoMentor)).resolves.toBeDefined();
    });

    it('refuses another clan\'s mentee', async () => {
      await expect(certificateService.listMenteeCertificates(otherMentee.id, lead))
        .rejects.toThrow(/only view certificates for mentees in your clan/i);
    });

    it('always lets a mentee read their own', async () => {
      await expect(certificateService.listMenteeCertificates(myMentee.id, myMentee)).resolves.toBeDefined();
    });
  });

  describe('the role shown in the issuance log', () => {
    // These issue as mentors, so the clan has to be released first — see
    // clan-approval.test.js for the gate itself. What is under test here is the
    // ROLE LABEL on the resulting row, not who may send.
    beforeEach(async () => {
      await verification.approveClan(template.id, myClan.id, {}, admin);
    });

    // `users.role` records what an account SIGNED UP as and never changes on
    // promotion, so a co-mentor promoted from a mentee account appeared as
    // MENTEE beside the certificates he had just issued.
    it('labels a promoted co-mentor by the role they hold in the programme', async () => {
      await certificateService.issueCertificates(
        { templateId: template.id, recipients: [{ menteeId: myMentee.id, tier: 'participation' }] },
        promotedCoMentor.id,
        promotedCoMentor
      );

      const [row] = await certificateService.getTemplateHistory(template.id, admin);
      expect(promotedCoMentor.role).toBe('mentee');      // the account is still a mentee account
      expect(row.issuedBy.id).toBe(promotedCoMentor.id);
      expect(row.issuedBy.role).toBe('co_mentor');       // …but he issued as a co-mentor
    });

    it('labels the lead mentor as lead_mentor', async () => {
      await certificateService.issueCertificates(
        { templateId: template.id, recipients: [{ menteeId: myMentee.id, tier: 'participation' }] },
        lead.id,
        lead
      );
      const [row] = await certificateService.getTemplateHistory(template.id, admin);
      expect(row.issuedBy.role).toBe('lead_mentor');
    });

    it('labels an admin issuer as admin, whatever clans they are in', async () => {
      await certificateService.issueCertificates(
        { templateId: template.id, recipients: [{ menteeId: myMentee.id, tier: 'participation' }] },
        admin.id,
        admin
      );
      const [row] = await certificateService.getTemplateHistory(template.id, admin);
      expect(row.issuedBy.role).toBe('admin');
    });

    it('still labels the recipient as a mentee', async () => {
      await certificateService.issueCertificates(
        { templateId: template.id, recipients: [{ menteeId: myMentee.id, tier: 'participation' }] },
        lead.id,
        lead
      );
      const [row] = await certificateService.getTemplateHistory(template.id, admin);
      expect(row.recipient.role).toBe('mentee');
    });
  });
});
