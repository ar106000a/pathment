'use strict';

/**
 * A certificate is never issued on the AI's grade alone, and the roster says
 * who signed off.
 *
 * What happened on production: an admin opened the participation certificate,
 * selected the roster and pressed Issue. 410 certificates went out in one
 * transaction. 215 had been signed off; 193 had a PENDING review row carrying
 * the AI's provisional 'participation'; 2 had no review row at all.
 *
 * Three defects lined up:
 *
 *   1. `blockedRecipients` returned early for `hasAdminAccess` — the admin
 *      skipped every check rather than just the clan release.
 *   2. `resolveTiers` selected `status` and never read it, so a pending row's
 *      `finalTier` (a copy of the AI's tier, written at send time) was returned
 *      as though a human had confirmed it.
 *   3. The issue path fell back to `|| 'participation'`, which invented a grade
 *      for the two mentees who had no review row.
 *
 * And the roster could not have revealed it either: `status` is only
 * 'pending' | 'verified', and a mentor's sign-off and an admin's both wrote
 * 'verified', so all 400-odd rows rendered the same "Signed off" badge.
 */

const { models } = require('../../src/db');
const clanService = require('../../src/services/clanService');
const certificateService = require('../../src/services/certificateService');
const verification = require('../../src/services/certificateVerificationService');
const { cleanDb, createAdmin, createMentor, createMentee, createProgram } = require('../helpers/seed');

