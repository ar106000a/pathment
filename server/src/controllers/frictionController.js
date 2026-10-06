const { catchAsync } = require('../middlewares/errorHandler');
const { successResponse } = require('../utils/responses');
const frictionService = require('../services/frictionService');
const { portalOf, requestedClanId } = require('../middlewares/portalScope');

/**
 * A mentee logging their own friction doesn't send a menteeId — the client has
 * no reason to know it — so default it to them. This grants nothing: the service
 * still runs the ownership check, and `canViewMentee` is true for self anyway.
 * Mentors/admins name the mentee explicitly.
 *
 * "Am I the mentee here" is answered by the PORTAL, not by `user.role`. The base
 * role is the account type somebody was created as, and a mentor who also learns
 * in a clan keeps `role: 'mentor'` forever — so keying on it meant their own
 * Roadblocks page sent no menteeId and every attempt to log one came back
 * "menteeId is required". The portal is the question they are actually asking.
 */
function targetMenteeId(req) {
  if (req.body?.menteeId) return req.body.menteeId;
  const portal = portalOf(req).role;
  if (portal === 'mentee') return req.user.id;
  // No portal (older client / script): fall back to the base role, as before.
  return !portal && req.user.role === 'mentee' ? req.user.id : undefined;
}

// ── Blockers ──────────────────────────────────────────────────────────────
const listBlockers = catchAsync(async (req, res) => {
  const blockers = await frictionService.listBlockers({
    menteeId: req.query.menteeId,
    status: req.query.status,
    user: req.user,
    portal: portalOf(req)
  });
  res.status(200).json(successResponse('Blockers retrieved', { blockers }));
});

const createBlocker = catchAsync(async (req, res) => {
  const blocker = await frictionService.createBlocker(
    { ...req.body, clanId: requestedClanId(req), menteeId: targetMenteeId(req) }, req.user.id, req.user
  );
  res.status(201).json(successResponse('Blocker logged', { blocker }, 201));
});

const resolveBlocker = catchAsync(async (req, res) => {
  const blocker = await frictionService.resolveBlocker(req.params.id, req.user);
  res.status(200).json(successResponse('Blocker resolved', { blocker }));
});

const deleteBlocker = catchAsync(async (req, res) => {
  const result = await frictionService.deleteBlocker(req.params.id, req.user);
  res.status(200).json(successResponse('Blocker deleted', result));
});

// ── Delays ──────────────────────────────────────────────────────────────
const listDelays = catchAsync(async (req, res) => {
  const delays = await frictionService.listDelays({
    menteeId: req.query.menteeId,
    user: req.user,
    portal: portalOf(req)
  });
  res.status(200).json(successResponse('Delays retrieved', { delays }));
});

const createDelay = catchAsync(async (req, res) => {
  const delay = await frictionService.createDelay(
    { ...req.body, clanId: requestedClanId(req), menteeId: targetMenteeId(req) }, req.user.id, req.user
  );
  res.status(201).json(successResponse('Delay logged', { delay }, 201));
});

const acceptDelay = catchAsync(async (req, res) => {
  const delay = await frictionService.acceptDelay(req.params.id, req.body, req.user);
  res.status(200).json(successResponse('Delay updated', { delay }));
});

const rejectDelay = catchAsync(async (req, res) => {
  const result = await frictionService.rejectDelay(req.params.id, req.user);
  res.status(200).json(successResponse('Delay rejected', result));
});

module.exports = {
  listBlockers,
  createBlocker,
  resolveBlocker,
  deleteBlocker,
  listDelays,
  createDelay,
  acceptDelay,
  rejectDelay
};
