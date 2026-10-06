'use strict';

/**
 * Who may sign off a clan's certificate grades, and when the round opens.
 *
 * Signing off is its own permission — `certificate.verify` — held by lead
 * mentors and, by default, co-mentors. A lead can revoke it from one co-mentor
 * without also taking away their ability to see the mentee at all, which is
 * what keying this off `mentee.view` would have forced.
 *
 * The round opens when the ADMIN sends it, not automatically when the AI
 * finishes. An admin usually runs the grading more than once while tuning the
 * criteria, and mailing every mentor on each run trains them to ignore it.
 */

const { models } = require('../../src/db');
const clanService = require('../../src/services/clanService');
const certificateService = require('../../src/services/certificateService');
const verification = require('../../src/services/certificateVerificationService');
const authzService = require('../../src/services/authzService');
const { PERMISSIONS } = require('../../src/config/permissions');
const { cleanDb, createAdmin, createMentor, createMentee, createProgram } = require('../helpers/seed');

describe('certificate verification permission and hand-off', () => {
  let admin, lead, coMentor, mentee, program, clan, template;

  beforeEach(async () => {
    await cleanDb();
    await models.CertificateVerification.destroy({ where: {}, force: true });
    await models.CertificateInstance.destroy({ where: {}, force: true });
    await models.CertificateTemplate.destroy({ where: {}, force: true });
    await models.ClanMemberPermission.destroy({ where: {}, force: true });

    admin = await createAdmin({ email: 'admin@test.com' });
    lead = await createMentor({ email: 'lead@test.com' });
    coMentor = await createMentee({ email: 'co@test.com' });   // promoted from mentee
    mentee = await createMentee({ email: 'mentee@test.com' });

    program = await createProgram({ createdBy: admin.id });
    clan = await models.Clan.create({ programId: program.id, name: 'Viral Loop', leadMentorId: lead.id, createdBy: admin.id });
    await clanService.addMember(clan.id, { userId: lead.id, role: 'lead_mentor' });
    await clanService.addMember(clan.id, { userId: coMentor.id, role: 'co_mentor' });
    await clanService.addMember(clan.id, { userId: mentee.id, role: 'mentee' });

    template = await certificateService.createTemplate({
      name: 'Fellowship',
      config: [],
      criteria: [
        { id: 'gold', name: 'Gold Certificate', artworkUrl: 'https://cdn/g.png', layout: [] },
        { id: 'bronze', name: 'Bronze Certificate', artworkUrl: 'https://cdn/b.png', layout: [] }
      ],
      programId: program.id
    }, admin.id);
  });

  const withAiResults = async () => {
    await template.update({
      aiEvaluation: {
        results: [{ mentee_id: mentee.id, certificate_tier: 'bronze', match_score: 61 }],
        ranAt: new Date().toISOString()
      }
    });
  };

  describe('the permission', () => {
    it('is held by a lead mentor', async () => {
      const scope = await authzService.scopeOfClan(clan.id);
      expect(await authzService.can(lead, PERMISSIONS.CERTIFICATE_VERIFY, scope)).toBe(true);
    });

    it('is held by a co-mentor by default', async () => {
      const scope = await authzService.scopeOfClan(clan.id);
      expect(await authzService.can(coMentor, PERMISSIONS.CERTIFICATE_VERIFY, scope)).toBe(true);
    });

    it('can be revoked from one co-mentor by the lead', async () => {
      await models.ClanMemberPermission.create({
        userId: coMentor.id, clanId: clan.id, denied: [PERMISSIONS.CERTIFICATE_VERIFY]
      });
      const scope = await authzService.scopeOfClan(clan.id);
      expect(await authzService.can(coMentor, PERMISSIONS.CERTIFICATE_VERIFY, scope)).toBe(false);
      // …without costing them sight of the mentee, which is the point of it
      // being a separate permission.
      expect(await authzService.can(coMentor, PERMISSIONS.MENTEE_VIEW, scope)).toBe(true);
    });
  });

  describe('who can sign off', () => {
    beforeEach(async () => {
      await withAiResults();
      await verification.sendToClans(template.id, {}, admin);
    });

    it('lets a co-mentor verify by default', async () => {
      const row = await verification.verify(template.id, mentee.id, {}, coMentor);
      expect(row.status).toBe('verified');
    });

    it('refuses a co-mentor whose lead revoked it', async () => {
      await models.ClanMemberPermission.create({
        userId: coMentor.id, clanId: clan.id, denied: [PERMISSIONS.CERTIFICATE_VERIFY]
      });
      await expect(verification.verify(template.id, mentee.id, {}, coMentor))
        .rejects.toThrow(/only verify certificates for mentees in your clan/i);
    });

    it('shows a revoked co-mentor an empty queue rather than someone else\'s', async () => {
      await models.ClanMemberPermission.create({
        userId: coMentor.id, clanId: clan.id, denied: [PERMISSIONS.CERTIFICATE_VERIFY]
      });
      const { rows } = await verification.listForReviewer(template.id, coMentor);
      expect(rows).toEqual([]);
    });
  });

  describe('the admin hands grades to the clans', () => {
    it('refuses to send before the AI has graded anyone', async () => {
      await expect(verification.sendToClans(template.id, {}, admin))
        .rejects.toThrow(/Run the AI evaluation first/i);
    });

    it('opens the round and records the deadline', async () => {
      await withAiResults();
      const deadline = new Date(Date.now() + 5 * 86400000);
      const res = await verification.sendToClans(template.id, { deadline }, admin);

      expect(res.created).toBe(1);
      await template.reload();
      expect(template.verificationDeadline).toBeTruthy();

      const summary = await verification.summary(template.id);
      expect(summary.pending).toBe(1);
      expect(summary.deadline).toBeTruthy();
    });

    it('sending again is a reminder, not a reset', async () => {
      await withAiResults();
      await verification.sendToClans(template.id, {}, admin);
      await verification.verify(template.id, mentee.id, { finalTier: 'gold', reason: 'Outstanding' }, lead);

      await verification.sendToClans(template.id, {}, admin);

      const summary = await verification.summary(template.id);
      expect(summary.verified).toBe(1);
      expect(summary.pending).toBe(0);
      const row = await models.CertificateVerification.findOne({ where: { templateId: template.id, menteeId: mentee.id } });
      expect(row.finalTier).toBe('gold');   // the mentor's decision survives
    });

    it('can target a subset of clans', async () => {
      await withAiResults();
      const other = await models.Clan.create({
        programId: program.id, name: 'Core Team', leadMentorId: lead.id, createdBy: admin.id
      });
      const res = await verification.sendToClans(template.id, { clanIds: [other.id] }, admin);
      // The graded mentee is in Viral Loop, so targeting Core Team reaches nobody.
      expect(res.created).toBe(0);
    });

    it('opens review rows only for the selected evaluated mentees', async () => {
      const second = await createMentee({ email: 'second-mentee@test.com' });
      await clanService.addMember(clan.id, { userId: second.id, role: 'mentee' });
      await template.update({
        aiEvaluation: {
          results: [
            { mentee_id: mentee.id, certificate_tier: 'bronze', match_score: 61 },
            { mentee_id: second.id, certificate_tier: 'gold', match_score: 90 }
          ],
          ranAt: new Date().toISOString()
        }
      });

      const res = await verification.sendToClans(template.id, { menteeIds: [second.id] }, admin);

      expect(res.created).toBe(1);
      const rows = await models.CertificateVerification.findAll({ where: { templateId: template.id }, raw: true });
      expect(rows.map((row) => row.menteeId)).toEqual([second.id]);
    });

    it('sends the admin-selected badge for review without overwriting the AI baseline', async () => {
      await template.update({
        aiEvaluation: {
          results: [{ mentee_id: mentee.id, decision: 'no_certificate', certificate_tier: null, match_score: 0 }],
          ranAt: new Date().toISOString()
        }
      });

      await verification.sendToClans(template.id, {
        menteeIds: [mentee.id],
        assignments: [{ menteeId: mentee.id, decision: 'award', finalTier: 'bronze', reason: 'Admin reviewed resumed work' }]
      }, admin);

      const row = await models.CertificateVerification.findOne({ where: { templateId: template.id, menteeId: mentee.id } });
      expect(row).toMatchObject({
        status: 'pending',
        aiDecision: 'no_certificate',
        aiTier: null,
        decision: 'award',
        finalTier: 'bronze',
        overridden: true,
        overrideReason: 'Admin reviewed resumed work'
      });
    });

    it('explains when selected mentees have no AI result yet', async () => {
      await withAiResults();
      await expect(verification.sendToClans(template.id, { menteeIds: [coMentor.id] }, admin))
        .rejects.toThrow(/Run AI evaluation for the selected mentees/i);
    });
  });
});