describe('an unreviewed grade cannot be issued', () => {
  let admin, lead, reviewed, unreviewed, noRow, program, clan, template;

  beforeEach(async () => {
    await cleanDb();
    for (const model of ['CertificateClanApproval', 'CertificateVerification', 'CertificateInstance', 'CertificateTemplate']) {
      await models[model].destroy({ where: {}, force: true });
    }

    admin = await createAdmin({ email: 'admin@test.com' });
    lead = await createMentor({ email: 'lead@test.com' });
    reviewed = await createMentee({ email: 'reviewed@test.com' });
    unreviewed = await createMentee({ email: 'unreviewed@test.com' });
    noRow = await createMentee({ email: 'norow@test.com' });

    program = await createProgram({ createdBy: admin.id });
    clan = await models.Clan.create({ programId: program.id, name: 'Viral Loop', leadMentorId: lead.id, createdBy: admin.id });
    await clanService.addMember(clan.id, { userId: lead.id, role: 'lead_mentor' });
    for (const person of [reviewed, unreviewed, noRow]) {
      await clanService.addMember(clan.id, { userId: person.id, role: 'mentee' });
    }

    template = await certificateService.createTemplate({
      name: 'Fellowship 2026 summer',
      config: [],
      criteria: [{ id: 'participation', name: 'Participation', artworkUrl: 'https://cdn/p.png', layout: [] }],
      programId: program.id
    }, admin.id);

    // Only two of the three are in the AI run, so `noRow` gets no review row at
    // all — exactly the state the two stray production certificates were in.
    await template.update({
      aiEvaluation: {
        results: [reviewed, unreviewed].map((m) => ({ mentee_id: m.id, certificate_tier: 'participation', match_score: 55 })),
        ranAt: new Date().toISOString()
      }
    });
    await verification.sendToClans(template.id, {}, admin);
    await verification.verify(template.id, reviewed.id, {}, lead);
  });

  const issue = (user, mentees) => certificateService.issueCertificates(
    { templateId: template.id, recipients: mentees.map((m) => ({ menteeId: m.id, tier: 'participation' })) },
    user.id, user
  );

  describe('the gate', () => {
    it('refuses the admin a pending row carrying only the AI grade', async () => {
      await expect(issue(admin, [unreviewed])).rejects.toThrow(/have not been signed off/i);
      expect(await models.CertificateInstance.count()).toBe(0);
    });

    it('refuses a mentee with no review row rather than defaulting to participation', async () => {
      await expect(issue(admin, [noRow])).rejects.toThrow(/have not been signed off/i);
      expect(await models.CertificateInstance.count()).toBe(0);
    });

    it('refuses the whole batch when only some are unreviewed, and counts them', async () => {
      await expect(issue(admin, [reviewed, unreviewed, noRow]))
        .rejects.toThrow(/2 of these 3 grades have not been signed off/i);
      expect(await models.CertificateInstance.count()).toBe(0);
    });

    it('lets the signed-off one through on its own', async () => {
      const res = await issue(admin, [reviewed]);
      expect(res.count).toBe(1);
      expect(await models.CertificateInstance.count()).toBe(1);
    });

    it('separates the two blockers for a mentor', async () => {
      const blockers = await verification.sendBlockers(template.id, [reviewed.id, unreviewed.id], lead);
      // reviewed is signed off but the clan is not released; unreviewed fails first.
      expect(blockers.unreviewed).toEqual([unreviewed.id]);
      expect(blockers.unapproved).toEqual([reviewed.id]);
    });

    it('exempts the admin from the clan release but not from review', async () => {
      const blockers = await verification.sendBlockers(template.id, [reviewed.id, unreviewed.id], admin);
      expect(blockers.unapproved).toEqual([]);
      expect(blockers.unreviewed).toEqual([unreviewed.id]);
    });

    it('lets an admin explicitly issue their selected badge without mentor verification', async () => {
      const res = await certificateService.issueCertificates({
        templateId: template.id,
        recipients: [{ menteeId: unreviewed.id, tier: 'participation' }],
        adminOverrideReview: true
      }, admin.id, admin);

      expect(res).toMatchObject({ count: 1, reviewBypassed: 1, skippedNoCertificate: 0 });
      const issued = await models.CertificateInstance.findOne({ where: { templateId: template.id, menteeId: unreviewed.id } });
      expect(issued.tier).toBe('participation');
      expect(issued.metadata).toMatchObject({ adminReviewBypassed: true });
      const decision = await models.CertificateVerification.findOne({ where: { templateId: template.id, menteeId: unreviewed.id } });
      expect(decision).toMatchObject({
        status: 'verified', stage: 'admin_approved', decision: 'award', finalTier: 'participation', verifiedBy: admin.id
      });
      expect(decision.overrideReason).toMatch(/Issued directly by admin/i);
    });

    it('does not let a mentor claim the admin bypass', async () => {
      await expect(certificateService.issueCertificates({
        templateId: template.id,
        recipients: [{ menteeId: unreviewed.id, tier: 'participation' }],
        adminOverrideReview: true
      }, lead.id, lead)).rejects.toThrow(/Only an admin can bypass/i);
    });
  });

  describe('a template with no review round is not gated', () => {
    /**
     * The gate keys off whether a round was ever opened, not off the mere
     * absence of a signed-off row. A certificate that has never been reviewed
     * is issued directly, and that is a real workflow — gating it broke 24
     * tests across four suites when this fix was first written too broadly.
     */
    it('issues at the caller\'s tier when the template was never reviewed', async () => {
      const plain = await certificateService.createTemplate({
        name: 'Attendance', config: [],
        criteria: [{ id: 'participation', name: 'Participation', artworkUrl: 'https://cdn/p.png', layout: [] }],
        programId: program.id
      }, admin.id);

      expect(await verification.hasReviewRound(plain.id)).toBe(false);
      const res = await certificateService.issueCertificates(
        { templateId: plain.id, recipients: [{ menteeId: noRow.id, tier: 'participation' }] }, admin.id, admin
      );
      expect(res.count).toBe(1);
    });

    it('reports no blockers at all when there is no round', async () => {
      const plain = await certificateService.createTemplate({
        name: 'Attendance 2', config: [],
        criteria: [{ id: 'participation', name: 'Participation', artworkUrl: 'https://cdn/p.png', layout: [] }],
        programId: program.id
      }, admin.id);
      const blockers = await verification.sendBlockers(plain.id, [noRow.id], admin);
      expect(blockers).toEqual({ unreviewed: [], unapproved: [] });
    });

    it('still gates the same template once a round is opened', async () => {
      expect(await verification.hasReviewRound(template.id)).toBe(true);
      await expect(issue(admin, [unreviewed])).rejects.toThrow(/have not been signed off/i);
    });
  });

  describe('somebody who would not receive anything is skipped, not an error', () => {
    /**
     * The gate runs over the people who would actually get a certificate. One
     * mentee already holding one, or excluded by a No-certificate decision,
     * must not fail everybody else's batch.
     */
    it('skips an already-issued mentee instead of blocking the batch', async () => {
      await issue(admin, [reviewed]);
      const again = await issue(admin, [reviewed]);
      expect(again.count).toBe(0);
      expect(again.skipped).toBe(1);
    });

    it('skips a No-certificate decision rather than refusing the send', async () => {
      await verification.verify(template.id, unreviewed.id,
        { decision: 'no_certificate', reason: 'Did not complete the work' }, lead);
      const res = await issue(admin, [reviewed, unreviewed]);
      expect(res.count).toBe(1);
      expect(res.skippedNoCertificate).toBe(1);
    });
  });

  describe('resolveTiers states a tier only for a signed-off row', () => {
    it('omits a pending row even though it carries the AI tier', async () => {
      const row = await models.CertificateVerification.findOne({
        where: { templateId: template.id, menteeId: unreviewed.id }
      });
      // The row really does hold a tier — this is what used to be trusted.
      expect(row.finalTier).toBe('participation');
      expect(row.status).toBe('pending');

      const tiers = await verification.resolveTiers(template.id, [reviewed.id, unreviewed.id]);
      expect(tiers.get(reviewed.id)).toBe('participation');
      expect(tiers.has(unreviewed.id)).toBe(false);
    });
  });

  describe('the stage says who signed off', () => {
    it('marks a mentor sign-off mentor_verified and an admin sign-off admin_approved', async () => {
      const byMentor = await models.CertificateVerification.findOne({
        where: { templateId: template.id, menteeId: reviewed.id }
      });
      expect(byMentor.stage).toBe('mentor_verified');
      expect(byMentor.status).toBe('verified');

      await verification.verify(template.id, unreviewed.id, {}, admin);
      const byAdmin = await models.CertificateVerification.findOne({
        where: { templateId: template.id, menteeId: unreviewed.id }
      });
      expect(byAdmin.stage).toBe('admin_approved');
      expect(byAdmin.status).toBe('verified');
    });

    it('starts a freshly sent row at awaiting_mentor', async () => {
      const row = await models.CertificateVerification.findOne({
        where: { templateId: template.id, menteeId: unreviewed.id }
      });
      expect(row.stage).toBe('awaiting_mentor');
    });

    it('promotes a mentor-verified row to admin_approved when the clan is released', async () => {
      await verification.approveClan(template.id, clan.id, {}, admin);
      const row = await models.CertificateVerification.findOne({
        where: { templateId: template.id, menteeId: reviewed.id }
      });
      // Releasing the clan IS the admin approving what is in it, which is the
      // question "what have I approved?" the roster has to answer.
      expect(row.stage).toBe('admin_approved');
      // Approve early explicitly finalizes the current AI decision too. It is
      // recorded by approvedBeforeVerified and cannot later be overwritten by
      // a mentor proof claim.
      const still = await models.CertificateVerification.findOne({
        where: { templateId: template.id, menteeId: unreviewed.id }
      });
      expect(still.stage).toBe('admin_approved');
      expect(still.status).toBe('verified');
    });

    it('does not let a mentor un-approve what an admin already approved', async () => {
      await verification.verify(template.id, unreviewed.id, {}, admin);
      expect((await models.CertificateVerification.findOne({
        where: { templateId: template.id, menteeId: unreviewed.id } })).stage).toBe('admin_approved');

      // A mentor working their queue re-confirms the SAME grade. This used to
      // rewrite the row to mentor_verified, so an admin who had approved a batch
      // came back to find only part of it still showing as theirs.
      await verification.verify(template.id, unreviewed.id, {}, lead);
      expect((await models.CertificateVerification.findOne({
        where: { templateId: template.id, menteeId: unreviewed.id } })).stage).toBe('admin_approved');
    });

    it('skips a direct mentor grade change after admin approval', async () => {
      await verification.verify(template.id, unreviewed.id, {}, admin);
      // The mentor must use the audited change-request flow instead.
      await expect(verification.verify(template.id, unreviewed.id,
        { decision: 'no_certificate', reason: 'Did not complete the work' }, lead)).rejects.toThrow(/request a change/i);
      const row = await models.CertificateVerification.findOne({
        where: { templateId: template.id, menteeId: unreviewed.id } });
      expect(row.stage).toBe('admin_approved');
      expect(row.decision).toBe('award');
    });

    it('reports the split in the summary', async () => {
      let summary = await verification.summary(template.id);
      expect(summary).toMatchObject({ mentorVerified: 1, adminApproved: 0 });

      await verification.verify(template.id, unreviewed.id, {}, admin);
      summary = await verification.summary(template.id);
      expect(summary).toMatchObject({ mentorVerified: 1, adminApproved: 1 });
      expect(summary.clans[0]).toMatchObject({ mentorVerified: 1, adminApproved: 1 });
    });

    it('exposes the stage on the serialized row the roster reads', async () => {
      const { rows } = await verification.listForReviewer(template.id, lead);
      const row = rows.find((r) => r.menteeId === reviewed.id);
      expect(row.stage).toBe('mentor_verified');
    });
  });
});
