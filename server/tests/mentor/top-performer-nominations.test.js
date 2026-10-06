'use strict';

/**
 * Top-performer nominations: a mentor's judgement, recorded next to the data.
 *
 * An admin running a fellowship of several hundred cannot know who deserves the
 * recognition, and cannot take a mentor's word for it unexamined either. So a
 * nomination carries the mentor's reasoning AND the system's independent rank
 * at the moment it was made, and the admin weighs them together.
 *
 * The disagreement is the point: nominated-and-ranked-first needs no scrutiny,
 * nominated-and-ranked-last says read this one closely.
 */

const service = require('../../src/services/performanceNominationService');
const gamificationService = require('../../src/services/gamificationService');
const clanService = require('../../src/services/clanService');
const { models } = require('../../src/db');
const {
  cleanDb, createAdmin, createMentor, createMentee, createProgram,
  createRoadmap, createRoadmapTask, createEnrollment
} = require('../helpers/seed');

describe('top performer nominations', () => {
  let admin, lead, outsider, strong, weak, otherClanMentee;
  let program, clan, otherClan, roadmap;
  let enrollments = {};

  /**
   * One enrollment per mentee, carrying the progress the score reads.
   *
   * `absoluteProgress` comes off `enrollment.overallProgressPercentage`, and
   * the eligibility bar wants 20% of the programme behind somebody — so a
   * fixture that leaves it at zero can never be ranked, however many tasks it
   * finishes.
   */
  const enrollFor = async (menteeId, progressPercent) => {
    const enrollment = await createEnrollment({ menteeId, programId: program.id, status: 'active' });
    await enrollment.update({ overallProgressPercentage: progressPercent, currentWeek: 4 });
    enrollments[menteeId] = enrollment;
    return enrollment;
  };

  /** Give a mentee a roadmap task at a status, so the ranking has something real. */
  const assign = async (menteeId, { status = 'assigned', order = 1 } = {}) => {
    const task = await createRoadmapTask({ roadmapId: roadmap.id, title: `Task ${order}`, taskOrder: order });
    return models.AssignedTask.create({
      roadmapTaskId: task.id, menteeId, mentorId: lead.id,
      clanId: clan.id,
      enrollmentId: enrollments[menteeId].id,
      status, isCustomTask: false, isLate: false,
      dueDate: new Date(Date.now() + 7 * 86400000),
      completedAt: status === 'completed' ? new Date() : null,
      finalRating: status === 'completed' ? 4.5 : null,
      pointsAwarded: status === 'completed' ? 10 : 0, pointsBase: 10
    });
  };

  beforeEach(async () => {
    await cleanDb();
    await models.PerformanceNomination.destroy({ where: {}, force: true });
    enrollments = {};

    admin = await createAdmin({ email: 'tp-admin@test.com' });
    lead = await createMentor({ email: 'tp-lead@test.com' });
    outsider = await createMentor({ email: 'tp-outsider@test.com' });
    strong = await createMentee({ email: 'tp-strong@test.com' });
    weak = await createMentee({ email: 'tp-weak@test.com' });
    otherClanMentee = await createMentee({ email: 'tp-other@test.com' });

    program = await createProgram({ createdBy: admin.id });
    roadmap = await createRoadmap({ programId: program.id, createdBy: admin.id });

    clan = await models.Clan.create({
      programId: program.id, name: 'Viral Loop', leadMentorId: lead.id, createdBy: admin.id
    });
    otherClan = await models.Clan.create({
      programId: program.id, name: 'Core Team', leadMentorId: outsider.id, createdBy: admin.id
    });
    await clanService.addMember(clan.id, { userId: lead.id, role: 'lead_mentor' });
    await clanService.addMember(clan.id, { userId: strong.id, role: 'mentee' });
    await clanService.addMember(clan.id, { userId: weak.id, role: 'mentee' });
    await clanService.addMember(otherClan.id, { userId: outsider.id, role: 'lead_mentor' });
    await clanService.addMember(otherClan.id, { userId: otherClanMentee.id, role: 'mentee' });

    // The progress score will not rank anybody on two data points: it needs at
    // least three reviewed tasks and 20% of the programme behind them. The
    // strong mentee clears that bar; the weak one deliberately does not, which
    // is the case the nomination flow has to handle.
    await enrollFor(strong.id, 60);
    await enrollFor(weak.id, 5);
    for (let i = 1; i <= 6; i += 1) {
      await assign(strong.id, { status: 'completed', order: i });
    }
    await assign(weak.id, { status: 'assigned', order: 7 });
  });

  describe('the ranking the system offers', () => {
    it('ranks the clan on the progress score, best first', async () => {
      const board = await service.ranking({ programId: program.id, clanId: clan.id });

      expect(board.ranked[0].menteeId).toBe(strong.id);
      expect(board.ranked[0].rank).toBe(1);
      expect(board.ranked[0].score).toBeGreaterThan(0);
      const everyone = [...board.ranked, ...board.notRanked].map((r) => r.menteeId);
      expect(everyone).not.toContain(otherClanMentee.id);
    });

    it('carries the numbers behind the placing, not just a score', async () => {
      const board = await service.ranking({ programId: program.id, clanId: clan.id });
      expect(board.ranked[0].signals).toEqual(expect.objectContaining({
        tasksCompleted: expect.any(Number),
        onTimeRate: expect.any(Number)
      }));
    });

    /**
     * Somebody below the evidence bar is still a person a mentor may want to put
     * forward — that is the judgement the numbers cannot make. They come back
     * with no rank and the reason, never with an invented position.
     */
    it('returns the unranked too, with why they are unranked', async () => {
      const board = await service.ranking({ programId: program.id, clanId: clan.id });

      const waiting = board.notRanked.find((r) => r.menteeId === weak.id);
      expect(waiting).toBeTruthy();
      expect(waiting.rank).toBeNull();
      expect(waiting.notRankedBecause).toMatch(/task|programme/i);
    });
  });

  describe('nominating', () => {
    it('records the reasoning and the rank at the time', async () => {
      const nomination = await service.nominate(strong.id, {
        programId: program.id, clanId: clan.id, level: 'clan',
        reasoning: 'Carried the clan through a bad month and mentored two juniors.'
      }, lead);

      expect(nomination.reasoning).toMatch(/carried the clan/i);
      expect(nomination.systemRank).toBe(1);
      expect(nomination.systemOutOf).toBe(1);   // only the strong mentee is rankable
      expect(nomination.systemSignals.tasksCompleted).toBe(6);
      expect(nomination.status).toBe('nominated');
    });

    /** A nomination without a reason is a vote, and a vote is what we are avoiding. */
    it('refuses a nomination with no reasoning', async () => {
      await expect(service.nominate(strong.id, {
        programId: program.id, clanId: clan.id, reasoning: '   '
      }, lead)).rejects.toThrow(/why/i);
    });

    it('lets a mentor nominate somebody the score cannot rank, and says so', async () => {
      const nomination = await service.nominate(weak.id, {
        programId: program.id, clanId: clan.id,
        reasoning: 'Numbers do not show it, but they turned the whole clan around.'
      }, lead);

      // The signal the admin acts on: a human said yes where the data is silent.
      expect(nomination.systemRank).toBeNull();
      expect(nomination.reasoning).toMatch(/turned the whole clan around/);
    });

    it('refuses a mentor a mentee from a clan they do not mentor', async () => {
      await expect(service.nominate(otherClanMentee.id, {
        programId: program.id, clanId: otherClan.id, reasoning: 'Good work'
      }, lead)).rejects.toThrow(/do not mentor|not in a clan/i);
    });

    it('refuses the same mentee twice for the same award', async () => {
      await service.nominate(strong.id, {
        programId: program.id, clanId: clan.id, reasoning: 'First nomination'
      }, lead);

      await expect(service.nominate(strong.id, {
        programId: program.id, clanId: clan.id, reasoning: 'Second, by a co-mentor'
      }, lead)).rejects.toThrow(/already been nominated/i);
    });
  });

  describe('what each person can see', () => {
    beforeEach(async () => {
      await service.nominate(strong.id, {
        programId: program.id, clanId: clan.id, reasoning: 'Excellent throughout'
      }, lead);
    });

    it('shows an admin every nomination', async () => {
      const rows = await service.list({ user: admin, programId: program.id });
      expect(rows).toHaveLength(1);
      expect(rows[0].menteeId).toBe(strong.id);
    });

    it('shows a mentor only their own clans', async () => {
      expect(await service.list({ user: lead, programId: program.id })).toHaveLength(1);
      expect(await service.list({ user: outsider, programId: program.id })).toHaveLength(0);
    });
  });

  describe('the admin decision', () => {
    let nomination;
    beforeEach(async () => {
      nomination = await service.nominate(strong.id, {
        programId: program.id, clanId: clan.id, reasoning: 'Excellent throughout'
      }, lead);
    });

    it('awards, recording who decided and why', async () => {
      const decided = await service.decide(nomination.id,
        { status: 'awarded', decisionNote: 'Agreed — the work backs it up.' }, admin);

      expect(decided.status).toBe('awarded');
      expect(decided.decisionNote).toMatch(/work backs it up/);
      expect(decided.decidedBy).toBe(`${admin.firstName} ${admin.lastName}`.trim());
      expect(decided.decidedAt).toBeTruthy();
    });

    it('shortlists a clan nomination for the fellowship award', async () => {
      const decided = await service.decide(nomination.id, { status: 'shortlisted' }, admin);
      expect(decided.status).toBe('shortlisted');
    });

    it('refuses a mentor the decision', async () => {
      await expect(
        service.decide(nomination.id, { status: 'awarded' }, lead)
      ).rejects.toThrow(/admin/i);
    });

    it('refuses an unknown decision', async () => {
      await expect(
        service.decide(nomination.id, { status: 'maybe' }, admin)
      ).rejects.toThrow(/unknown decision/i);
    });
  });

  describe('the drafted reasoning', () => {
    it('always returns something usable, grounded in the numbers', async () => {
      const { draft, rank, outOf } = await service.aiDraft(strong.id,
        { programId: program.id, clanId: clan.id }, lead);

      expect(draft.length).toBeGreaterThan(20);
      expect(rank).toBe(1);
      expect(outOf).toBe(1);
    });
  });
});
