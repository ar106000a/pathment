const { models } = require('../db');
const authzService = require('./authzService');
const { PERMISSIONS: P } = require('../config/permissions');
const { resolveMenteeClanId } = require('./menteeClanScope');
const { NotFoundError, ValidationError, ForbiddenError } = require('../utils/errors/errorTypes');
const clanLifecycleService = require('./clanLifecycleService');

// Grace window for a mentee to delete a friction record they logged. Long
// enough to undo an accidental/duplicate entry, short enough that nobody can
// scrub a week's worth of blockers off their record right before a review.
// (Mentors/admins are exempt — they delete as moderators.) Tunable.
const DELETE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * frictionService - blockers and delay events. These are the mentee-facing
 * "what's slowing you down" inputs that feed the cockpit and the fairness read.
 */
class FrictionService {
  async clanFor(data, actorId) {
    const task = data.assignedTaskId && await models.AssignedTask.findByPk(data.assignedTaskId);
    if (data.assignedTaskId && (!task || task.menteeId !== data.menteeId || (data.clanId && task.clanId !== data.clanId))) throw new ValidationError('Choose a task belonging to this mentee and clan');
    return resolveMenteeClanId(data.menteeId, data.clanId || task?.clanId, { actorId });
  }
  /**
   * Throw unless `user` may touch this mentee's friction records. `canViewMentee`
   * is the one ownership rule — self, admin, direct 1:1 match, or MENTEE_VIEW at
   * the mentee's clan (covers lead/co-mentor and cross-clan cover) — so every
   * entry point below shares a single definition instead of its own guess.
   */
  async #assertCanAccessMentee(user, menteeId) {
    if (!user) throw new ForbiddenError('Authentication required');
    if (!menteeId) throw new ValidationError('menteeId is required');
    if (!(await authzService.canViewMentee(user, menteeId))) {
      throw new ForbiddenError('You are not authorized to access this mentee\'s records');
    }
    return menteeId;
  }

  /** Access to a specific friction row must include its clan when one is set. */
  async #assertCanAccessFriction(user, record) {
    await this.#assertCanAccessMentee(user, record.menteeId);
    if (!record.clanId || await authzService.hasAdminAccess(user)) return;
    const resource = await authzService.scopeOfClan(record.clanId);
    if (!(await authzService.can(user, P.MENTEE_VIEW, resource))) {
      throw new ForbiddenError('You do not have access to this clan\'s records');
    }
  }

  /**
   * The mentee ids a LIST narrows to when the caller named none.
   *   undefined → no filter (admin tier: they see everything)
   *   [ids]     → whoever the caller's current PORTAL is about
   * Derived from capabilities, never the base `role` column: a mentee-based
   * co-mentor really does mentor a clan, and an admin sub-role (core_team,
   * program_admin) doesn't read 'admin' there.
   *
   * `portal` is the hat the caller is wearing (middlewares/portalScope.js). It
   * is what stopped the mentee Roadblocks page listing the caller's MENTEES'
   * roadblocks: somebody who both leads a clan and learns in another is, to the
   * union below, entitled to all of it — which is true, and completely wrong as
   * an answer to "what is slowing ME down". The portal asks the narrower
   * question. Without one (an older client, a script) the union stands, so this
   * is additive.
   */
  async #visibleMenteeIds(user, portal) {
    if (!user) throw new ForbiddenError('Authentication required');
    // Resolved once and threaded through — each of these would otherwise rebuild
    // the user's whole role set (memberships + cover + grants) from scratch.
    const assignments = await authzService.getAssignments(user);

    const scoped = await authzService.menteeIdsForPortal(user, portal, {
      permission: P.MENTEE_VIEW,
      assignments
    });
    // An admin browsing the admin portal still sees everything; a mentee/mentor
    // portal narrows even for them, because that is the portal they opened.
    if (scoped) return scoped;

    if (await authzService.hasAdminAccess(user, { assignments })) return undefined;
    const [mentored, capabilities] = await Promise.all([
      authzService.resolveMenteeIds(user, { permission: P.MENTEE_VIEW, assignments }),
      authzService.getCapabilities(user, { assignments })
    ]);
    const ids = new Set(mentored);
    if (capabilities.includes('mentee')) ids.add(user.id);
    return [...ids];
  }

  /** List scoping: `undefined` = unfiltered, `[]` = nothing this user can see. */
  async #menteeScope(menteeId, user, portal) {
    if (menteeId) return this.#assertCanAccessMentee(user, menteeId);
    return this.#visibleMenteeIds(user, portal);
  }

  /**
   * A delay is reviewed FOR someone, never BY them. A mentee who co-mentors the
   * clan they also learn in holds TASK_REVIEW at that clan's scope and passes
   * `canViewMentee` on themselves, so without this they could accept — and
   * credit — their own delay. Mirrors the guard in authzService.canActOnTask.
   */
  async #assertNotSelfReview(user, menteeId) {
    if (user.id === menteeId && !(await authzService.hasAdminAccess(user))) {
      throw new ForbiddenError('You cannot review your own delay.');
    }
  }

  // ── Blockers ──────────────────────────────────────────────────────────────
  async listBlockers({ menteeId, status, user, portal }) {
    const scope = await this.#menteeScope(menteeId, user, portal);
    if (Array.isArray(scope) && scope.length === 0) return [];
    const where = {};
    if (scope !== undefined) where.menteeId = scope;
    if (status) where.status = status;
    if (portal?.clanId) where.clanId = portal.clanId;
    return models.Blocker.findAll({ where, order: [['openedAt', 'DESC']] });
  }

  /**
   * Blockers for a single mentee, eager-loaded with their linked task title —
   * the shape the mentor's mentee-profile view renders. Owned here (not by
   * cohortService) so the friction domain keeps its query/includes in one place.
   *
   * Like `listDelaysFor`, this is an INTERNAL read for a caller that has already
   * authorized the mentee (cohortController runs `canViewMentee` before building
   * the profile). It takes a bare menteeId and does no check of its own — never
   * reach it straight from a route.
   */
  async listBlockersWithTask(menteeId, clanId = null) {
    const where = { menteeId };
    if (clanId) where.clanId = clanId;
    return models.Blocker.findAll({
      where,
      order: [['status', 'ASC'], ['openedAt', 'DESC']],
      include: [{ model: models.AssignedTask, as: 'task', attributes: ['id'], include: [{ model: models.RoadmapTask, as: 'roadmapTask', attributes: ['title'] }] }]
    });
  }

  async createBlocker(data, createdBy, currentUser) {
    const { menteeId } = data;
    await this.#assertCanAccessMentee(currentUser, menteeId);
    const title = typeof data.title === 'string' ? data.title.trim() : '';
    if (!title) throw new ValidationError('title is required');
    if (title.length > 5000) throw new ValidationError('That blocker note is too long — please keep it under 5000 characters.');
    const clanId = await this.clanFor(data, createdBy);
    await clanLifecycleService.assertClanWritable(clanId);
    return models.Blocker.create({
      menteeId,
      clanId,
      assignedTaskId: data.assignedTaskId || null,
      title,
      category: data.category || 'technical',
      severity: data.severity || 'medium',
      status: 'open',
      createdBy: createdBy || null
    });
  }

  async resolveBlocker(id, currentUser) {
    const blocker = await models.Blocker.findByPk(id);
    if (!blocker) throw new NotFoundError('Blocker not found');
    await this.#assertCanAccessFriction(currentUser, blocker);
    await clanLifecycleService.assertClanWritable(blocker.clanId);
    blocker.status = 'resolved';
    blocker.resolvedAt = new Date();
    await blocker.save();
    return blocker;
  }

  /**
   * Delete a blocker outright. Deleting your OWN record is the windowed case —
   * long enough to undo a mistake, short enough that nobody scrubs a week of
   * blockers off their record before a review. Mentors/admins delete as
   * moderators, so they're exempt. Keyed on whose record it is, not on the base
   * role: a mentee-based co-mentor is a moderator for their clan and a learner
   * for their own row.
   */
  async deleteBlocker(id, currentUser) {
    const blocker = await models.Blocker.findByPk(id);
    if (!blocker) throw new NotFoundError('Blocker not found');
    await this.#assertCanAccessFriction(currentUser, blocker);
    await clanLifecycleService.assertClanWritable(blocker.clanId);
    const ownRecord = currentUser.id === blocker.menteeId;
    if (ownRecord && !(await authzService.hasAdminAccess(currentUser))) {
      const age = Date.now() - new Date(blocker.openedAt || blocker.createdAt).getTime();
      if (age > DELETE_WINDOW_MS) {
        throw new ForbiddenError('Blockers can only be deleted within 6 hours of logging them. Mark it resolved instead.');
      }
    }
    await blocker.destroy();
    return { deleted: true, id };
  }

  // ── Delays ──────────────────────────────────────────────────────────────
  async listDelays({ menteeId, user, portal }) {
    const scope = await this.#menteeScope(menteeId, user, portal);
    if (Array.isArray(scope) && scope.length === 0) return [];
    const where = {};
    if (portal?.clanId) where.clanId = portal.clanId;
    if (scope !== undefined) where.menteeId = scope;
    return models.DelayEvent.findAll({ where, order: [['occurredAt', 'DESC']] });
  }

  /**
   * Delays for one mentee, for a caller that has ALREADY authorized them — the
   * mentor's mentee-profile assembly, where cohortController checks
   * `canViewMentee` before any of this runs. The counterpart to
   * `listBlockersWithTask`; `listDelays` stays the request-facing entry point
   * and keeps its own check. Route handlers must not call this.
   */
  async listDelaysFor(menteeId, clanId = null) {
    const where = { menteeId };
    if (clanId) where.clanId = clanId;
    return models.DelayEvent.findAll({ where, order: [['occurredAt', 'DESC']] });
  }

  async createDelay(data, createdBy, currentUser) {
    const { reason, menteeId } = data;
    await this.#assertCanAccessMentee(currentUser, menteeId);
    if (!reason) throw new ValidationError('reason is required');
    const clanId = await this.clanFor(data, createdBy);
    await clanLifecycleService.assertClanWritable(clanId);
    return models.DelayEvent.create({
      clanId,
      menteeId,
      assignedTaskId: data.assignedTaskId || null,
      reason,
      kind: data.kind || 'other',
      days: data.days || 0,
      category: data.category || 'external',
      accepted: false,
      aiRationale: data.aiRationale || null,
      createdBy: createdBy || null
    });
  }

  async acceptDelay(id, { accepted = true, category }, currentUser) {
    const delay = await models.DelayEvent.findByPk(id);
    if (!delay) throw new NotFoundError('Delay event not found');
    await this.#assertCanAccessFriction(currentUser, delay);
    await clanLifecycleService.assertClanWritable(delay.clanId);
    await this.#assertNotSelfReview(currentUser, delay.menteeId);
    delay.accepted = accepted;
    if (category) delay.category = category;
    await delay.save();
    return delay;
  }

  /**
   * Reject (remove) a PENDING logged delay, so a mentor can clear a duplicate or
   * bogus request. An already-accepted delay is locked: it has been credited
   * toward the mentee's fair progress, and removing it would retroactively
   * change standings. The route also gates on TASK_REVIEW at the delay's scope.
   */
  async rejectDelay(id, currentUser) {
    const delay = await models.DelayEvent.findByPk(id);
    if (!delay) throw new NotFoundError('Delay event not found');
    await this.#assertCanAccessFriction(currentUser, delay);
    await clanLifecycleService.assertClanWritable(delay.clanId);
    await this.#assertNotSelfReview(currentUser, delay.menteeId);
    if (delay.accepted) {
      throw new ValidationError('This delay was already accepted and credited — it can no longer be rejected.');
    }
    await delay.destroy();
    return { deleted: true, id };
  }
}

module.exports = new FrictionService();
