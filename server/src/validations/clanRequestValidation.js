const Joi = require('joi');

/**
 * Standing-clan request payloads for /api/clan-requests/standing*.
 * Move/cross-clan routes keep service-level checks (existing pattern).
 */
module.exports = {
  idParams: Joi.object({
    id: Joi.string().uuid().required()
  }),

  standingRequest: Joi.object({
    programId: Joi.string().uuid().required().messages({
      'any.required': 'Choose a completed program',
      'string.guid': 'Choose a completed program'
    }),
    name: Joi.string().trim().min(1).max(150).required().messages({
      'string.empty': 'Choose a clan name of 1–150 characters',
      'string.max': 'Choose a clan name of 1–150 characters',
      'any.required': 'Choose a clan name of 1–150 characters'
    }),
    description: Joi.string().trim().max(4000).allow('', null).optional()
  }),

  standingDecision: Joi.object({
    decision: Joi.string().valid('approved', 'rejected').required().messages({
      'any.only': 'Choose approve or reject',
      'any.required': 'Choose approve or reject'
    }),
    note: Joi.when('decision', {
      is: 'rejected',
      then: Joi.string().trim().min(1).max(4000).required().messages({
        'string.empty': 'Explain the rejection so the mentor knows why',
        'any.required': 'Explain the rejection so the mentor knows why'
      }),
      otherwise: Joi.string().trim().max(4000).allow('', null).optional()
    })
  })
};
