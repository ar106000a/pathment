const { requireWorkspaceId, forEachWorkspace } = require('../utils/workspaceExecution');
const { Op } = require('sequelize');
const { models, sequelize } = require('../db');
const certificateService = require('../services/certificateService');
const { saveResults } = require('../services/certificateEvaluationStore');
const { enrichEvaluationResults } = require('../utils/certificateUtils');
const { emitToUser } = require('../socket');
const logger = require('../utils/logger');
const { runWithRequestContext } = require('../utils/auditContext');
const organizationService = require('../services/organizationService');

// ==================== WORKER CONFIGURATION ====================

const AI_EVAL_POLL_MS = Number(process.env.AI_EVAL_WORKER_POLL_MS) || 1000;

const MAX_AI_EVAL_ATTEMPTS = 3;
const BATCH_SIZE = 10;
const CONCURRENT_BATCHES = 4;

let aiEvalTimer = null;
let aiEvalRunning = false;

// ==================== AI EVALUATION WORKER LOGIC ====================

// Resolve ownership from persisted data, never the poller's ambient context or
// a default workspace. This scopes delivery only; queue isolation is separate.
async function emitEvaluationEvent(templateId, triggeredBy, event, payload) {
  try {
    const template = await models.CertificateTemplate.findByPk(templateId, {
      attributes: ['organizationId'], skipOrganizationScope: true,
    });
    if (!template?.organizationId) {
      logger.warn('[Certificate Worker] Skipping realtime event: template ownership unavailable');
      return;
    }
    await runWithRequestContext({ organizationId: template.organizationId, userId: triggeredBy }, async () => {
      await organizationService.assertMembership(triggeredBy, template.organizationId);
      emitToUser(triggeredBy, event, payload);
    });
  } catch (error) {
    // Notification failure must not retry already-persisted evaluation work.
    logger.warn(`[Certificate Worker] Skipping realtime event: ${error.message}`);
  }
}

async function checkRunCompletion(runId, triggeredBy, templateId) {
  const stats = await models.AIEvaluationQueue.findAll({
    where: { runId, templateId, triggeredBy },
    attributes: [
      'status',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count']
    ],
    group: ['status'],
    raw: true
  });

  const statusMap = {};
  let total = 0;
  for (const s of stats) {
    statusMap[s.status] = parseInt(s.count, 10);
    total += parseInt(s.count, 10);
  }

  const pending    = statusMap['pending']    || 0;
  const processing = statusMap['processing'] || 0;
  const completed  = statusMap['completed']  || 0;
  const failed     = statusMap['failed']     || 0;

  if (pending === 0 && processing === 0) {
    const finishedJobs = await models.AIEvaluationQueue.findAll({
      where: { runId, templateId, triggeredBy, status: 'completed' },
      attributes: ['menteeId', 'result', 'templateId', 'createdAt'],
      raw: true
    });

    const skipped = finishedJobs.filter(j => j.result?._skipped).length;
    const results = finishedJobs.filter(j => j.result && !j.result._skipped).map(j => ({ ...j.result, mentee_id: j.menteeId, evaluatedAt: j.createdAt }));
    const enrichedResults = await enrichEvaluationResults(results);

    if (templateId) {
      await saveResults(templateId, enrichedResults);

      // The round is NOT opened here. Grading and asking mentors to review are
      // two different decisions: an admin usually runs the AI more than once
      // while tuning the criteria, and mailing every mentor on each run would
      // train them to ignore the notification. The admin sends to clans
      // explicitly, with a deadline they choose — see
      // certificateVerificationService.sendToClans.
    }

    await emitEvaluationEvent(templateId, triggeredBy, 'ai-eval:complete', {
      runId,
      results: enrichedResults,
      ranAt: new Date().toISOString(),
      total,
      completed,
      failed,
      skipped
    });

    logger.info(`[Certificate Worker - AI Eval] Run ${runId} complete: ${completed} done, ${failed} failed out of ${total}`);
  }
}

