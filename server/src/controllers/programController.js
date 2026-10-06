const programService = require('../services/programService');
const programLifecycleService = require('../services/programLifecycleService');
const { successResponse, paginatedResponse } = require('../utils/responses');
const { catchAsync } = require('../middlewares/errorHandler');

class ProgramController {
  /**
   * Create a new program
   * @route POST /api/programs
   * @access Admin, Mentor
   */
  createProgram = catchAsync(async (req, res) => {
    const program = await programService.createProgram(req.body, req.user.id);

    res.status(201).json(successResponse(
      'Program created successfully',
      { program },
      201
    ));
  });

  /**
   * Get all programs with filters
   * @route GET /api/programs
   * @access Public (published), Admin/Creator (all)
   */
  getPrograms = catchAsync(async (req, res) => {
    const result = await programService.getPrograms(
      req.query,
      req.user?.id,
      req.user?.role
    );

    res.status(200).json(paginatedResponse(
      'Programs retrieved successfully',
      result.programs,
      result.pagination
    ));
  });

  /**
   * Get program by ID
   * @route GET /api/programs/:id
   * @access Public (published), Admin/Creator (all)
   */
  getProgramById = catchAsync(async (req, res) => {
    const program = await programService.getProgramById(
      req.params.id,
      req.user?.id,
      req.user?.role
    );

    res.status(200).json(successResponse(
      'Program retrieved successfully',
      { program }
    ));
  });

  /**
   * Update program
   * @route PUT /api/programs/:id
   * @access Admin, Creator
   */
  updateProgram = catchAsync(async (req, res) => {
    const program = await programService.updateProgram(
      req.params.id,
      req.body,
      req.user.id,
      (await req.loadWorkspaceRole())
    );

    res.status(200).json(successResponse(
      'Program updated successfully',
      { program }
    ));
  });

  /**
   * Delete program
   * @route DELETE /api/programs/:id
   * @access Admin, Creator
   */
  deleteProgram = catchAsync(async (req, res) => {
    const result = await programService.deleteProgram(
      req.params.id,
      req.user.id,
      (await req.loadWorkspaceRole())
    );

    res.status(200).json(successResponse(
      result.message
    ));
  });

  /**
   * Enroll in program
   * @route POST /api/programs/:id/enroll
   * @access Mentee
   */
  enrollInProgram = catchAsync(async (req, res) => {
    const enrollment = await programService.enrollMentee(
      req.params.id,
      req.user.id
    );

    res.status(201).json(successResponse(
      'Successfully enrolled in program',
      { enrollment },
      201
    ));
  });

  /**
   * Get program enrollments
   * @route GET /api/programs/:id/enrollments
   * @access Admin, Creator
   */
  getProgramEnrollments = catchAsync(async (req, res) => {
    const enrollments = await programService.getProgramEnrollments(
      req.params.id,
      req.user.id,
      (await req.loadWorkspaceRole())
    );

    res.status(200).json(successResponse(
      'Enrollments retrieved successfully',
      { enrollments }
    ));
  });

  /**
   * Clone program
   * @route POST /api/programs/:id/clone
   * @access Admin, Mentor
   */
  cloneProgram = catchAsync(async (req, res) => {
    const program = await programService.cloneProgram(
      req.params.id,
      req.user.id,
      req.body
    );

    res.status(201).json(successResponse(
      'Program cloned successfully',
      { program },
      201
    ));
  });

  /**
   * Get program statistics
   * @route GET /api/programs/:id/stats
   * @access Admin, Creator
   */
  getProgramStats = catchAsync(async (req, res) => {
    const stats = await programService.getProgramStats(
      req.params.id,
      req.user.id,
      (await req.loadWorkspaceRole())
    );

    res.status(200).json(successResponse(
      'Program statistics retrieved successfully',
      stats
    ));
  });

  /**
   * Preview formal program close (admin)
   * @route GET /api/programs/:id/completion
   * @access Admin
   */
  previewCompletion = catchAsync(async (req, res) => {
    const preview = await programLifecycleService.preview(req.params.id, req.user);
    res.status(200).json(successResponse('Program completion', preview));
  });

  /**
   * Formally close a program
   * @route POST /api/programs/:id/close
   * @access Admin
   */
  closeProgram = catchAsync(async (req, res) => {
    const program = await programLifecycleService.closeProgram(req.params.id, req.user, req.body || {});
    res.status(200).json(successResponse('Program closed', program));
  });

  /**
   * Reopen a formally closed program
   * @route POST /api/programs/:id/reopen
   * @access Admin
   */
  reopenProgram = catchAsync(async (req, res) => {
    const result = await programLifecycleService.reopenProgram(
      req.params.id,
      req.body.reason,
      req.user
    );
    res.status(200).json(successResponse('Program reopened', result));
  });

  /**
   * Final results after program close
   * @route GET /api/programs/:id/results
   * @access Admin, Mentor, Mentee (scoped in service)
   */
  getFinalResults = catchAsync(async (req, res) => {
    const results = await programLifecycleService.results(req.params.id, req.user);
    res.status(200).json(successResponse('Final results', results));
  });
}

module.exports = new ProgramController();
