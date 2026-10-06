'use strict';

/**
 * "Why did this person get that certificate?"
 *
 * Two things are pinned here.
 *
 * COMPLETION RATE measures progress through the ROADMAP: of the roadmap tasks
 * assigned to somebody, how many are done. It used to count every assigned
 * task, custom one-offs included — so two mentees with identical roadmap
 * progress scored differently because a mentor had added ad-hoc work to one of
 * them, and a tier threshold like "80% completion" meant something different
 * per person. A threshold is only meaningful against a fixed syllabus.
 *
 * THE EVIDENCE PAYLOAD is what both portals read to answer the question, so it
 * has to work before any AI run (the numbers come from the record, not a stored
 * result), it has to carry a mentor's override and their reason, and it has to
 * be scoped exactly like every other read — a mentor sees their own clan.
 */

const request = require('supertest');
const app = require('../../src/index');
const { models } = require('../../src/db');
const clanService = require('../../src/services/clanService');
const certificateService = require('../../src/services/certificateService');
const verification = require('../../src/services/certificateVerificationService');
const {
  cleanDb, createAdmin, createMentor, createMentee, createProgram,
  createRoadmap, createRoadmapTask, createEnrollment, authHeader
} = require('../helpers/seed');

describe('certificate evidence for one mentee', () => {
  let admin, lead, outsider, mentee, otherMentee;
  let program, clan, otherClan, roadmap, template, enrollment;

  /** Assign a roadmap task, or a custom one-off, at a given status. */
  const assign = async ({ custom = false, status = 'assigned', title = 'Task' } = {}) => {
    const roadmapTask = await createRoadmapTask({ roadmapId: custom ? null : roadmap.id, title });
    return models.AssignedTask.create({
      roadmapTaskId: roadmapTask.id,
      menteeId: mentee.id,
      mentorId: lead.id,
      enrollmentId: enrollment.id,
      clanId: clan.id,
      status,
      isCustomTask: custom,
      dueDate: new Date(Date.now() + 7 * 86400000),
      isLate: false,
      pointsAwarded: status === 'completed' ? 10 : 0
    });
  };

  /**
   * The scaffolding is built ONCE.
   *
   * `cleanDb()` truncates ~25 tables with CASCADE, and paying that before each
   * of eleven tests made this file heavy enough to slow the suite that follows
   * it: on a loaded run the next file's own first `cleanDb()` crossed the 30s
   * testTimeout and failed with no assertion — the victim moving between runs,
   * which is what an exhausted environment looks like rather than a bug.
   *
   * Nothing here mutates the people or the clans, so only the per-test rows —
   * the tasks and the review round — are cleared between tests.
   */
  beforeAll(async () => {
    await cleanDb();
    await models.CertificateTemplate.destroy({ where: {}, force: true });

    admin = await createAdmin({ email: 'ev-admin@test.com' });
    lead = await createMentor({ email: 'ev-lead@test.com' });
    outsider = await createMentor({ email: 'ev-outsider@test.com' });
    mentee = await createMentee({ email: 'ev-mentee@test.com' });
    otherMentee = await createMentee({ email: 'ev-other@test.com' });

    program = await createProgram({ createdBy: admin.id });
    roadmap = await createRoadmap({ programId: program.id, createdBy: admin.id });

    clan = await models.Clan.create({
      programId: program.id, name: 'Viral Loop', leadMentorId: lead.id, createdBy: admin.id
    });
    otherClan = await models.Clan.create({
      programId: program.id, name: 'Core Team', leadMentorId: outsider.id, createdBy: admin.id
    });
    await clanService.addMember(clan.id, { userId: lead.id, role: 'lead_mentor' });
    await clanService.addMember(clan.id, { userId: mentee.id, role: 'mentee' });
    await clanService.addMember(otherClan.id, { userId: outsider.id, role: 'lead_mentor' });
    await clanService.addMember(otherClan.id, { userId: otherMentee.id, role: 'mentee' });

    enrollment = await createEnrollment({ menteeId: mentee.id, programId: program.id, status: 'active' });

    template = await certificateService.createTemplate(
      {
        name: 'Fellowship',
        config: [],
        criteria: [
          { id: 'gold', name: 'Gold', minCompletionRate: 80 },
          { id: 'participation', name: 'Participation' }
        ],
        programId: program.id
      },
      admin.id
    );
  });

  afterAll(async () => {
    await models.CertificateTemplate.destroy({ where: {}, force: true });
    await cleanDb();
  });

  beforeEach(async () => {
    await models.CertificateTemplate.update({ aiEvaluation: null }, { where: { id: template.id } });
    await models.CertificateVerification.destroy({ where: { templateId: template.id }, force: true });
    await models.AssignedTask.destroy({ where: { menteeId: mentee.id }, force: true });
    await models.RoadmapTask.destroy({ where: { roadmapId: roadmap.id }, force: true });
    await models.RoadmapTask.destroy({ where: { roadmapId: null }, force: true });
  });

  describe('completion rate', () => {
    it('measures roadmap tasks only, ignoring custom one-offs', async () => {
      // 3 of 4 roadmap tasks done = 75%.
      await assign({ status: 'completed' });
      await assign({ status: 'completed' });
      await assign({ status: 'completed' });
      await assign({ status: 'assigned' });
      // Two custom tasks, both unfinished. Counting them would drag this to 50%.
      await assign({ custom: true, status: 'assigned' });
      await assign({ custom: true, status: 'assigned' });

      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, admin);

      expect(ev.metrics.completion_rate).toBe(75);
      expect(ev.metrics.completion_basis).toMatchObject({
        basis: 'roadmap',
        counted_total: 4,
        counted_completed: 3,
        custom_total: 2,
        custom_completed: 0
      });
    });

    it('falls back to all assigned work when no roadmap task was ever assigned', async () => {
      // 0% here would read as "did nothing" when the truth is "nothing from a
      // roadmap was assigned" — a different statement entirely.
      await assign({ custom: true, status: 'completed' });
      await assign({ custom: true, status: 'assigned' });

      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, admin);

      expect(ev.metrics.completion_rate).toBe(50);
      expect(ev.metrics.completion_basis.basis).toBe('all_assigned');
    });

    it('is 0 with nothing assigned at all, and says so', async () => {
      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, admin);
      expect(ev.metrics.completion_rate).toBe(0);
      expect(ev.metrics.completion_basis.counted_total).toBe(0);
    });
  });

  describe('the payload', () => {
    it('answers before any AI run, from the record', async () => {
      await assign({ status: 'completed' });

      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, lead);

      expect(ev.ai).toBeNull();
      expect(ev.mentee.id).toBe(mentee.id);
      expect(ev.clan.name).toBe('Viral Loop');
      expect(ev.metrics.completion_rate).toBe(100);
      // Thresholds are recomputed here, not read from a stale evaluation.
      expect(ev.constraints.hardChecks.gold.completion_rate_ok).toBe(true);
    });

    it('reports a tier the mentee falls short of as failing, with the real number', async () => {
      await assign({ status: 'completed' });
      await assign({ status: 'assigned' });   // 50%, under Gold's 80

      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, lead);

      expect(ev.metrics.completion_rate).toBe(50);
      expect(ev.constraints.hardChecks.gold.completion_rate_ok).toBe(false);
      expect(ev.constraints.maxEligibleTier).toBe('participation');
    });

    it('carries a mentor override and the reason they gave', async () => {
      await verification.open(template.id, [
        { mentee_id: mentee.id, certificate_tier: 'participation', match_score: 64 }
      ], { notify: false });

      await verification.verify(
        template.id, mentee.id,
        { finalTier: 'gold', reason: 'Carried the clan through a bad month' },
        lead
      );

      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, admin);

      expect(ev.verification).toMatchObject({
        status: 'verified',
        aiTier: 'participation',
        finalTier: 'gold',
        overridden: true,
        overrideReason: 'Carried the clan through a bad month'
      });
      expect(ev.verification.verifiedBy).toContain('Test');
    });

    it('refuses an override with no reason', async () => {
      await verification.open(template.id, [
        { mentee_id: mentee.id, certificate_tier: 'participation', match_score: 64 }
      ], { notify: false });

      await expect(
        verification.verify(template.id, mentee.id, { finalTier: 'gold' }, lead)
      ).rejects.toThrow(/why/i);
    });
  });

  describe('the AI result lookup', () => {
    /**
     * The result is pulled out of the JSONB array in the database, not by
     * shipping every mentee's result back and filtering in JS — on a 600-person
     * cycle that was megabytes per drawer open and timed the request out. These
     * pin the SQL: it has to find the right person, tolerate a template that
     * has never been evaluated, and accept both key spellings the evaluator has
     * used for the id.
     */
    it('finds this mentee among many results', async () => {
      await models.CertificateTemplate.update(
        { aiEvaluation: { ranAt: new Date().toISOString(), results: [
          { mentee_id: otherMentee.id, certificate_tier: 'gold', match_score: 99, reasoning: 'not this one' },
          { mentee_id: mentee.id, certificate_tier: 'participation', match_score: 71, reasoning: 'steady work' }
        ] } },
        { where: { id: template.id } }
      );

      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, admin);

      expect(ev.ai).toMatchObject({ certificate_tier: 'participation', reasoning: 'steady work' });
    });

    it('accepts the older `id` spelling for the mentee key', async () => {
      await models.CertificateTemplate.update(
        { aiEvaluation: { results: [{ id: mentee.id, certificate_tier: 'gold', reasoning: 'legacy shape' }] } },
        { where: { id: template.id } }
      );

      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, admin);
      expect(ev.ai.reasoning).toBe('legacy shape');
    });

    it('returns null rather than throwing when nothing has been evaluated', async () => {
      await models.CertificateTemplate.update({ aiEvaluation: null }, { where: { id: template.id } });
      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, admin);
      expect(ev.ai).toBeNull();
    });

    it('survives a results value that is not an array', async () => {
      await models.CertificateTemplate.update(
        { aiEvaluation: { results: 'broken' } }, { where: { id: template.id } }
      );
      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, admin);
      expect(ev.ai).toBeNull();
    });
  });

  describe('over HTTP', () => {
    /**
     * These exist because the service tests all passed while the endpoint hung
     * for thirty seconds in production.
     *
     * The controller called `successResponse(res, data)` — but in this codebase
     * `successResponse(message, data, status)` is a pure FORMATTER that returns
     * an object; it never touches `res`. So the handler did every query, built
     * the payload, and then sent nothing. The request sat open until Heroku's
     * router killed it with an H12 at 30s, and no error was ever logged because
     * nothing had gone wrong — the response was simply never written.
     *
     * Calling the service directly can never catch that. Something has to make
     * a real request and insist on a real response.
     */
    const url = () => `/api/certificates/templates/${template.id}/mentees/${mentee.id}/evidence`;

    it('actually responds, with the payload', async () => {
      await assign({ status: 'completed' });

      const res = await request(app).get(url()).set('Authorization', authHeader(admin));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.mentee.id).toBe(mentee.id);
      expect(res.body.data.metrics.completion_rate).toBe(100);
    });

    it('answers a mentor of that clan', async () => {
      const res = await request(app).get(url()).set('Authorization', authHeader(lead));
      expect(res.status).toBe(200);
      expect(res.body.data.mentee.id).toBe(mentee.id);
    });

    it('refuses a mentor from another clan', async () => {
      const res = await request(app).get(url()).set('Authorization', authHeader(outsider));
      expect(res.status).toBe(403);
    });

    it('refuses an anonymous caller', async () => {
      const res = await request(app).get(url());
      expect(res.status).toBe(401);
    });
  });

  describe('scope', () => {
    it('lets a mentor read their own clan', async () => {
      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, lead);
      expect(ev.mentee.id).toBe(mentee.id);
    });

    it('refuses a mentor somebody else\'s mentee', async () => {
      await expect(
        certificateService.getMenteeEvidence(template.id, otherMentee.id, lead)
      ).rejects.toThrow(/denied/i);
    });

    it('lets a mentee read their own', async () => {
      const ev = await certificateService.getMenteeEvidence(template.id, mentee.id, mentee);
      expect(ev.mentee.id).toBe(mentee.id);
    });

    it('refuses a mentee somebody else\'s', async () => {
      await expect(
        certificateService.getMenteeEvidence(template.id, otherMentee.id, mentee)
      ).rejects.toThrow(/denied/i);
    });
  });
});
