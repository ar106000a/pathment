const { catchAsync } = require('../middlewares/errorHandler');
const { successResponse } = require('../utils/responses');
const promotionService = require('../services/promotionService');
const authzService = require('../services/authzService');
const { portalOf } = require('../middlewares/portalScope');

const list = catchAsync(async (req, res) => {
  const portal = portalOf(req);
  const candidates = await promotionService.list({
    actorId: req.user.id,
    isAdmin: await authzService.actsAsAdmin(req.user),
    activeClanId: portal.role === 'mentor' ? portal.clanId : null
  });
  res.status(200).json(successResponse('Promotion candidates retrieved', { candidates }));
});

const nominate = catchAsync(async (req, res) => {
  const portal = portalOf(req);
  const candidate = await promotionService.nominate(req.body.menteeId, req.user.id, {
    isAdmin: await authzService.actsAsAdmin(req.user),
    activeClanId: portal.role === 'mentor' ? portal.clanId : null
  });
  res.status(201).json(successResponse('Mentee nominated', { candidate }, 201));
});

const advance = catchAsync(async (req, res) => {
  const candidate = await promotionService.advance(req.params.id, req.body);
  res.status(200).json(successResponse('Candidate updated', { candidate }));
});

const promote = catchAsync(async (req, res) => {
  const candidate = await promotionService.promote(req.params.id, req.body);
  res.status(200).json(successResponse('Mentee promoted to co-mentor', { candidate }));
});

const decline = catchAsync(async (req, res) => {
  const candidate = await promotionService.decline(req.params.id, req.body);
  res.status(200).json(successResponse('Nomination declined', { candidate }));
});

const draft = catchAsync(async (req, res) => {
  const draft = await promotionService.aiDraft(req.params.id);
  res.status(200).json(successResponse('Interview draft generated', draft));
});

module.exports = { list, nominate, advance, promote, decline, draft };
