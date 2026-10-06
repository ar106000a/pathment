'use strict';

/**
 * The portal narrows. It never widens.
 *
 * A person can hold admin AND mentor at once. `hasAdminAccess` answered from
 * what they HOLD, with no idea which portal they had open — so every scope
 * check on a mentor screen answered "admin", and `resolveMenteeScope` returned
 * null, meaning "no scoping, whole programme".
 *
 * On production that showed a mentor whose clan selector said "Viral Loop Clan
 * 2026" a certificate roster of all 28 clans and 622 mentees, with 592 of them
 * selected for issuing.
 *
 * This is the mirror of the admin leak fixed in admin-portal-clan-leak: there
 * the mentor's clan header narrowed an ADMIN screen it had no business
 * touching. Both come from the same mistake — treating the two hats as one.
 */

const { models } = require('../../src/db');
const clanService = require('../../src/services/clanService');
const authzService = require('../../src/services/authzService');
const certificateService = require('../../src/services/certificateService');
const mentorshipPauseService = require('../../src/services/mentorshipPauseService');
const promotionService = require('../../src/services/promotionService');
const { runWithRequestContext, getRequestContext } = require('../../src/utils/auditContext');
const { cleanDb, createAdmin, createMentee, createProgram } = require('../helpers/seed');

describe('a user who is both an admin and a mentor', () => {
  let person, program, mine, theirs, myMentee, theirMentee;

  beforeEach(async () => {
    await cleanDb();

    // One account holding both hats — admin by role, mentor by clan membership.
    person = await createAdmin({ email: 'both@test.com' });
    myMentee = await createMentee({ email: 'mine@test.com' });
    theirMentee = await createMentee({ email: 'theirs@test.com' });

    program = await createProgram({ createdBy: person.id });
    mine = await models.Clan.create({ programId: program.id, name: 'Viral Loop', leadMentorId: person.id, createdBy: person.id });
    theirs = await models.Clan.create({ programId: program.id, name: 'Static Stream', createdBy: person.id });
    await clanService.addMember(mine.id, { userId: person.id, role: 'lead_mentor' });
    await clanService.addMember(mine.id, { userId: myMentee.id, role: 'mentee' });
    await clanService.addMember(theirs.id, { userId: theirMentee.id, role: 'mentee' });
  });

  const inPortal = (role, fn) => runWithRequestContext({ ...getRequestContext(), portalRole: role }, fn);

  describe('what they HOLD never changes', () => {
    /**
     * `hasAdminAccess` must keep answering from standing, because the client
     * caches it per USER, not per portal. A `false` fetched on a mentor screen
     * is still in the cache when they navigate to /admin, where `RoleGuard`
     * reads it and bounces them out — narrowing this locks an admin out of
     * their own admin area.
     */
    it('stays true in every portal', async () => {
      expect(await authzService.hasAdminAccess(person)).toBe(true);
      for (const portal of ['admin', 'mentor', 'mentee']) {
        expect(await inPortal(portal, () => authzService.hasAdminAccess(person)))
          .toBe(true);
      }
    });
  });

  describe('what they are ACTING as narrows to the portal', () => {
    it('is true with no portal stated — a job, a script, a plain call', async () => {
      expect(await authzService.actsAsAdmin(person)).toBe(true);
    });

    it('is true in the admin portal', async () => {
      expect(await inPortal('admin', () => authzService.actsAsAdmin(person))).toBe(true);
    });

    it('is FALSE in the mentor portal — they are wearing the other hat', async () => {
      expect(await inPortal('mentor', () => authzService.actsAsAdmin(person))).toBe(false);
    });

    it('is FALSE in the mentee portal', async () => {
      expect(await inPortal('mentee', () => authzService.actsAsAdmin(person))).toBe(false);
    });
  });

  describe('the roster scope that leaked', () => {
    it('is unscoped in the admin portal — an admin really does see everyone', async () => {
      const scope = await inPortal('admin', () => certificateService.resolveMenteeScope(person, { programId: program.id }));
      expect(scope).toBeNull();
    });

    it('is limited to their own clan in the mentor portal', async () => {
      const scope = await inPortal('mentor', () => certificateService.resolveMenteeScope(person, { programId: program.id }));
      expect(scope).toEqual([myMentee.id]);
      expect(scope).not.toContain(theirMentee.id);
    });

    it('limits paused mentees to their own clans in the mentor portal', async () => {
      await models.ClanMembership.update(
        { status: 'paused', pausedAt: new Date() },
        { where: { userId: [myMentee.id, theirMentee.id], role: 'mentee' } }
      );

      const asAdmin = await inPortal('admin', () => mentorshipPauseService.listPaused(person));
      expect(asAdmin.map((row) => row.menteeId).sort()).toEqual([myMentee.id, theirMentee.id].sort());

      const asMentor = await inPortal('mentor', () => mentorshipPauseService.listPaused(person));
      expect(asMentor.map((row) => row.menteeId)).toEqual([myMentee.id]);
    });

    it('limits promotions to mentees in the selected mentor clan', async () => {
      const [mineCandidate, theirCandidate] = await Promise.all([
        models.PromotionCandidate.create({ menteeId: myMentee.id, nominatedBy: person.id, stage: 'nominated' }),
        models.PromotionCandidate.create({ menteeId: theirMentee.id, nominatedBy: person.id, stage: 'nominated' })
      ]);
      const enrich = jest.spyOn(promotionService, '_enrich').mockImplementation(async (candidate) => ({ id: candidate.id }));

      const asMentor = await inPortal('mentor', () => promotionService.list({
        actorId: person.id, isAdmin: false, activeClanId: mine.id
      }));
      expect(asMentor.map((row) => row.id)).toEqual([mineCandidate.id]);
      expect(asMentor.map((row) => row.id)).not.toContain(theirCandidate.id);

      enrich.mockRestore();
    });
  });

  describe('the recorded stage follows the hat, not the standing', () => {
    /**
     * The mentor screen's button says "sign off"; the admin screen's says
     * "approve". Whatever the record says has to agree with whichever button
     * the person actually pressed.
     */
    it('records mentor_verified when an admin signs off from the mentor portal', async () => {
      const certificateService = require('../../src/services/certificateService');
      const verification = require('../../src/services/certificateVerificationService');

      const template = await inPortal('admin', () => certificateService.createTemplate({
        name: 'Fellowship', config: [],
        criteria: [{ id: 'bronze', name: 'Bronze', artworkUrl: 'https://cdn/b.png', layout: [] }],
        programId: program.id
      }, person.id));
      await template.update({
        aiEvaluation: {
          results: [{ mentee_id: myMentee.id, certificate_tier: 'bronze', match_score: 60 }],
          ranAt: new Date().toISOString()
        }
      });
      await inPortal('admin', () => verification.sendToClans(template.id, {}, person));

      await inPortal('mentor', () => verification.verify(template.id, myMentee.id, {}, person));
      const asMentor = await models.CertificateVerification.findOne({
        where: { templateId: template.id, menteeId: myMentee.id }
      });
      expect(asMentor.stage).toBe('mentor_verified');

      await inPortal('admin', () => verification.verify(template.id, myMentee.id, {}, person));
      await asMentor.reload();
      expect(asMentor.stage).toBe('admin_approved');
    });
  });

  describe('no lockout', () => {
    /**
     * The switcher and the admin-area guard both hang off standing, so they
     * must survive being read from another portal. If they narrowed, "admin"
     * would vanish the moment you switched to mentor and there would be no way
     * back.
     */
    it('still offers admin while in the mentor portal', async () => {
      const caps = await inPortal('mentor', () => authzService.getCapabilities(person));
      expect(caps).toContain('admin');
    });

    it('still offers admin while in the mentee portal', async () => {
      const caps = await inPortal('mentee', () => authzService.getCapabilities(person));
      expect(caps).toContain('admin');
    });
  });
});