async function processBatchJobs(batchJobs) {
  if (!batchJobs || batchJobs.length === 0) return;

  const templateId  = batchJobs[0].templateId;
  const triggeredBy = batchJobs[0].triggeredBy;
  const runId       = batchJobs[0].runId;
  let persisted = false;

  try {
    logger.info(`[Certificate Worker - AI Eval] Processing micro-batch of ${batchJobs.length} mentees for run ${runId}`);
    const template = await models.CertificateTemplate.findByPk(templateId);
    if (!template || template.organizationId !== requireWorkspaceId() ||
        batchJobs.some(job => job.organizationId !== requireWorkspaceId())) {
      throw new Error('Certificate jobs and template must belong to the current workspace');
    }
    await organizationService.assertMembership(triggeredBy, requireWorkspaceId());
    for (const job of batchJobs) await organizationService.assertMembership(job.menteeId, requireWorkspaceId());

    // A mentor/admin may finalize a decision while this job is waiting. Check
    // again immediately before the model call so the worker can never overwrite
    // a human-reviewed, approved, or issued certificate due to a race.
    const menteeIds = batchJobs.map((job) => job.menteeId);
    const [issuedRows, verificationRows, approvedClanRows] = await Promise.all([
      models.CertificateInstance.findAll({ where: { templateId, menteeId: { [Op.in]: menteeIds } }, attributes: ['menteeId'], raw: true }),
      models.CertificateVerification.findAll({
        where: { templateId, menteeId: { [Op.in]: menteeIds } },
        attributes: ['menteeId', 'clanId', 'status', 'stage'], raw: true
      }),
      models.CertificateClanApproval.findAll({ where: { templateId }, attributes: ['clanId'], raw: true })
    ]);
    const approvedClanIds = new Set(approvedClanRows.map((row) => row.clanId));
    const finalizedIds = new Set([
      ...issuedRows.map((row) => row.menteeId),
      ...verificationRows
        .filter((row) => row.status === 'verified' || row.stage === 'admin_approved' || approvedClanIds.has(row.clanId))
        .map((row) => row.menteeId)
    ]);
    for (const job of batchJobs) {
      if (!finalizedIds.has(job.menteeId)) continue;
      job.status = 'completed';
      job.result = { _skipped: true, mentee_id: job.menteeId, reason: 'Human-reviewed, approved, or issued before AI processing.' };
      job.error = null;
    }

    const evaluationJobs = batchJobs.filter((job) => !finalizedIds.has(job.menteeId));
    const batchItems = evaluationJobs.map(j => ({
      menteeId:      j.menteeId,
      menteePayload: j.menteePayload,
      preCheck:      j.preCheck
    }));

    const batchResults = evaluationJobs.length
      ? await certificateService.evaluateBatchMentees(template, batchItems, triggeredBy)
      : [];
    const resultMap = new Map(batchResults.map(r => [r.menteeId, r.result]));

    for (const job of batchJobs) {
      if (finalizedIds.has(job.menteeId)) continue;
      const result = resultMap.get(job.menteeId) || certificateService.buildFallbackResult(job.menteePayload, job.preCheck);
      job.status = result._failed ? 'failed' : 'completed';
      job.result = result;
      job.error  = null;
    }

    // Persist each completed batch before reporting progress, including runs
    // whose remaining batches fail or whose worker is restarted.
    const persistedResults = await enrichEvaluationResults(batchJobs.filter((job) => !job.result?._skipped).map(job => ({
      ...job.result, mentee_id: job.menteeId, evaluatedAt: job.createdAt
    })));
    await sequelize.transaction(async transaction => {
      await saveResults(templateId, persistedResults, { transaction });
      for (const job of batchJobs) await job.save({ transaction });
    });
    persisted = true;

    const [{ completedCount, totalCount }] = await sequelize.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('completed', 'failed')) AS "completedCount", COUNT(*) AS "totalCount" FROM ai_evaluation_queue WHERE organization_id = :organizationId AND run_id = :runId AND template_id = :templateId AND triggered_by = :triggeredBy`,
      { replacements: { runId, templateId, triggeredBy, organizationId: requireWorkspaceId() }, type: sequelize.QueryTypes.SELECT }
    );

    const mentees = await models.User.findAll({
      where: { id: { [Op.in]: menteeIds } },
      attributes: ['id', 'firstName', 'lastName', 'email'],
      raw: true
    });
    const menteeMap = new Map(mentees.map(m => [m.id, m]));

    for (const job of batchJobs) {
      const mentee = menteeMap.get(job.menteeId);
      const result = job.result;

      await emitEvaluationEvent(job.templateId, job.triggeredBy, 'ai-eval:progress', {
        runId,
        menteeId: job.menteeId,
        result: {
          ...result,
          firstName: mentee?.firstName ?? '',
          lastName:  mentee?.lastName  ?? '',
          email:     mentee?.email     ?? ''
        },
        completed: completedCount,
        total:     totalCount
      });
    }

    logger.info(`[Certificate Worker - AI Eval] Micro-batch completed (${completedCount}/${totalCount})`);
    await checkRunCompletion(runId, triggeredBy, templateId);
  } catch (batchError) {
    logger.error(`[Certificate Worker - AI Eval] Micro-batch failed: ${batchError.stack || batchError.message}`);
    // A progress/notification failure after commit must not undo completed jobs.
    // Polling can still read their saved results.
    if (persisted) return;

    let errorCompletedCount = 0;
    let errorTotalCount = 0;
    try {
      const [counts] = await sequelize.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('completed', 'failed')) AS "completedCount",
           COUNT(*) AS "totalCount"
         FROM ai_evaluation_queue WHERE organization_id = :organizationId AND run_id = :runId AND template_id = :templateId AND triggered_by = :triggeredBy`,
        { replacements: { runId, templateId, triggeredBy, organizationId: requireWorkspaceId() }, type: sequelize.QueryTypes.SELECT }
      );
      errorCompletedCount = Number(counts?.completedCount ?? 0);
      errorTotalCount     = Number(counts?.totalCount     ?? 0);
    } catch (_) { }

    for (const job of batchJobs) {
      job.status = job.attempts >= MAX_AI_EVAL_ATTEMPTS ? 'failed' : 'pending';
      job.error  = batchError.message;
      await job.save();

      if (job.status === 'failed') {
        const fallbackResult = certificateService.buildFallbackResult(
          job.menteePayload,
          job.preCheck
        );

        const mentee = await models.User.findByPk(job.menteeId, {
          attributes: ['id', 'firstName', 'lastName', 'email'],
          raw: true
        });

        await emitEvaluationEvent(job.templateId, job.triggeredBy, 'ai-eval:progress', {
          runId:    job.runId,
          menteeId: job.menteeId,
          result: {
            ...fallbackResult,
            firstName: mentee?.firstName ?? '',
            lastName:  mentee?.lastName  ?? '',
            email:     mentee?.email     ?? '',
            _failed: true
          },
          completed: errorCompletedCount,
          total:     errorTotalCount
        });
      }
    }
  }
}

