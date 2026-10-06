const express = require('express');
const router = express.Router();
const programController = require('../controllers/programController');
const { authenticate, authorize, optionalAuth } = require('../middlewares/auth');
const { validate, validateBody, validateParams } = require('../middlewares/validate');
const programValidation = require('../validations/programValidation');

/**
 * @route   GET /api/programs
 * @desc    Get all programs with filters
 * @access  Public (published), Admin/Creator (all)
 */
router.get(
  '/',
  optionalAuth,
  validate(programValidation.getProgramsFilters, 'query'),
  programController.getPrograms
);

/**
 * @route   GET /api/programs/:id/completion
 * @desc    Preview formal program close (certificate notices, canClose)
 * @access  Admin
 */
router.get(
  '/:id/completion',
  authenticate,
  validateParams(programValidation.idParams),
  programController.previewCompletion
);

/**
 * @route   POST /api/programs/:id/close
 * @desc    Formally close a program
 * @access  Admin
 */
router.post(
  '/:id/close',
  authenticate,
  validateParams(programValidation.idParams),
  validateBody(programValidation.closeProgram),
  programController.closeProgram
);

/**
 * @route   POST /api/programs/:id/reopen
 * @desc    Reopen a formally closed program for corrections
 * @access  Admin
 */
router.post(
  '/:id/reopen',
  authenticate,
  validateParams(programValidation.idParams),
  validateBody(programValidation.reopenProgram),
  programController.reopenProgram
);

/**
 * @route   GET /api/programs/:id/results
 * @desc    Final results for a closed program
 * @access  Admin, Mentor, Mentee (scoped in service)
 */
router.get(
  '/:id/results',
  authenticate,
  validateParams(programValidation.idParams),
  programController.getFinalResults
);

/**
 * @route   GET /api/programs/:id
 * @desc    Get program by ID
 * @access  Public (published), Admin/Creator (all)
 */
router.get(
  '/:id',
  optionalAuth,
  programController.getProgramById
);

/**
 * @route   GET /api/programs/:id/stats
 * @desc    Get program statistics
 * @access  Admin, Creator
 */
router.get(
  '/:id/stats',
  authenticate,
  programController.getProgramStats
);

/**
 * @route   GET /api/programs/:id/enrollments
 * @desc    Get program enrollments
 * @access  Admin, Creator
 */
router.get(
  '/:id/enrollments',
  authenticate,
  programController.getProgramEnrollments
);

/**
 * @route   POST /api/programs
 * @desc    Create a new program
 * @access  Admin, Mentor
 */
router.post(
  '/',
  authenticate,
  authorize('admin', 'mentor'),
  validate(programValidation.createProgram),
  programController.createProgram
);

/**
 * @route   POST /api/programs/:id/enroll
 * @desc    Enroll in a program
 * @access  Mentee
 */
router.post(
  '/:id/enroll',
  authenticate,
  authorize('mentee'),
  programController.enrollInProgram
);

/**
 * @route   POST /api/programs/:id/clone
 * @desc    Clone a program
 * @access  Admin, Mentor
 */
router.post(
  '/:id/clone',
  authenticate,
  authorize('admin', 'mentor'),
  validate(programValidation.cloneProgram),
  programController.cloneProgram
);

/**
 * @route   PUT /api/programs/:id
 * @desc    Update a program
 * @access  Admin, Creator
 */
router.put(
  '/:id',
  authenticate,
  validate(programValidation.updateProgram),
  programController.updateProgram
);

/**
 * @route   DELETE /api/programs/:id
 * @desc    Delete a program
 * @access  Admin, Creator
 */
router.delete(
  '/:id',
  authenticate,
  programController.deleteProgram
);

module.exports = router;
