'use strict';

/**
 * Taking back certificates that went out without a sign-off.
 *
 * This exists because `revokeAllTemplateCertificates` cannot do the job. On
 * production "Fellowship 2026 summer" had issued 410 participation certificates
 * of which 215 were properly signed off and 195 were not; revoking the template
 * would have destroyed all 410, including everybody's legitimate credential.
 *
 * The scope is the same two conditions the send gate uses, so a preview and the
 * gate can never disagree: the template HAS a review round, and this mentee's
 * row is absent or not verified.
 */

const request = require('supertest');
const app = require('../../src/index');
const { models } = require('../../src/db');
const clanService = require('../../src/services/clanService');
const certificateService = require('../../src/services/certificateService');
const verification = require('../../src/services/certificateVerificationService');
const { cleanDb, createAdmin, createMentor, createMentee, createProgram } = require('../helpers/seed');
const { generateAccessToken } = require('../../src/utils/jwt');

describe('revoking certificates issued without a sign-off', () => {
  let admin, lead, signedOff, unreviewed, program, clan, template, adminToken, mentorToken;

  beforeEach(async () => {
    await cleanDb();
    for (const model of ['CertificateClanApproval', 'CertificateVerification', 'CertificateInstance', 'CertificateTemplate']) {
      await models[model].destroy({ where: {}, force: true });
    }

    admin = await createAdmin({ email: 'admin@test.com' });
    lead = await createMentor({ email: 'lead@test.com' });
    signedOff = await createMentee({ email: 'signed@test.com' });
    unreviewed = await createMentee({ email: 'unreviewed@test.com' });

    program = await createProgram({ createdBy: admin.id });
    clan = await models.Clan.create({ programId: program.id, name: 'Viral Loop', leadMentorId: lead.id, createdBy: admin.id });
    await clanService.addMember(clan.id, { userId: lead.id, role: 'lead_mentor' });
    for (const person of [signedOff, unreviewed]) {
      await clanService.addMember(clan.id, { userId: person.id, role: 'mentee' });
    }

    template = await certificateService.createTemplate({
      name: 'Fellowship 2026 summer',
      config: [],
      criteria: [{ id: 'participation', name: 'Participation', artworkUrl: 'https://cdn/p.png', layout: [] }],
      programId: program.id
    }, admin.id);
    await template.update({
      aiEvaluation: {
        results: [signedOff, unreviewed].map((m) => ({ mentee_id: m.id, certificate_tier: 'participation', match_score: 55 })),
        ranAt: new Date().toISOString()
      }
    });
    await verification.sendToClans(template.id, {}, admin);
    await verification.verify(template.id, signedOff.id, {}, lead);

    adminToken = generateAccessToken({ id: admin.id, email: admin.email, role: admin.role });
    mentorToken = generateAccessToken({ id: lead.id, email: lead.email, role: lead.role });

    // Reproduce the production state: one legitimate certificate, and one that
    // bypassed the round. The gate now refuses the second, so it is written
    // directly rather than issued through the service.
    await certificateService.issueCertificates(
      { templateId: template.id, recipients: [{ menteeId: signedOff.id, tier: 'participation' }] }, admin.id, admin
    );
    await models.CertificateInstance.create({
      templateId: template.id, menteeId: unreviewed.id, issuedBy: admin.id,
      tier: 'participation', certificateNumber: 'BYPASSED1234', organizationId: template.organizationId
    });
  });

  describe('what it selects', () => {
    it('lists only the certificate with no sign-off', async () => {
      const rows = await verification.unreviewedIssued(template.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        menteeId: unreviewed.id,
        menteeEmail: 'unreviewed@test.com',
        clanName: 'Viral Loop',
        certificateNumber: 'BYPASSED1234',
        reviewStatus: 'pending',
        reviewStage: 'awaiting_mentor'
      });
    });

    it('lists a mentee who has no review row at all', async () => {
      const stray = await createMentee({ email: 'stray@test.com' });
      await clanService.addMember(clan.id, { userId: stray.id, role: 'mentee' });
      await models.CertificateInstance.create({
        templateId: template.id, menteeId: stray.id, issuedBy: admin.id,
        tier: 'participation', certificateNumber: 'NOROW0000001', organizationId: template.organizationId
      });
      const rows = await verification.unreviewedIssued(template.id);
      expect(rows.map((r) => r.menteeId).sort()).toEqual([unreviewed.id, stray.id].sort());
      expect(rows.find((r) => r.menteeId === stray.id).reviewStatus).toBeNull();
    });

    it('lists nothing for a template that never had a review round', async () => {
      const plain = await certificateService.createTemplate({
        name: 'Attendance', config: [],
        criteria: [{ id: 'participation', name: 'Participation', artworkUrl: 'https://cdn/p.png', layout: [] }],
        programId: program.id
      }, admin.id);
      await certificateService.issueCertificates(
        { templateId: plain.id, recipients: [{ menteeId: unreviewed.id, tier: 'participation' }] }, admin.id, admin
      );
      // Issuing directly from an unreviewed template is a real workflow, so its
      // certificates are never in scope here.
      expect(await verification.unreviewedIssued(plain.id)).toEqual([]);
    });
  });

  describe('revoking', () => {
    it('removes only the bypassed certificate and leaves the signed-off one', async () => {
      const result = await verification.revokeUnreviewed(template.id, admin);
      expect(result.revoked).toBe(1);

      const left = await models.CertificateInstance.findAll({ where: { templateId: template.id } });
      expect(left).toHaveLength(1);
      expect(left[0].menteeId).toBe(signedOff.id);
    });

    it('records every removed row in the audit log before deleting it', async () => {
      await verification.revokeUnreviewed(template.id, admin);
      const entry = await models.AuditLog.findOne({
        where: { action: 'certificate.revoked_unreviewed' }, order: [['createdAt', 'DESC']]
      });
      expect(entry).toBeTruthy();
      expect(entry.userId).toBe(admin.id);
      expect(entry.oldValues.count).toBe(1);
      // The number is gone from the table, so the audit entry is the only record.
      expect(entry.oldValues.certificates[0]).toMatchObject({
        menteeEmail: 'unreviewed@test.com', certificateNumber: 'BYPASSED1234'
      });
    });

    it('is idempotent — a second run finds nothing', async () => {
      expect((await verification.revokeUnreviewed(template.id, admin)).revoked).toBe(1);
      expect((await verification.revokeUnreviewed(template.id, admin)).revoked).toBe(0);
    });

    it('unblocks the mentor, who could not change a grade while it was issued', async () => {
      // This is the message revoking exists to clear.
      await expect(verification.verify(template.id, unreviewed.id,
        { decision: 'no_certificate', reason: 'Did not finish the work' }, lead))
        .rejects.toThrow(/already been (issued|sent)/i);

      await verification.revokeUnreviewed(template.id, admin);
      const row = await verification.verify(template.id, unreviewed.id,
        { decision: 'no_certificate', reason: 'Did not finish the work' }, lead);
      expect(row.decision).toBe('no_certificate');
    });

    it('refuses a mentor', async () => {
      await expect(verification.revokeUnreviewed(template.id, lead))
        .rejects.toThrow(/Only an admin/i);
      expect(await models.CertificateInstance.count({ where: { templateId: template.id } })).toBe(2);
    });

    it('refuses an unknown template', async () => {
      await expect(verification.revokeUnreviewed('00000000-0000-4000-8000-000000000000', admin))
        .rejects.toThrow(/not found/i);
    });
  });

  describe('over HTTP', () => {
    it('previews without changing anything', async () => {
      const res = await request(app)
        .get(`/api/certificates/templates/${template.id}/unreviewed-issued`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(1);
      expect(await models.CertificateInstance.count({ where: { templateId: template.id } })).toBe(2);
    });

    it('revokes on DELETE', async () => {
      const res = await request(app)
        .delete(`/api/certificates/templates/${template.id}/unreviewed-issued`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.revoked).toBe(1);
      expect(await models.CertificateInstance.count({ where: { templateId: template.id } })).toBe(1);
    });

    it('keeps a mentor out of both', async () => {
      for (const call of [
        request(app).get(`/api/certificates/templates/${template.id}/unreviewed-issued`),
        request(app).delete(`/api/certificates/templates/${template.id}/unreviewed-issued`),
      ]) {
        const res = await call.set('Authorization', `Bearer ${mentorToken}`);
        expect(res.status).toBe(403);
      }
      expect(await models.CertificateInstance.count({ where: { templateId: template.id } })).toBe(2);
    });

    it('rejects an anonymous caller', async () => {
      const res = await request(app).delete(`/api/certificates/templates/${template.id}/unreviewed-issued`);
      expect(res.status).toBe(401);
    });
  });
});
