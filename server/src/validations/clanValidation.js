const Joi = require('joi');

/**
 * Clan query/body validation. `listQuery` caps pagination server-side so a
 * crafted `?limit=10000` can never dump the whole table — it 400s instead.
 */
module.exports = {
  followUpQuery: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(50).default(20),
    programId: Joi.string().uuid().optional(),
    clanId: Joi.string().uuid().optional(),
    risk: Joi.string().valid('high', 'watch').optional(),
    search: Joi.string().trim().max(120).allow('').optional(),
  }),
  listQuery: Joi.object({
    programId: Joi.string().uuid().optional().allow(null, ''),
    status: Joi.string().valid('active', 'inactive', 'archived').optional().allow(null, ''),
    search: Joi.string().trim().max(120).optional().allow(''),
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).max(100).optional()
  }),

  idParams: Joi.object({
    id: Joi.string().uuid().required()
  }),

  // Admin only toggles permission — join window is set by the lead on generate/regenerate.
  publicJoinAccess: Joi.object({
    allowed: Joi.boolean().required()
  }),

  bulkPublicJoinAccess: Joi.object({
    clanIds: Joi.array().items(Joi.string().uuid()).min(1).max(100).required(),
    allowed: Joi.boolean().required()
  }),

  // Lead mentor: optional join window when generating / regenerating the link.
  publicJoinLinkBody: Joi.object({
    timezone: Joi.string().trim().max(64).allow('', null).optional(),
    startsDate: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null).optional(),
    startsTime: Joi.string().trim().max(16).allow('', null).optional(),
    endsDate: Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null).optional(),
    endsTime: Joi.string().trim().max(16).allow('', null).optional(),
    startsAt: Joi.alternatives().try(Joi.date().iso(), Joi.valid(null)).optional(),
    endsAt: Joi.alternatives().try(Joi.date().iso(), Joi.valid(null)).optional()
  }).default({}),

  joinRequestQuery: Joi.object({
    status: Joi.string().valid('pending', 'approved', 'rejected', 'cancelled').optional()
  }),

  joinRequestParams: Joi.object({
    id: Joi.string().uuid().required(),
    requestId: Joi.string().uuid().required()
  }),

  rejectJoinRequest: Joi.object({
    note: Joi.string().trim().max(2000).allow('', null).optional()
  }),

  publicJoinRequestBody: Joi.object({
    message: Joi.string().trim().max(2000).allow('', null).optional()
  }),

  standingMembersBody: Joi.object({
    menteeIds: Joi.array()
      .items(Joi.string().uuid())
      .min(1)
      .max(100)
      .required()
      .messages({
        'array.min': 'Select between 1 and 100 mentees',
        'array.max': 'Select between 1 and 100 mentees',
        'any.required': 'Select between 1 and 100 mentees'
      })
  }),

  standingActivityQuery: Joi.object({
    period: Joi.string().valid('30d', 'quarter', 'joined').default('30d')
  })
};
