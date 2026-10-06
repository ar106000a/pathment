const { catchAsync } = require('../middlewares/errorHandler');
const { successResponse } = require('../utils/responses');
const pauseService = require('../services/mentorshipPauseService');
const { requestedClanId } = require('../middlewares/portalScope');

/** Prefer body clanId, then portal X-Active-Clan — never an arbitrary membership. */
function resolveClan(req) {
  return req.body?.clanId || req.query?.clanId || requestedClanId(req) || null;
}

/** POST /api/mentor/mentees/:menteeId/pause  { clanId?, reason? } */
const pause = catchAsync(async (req, res) => {
  const { reason } = req.body || {};
  const result = await pauseService.pause(req.user, req.params.menteeId, resolveClan(req), reason || null, 'mentor');
  res.status(200).json(successResponse('Mentee paused', result));
});

/** POST /api/mentor/mentees/:menteeId/resume  { clanId? } */
const resume = catchAsync(async (req, res) => {
  const result = await pauseService.resume(req.user, req.params.menteeId, resolveClan(req));
  res.status(200).json(successResponse('Mentee resumed', result));
});

/** GET /api/mentor/mentees/:menteeId/pause-state — is this mentee paused? */
const menteeState = catchAsync(async (req, res) => {
  const state = await pauseService.menteeState(req.user, req.params.menteeId, resolveClan(req));
  res.status(200).json(successResponse('Pause state', state));
});

/** GET /api/mentor/paused — paused mentees across the requester's clans. */
const listPaused = catchAsync(async (req, res) => {
  const paused = await pauseService.listPaused(req.user);
  res.status(200).json(successResponse('Paused mentees', { paused }));
});

/** GET /api/mentor/pause-suggestions?clanId= — active mentees that look inactive. */
const listSuggestions = catchAsync(async (req, res) => {
  const suggestions = await pauseService.listSuggestions(req.user, req.query.clanId || requestedClanId(req) || null);
  res.status(200).json(successResponse('Pause suggestions', { suggestions }));
});

/** POST /api/mentor/inactivity-check  { clanId?, autoPause? } — run a check now. */
const runInactivityCheck = catchAsync(async (req, res) => {
  const { autoPause } = req.body || {};
  const clanId = resolveClan(req);
  const result = await pauseService.runInactivityCheck(req.user, { clanId: clanId || null, autoPause: !!autoPause });
  res.status(200).json(successResponse(autoPause ? 'Inactivity check applied' : 'Inactivity check preview', result));
});

/** GET /api/mentee/pause-state — is the signed-in mentee paused, and by whom to ask. */
const selfPauseState = catchAsync(async (req, res) => {
  const state = await pauseService.selfPauseState(req.user.id);
  res.status(200).json(successResponse('Pause state', state));
});

/** POST /api/mentor/pause-suggestions/:menteeId/dismiss  { clanId? } */
const dismissSuggestion = catchAsync(async (req, res) => {
  const result = await pauseService.dismissSuggestion(req.user, req.params.menteeId, resolveClan(req));
  res.status(200).json(successResponse('Suggestion dismissed', result));
});

module.exports = { pause, resume, listPaused, listSuggestions, dismissSuggestion, menteeState, runInactivityCheck, selfPauseState };
