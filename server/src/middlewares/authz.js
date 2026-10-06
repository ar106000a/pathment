const authzService = require('../services/authzService');
const { PERMISSIONS } = require('../config/permissions');
const { AuthenticationError, AuthorizationError } = require('../utils/errors/errorTypes');
const { requestedClanId } = require('./portalScope');

/**
 * requirePermission('task.review', scopeResolver?)
 *
 * Gate a route on a permission, optionally scoped to a resource. `scopeResolver`
 * is `(req) => descriptor | Promise<descriptor>` returning { programId?, clanId?,
 * userId? }; omit it for org-wide actions. Assignments are fetched once and
 * cached on the request so multiple checks in a chain stay cheap.
 */
function requirePermission(permission, scopeResolver = null) {
  return async (req, res, next) => {
    try {
      if (!req.user) throw new AuthenticationError('You must be logged in to access this resource');

      // Reuse the per-request memoized loader seeded by authenticate(); fall back
      // to a direct fetch if this route somehow runs without it.
      req._assignments = req.loadAssignments
        ? await req.loadAssignments()
        : (req._assignments || (await authzService.getAssignments(req.user)));
      const resource = scopeResolver ? await scopeResolver(req) : null;

      const allowed = await authzService.can(req.user, permission, resource, { assignments: req._assignments });
      if (!allowed) {
        throw new AuthorizationError('You do not have permission to perform this action');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * requireMenteeAccess('id')
 *
 * Gate a route on "may I see this mentee?" using the SAME rule the mentee-detail
 * controllers use (cohortController, enrollmentController, taskController) —
 * `authzService.canViewMentee`, which admits admins, the mentee themselves, a
 * 1:1 MentorMenteeMatch, and anyone holding mentee.view at one of the mentee's
 * clans.
 *
 * Prefer this over `requirePermission(MENTEE_VIEW, scope.mentee(...))` for
 * per-mentee routes: `scope.mentee` resolves only the mentee's CLAN, so a mentee
 * matched 1:1 with no clan placement resolves to a bare { userId } and is denied
 * — which is how the activity summary came to 403 on mentees whose profile page
 * loaded fine.
 */
function requireMenteeAccess(param = 'id') {
  return async (req, res, next) => {
    try {
      if (!req.user) throw new AuthenticationError('You must be logged in to access this resource');

      req._assignments = req.loadAssignments
        ? await req.loadAssignments()
        : (req._assignments || (await authzService.getAssignments(req.user)));

      const allowed = await authzService.canViewMentee(req.user, req.params[param], {
        assignments: req._assignments
      });
      if (!allowed) throw new AuthorizationError('You do not have access to this mentee');
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The body-field equivalent of requireMenteeAccess, for actions such as rewards. */
function requireMenteeBodyAccess(field = 'menteeId') {
  return async (req, res, next) => {
    try {
      if (!req.user) throw new AuthenticationError('You must be logged in to access this resource');

      req._assignments = req.loadAssignments
        ? await req.loadAssignments()
        : (req._assignments || (await authzService.getAssignments(req.user)));

      const menteeId = req.body && req.body[field];
      // Leave required-field validation to the controller so malformed input is
      // a 400, not reported as though a real mentee was outside the caller's scope.
      if (!menteeId) return next();

      const allowed = await authzService.canViewMentee(req.user, menteeId, {
        assignments: req._assignments
      });
      if (!allowed) throw new AuthorizationError('You do not have access to this mentee');
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Admit the request when the user holds ANY of the listed permissions at the
 * resolved scope. Same assignment caching as requirePermission.
 */
function requireAnyPermission(permissions, scopeResolver = null) {
  return async (req, res, next) => {
    try {
      if (!req.user) throw new AuthenticationError('You must be logged in to access this resource');

      req._assignments = req.loadAssignments
        ? await req.loadAssignments()
        : (req._assignments || (await authzService.getAssignments(req.user)));
      const resource = scopeResolver ? await scopeResolver(req) : null;

      for (const permission of permissions) {
        // eslint-disable-next-line no-await-in-loop
        if (await authzService.can(req.user, permission, resource, { assignments: req._assignments })) {
          return next();
        }
      }
      throw new AuthorizationError('You do not have permission to perform this action');
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Add a member to a clan: clan.manage_members covers any role; mentee.add covers
 * adding mentees only (co-mentor toggle). Prevents mentee.add from assigning
 * co-mentors / core team.
 */
function requireAddClanMember(scopeResolver) {
  return async (req, res, next) => {
    try {
      if (!req.user) throw new AuthenticationError('You must be logged in to access this resource');

      req._assignments = req.loadAssignments
        ? await req.loadAssignments()
        : (req._assignments || (await authzService.getAssignments(req.user)));
      const resource = await scopeResolver(req);

      if (await authzService.can(req.user, PERMISSIONS.CLAN_MANAGE_MEMBERS, resource, { assignments: req._assignments })) {
        return next();
      }
      if (req.body?.role === 'mentee' && await authzService.can(req.user, PERMISSIONS.MENTEE_ADD, resource, { assignments: req._assignments })) {
        return next();
      }
      throw new AuthorizationError('You do not have permission to perform this action');
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Org-global resources (e.g. the shared library) aren't tied to one clan/program,
 * but should still require a real permission — not merely a role. This admits
 * anyone holding the permission at ANY scope (so a clan mentor with library.manage
 * @clan qualifies), while still blocking roles that lack it (e.g. analyst).
 */
function requirePermissionAnyScope(permission) {
  return async (req, res, next) => {
    try {
      if (!req.user) throw new AuthenticationError('You must be logged in to access this resource');
      const perms = await authzService.getPermissionUnion(req.user);
      if (!perms.includes(permission)) {
        throw new AuthorizationError('You do not have permission to perform this action');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Org/program-level admin endpoints (no single resource) that a program_admin
 * should run but a clan mentor should not. Admits holders of `permission` at
 * org OR program scope (default), excluding clan/self-scoped holders — so e.g. a
 * lead_mentor's clan-scoped mentee.manage can't drive an org enrollment action.
 */
function requirePermissionMinScope(permission, minLevel = 'program') {
  return async (req, res, next) => {
    try {
      if (!req.user) throw new AuthenticationError('You must be logged in to access this resource');
      const assignments = req.loadAssignments ? await req.loadAssignments() : undefined;
      const ok = await authzService.canAtMinScope(req.user, permission, minLevel, { assignments });
      if (!ok) throw new AuthorizationError('You do not have permission to perform this action');
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Common scope resolvers for route params (and a couple body-based ones). */
const scope = {
  clan: (param = 'id') => async (req) => authzService.scopeOfClan(req.params[param]),
  program: (param = 'id') => (req) => ({ programId: req.params[param] }),
  task: (param = 'id') => async (req) => authzService.scopeOfAssignedTask(req.params[param]),
  enrollment: (param = 'id') => async (req) => authzService.scopeOfEnrollment(req.params[param]),
  submission: (param = 'submissionId') => async (req) => authzService.scopeOfSubmission(req.params[param]),
  delay: (param = 'id') => async (req) => authzService.scopeOfDelay(req.params[param]),
  announcement: (param = 'id') => async (req) => authzService.scopeOfAnnouncement(req.params[param]),
  track: (param = 'id') => async (req) => authzService.scopeOfTrack(req.params[param]),
  mentee: (param = 'id') => async (req) =>
    authzService.scopeOfMentee(req.params[param], requestedClanId(req)),
  menteeBody: (field = 'menteeId') => async (req) =>
    authzService.scopeOfMentee(req.body && req.body[field], requestedClanId(req)),
  // Task creation names its target in the body (enrollmentId or menteeId).
  taskTarget: () => async (req) => {
    if (req.body && req.body.enrollmentId) return authzService.scopeOfEnrollment(req.body.enrollmentId);
    return authzService.scopeOfMentee(req.body && req.body.menteeId, requestedClanId(req));
  },
  // Announcement creation names its audience in the body.
  announcementBody: () => async (req) =>
    authzService.scopeOfAnnouncementAudience(req.body && req.body.audience, req.body && req.body.audienceId)
};

module.exports = {
  requirePermission,
  requireAnyPermission,
  requireAddClanMember,
  requireMenteeAccess,
  requireMenteeBodyAccess,
  requirePermissionAnyScope,
  requirePermissionMinScope,
  scope
};