async function tickAIEval() {
  if (aiEvalRunning) return;
  aiEvalRunning = true;

  try {
    await forEachWorkspace(async () => {
    const allBatchJobs = [];

    for (let b = 0; b < CONCURRENT_BATCHES; b++) {
      const batchJobs = await sequelize.transaction(async (t) => {
        const nextTarget = await models.AIEvaluationQueue.findOne({
          where: {
            [Op.or]: [
              { status: 'pending' },
              {
                status:   'processing',
                lockedAt: { [Op.lt]: new Date(Date.now() - 45000) }
              }
            ],
            attempts: { [Op.lt]: MAX_AI_EVAL_ATTEMPTS }
          },
          order:      [['createdAt', 'ASC']],
          attributes: ['runId', 'templateId', 'triggeredBy'],
          raw: true,
          transaction: t
        });

        if (!nextTarget) return [];

        const pendingJobs = await models.AIEvaluationQueue.findAll({
          where: {
            runId: nextTarget.runId,
            templateId: nextTarget.templateId,
            triggeredBy: nextTarget.triggeredBy,
            [Op.or]: [
              { status: 'pending' },
              {
                status:   'processing',
                lockedAt: { [Op.lt]: new Date(Date.now() - 45000) }
              }
            ],
            attempts: { [Op.lt]: MAX_AI_EVAL_ATTEMPTS }
          },
          order:       [['createdAt', 'ASC']],
          limit:       BATCH_SIZE,
          lock:        { level: t.LOCK.UPDATE, of: models.AIEvaluationQueue },
          skipLocked:  true,
          transaction: t
        });

        if (!pendingJobs.length) return [];

        const now = new Date();
        for (const j of pendingJobs) {
          j.status   = 'processing';
          j.lockedAt = now;
          j.attempts += 1;
          await j.save({ transaction: t });
        }

        return pendingJobs;
      });

      if (batchJobs && batchJobs.length > 0) {
        allBatchJobs.push(batchJobs);
      } else {
        break;
      }
    }

    if (allBatchJobs.length > 0) {
      await Promise.allSettled(allBatchJobs.map(jobs => processBatchJobs(jobs)));
    }
    });
  } catch (err) {
    logger.error(`[Certificate Worker - AI Eval] Tick error: ${err.message}`);
  } finally {
    aiEvalRunning = false;
  }
}

// ==================== WORKER CONTROLS ====================

function start() {
  if (!aiEvalTimer && process.env.AI_EVAL_WORKER_DISABLED !== 'true') {
    aiEvalTimer = setInterval(tickAIEval, AI_EVAL_POLL_MS);
    if (aiEvalTimer.unref) aiEvalTimer.unref();
    logger.info(`Certificate AI Evaluation worker started (polling every ${AI_EVAL_POLL_MS}ms)`);
  }
}

async function stop() {
  if (aiEvalTimer) {
    clearInterval(aiEvalTimer);
    aiEvalTimer = null;
  }

  let waitCount = 0;
  while (aiEvalRunning && waitCount < 10) {
    await new Promise(r => setTimeout(r, 500));
    waitCount++;
  }
  logger.info('Certificate worker (AI Eval) stopped gracefully');
}

module.exports = { start, stop, tickAIEval };
