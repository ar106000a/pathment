const { Op } = require('sequelize');
const { models, sequelize } = require('../db');
const { NotFoundError, ValidationError, ForbiddenError } = require('../utils/errors/errorTypes');
const authzService = require('./authzService');
const notificationOrchestrator = require('./notificationOrchestrator');
const { NOTIFICATION_EVENTS } = require('../config/notificationMatrix');
const { PERMISSIONS } = require('../config/permissions');
const { VISIBLE_MEMBERSHIP_STATUSES } = require('../config/membership');
const logger = require('../utils/logger');

/**
 * Mentor sign-off on AI-assigned certificate tiers.
 *
 * The AI grades from the record: points, completion, on-time rate, blockers,
 * attendance. It cannot know that somebody carried the clan through a bad
 * month, or that a strong-looking score came from work a mentor had already
 * flagged. So a human who actually knows the person confirms the grade — or
 * changes it — before anything is issued.
 *
 * The shape of the round:
 *
 *   open()      after an AI run, one pending row per graded mentee, routed to
 *               the mentors of that mentee's clan, with a deadline
 *   verify()    the mentor confirms or overrides; an override keeps the AI's
 *               original tier beside the new one so the change stays visible
 *   summary()   what the admin sees: which clans are done, which are overdue
 *
 * The deadline is a NUDGE, never a gate. Nothing issues on its own when it
 * passes and the admin is never blocked — they are told, and they decide. A
 * workflow that silently issued the wrong grade because nobody looked would be
 * worse than one that issues late.
 */
class CertificateVerificationService {
  /** Clan roles that can sign off on a clan's certificates. */
  static MENTOR_ROLES = ['lead_mentor', 'co_mentor'];

  /**
   * Open (or refresh) the review round for a template's AI results.
   *
   * Re-running the AI updates each person's row in place rather than stacking a
   * second opinion beside the first — but a row the mentor has ALREADY verified
   * keeps their decision. Re-grading must not quietly undo a human's sign-off.
   */
  async open(templateId, results, { deadline = null, notify = true } = {}) {
    if (!Array.isArray(results) || results.length === 0) return { created: 0, updated: 0, notified: 0 };

    const { template, created, updated } = await sequelize.transaction(async transaction => {
      const template = await models.CertificateTemplate.findByPk(templateId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!template) throw new NotFoundError('Certificate template not found');

      if (deadline) {
        template.verificationDeadline = deadline;
        await template.save({ transaction });
      }

      const menteeIds = [...new Set(results.map((r) => r.mentee_id || r.id).filter(Boolean))];
      const clanByMentee = await this._clanOfMentees(menteeIds, template.programId);
      const issued = await models.CertificateInstance.findAll({
        where: { templateId, menteeId: { [Op.in]: menteeIds } }, attributes: ['menteeId'], transaction
      });
      const issuedIds = new Set(issued.map(instance => instance.menteeId));

      const approved = new Set((await models.CertificateClanApproval.findAll({ where: { templateId }, attributes: ['clanId'], transaction })).map(row => row.clanId));
      let created = 0;
      let updated = 0;
      for (const result of results) {
        const menteeId = result.mentee_id || result.id;
        if (!menteeId || issuedIds.has(menteeId) || result._failed || result.decision === 'undecided') continue;

        const aiDecision = result.decision === 'no_certificate' ? 'no_certificate' : (result.certificate_tier ? 'award' : 'undecided');
        if (aiDecision === 'undecided') continue;
        const aiTier = aiDecision === 'award' ? result.certificate_tier : null;
        // Keep the AI recommendation as the baseline, but send the admin's
        // selected badge as the pending grade. Previously this selection was
        // discarded and the mentor received the AI's "No certificate" result.
        const adminAssignment = result.admin_assignment || null;
        const proposedDecision = adminAssignment?.decision === 'no_certificate'
          ? 'no_certificate'
          : adminAssignment?.finalTier ? 'award' : aiDecision;
        const proposedTier = proposedDecision === 'award'
          ? (adminAssignment?.finalTier || aiTier)
          : null;
        if (adminAssignment && proposedDecision === 'award') this._assertTierExists(template, proposedTier);
        const proposedOverride = proposedDecision !== aiDecision || proposedTier !== aiTier;
        const proposedReason = proposedOverride
          ? (String(adminAssignment?.reason || '').trim() || 'Assigned by an admin before mentor review')
          : (aiDecision === 'no_certificate' ? result.reasoning : null);
        const aiMatchScore = result.match_score != null && Number.isFinite(Number(result.match_score)) ? Number(result.match_score) : null;
        const existing = await models.CertificateVerification.findOne({ where: { templateId, menteeId }, transaction });

        // Prefer clan stamped on the AI result (Standee runs) over cohort first-membership.
        const clanId = result.clan_id || result.clanId || clanByMentee.get(menteeId);
        if (approved.has(clanId)) continue;
        const pendingGradeChanged = !existing || (existing.status !== 'verified' &&
          (existing.aiTier !== aiTier || existing.aiDecision !== aiDecision));
        if (pendingGradeChanged && clanId) {
          await models.CertificateClanApproval.destroy({ where: { templateId, clanId }, transaction });
        }
        if (!existing) {
          await models.CertificateVerification.create({
            templateId,
            menteeId,
            clanId: clanId || null,
            aiTier,
            aiDecision,
            decision: proposedDecision,
            overrideReason: proposedReason,
            aiMatchScore,
            finalTier: proposedTier,
            overridden: proposedOverride,
            status: 'pending',
            stage: 'awaiting_mentor'
          }, { transaction });
          created += 1;
          continue;
        }

        // Re-sending must preserve the reviewed decision and its original baseline.
        existing.clanId = clanByMentee.get(menteeId) || existing.clanId;
        if (existing.status !== 'verified') {
          existing.aiTier = aiTier;
          existing.aiDecision = aiDecision;
          existing.aiMatchScore = aiMatchScore;
          existing.finalTier = proposedTier;
          existing.decision = proposedDecision;
          existing.overrideReason = proposedReason;
          existing.overridden = proposedOverride;
        }
        await existing.save({ transaction });
        updated += 1;
      }
      return { template, created, updated };
    });

    const notified = notify ? await this._notifyMentors(template) : 0;
    return { created, updated, notified };
  }

  /**
   * The admin hands a template's grades to the clans that must sign them off.
   *
   * Explicit rather than automatic. Grading and asking people to review are two
   * different decisions: an admin often runs the AI more than once while tuning
   * the criteria, and mailing every mentor on each run would train them to
   * ignore the notification. So the round opens when the admin says so, and
   * they set the deadline when they know their own cycle.
   *
   * Sending again is a reminder, not a reset — already-signed-off rows keep
   * their decision (see `open`).
   */
  async sendToClans(templateId, { deadline = null, clanIds = null, menteeIds = null, assignments = null } = {}, user) {
    const template = await models.CertificateTemplate.findByPk(templateId);
    if (!template) throw new NotFoundError('Certificate template not found');

    const results = Array.isArray(template.aiEvaluation?.results) ? template.aiEvaluation.results : [];
    if (!results.length) {
      throw new ValidationError('Run the AI evaluation first — there are no grades to review yet.');
    }

    // An admin can send to a subset of clans; everyone else is confined to
    // the clans they may sign off in anyway.
    let scopedResults = results;
    if (Array.isArray(menteeIds)) {
      const selected = new Set(menteeIds.filter((value) => typeof value === 'string' && value.length > 0));
      scopedResults = scopedResults.filter((result) => selected.has(result.mentee_id || result.id));
      if (!scopedResults.length) {
        throw new ValidationError('Run AI evaluation for the selected mentees before sending them for review.');
      }
    }
    if (Array.isArray(assignments) && assignments.length) {
      if (!(await authzService.hasAdminAccess(user))) {
        throw new ForbiddenError('Only an admin can assign badges while sending a review round.');
      }
      const criteriaIds = new Set((template.criteria || []).map((item) => item.id));
      const byMentee = new Map();
      for (const assignment of assignments) {
        if (!assignment || typeof assignment.menteeId !== 'string') continue;
        const decision = assignment.decision === 'no_certificate' ? 'no_certificate' : 'award';
        const finalTier = decision === 'award' ? assignment.finalTier : null;
        if (decision === 'award' && (!finalTier || !criteriaIds.has(finalTier))) {
          throw new ValidationError('One of the selected admin badge assignments is not part of this certificate template.');
        }
        byMentee.set(assignment.menteeId, {
          decision,
          finalTier,
          reason: String(assignment.reason || '').trim() || null
        });
      }
      scopedResults = scopedResults.map((result) => {
        const assignment = byMentee.get(result.mentee_id || result.id);
        return assignment ? { ...result, admin_assignment: assignment } : result;
      });
    }
    if (Array.isArray(clanIds) && clanIds.length) {
      const scopedMenteeIds = scopedResults.map((r) => r.mentee_id || r.id).filter(Boolean);
      const clanOf = await this._clanOfMentees(scopedMenteeIds, template.programId);
      const wanted = new Set(clanIds);
      scopedResults = scopedResults.filter((r) => wanted.has(clanOf.get(r.mentee_id || r.id)));
    }

    const round = await this.open(templateId, scopedResults, { deadline, notify: true });
    logger.info('[certificateVerification] round sent to clans', {
      templateId, by: user?.id, ...round
    });
    return round;
  }

  /**
   * The mentees this user must sign off on for a template, with what the AI
   * proposed and what has been decided so far.
   */
  async listForReviewer(templateId, user, { clanId = null } = {}) {
    const template = await models.CertificateTemplate.findByPk(templateId);
    if (!template) throw new NotFoundError('Certificate template not found');

    const where = { templateId };
    // The roster that leaked: an admin on a MENTOR screen was handed every clan.
    const isAdmin = await authzService.actsAsAdmin(user);
    if (!isAdmin) {
      const clanIds = await this._reviewableClanIds(user, template.programId, clanId);
      if (!clanIds.length) return { template: this._templateSummary(template), rows: [], clans: [] };
      where.clanId = { [Op.in]: clanIds };
    } else if (clanId) {
      where.clanId = clanId;
    }

    const historicalRows = await models.CertificateVerification.findAll({
      where,
      include: [
        { model: models.User, as: 'mentee', attributes: ['id', 'firstName', 'lastName', 'email', 'profilePictureUrl'] },
        { model: models.User, as: 'verifier', attributes: ['id', 'firstName', 'lastName'], required: false },
        { model: models.Clan, as: 'clan', attributes: ['id', 'name'], required: false }
      ],
      order: [['createdAt', 'ASC']]
    });

    const rows = await this._activeReviewRows(historicalRows, template.programId);

    // Whether each clan in this queue has been released, so the mentor's screen
    // can say "signed off, waiting on the admin" rather than leaving them
    // wondering why there is no send button.
    const approved = await this.approvedClanIds(templateId);
    const clanIdsInQueue = [...new Set(rows.map((r) => r.clanId).filter(Boolean))];
    const clanState = clanIdsInQueue.map((id) => {
      const forClan = rows.filter((r) => r.clanId === id);
      const pending = forClan.filter((r) => r.status !== 'verified').length;
      return {
        clanId: id,
        clanName: forClan[0]?.clan?.name || null,
        total: forClan.length,
        pending,
        verified: forClan.filter((r) => r.status === 'verified').length,
        overridden: forClan.filter((r) => r.overridden).length,
        noCertificate: forClan.filter((r) => r.decision === 'no_certificate').length,
        complete: pending === 0,
        approved: approved.has(id),
        canSend: approved.has(id)
      };
    });

    // Open threads travel with the rows, so the roster can show what is under
    // query or awaiting a decision without a request per mentee.
    const { questioned, changeRequested } = await this.openThreads(templateId);

    return {
      template: this._templateSummary(template),
      rows: rows.map((r) => ({
        ...this._serialize(r),
        hasOpenQuestion: questioned.has(r.menteeId),
        hasChangeRequest: changeRequested.has(r.menteeId)
      })),
      clans: clanState
    };
  }

  /**
   * Record an award or explicit No certificate decision for one mentee.
   * A No certificate decision always needs a reason and never uses a tier.
   *
   * `finalTier` omitted means "the AI had it right". Supplying a different tier
   * is an override: the AI's tier is preserved alongside it so the admin can
   * see what was changed, by whom and why.
   */
  async verify(templateId, menteeId, { decision, finalTier, reason = null, criteriaChecks } = {}, user, { notify = true, transaction: existingTransaction } = {}) {
    const execute = async transaction => {
      // Issuance, review, and approval use the same lock so a changed decision
      // cannot race with sending a certificate under an older approval.
      const template = await models.CertificateTemplate.findByPk(templateId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!template) throw new NotFoundError('Certificate template not found');
      const row = await models.CertificateVerification.findOne({ where: { templateId, menteeId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!row) throw new NotFoundError('There is nothing to verify for this mentee');
      await this._assertCanReview(user, row);
      const actingAsAdmin = await authzService.actsAsAdmin(user);
      const aiDecision = row.aiDecision === 'no_certificate' ? 'no_certificate' : (row.aiTier ? 'award' : 'undecided');
      const nextDecision = decision ?? (finalTier ? 'award' : aiDecision);
      if (!['award', 'no_certificate'].includes(nextDecision)) throw new ValidationError('Choose a certificate or No certificate before verifying.');
      if (nextDecision === 'no_certificate' && finalTier) {
        throw new ValidationError('No certificate cannot have a certificate tier.');
      }
      const tier = nextDecision === 'award' ? (finalTier ?? row.aiTier) : null;
      if (nextDecision === 'award') this._assertTierExists(template, tier);
      const tierConfig = nextDecision === 'award'
        ? (template.criteria || []).find((item) => item.id === tier)
        : null;
      const requiredChecks = Array.isArray(tierConfig?.reviewChecklist)
        ? tierConfig.reviewChecklist.map((item) => String(item).trim()).filter(Boolean)
        : [];
      const submittedChecks = Array.isArray(criteriaChecks)
        ? criteriaChecks.map((item) => String(item).trim()).filter(Boolean)
        : (row.criteriaChecks || []);
      const checked = new Set(submittedChecks);
      const missingChecks = requiredChecks.filter((item) => !checked.has(item));
      if (missingChecks.length) {
        throw new ValidationError(`Confirm every checklist item for ${tierConfig?.name || tier}: ${missingChecks.join('; ')}`);
      }
      const overridden = nextDecision !== aiDecision || tier !== row.aiTier;
      const previousDecision = row.decision === 'no_certificate' ? row.decision : (row.finalTier ? 'award' : 'undecided');
      const changed = previousDecision !== nextDecision || row.finalTier !== tier;
      const reasonRequired = overridden || nextDecision === 'no_certificate' || (row.status === 'verified' && changed);
      const explanation = String(reason || '').trim();
      if (reasonRequired && !explanation) {
        throw new ValidationError('A reason is required: tell us why you are changing this grade or selecting No certificate.');
      }
      if (changed && row.stage === 'admin_approved' && !actingAsAdmin) {
        throw new ForbiddenError('This certificate has been approved. Request a change and an admin will decide.');
      }
      if (changed && await models.CertificateInstance.count({ where: { templateId, menteeId }, transaction })) {
        if (!actingAsAdmin) {
          throw new ForbiddenError('This certificate has already been sent. Request a revoke and change, and an admin will decide.');
        }
        throw new ValidationError('This certificate has already been sent. Revoke it before changing the decision.');
      }
      const decisionReason = reasonRequired ? explanation : null;
      const needsApproval = changed || row.status !== 'verified' || row.overrideReason !== decisionReason;
      if (needsApproval) {
        row.decisionHistory = [...(row.decisionHistory || []), {
          at: new Date().toISOString(), by: user.id, byName: [user.firstName, user.lastName].filter(Boolean).join(' '),
          from: { decision: previousDecision, tier: row.finalTier },
          to: { decision: nextDecision, tier }, reason: decisionReason
        }];
        // Admin edits retain the release and its mentor lock.
      }
      row.decision = nextDecision;
      row.finalTier = tier;
      row.overridden = overridden;
      row.overrideReason = decisionReason;
      row.criteriaChecks = nextDecision === 'award' ? requiredChecks : [];
      row.status = 'verified';
      // An admin's sign-off is also the approval; a mentor's is only the check.
      // Writing one 'verified' for both is what left an admin unable to tell
      // their own four hundred decisions from everybody else's.
      //
      // The stage does not go BACKWARDS on an unchanged grade. A mentor working
      // through their queue after the admin had already approved a row used to
      // rewrite it to 'mentor_verified', quietly un-approving work the admin had
      // done — so an admin who approved a batch came back to find only some of
      // it still showing as theirs. A mentor re-confirming the same grade leaves
      // the approval standing; a mentor who actually CHANGES it drops the row
      // back, because the admin approved the old grade, not the new one.
      // `actsAsAdmin`, not `hasAdminAccess`: the stage records which hat was
      // worn. An admin signing off on a MENTOR screen is doing a mentor's
      // review — the button there says "sign off", and the record must agree
      // with the button.
      if (actingAsAdmin) {
        row.stage = 'admin_approved';
      } else if (row.stage === 'admin_approved' && !changed) {
        row.stage = 'admin_approved';
      } else {
        row.stage = 'mentor_verified';
      }
      row.verifiedBy = user.id;
      row.verifiedAt = new Date();
      await row.save({ transaction });
      return row;
    };
    const saved = existingTransaction ? await execute(existingTransaction) : await sequelize.transaction(execute);
    if (notify) await this._notifyAdminsIfClanComplete(templateId, saved.clanId, user);
    return this._serialize(saved);
  }

  /**
   * Sign off several at once — "these all look right" is the common case.
   *
   * The completion notice is held until the whole batch has landed and then
   * sent once per clan. Firing it inside each row meant a mentor confirming
   * twenty grades in one press sent the admin twenty copies of the same
   * "this clan is done" message.
   */
  async verifyMany(templateId, decisions, user) {
    if (!Array.isArray(decisions) || !decisions.length) {
      throw new ValidationError('Nothing to verify');
    }
    const out = await sequelize.transaction(async transaction => {
      const rows = [];
      for (const decision of decisions) {
        rows.push(await this.verify(templateId, decision.menteeId,
          { decision: decision.decision, finalTier: decision.finalTier, reason: decision.reason, criteriaChecks: decision.criteriaChecks },
          user, { notify: false, transaction }));
      }
      return rows;
    });
    for (const clanId of new Set(out.map((r) => r.clanId).filter(Boolean))) {
      await this._notifyAdminsIfClanComplete(templateId, clanId, user);
    }
    return { verified: out.length, rows: out };
  }

  /**
   * What the admin sees before issuing: per-clan progress, overrides, and
   * whether the deadline has passed. Never blocks — it informs.
   */
  async summary(templateId) {
    const template = await models.CertificateTemplate.findByPk(templateId);
    if (!template) throw new NotFoundError('Certificate template not found');

    const [historicalRows, approvedClans] = await Promise.all([
      models.CertificateVerification.findAll({
        where: { templateId },
        include: [{ model: models.Clan, as: 'clan', attributes: ['id', 'name'], required: false }]
      }),
      this.approvedClanIds(templateId)
    ]);

    const rows = await this._activeReviewRows(historicalRows, template.programId);

    const byClan = new Map();
    for (const row of rows) {
      const key = row.clanId || 'unassigned';
      if (!byClan.has(key)) {
        byClan.set(key, {
          clanId: row.clanId || null,
          clanName: row.clan?.name || 'No clan',
          total: 0, verified: 0, pending: 0, overridden: 0, noCertificate: 0,
          mentorVerified: 0, adminApproved: 0
        });
      }
      const bucket = byClan.get(key);
      bucket.total += 1;
      if (row.status === 'verified') bucket.verified += 1; else bucket.pending += 1;
      if (row.stage === 'admin_approved') bucket.adminApproved += 1;
      else if (row.stage === 'mentor_verified') bucket.mentorVerified += 1;
      if (row.overridden) bucket.overridden += 1;
      if (row.decision === 'no_certificate') bucket.noCertificate += 1;
    }

    // One read for all open-thread counts and per-clan change-request badges.
    const openThreads = await this.openThreads(templateId);
    const clans = [...byClan.values()].map((c) => ({
      ...c,
      changeRequests: rows.filter((row) => row.clanId === c.clanId && openThreads.changeRequested.has(row.menteeId)).length,
      complete: c.pending === 0,
      // Released by the admin — this is what lets the clan's mentors send.
      approved: Boolean(c.clanId && approvedClans.has(c.clanId)),
      // Verified but not released: the admin's move.
      readyToApprove: c.pending === 0 && !(c.clanId && approvedClans.has(c.clanId))
    }));
    const deadline = template.verificationDeadline || null;
    return {
      deadline,
      overdue: Boolean(deadline && new Date(deadline) < new Date() && clans.some((c) => !c.complete)),
      total: rows.length,
      verified: rows.filter((r) => r.status === 'verified').length,
      pending: rows.filter((r) => r.status !== 'verified').length,
      overridden: rows.filter((r) => r.overridden).length,
      noCertificate: rows.filter(r => r.decision === 'no_certificate').length,
      allVerified: rows.length > 0 && rows.every((r) => r.status === 'verified'),
      // The split an admin actually needs: what they have approved themselves
      // against what is still only a mentor's check waiting on them.
      mentorVerified: rows.filter((r) => r.stage === 'mentor_verified').length,
      adminApproved: rows.filter((r) => r.stage === 'admin_approved').length,
      /** Grades an admin has queried and the mentor has not yet answered. */
      questioned: openThreads.questioned.size,
      /** Approved grades a mentor has asked to change, awaiting an admin. */
      changeRequested: openThreads.changeRequested.size,
      /** Clans whose mentor has asked for the certificate report. */
      reportRequests: openThreads.reportRequests.length,
      approvedClans: clans.filter((c) => c.approved).length,
      awaitingApproval: clans.filter((c) => c.readyToApprove).length,
      clans: clans.sort((a, b) => a.clanName.localeCompare(b.clanName))
    };
  }

  /**
   * The admin releases a clan: its certificates may now be sent.
   *
   * Separate from verification on purpose. A clan finishing its review says the
   * grades are right; it does not say the cohort is ready to receive anything —
   * the admin may be waiting on a ceremony date, a sponsor, or the other clans.
   * So mentors can review the moment they are asked, and can only SEND once
   * this has happened.
   *
   * An admin may release a clan whose mentors have not finished. They are never
   * blocked — but it is recorded as such, because "we shipped before anyone
   * checked" is a thing somebody will need to know later.
   */
  async approveClan(templateId, clanId, { note = null } = {}, user) {
    const template = await models.CertificateTemplate.findByPk(templateId);
    if (!template) throw new NotFoundError('Certificate template not found');
    if (!clanId) throw new ValidationError('A clan is required');

    if (!(await authzService.hasAdminAccess(user))) {
      throw new ForbiddenError('Only an admin can release a clan for issuing');
    }

    const { approval, pending } = await sequelize.transaction(async transaction => {
      await models.CertificateTemplate.findByPk(templateId, { transaction, lock: transaction.LOCK.UPDATE });
      const clanRows = await models.CertificateVerification.findAll({ where: { templateId, clanId }, transaction });
      const activeRows = await this._activeReviewRows(clanRows, template.programId, { transaction });
      const pending = activeRows.filter((row) => row.status === 'pending').length;

      const [approval] = await models.CertificateClanApproval.findOrCreate({
        where: { templateId, clanId },
        transaction,
        defaults: {
          templateId,
          clanId,
          approvedBy: user.id,
          approvedAt: new Date(),
          approvedBeforeVerified: pending > 0,
          note
        }
      });
      // Releasing the clan is the admin's approval of what is in it. Without
      // this the roster still said "mentor verified" on rows the admin had
      // already cleared to send, which is the question they came to answer.
      const activeIds = activeRows.map((row) => row.id);
      if (activeIds.length) {
        await models.CertificateVerification.update(
          { stage: 'admin_approved', status: 'verified', verifiedBy: user.id, verifiedAt: new Date() },
          { where: { id: { [Op.in]: activeIds } }, transaction }
        );
      }
      return { approval, pending };
    });

    await this._notifyClanApproved(templateId, clanId);
    return {
      clanId,
      approvedAt: approval.approvedAt,
      approvedBeforeVerified: approval.approvedBeforeVerified,
      outstandingAtApproval: pending
    };
  }

  /** Take a clan's release back — nothing more can be sent until it returns. */
  async revokeClanApproval(templateId, clanId, user) {
    if (!(await authzService.hasAdminAccess(user))) {
      throw new ForbiddenError('Only an admin can withdraw a clan\'s approval');
    }
    const removed = await models.CertificateClanApproval.destroy({ where: { templateId, clanId } });
    return { revoked: removed > 0 };
  }

  /** The clans an admin has released for this template. */
  async approvedClanIds(templateId) {
    const rows = await models.CertificateClanApproval.findAll({
      where: { templateId }, attributes: ['clanId'], raw: true
    });
    return new Set(rows.map((r) => r.clanId));
  }

  /**
   * May this user send certificates to these people right now?
   *
   * Two separate gates, and they are not the same question:
   *
   *   1. Has this person's grade been signed off? Nobody may send a
   *      certificate no human has confirmed — an admin included. This used to
   *      return early for admins, so `hasAdminAccess` skipped every check;
   *      combined with `resolveTiers` reading a pending row's tier, one press
   *      of Issue sent 410 certificates of which 195 had never been reviewed.
   *      An admin who wants to send an unreviewed grade signs it off first,
   *      which takes one click and leaves their name on the decision.
   *
   *   2. Is the mentee's clan released? That one IS the admin's own call, so
   *      admins are not gated by it: they may send into a clan they have not
   *      formally released. Mentors may not — otherwise a mentor could issue
   *      the moment the round opened, skipping approval entirely.
   *
   * Returns the mentee ids that must NOT be sent to, so the caller can report
   * precisely rather than refusing a whole batch.
   */
  async sendBlockers(templateId, menteeIds, user, { transaction = null } = {}) {
    const empty = { unreviewed: [], unapproved: [] };
    if (!Array.isArray(menteeIds) || !menteeIds.length) return empty;
    const isAdmin = await authzService.hasAdminAccess(user);

    const unique = [...new Set(menteeIds.filter(Boolean))];
    // Has this template ever been reviewed at all? If not there is nothing to
    // bypass: a certificate with no review round is issued directly, and that is
    // a real workflow rather than the defect. Gating it would break issuing from
    // any template that never had an AI evaluation.
    const hasRound = await this.hasReviewRound(templateId, { transaction });

    const reviews = hasRound ? await models.CertificateVerification.findAll({
      where: { templateId, menteeId: { [Op.in]: unique.length ? unique : [null] } },
      attributes: ['menteeId', 'status'],
      raw: true,
      transaction
    }) : [];
    // Inside an open round, a mentee with no review row at all has certainly not
    // been reviewed. Two such people were issued certificates off the hardcoded
    // tier fallback, so absence is refused rather than defaulted.
    const signedOff = new Set(reviews.filter((r) => r.status === 'verified').map((r) => r.menteeId));

    const template = await models.CertificateTemplate.findByPk(templateId, { attributes: ['programId'], transaction });
    const clanOf = await this._clanOfMentees(unique, template?.programId || null);
    const approved = isAdmin ? null : await this.approvedClanIds(templateId);

    const out = { unreviewed: [], unapproved: [] };
    for (const menteeId of unique) {
      if (hasRound && !signedOff.has(menteeId)) { out.unreviewed.push(menteeId); continue; }
      if (isAdmin) continue;
      const clanId = clanOf.get(menteeId);
      // A mentee with no clan cannot be released by clan, so only an admin can
      // send to them. Refusing here is the safe reading.
      if (!clanId || !approved.has(clanId)) out.unapproved.push(menteeId);
    }
    return out;
  }

  /** Has a review round been opened on this template? Row existence is the signal. */
  async hasReviewRound(templateId, { transaction = null } = {}) {
    return (await models.CertificateVerification.count({ where: { templateId }, transaction })) > 0;
  }

  /**
   * Certificates this template has issued that no human ever signed off.
   *
   * The same two conditions the send gate uses, so a preview and the send path
   * can never disagree: the template HAS a round, and this mentee's row is
   * absent or not verified. A template with no round at all is issued from
   * directly, on purpose, and none of its certificates are listed here.
   *
   * Read-only. `revokeUnreviewed` is what acts on it.
   */
  async unreviewedIssued(templateId, { transaction = null } = {}) {
    if (!(await this.hasReviewRound(templateId, { transaction }))) return [];

    const instances = await models.CertificateInstance.findAll({
      where: { templateId },
      attributes: ['id', 'menteeId', 'tier', 'certificateNumber', 'createdAt', 'organizationId'],
      include: [{ model: models.User, as: 'mentee', attributes: ['id', 'firstName', 'lastName', 'email'], required: false }],
      transaction
    });
    if (!instances.length) return [];

    const menteeIds = instances.map((row) => row.menteeId);
    const reviews = await models.CertificateVerification.findAll({
      where: { templateId, menteeId: { [Op.in]: menteeIds } },
      attributes: ['menteeId', 'status', 'stage', 'finalTier', 'clanId'],
      include: [{ model: models.Clan, as: 'clan', attributes: ['id', 'name'], required: false }],
      transaction
    });
    const reviewOf = new Map(reviews.map((row) => [row.menteeId, row]));

    return instances
      .filter((instance) => reviewOf.get(instance.menteeId)?.status !== 'verified')
      .map((instance) => {
        const review = reviewOf.get(instance.menteeId) || null;
        return {
          instanceId: instance.id,
          menteeId: instance.menteeId,
          menteeName: instance.mentee
            ? `${instance.mentee.firstName || ''} ${instance.mentee.lastName || ''}`.trim()
            : null,
          menteeEmail: instance.mentee?.email || null,
          clanId: review?.clanId || null,
          clanName: review?.clan?.name || null,
          tier: instance.tier,
          certificateNumber: instance.certificateNumber,
          issuedAt: instance.createdAt,
          reviewStatus: review ? review.status : null,
          reviewStage: review ? review.stage : null,
          organizationId: instance.organizationId
        };
      });
  }

  /**
   * Take those certificates back.
   *
   * `certificate_instances` is not paranoid, so this is a real delete: the row
   * goes, and because `certificate_number` is unique per row a re-issued
   * certificate gets a NEW number and the old public link stops resolving. The
   * recipients are not told — the platform has no revocation notice — so this is
   * deliberately an explicit admin action rather than anything automatic.
   *
   * Everything removed is written to the audit log in the SAME transaction
   * first: if the record cannot be written, nothing is deleted.
   *
   * Revoking also unblocks the mentors. While an instance exists, `verify()`
   * refuses to change the grade ("already issued"); once it is gone the round
   * can be reviewed properly and re-issued.
   */
  async revokeUnreviewed(templateId, user) {
    if (!(await authzService.hasAdminAccess(user))) {
      throw new ForbiddenError('Only an admin can revoke certificates that were issued without a sign-off');
    }
    const template = await models.CertificateTemplate.findByPk(templateId, { attributes: ['id', 'name'] });
    if (!template) throw new NotFoundError('Certificate template not found');

    return sequelize.transaction(async (transaction) => {
      const targets = await this.unreviewedIssued(templateId, { transaction });
      if (!targets.length) return { revoked: 0, certificates: [] };

      const byOrg = new Map();
      for (const row of targets) {
        if (!byOrg.has(row.organizationId)) byOrg.set(row.organizationId, []);
        byOrg.get(row.organizationId).push(row);
      }
      for (const [organizationId, rows] of byOrg.entries()) {
        await models.AuditLog.create({
          organizationId,
          userId: user.id,
          action: 'certificate.revoked_unreviewed',
          entityType: 'CertificateTemplate',
          entityId: templateId,
          oldValues: {
            reason: 'Issued without a signed-off grade while a review round was open',
            template: template.name,
            count: rows.length,
            certificates: rows
          }
        }, { transaction });
      }

      await models.CertificateInstance.destroy({
        where: { id: { [Op.in]: targets.map((row) => row.instanceId) } },
        transaction
      });

      logger.info('[certificateVerification] revoked unreviewed certificates', {
        templateId, by: user.id, revoked: targets.length
      });
      return { revoked: targets.length, certificates: targets };
    });
  }

  /** The union of both blockers — the ids that must not be sent to. */
  async blockedRecipients(templateId, menteeIds, user) {
    const { unreviewed, unapproved } = await this.sendBlockers(templateId, menteeIds, user);
    return [...new Set([...unreviewed, ...unapproved])];
  }

  /** Tell a clan's mentors that their reviewed grades are approved to send. */
  async _notifyClanApproved(templateId, clanId) {
    const mentors = await models.ClanMembership.findAll({
      where: {
        clanId,
        role: { [Op.in]: CertificateVerificationService.MENTOR_ROLES },
        status: 'active'
      },
      attributes: ['userId'],
      raw: true
    });
    if (!mentors.length) return;

    const [template, clan] = await Promise.all([
      models.CertificateTemplate.findByPk(templateId, { attributes: ['name'] }),
      models.Clan.findByPk(clanId, { attributes: ['name'] })
    ]);

    try {
      await notificationOrchestrator.dispatch({
        eventKey: NOTIFICATION_EVENTS.CERTIFICATE_CLAN_APPROVED,
        recipients: [...new Set(mentors.map((m) => m.userId))].map((userId) => ({ userId })),
        payload: {
          title: 'Grades approved for your clan',
          message: `"${template?.name}" is approved for ${clan?.name || 'your clan'}. You can now send the certificates to your mentees.`,
          actionUrl: '/mentor/certificates',
          actionLabel: 'Send certificates',
          relatedEntityType: 'CertificateTemplate'
        }
      });
    } catch (err) {
      logger.warn(`[certificateVerification] approval notification failed: ${err.message}`);
    }
  }

  /**
   * The tier to actually issue for each mentee.
   *
   * The mentor's decision wins where one exists — that is the entire point of
   * the round. A mentee with no verification row falls through to whatever the
   * caller already had, so issuance still works for a template that never went
   * through a review.
   */
  async resolveTiers(templateId, menteeIds) {
    const out = new Map();
    if (!Array.isArray(menteeIds) || !menteeIds.length) return out;
    const rows = await models.CertificateVerification.findAll({
      where: { templateId, menteeId: { [Op.in]: menteeIds } },
      attributes: ['menteeId', 'finalTier', 'status', 'decision']
    });
    for (const row of rows) {
      // Only a signed-off row states a tier. This read `finalTier` regardless
      // of status, and a pending row carries the AI's provisional grade — so
      // the AI's unconfirmed guess was handed to the issuer as if a human had
      // confirmed it. On production that issued 193 certificates nobody had
      // reviewed. An unreviewed mentee is absent here, and `blockedRecipients`
      // refuses them rather than the caller inventing a tier.
      if (row.status !== 'verified') continue;
      if (row.decision === 'no_certificate') out.set(row.menteeId, null);
      else if (row.finalTier) out.set(row.menteeId, row.finalTier);
    }
    return out;
  }

  /**
   * Make an explicit admin issuance the recorded final decision as well.
   *
   * Without this, the credential existed but an older pending row still told
   * the mentor and admin banners that the mentee was waiting for review. This
   * runs inside the issuance transaction: either the approval and credential
   * both land, or neither does.
   */
  async recordAdminIssuanceDecisions(template, assignments, user, { transaction } = {}) {
    if (!Array.isArray(assignments) || !assignments.length) return 0;
    if (!(await authzService.hasAdminAccess(user))) {
      throw new ForbiddenError('Only an admin can record a direct issuance decision');
    }

    const menteeIds = assignments.map((item) => item.menteeId).filter(Boolean);
    const clanByMentee = await this._clanOfMentees(menteeIds, template.programId);
    const aiByMentee = new Map((template.aiEvaluation?.results || []).map((result) => [result.mentee_id || result.id, result]));
    let recorded = 0;

    for (const assignment of assignments) {
      const { menteeId, tier } = assignment;
      if (!menteeId || !tier) continue;
      const ai = aiByMentee.get(menteeId) || null;
      const aiDecision = ai?.decision === 'no_certificate' ? 'no_certificate' : (ai?.certificate_tier ? 'award' : 'undecided');
      const aiTier = aiDecision === 'award' ? ai.certificate_tier : null;
      const reason = 'Issued directly by admin without mentor verification';
      let row = await models.CertificateVerification.findOne({
        where: { templateId: template.id, menteeId }, transaction, lock: transaction?.LOCK.UPDATE
      });
      const previousDecision = row?.decision === 'no_certificate' ? 'no_certificate' : (row?.finalTier ? 'award' : 'undecided');
      const previousTier = row?.finalTier || null;
      const baselineAiDecision = row?.aiDecision ?? aiDecision;
      const baselineAiTier = row?.aiTier ?? aiTier;
      const history = [...(row?.decisionHistory || [])];
      if (previousDecision !== 'award' || previousTier !== tier || row?.stage !== 'admin_approved') {
        history.push({
          at: new Date().toISOString(),
          by: user.id,
          byName: [user.firstName, user.lastName].filter(Boolean).join(' '),
          from: { decision: previousDecision, tier: previousTier },
          to: { decision: 'award', tier },
          reason
        });
      }

      const values = {
        templateId: template.id,
        menteeId,
        clanId: row?.clanId || clanByMentee.get(menteeId) || null,
        aiTier: baselineAiTier,
        aiDecision: baselineAiDecision,
        aiMatchScore: row?.aiMatchScore ?? (Number.isFinite(Number(ai?.match_score)) ? Number(ai.match_score) : null),
        decision: 'award',
        finalTier: tier,
        overridden: baselineAiDecision !== 'award' || baselineAiTier !== tier,
        overrideReason: reason,
        decisionHistory: history,
        status: 'verified',
        stage: 'admin_approved',
        verifiedBy: user.id,
        verifiedAt: new Date()
      };
      if (row) {
        Object.assign(row, values);
        await row.save({ transaction });
      } else {
        row = await models.CertificateVerification.create(values, { transaction });
      }
      recorded += 1;
    }
    return recorded;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  _templateSummary(template) {
    return {
      id: template.id,
      name: template.name,
      criteria: Array.isArray(template.criteria) ? template.criteria : [],
      verificationDeadline: template.verificationDeadline || null
    };
  }

  _serialize(row) {
    const json = row.toJSON ? row.toJSON() : row;
    return {
      id: json.id,
      menteeId: json.menteeId,
      mentee: json.mentee || null,
      clanId: json.clanId,
      clanName: json.clan?.name || null,
      aiTier: json.aiTier,
      aiMatchScore: json.aiMatchScore != null ? Number(json.aiMatchScore) : null,
      finalTier: json.finalTier,
      decision: json.decision,
      aiDecision: json.aiDecision,
      decisionHistory: json.decisionHistory || [],
      overridden: Boolean(json.overridden),
      overrideReason: json.overrideReason || null,
      criteriaChecks: Array.isArray(json.criteriaChecks) ? json.criteriaChecks : [],
      status: json.status,
      stage: json.stage || (json.status === 'verified' ? 'mentor_verified' : 'awaiting_mentor'),
      verifiedAt: json.verifiedAt || null,
      verifiedBy: json.verifier
        ? `${json.verifier.firstName || ''} ${json.verifier.lastName || ''}`.trim()
        : null
    };
  }

  _assertTierExists(template, tierId) {
    const criteria = Array.isArray(template?.criteria) ? template.criteria : [];
    if (!criteria.some((c) => c.id === tierId)) {
      throw new ValidationError(`"${tierId}" is not a certificate type on this template`);
    }
  }

  /** Clans in this programme where the user may sign off. */
  async _reviewableClanIds(user, programId, onlyClanId = null) {
    // `certificate.verify`, not `mentee.view`: a lead mentor can revoke signing
    // off from an individual co-mentor without taking away their ability to see
    // the mentee at all. It is on by default for co-mentors.
    let clanIds = await authzService.clansWhereCan(user, PERMISSIONS.CERTIFICATE_VERIFY);
    if (!clanIds.length) return [];

    // Standee + cohort: mentors may sign off in either kind they can verify.
    // onlyClanId = Standee keeps the round isolated to that clan.
    {
      const inScope = await models.Clan.findAll({
        where: {
          id: { [Op.in]: clanIds },
          kind: { [Op.in]: ['cohort', 'standing'] },
          ...(programId ? { programId } : {}),
        },
        attributes: ['id'],
        raw: true,
      });
      clanIds = inScope.map((c) => c.id);
    }
    if (onlyClanId) clanIds = clanIds.filter((id) => id === onlyClanId);
    return clanIds;
  }

  async _assertCanReview(user, row) {
    if (await authzService.hasAdminAccess(user)) return;
    const clan = row.clanId && await models.Clan.findByPk(row.clanId);
    if (clan?.frozenAt) throw new ForbiddenError('Certificate decisions in a completed program are read-only for mentors');
    const allowed = await this._reviewableClanIds(user, null);
    if (!row.clanId || !allowed.includes(row.clanId)) {
      throw new ForbiddenError('You can only verify certificates for mentees in your clan');
    }
  }

  /** Which clan each mentee sits in, within one programme. */
  async _clanOfMentees(menteeIds, programId) {
    const out = new Map();
    if (!menteeIds.length) return out;
    const rows = await models.ClanMembership.findAll({
      where: {
        userId: { [Op.in]: menteeIds },
        role: 'mentee',
        status: { [Op.in]: VISIBLE_MEMBERSHIP_STATUSES }
      },
      attributes: ['userId', 'clanId'],
      include: [{
        model: models.Clan,
        as: 'clan',
        where: { kind: 'cohort', ...(programId ? { programId } : {}) },
        attributes: ['frozenAt'],
      }],
    });
    // Prefer frozen (completed) cohort when a mentee also sits in a live cohort.
    // Standee attribution comes from result.clan_id in open() — not from here.
    const frozenByUser = new Map();
    for (const row of rows) {
      const frozen = !!row.clan?.frozenAt;
      if (!out.has(row.userId) || (frozen && !frozenByUser.get(row.userId))) {
        out.set(row.userId, row.clanId);
        frozenByUser.set(row.userId, frozen);
      }
    }
    return out;
  }

  /**
   * Review rows are an audit trail, not the live roster. Keep past decisions in
   * storage, but don't ask a clan to sign off for paused, removed, suspended or
   * transferred mentees it cannot see. All review counts use this same scope.
   */
  async _activeReviewRows(rows, programId, { transaction } = {}) {
    if (!rows.length) return [];
    const menteeIds = [...new Set(rows.map((row) => row.menteeId))];
    // Include standing memberships so Standee review rows are not dropped.
    const memberships = await models.ClanMembership.findAll({
      where: { userId: { [Op.in]: menteeIds }, role: 'mentee', status: { [Op.in]: VISIBLE_MEMBERSHIP_STATUSES } },
      attributes: ['userId', 'clanId', 'status'],
      include: [
        { model: models.User, as: 'user', attributes: [], required: true, where: { status: { [Op.ne]: 'suspended' } } },
        {
          model: models.Clan,
          as: 'clan',
          attributes: [],
          required: true,
          where: programId
            ? { programId, kind: { [Op.in]: ['cohort', 'standing'] } }
            : { kind: { [Op.in]: ['cohort', 'standing'] } },
        }
      ],
      raw: true, transaction
    });
    const paused = new Set(memberships.filter((m) => m.status === 'paused').map((m) => m.userId));
    const current = new Set(memberships.filter((m) => m.status === 'active').map((m) => `${m.userId}:${m.clanId}`));
    const placed = new Set(memberships.map((m) => m.userId));
    const unassignedIds = rows.filter((r) => !r.clanId).map((r) => r.menteeId);
    const enrollments = unassignedIds.length ? await models.Enrollment.findAll({
      where: { programId, menteeId: { [Op.in]: unassignedIds }, status: { [Op.notIn]: ['paused', 'dropped', 'rejected'] } },
      attributes: ['menteeId'],
      include: [{ model: models.User, as: 'mentee', attributes: [], required: true, where: { status: { [Op.ne]: 'suspended' } } }],
      raw: true, transaction
    }) : [];
    const unassigned = new Set(enrollments.map((e) => e.menteeId));
    return rows.filter((row) => !paused.has(row.menteeId) && (row.clanId
      ? current.has(`${row.menteeId}:${row.clanId}`)
      : unassigned.has(row.menteeId) && !placed.has(row.menteeId)));
  }

  /** Tell each clan's mentors they have grades waiting, and by when. */
  async _notifyMentors(template) {
    const historicalRows = await models.CertificateVerification.findAll({
      where: { templateId: template.id, status: 'pending' },
      attributes: ['menteeId', 'clanId'],
      raw: true
    });
    const pending = await this._activeReviewRows(historicalRows, template.programId);
    const clanIds = [...new Set(pending.map((r) => r.clanId).filter(Boolean))];
    if (!clanIds.length) return 0;

    const mentors = await models.ClanMembership.findAll({
      where: {
        clanId: { [Op.in]: clanIds },
        role: { [Op.in]: CertificateVerificationService.MENTOR_ROLES },
        status: 'active'
      },
      attributes: ['userId', 'clanId'],
      raw: true
    });

    const countByClan = pending.reduce((acc, r) => {
      if (r.clanId) acc[r.clanId] = (acc[r.clanId] || 0) + 1;
      return acc;
    }, {});

    const due = template.verificationDeadline
      ? ` by ${new Date(template.verificationDeadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';

    const recipients = [...new Set(mentors.map((m) => m.userId))].map((userId) => ({ userId }));
    if (!recipients.length) return 0;

    const total = Object.values(countByClan).reduce((a, b) => a + b, 0);
    try {
      await notificationOrchestrator.dispatch({
        eventKey: NOTIFICATION_EVENTS.CERTIFICATE_VERIFICATION_REQUESTED,
        recipients,
        payload: {
          title: 'Certificate grades need your review',
          message: `${total} of your mentees have been graded for "${template.name}". Check the grades${due} before they go out.`,
          actionUrl: `/mentor/certificates?verify=${template.id}`,
          actionLabel: 'Review grades',
          relatedEntityType: 'CertificateTemplate',
          emailSubject: `Pathment: certificate grades to review${due}`
        }
      });
    } catch (err) {
      logger.warn(`[certificateVerification] mentor notification failed: ${err.message}`);
    }
    return recipients.length;
  }

  /**
   * Nudge the people who still owe a review — and change nothing else.
   *
   * "Remind mentors" used to call `open()`, which is not a reminder at all: it
   * rewrites every pending row back to the AI's grade (dropping a staged change
   * and clearing `overridden`) and destroys the clan's approval wherever the
   * grade moved. Pressing a nudge button could therefore un-approve clans and
   * silently reset decisions. This reads, and only notifies.
   *
   * It also mails the right people the right number. The old notice went to
   * every mentor of every clan holding a pending row and told them all the same
   * GLOBAL figure — a mentor with two left to do was told "402 of your mentees
   * have been graded", which is how a reminder trains people to ignore it. Each
   * mentor now gets their own count, and a mentor with nothing outstanding is
   * not written to at all.
   */
  async remindReviewers(templateId, { deadline = null } = {}, user) {
    if (!(await authzService.hasAdminAccess(user))) {
      throw new ForbiddenError('Only an admin can remind reviewers');
    }
    const template = await models.CertificateTemplate.findByPk(templateId);
    if (!template) throw new NotFoundError('Certificate template not found');

    // Moving the deadline is the one change a reminder may legitimately make,
    // and only when the admin explicitly passes a new one.
    if (deadline) {
      template.verificationDeadline = deadline;
      await template.save();
    }

    const pendingRows = await models.CertificateVerification.findAll({
      where: { templateId, status: 'pending' },
      attributes: ['menteeId', 'clanId'],
      raw: true
    });
    // Historical rows can name people who have since left; only current
    // memberships are somebody's outstanding work.
    const pending = await this._activeReviewRows(pendingRows, template.programId);
    const outstandingByClan = new Map();
    for (const row of pending) {
      if (!row.clanId) continue;
      outstandingByClan.set(row.clanId, (outstandingByClan.get(row.clanId) || 0) + 1);
    }
    const clanIds = [...outstandingByClan.keys()];
    if (!clanIds.length) {
      return { notified: 0, clans: 0, outstanding: 0, unassigned: pending.length };
    }

    const memberships = await models.ClanMembership.findAll({
      where: {
        clanId: { [Op.in]: clanIds },
        role: { [Op.in]: CertificateVerificationService.MENTOR_ROLES },
        status: 'active'
      },
      attributes: ['userId', 'clanId'],
      raw: true
    });

    const owedBy = new Map();
    for (const m of memberships) {
      const owed = outstandingByClan.get(m.clanId) || 0;
      if (!owed) continue;
      owedBy.set(m.userId, (owedBy.get(m.userId) || 0) + owed);
    }
    if (!owedBy.size) {
      return { notified: 0, clans: clanIds.length, outstanding: pending.length, unassigned: 0 };
    }

    const due = template.verificationDeadline
      ? ` by ${new Date(template.verificationDeadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';

    let notified = 0;
    for (const [userId, owed] of owedBy.entries()) {
      try {
        await notificationOrchestrator.dispatch({
          eventKey: NOTIFICATION_EVENTS.CERTIFICATE_VERIFICATION_REQUESTED,
          recipients: [{ userId }],
          payload: {
            title: 'Certificate grades still need your review',
            // Their own number. A reminder that overstates what somebody owes
            // gets read as noise.
            message: `${owed} grade${owed === 1 ? '' : 's'} in your clan${owed === 1 ? '' : 's'} still need your review for "${template.name}"${due}.`,
            actionUrl: `/mentor/certificates?verify=${templateId}`,
            actionLabel: 'Review grades',
            relatedEntityType: 'CertificateTemplate',
            emailSubject: `Pathment: ${owed} certificate grade${owed === 1 ? '' : 's'} to review${due}`
          }
        });
        notified += 1;
      } catch (err) {
        logger.warn(`[certificateVerification] reminder to ${userId} failed: ${err.message}`);
      }
    }

    logger.info('[certificateVerification] reminded reviewers', {
      templateId, by: user.id, notified, clans: clanIds.length, outstanding: pending.length
    });
    return {
      notified,
      clans: clanIds.length,
      outstanding: pending.length,
      unassigned: pending.filter((r) => !r.clanId).length
    };
  }

  /**
   * Who decided this grade, and are they a mentor rather than an admin?
   *
   * "Only if a mentor assigned it" is the whole precondition for asking: there
   * is no point asking an admin to explain a decision to themselves, and a row
   * nobody has signed off has no decision to explain.
   */
  async _mentorBehindDecision(row) {
    if (!row || row.status !== 'verified' || !row.verifiedBy) return null;
    const decider = await models.User.findByPk(row.verifiedBy, {
      attributes: ['id', 'firstName', 'lastName', 'email', 'role', 'capabilities']
    });
    if (!decider) return null;
    return (await authzService.hasAdminAccess(decider)) ? null : decider;
  }

  /**
   * Ask the mentor why they graded somebody the way they did.
   *
   * The grade is untouched. An admin who disagrees could previously only accept
   * it or overrule it, and overruling throws away both the mentor's judgement
   * and the reason for it — when very often the mentor knows something the
   * record does not. The admin can still override afterwards, but with the
   * answer in front of them.
   */
  async askMentor(templateId, menteeId, question, user) {
    if (!(await authzService.hasAdminAccess(user))) {
      throw new ForbiddenError('Only an admin can question a grade');
    }
    const text = String(question || '').trim();
    if (!text) throw new ValidationError('Write the question you want the mentor to answer');

    const template = await models.CertificateTemplate.findByPk(templateId, { attributes: ['id', 'name', 'organizationId'] });
    if (!template) throw new NotFoundError('Certificate template not found');

    const row = await models.CertificateVerification.findOne({ where: { templateId, menteeId } });
    if (!row) throw new NotFoundError('There is no review for this mentee to ask about');

    const mentor = await this._mentorBehindDecision(row);
    if (!mentor) {
      throw new ValidationError(
        row.status === 'verified'
          ? 'This grade was decided by an admin, so there is no mentor to ask.'
          : 'Nobody has signed this grade off yet, so there is nothing to ask about.'
      );
    }

    const existing = await models.CertificateReviewQuestion.findOne({
      where: { templateId, menteeId, kind: 'question', status: 'open' }, attributes: ['id']
    });
    if (existing) {
      throw new ValidationError('There is already an open question on this grade, waiting for an answer.');
    }

    const asked = await models.CertificateReviewQuestion.create({
      organizationId: template.organizationId,
      templateId,
      menteeId,
      clanId: row.clanId || null,
      askedBy: user.id,
      kind: 'question',
      question: text,
      addressedTo: mentor.id,
      status: 'open'
    });

    const mentee = await models.User.findByPk(menteeId, { attributes: ['firstName', 'lastName'] });
    const who = mentee ? `${mentee.firstName || ''} ${mentee.lastName || ''}`.trim() : 'a mentee';
    try {
      await notificationOrchestrator.dispatch({
        eventKey: NOTIFICATION_EVENTS.CERTIFICATE_VERIFICATION_REQUESTED,
        recipients: [{ userId: mentor.id }],
        payload: {
          title: 'An admin asked about a grade you gave',
          message: `${who}: "${text}"`,
          actionUrl: `/mentor/certificates?verify=${templateId}&question=${asked.id}`,
          actionLabel: 'Answer',
          relatedEntityType: 'CertificateTemplate',
          emailSubject: `Pathment: a question about ${who}'s certificate`
        }
      });
    } catch (err) {
      logger.warn(`[certificateVerification] question notification failed: ${err.message}`);
    }

    logger.info('[certificateVerification] grade questioned', { templateId, menteeId, by: user.id, mentor: mentor.id });
    return this._serializeQuestion(await this._reloadQuestion(asked.id));
  }

  /** The mentor's reply. Closes the question and tells the admin who asked. */
  async answerQuestion(questionId, answer, user) {
    const text = String(answer || '').trim();
    if (!text) throw new ValidationError('Write an answer before sending it');

    const question = await models.CertificateReviewQuestion.findByPk(questionId);
    if (!question) throw new NotFoundError('Question not found');
    if (question.status !== 'open') {
      throw new ValidationError('This question has already been answered.');
    }

    // The mentor it was addressed to answers it. A lead mentor covering for
    // somebody who has left can answer too — otherwise a question outlives the
    // only person able to close it.
    const isAddressee = question.addressedTo === user.id;
    const coversClan = question.clanId
      ? (await authzService.clansWhereCan(user, PERMISSIONS.MENTEE_VIEW)).includes(question.clanId)
      : false;
    if (!isAddressee && !coversClan) {
      throw new ForbiddenError('Only the mentor who made this decision can answer it');
    }

    question.answer = text;
    question.answeredBy = user.id;
    question.answeredAt = new Date();
    question.status = 'answered';
    await question.save();

    const mentee = await models.User.findByPk(question.menteeId, { attributes: ['firstName', 'lastName'] });
    const who = mentee ? `${mentee.firstName || ''} ${mentee.lastName || ''}`.trim() : 'a mentee';
    try {
      await notificationOrchestrator.dispatch({
        eventKey: NOTIFICATION_EVENTS.CERTIFICATE_VERIFICATION_COMPLETED,
        recipients: [{ userId: question.askedBy }],
        payload: {
          title: 'A mentor answered your question',
          message: `${who}: "${text}"`,
          actionUrl: `/admin/certificates/${question.templateId}/edit?mentee=${question.menteeId}`,
          actionLabel: 'Read the answer',
          relatedEntityType: 'CertificateTemplate',
          emailSubject: `Pathment: answer about ${who}'s certificate`
        }
      });
    } catch (err) {
      logger.warn(`[certificateVerification] answer notification failed: ${err.message}`);
    }

    return this._serializeQuestion(await this._reloadQuestion(question.id));
  }

  /**
   * The mentor's way forward once a certificate has been approved or sent.
   *
   * They may not edit an issued credential, but they are the person who knows the
   * mentee and the one most likely to spot a mistake afterwards. So they say
   * what they want it changed to and why, and the admin decides in one press.
   *
   * Admin approval is the finalization boundary. An issued instance may also
   * exist; when it does, approval of the request revokes it before changing.
   */
  async requestChange(templateId, menteeId, { finalTier, decision, reason } = {}, user) {
    const text = String(reason || '').trim();
    if (!text) throw new ValidationError('Say why the grade should change');

    const template = await models.CertificateTemplate.findByPk(templateId, {
      attributes: ['id', 'name', 'organizationId', 'criteria']
    });
    if (!template) throw new NotFoundError('Certificate template not found');

    const row = await models.CertificateVerification.findOne({ where: { templateId, menteeId } });
    if (!row) throw new NotFoundError('There is no review for this mentee');
    await this._assertCanReview(user, row);

    if (await authzService.hasAdminAccess(user)) {
      throw new ValidationError('You can change this grade directly — there is nobody to ask.');
    }

    const issued = await models.CertificateInstance.findOne({
      where: { templateId, menteeId }, attributes: ['id', 'tier', 'certificateNumber', 'createdAt']
    });
    if (row.stage !== 'admin_approved' && !issued) {
      throw new ValidationError('This certificate has not been approved yet — change the grade directly instead.');
    }

    const nextDecision = decision || (finalTier ? 'award' : null);
    if (!['award', 'no_certificate'].includes(nextDecision)) {
      throw new ValidationError('Choose a certificate or No certificate to request.');
    }
    const tier = nextDecision === 'award' ? (finalTier || null) : null;
    if (nextDecision === 'award') this._assertTierExists(template, tier);
    if (nextDecision === row.decision && tier === row.finalTier) {
      throw new ValidationError('That is the grade it already has.');
    }

    const existing = await models.CertificateReviewQuestion.findOne({
      where: { templateId, menteeId, kind: 'change_request', status: 'open' }, attributes: ['id']
    });
    if (existing) throw new ValidationError('You already have a change request open on this grade.');

    const created = await models.CertificateReviewQuestion.create({
      organizationId: template.organizationId,
      templateId,
      menteeId,
      clanId: row.clanId || null,
      kind: 'change_request',
      askedBy: user.id,
      question: text,
      requestedTier: tier,
      requestedDecision: nextDecision,
      status: 'open'
    });

    await this._tellAdmins(template, {
      title: 'A mentor requested a certificate change',
      message: `${await this._menteeName(menteeId)} asked to ${issued ? 'revoke the issued certificate and ' : ''}change ${this._tierLabel(template, row.finalTier, row.decision)} → ${this._tierLabel(template, tier, nextDecision)}. "${text}"`,
      actionUrl: `/admin/certificates/${templateId}/edit?mentee=${menteeId}`,
      actionLabel: 'Review the request'
    });

    return this._serializeQuestion(await this._reloadQuestion(created.id));
  }

  /**
   * Approving applies the requested grade in one transaction. If an issued
   * credential exists it is revoked first; replacement issuance stays explicit.
   */
  async resolveChangeRequest(questionId, { approve, note = null } = {}, user) {
    if (!(await authzService.hasAdminAccess(user))) {
      throw new ForbiddenError('Only an admin can decide a change request');
    }
    const request = await models.CertificateReviewQuestion.findByPk(questionId);
    if (!request) throw new NotFoundError('Request not found');
    if (request.kind !== 'change_request') throw new ValidationError('That is not a change request.');
    if (request.status !== 'open') throw new ValidationError('This request has already been decided.');

    const text = String(note || '').trim();
    if (!approve && !text) throw new ValidationError('Give a reason when declining a change request');

    await sequelize.transaction(async transaction => {
      if (approve) {
        const issued = await models.CertificateInstance.findAll({
          where: { templateId: request.templateId, menteeId: request.menteeId },
          transaction, lock: transaction.LOCK.UPDATE
        });
        await models.AuditLog.create({
          organizationId: request.organizationId,
          userId: user.id,
          action: 'certificate.revocation_request_approved',
          entityType: 'CertificateVerification',
          entityId: request.menteeId,
          oldValues: {
            requestId: request.id,
            reason: request.question,
            certificates: issued.map(instance => ({
              id: instance.id, tier: instance.tier,
              certificateNumber: instance.certificateNumber, issuedAt: instance.createdAt
            }))
          },
          newValues: { decision: request.requestedDecision, tier: request.requestedTier }
        }, { transaction });

        if (issued.length) {
          await models.CertificateInstance.destroy({
            where: { id: { [Op.in]: issued.map(instance => instance.id) } }, transaction
          });
        }
        await this.verify(request.templateId, request.menteeId, {
          decision: request.requestedDecision,
          finalTier: request.requestedTier,
          reason: text || `Approved revoke-and-change request: ${request.question}`
        }, user, { notify: false, transaction });
      }

      request.status = 'answered';
      request.resolution = approve ? 'approved' : 'declined';
      request.answer = text || (approve ? 'Change approved. Ready to send.' : null);
      request.answeredBy = user.id;
      request.answeredAt = new Date();
      await request.save({ transaction });
    });

    const template = await models.CertificateTemplate.findByPk(request.templateId, { attributes: ['id', 'name', 'criteria'] });
    try {
      await notificationOrchestrator.dispatch({
        eventKey: NOTIFICATION_EVENTS.CERTIFICATE_VERIFICATION_COMPLETED,
        recipients: [{ userId: request.askedBy }],
        payload: {
          title: approve ? 'Certificate change approved' : 'Your change request was declined',
          message: `${await this._menteeName(request.menteeId)}: ${approve
            ? `the grade is now ${this._tierLabel(template, request.requestedTier, request.requestedDecision)}. You can send the certificate.`
            : 'the grade stands.'}${text ? ` "${text}"` : ''}`,
          actionUrl: `/mentor/certificates?verify=${request.templateId}`,
          actionLabel: 'Open the review',
          relatedEntityType: 'CertificateTemplate',
          emailSubject: `Pathment: change request ${approve ? 'approved' : 'declined'}`
        }
      });
    } catch (err) {
      logger.warn(`[certificateVerification] change-request reply failed: ${err.message}`);
    }

    return this._serializeQuestion(await this._reloadQuestion(request.id));
  }

  /**
   * A mentor asking for the certificate report for their clan.
   *
   * Reports are an admin surface; a mentor who wants one had no way to say so.
   * This is a request, not a generated file — the admin sends it, and the
   * thread records that it was asked for.
   */
  async requestReport(templateId, { clanId = null, note = null } = {}, user) {
    const template = await models.CertificateTemplate.findByPk(templateId, {
      attributes: ['id', 'name', 'organizationId']
    });
    if (!template) throw new NotFoundError('Certificate template not found');
    if (await authzService.hasAdminAccess(user)) {
      throw new ValidationError('You already have the report — open the issuance history.');
    }

    const mine = await authzService.clansWhereCan(user, PERMISSIONS.MENTEE_VIEW);
    const target = clanId || mine[0] || null;
    if (!target || !mine.includes(target)) {
      throw new ForbiddenError('You can only request the report for a clan you mentor');
    }

    const existing = await models.CertificateReviewQuestion.findOne({
      where: { templateId, clanId: target, kind: 'report_request', status: 'open' }, attributes: ['id']
    });
    if (existing) throw new ValidationError('You already have a report request open for this clan.');

    const clan = await models.Clan.findByPk(target, { attributes: ['name'] });
    const text = String(note || '').trim();
    const created = await models.CertificateReviewQuestion.create({
      organizationId: template.organizationId,
      templateId,
      menteeId: null,
      clanId: target,
      kind: 'report_request',
      askedBy: user.id,
      question: text || `Please send the certificate report for ${clan?.name || 'my clan'}.`,
      status: 'open'
    });

    await this._tellAdmins(template, {
      title: 'A mentor requested the certificate report',
      message: `${clan?.name || 'A clan'} — "${created.question}"`,
      actionUrl: `/admin/certificates/${templateId}/edit`,
      actionLabel: 'Open the cycle'
    });

    return this._serializeQuestion(await this._reloadQuestion(created.id));
  }

  /** Every admin on this workspace, told once. */
  async _tellAdmins(template, { title, message, actionUrl, actionLabel }) {
    const admins = await models.User.findAll({
      where: { role: 'admin', status: 'active' }, attributes: ['id'], raw: true
    });
    if (!admins.length) return 0;
    try {
      await notificationOrchestrator.dispatch({
        eventKey: NOTIFICATION_EVENTS.CERTIFICATE_VERIFICATION_COMPLETED,
        recipients: admins.map((a) => ({ userId: a.id })),
        payload: {
          title, message, actionUrl, actionLabel,
          relatedEntityType: 'CertificateTemplate',
          emailSubject: `Pathment: ${title}`
        }
      });
    } catch (err) {
      logger.warn(`[certificateVerification] admin notification failed: ${err.message}`);
    }
    return admins.length;
  }

  async _menteeName(menteeId) {
    if (!menteeId) return 'A mentee';
    const u = await models.User.findByPk(menteeId, { attributes: ['firstName', 'lastName'] });
    return u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : 'A mentee';
  }

  _tierLabel(template, tier, decision) {
    if (decision === 'no_certificate') return 'No certificate';
    if (!tier) return 'no grade';
    const match = (template?.criteria || []).find((c) => c.id === tier);
    return match?.name || tier;
  }

  /** Take a question back — asked in error, or already resolved another way. */
  async withdrawQuestion(questionId, user) {
    if (!(await authzService.hasAdminAccess(user))) {
      throw new ForbiddenError('Only an admin can withdraw a question');
    }
    const question = await models.CertificateReviewQuestion.findByPk(questionId);
    if (!question) throw new NotFoundError('Question not found');
    if (question.status !== 'open') throw new ValidationError('Only an open question can be withdrawn.');
    question.status = 'withdrawn';
    await question.save();
    return this._serializeQuestion(await this._reloadQuestion(question.id));
  }

  /**
   * Questions on a template, newest first. `menteeId` narrows to one person's
   * thread; `openOnly` is what the roster badge and the mentor's inbox read.
   */
  async listQuestions(templateId, { menteeId = null, openOnly = false, kind = null } = {}) {
    const where = { templateId };
    if (menteeId) where.menteeId = menteeId;
    if (openOnly) where.status = 'open';
    if (kind) where.kind = kind;
    const rows = await models.CertificateReviewQuestion.findAll({
      where,
      include: [
        { model: models.User, as: 'mentee', attributes: ['id', 'firstName', 'lastName', 'email'], required: false },
        { model: models.User, as: 'asker', attributes: ['id', 'firstName', 'lastName'], required: false },
        { model: models.User, as: 'addressee', attributes: ['id', 'firstName', 'lastName'], required: false },
        { model: models.User, as: 'answerer', attributes: ['id', 'firstName', 'lastName'], required: false },
        { model: models.Clan, as: 'clan', attributes: ['id', 'name'], required: false }
      ],
      order: [['askedAt', 'DESC']]
    });
    return rows.map((row) => this._serializeQuestion(row));
  }

  /**
   * Every open thread on this template, in one read.
   *
   * The roster needs two different flags per row — queried by an admin, and
   * change requested by a mentor — and they come from the same table. One
   * query, split here, rather than one round trip per flag.
   */
  async openThreads(templateId) {
    const rows = await models.CertificateReviewQuestion.findAll({
      where: { templateId, status: 'open' },
      attributes: ['menteeId', 'kind', 'clanId'],
      raw: true
    });
    const questioned = new Set();
    const changeRequested = new Set();
    const reportRequests = [];
    for (const row of rows) {
      if (row.kind === 'question' && row.menteeId) questioned.add(row.menteeId);
      else if (row.kind === 'change_request' && row.menteeId) changeRequested.add(row.menteeId);
      else if (row.kind === 'report_request') reportRequests.push(row.clanId);
    }
    return { questioned, changeRequested, reportRequests };
  }

  /** The mentee ids carrying an open admin question. */
  async openQuestionMenteeIds(templateId) {
    return (await this.openThreads(templateId)).questioned;
  }

  async _reloadQuestion(id) {
    return models.CertificateReviewQuestion.findByPk(id, {
      include: [
        { model: models.User, as: 'mentee', attributes: ['id', 'firstName', 'lastName', 'email'], required: false },
        { model: models.User, as: 'asker', attributes: ['id', 'firstName', 'lastName'], required: false },
        { model: models.User, as: 'addressee', attributes: ['id', 'firstName', 'lastName'], required: false },
        { model: models.User, as: 'answerer', attributes: ['id', 'firstName', 'lastName'], required: false },
        { model: models.Clan, as: 'clan', attributes: ['id', 'name'], required: false }
      ]
    });
  }

  _serializeQuestion(row) {
    if (!row) return null;
    const json = row.toJSON ? row.toJSON() : row;
    const name = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : null);
    return {
      id: json.id,
      templateId: json.templateId,
      menteeId: json.menteeId,
      menteeName: name(json.mentee),
      clanId: json.clanId,
      clanName: json.clan?.name || null,
      kind: json.kind || 'question',
      question: json.question,
      requestedTier: json.requestedTier || null,
      requestedDecision: json.requestedDecision || null,
      resolution: json.resolution || null,
      askedBy: name(json.asker),
      askedById: json.askedBy,
      askedAt: json.askedAt,
      addressedTo: json.addressedTo,
      addressedToName: name(json.addressee),
      answer: json.answer || null,
      answeredBy: name(json.answerer),
      answeredAt: json.answeredAt || null,
      status: json.status
    };
  }

  /**
   * Tell this one mentee's mentors their review is waiting.
   *
   * The round-wide reminder is all-or-nothing; an admin looking at one person
   * had no way to chase just them without mailing every unfinished clan.
   */
  async notifyMentorsForMentee(templateId, menteeId, { note = null } = {}, user) {
    if (!(await authzService.hasAdminAccess(user))) {
      throw new ForbiddenError('Only an admin can notify a mentor about a mentee');
    }
    const template = await models.CertificateTemplate.findByPk(templateId, { attributes: ['id', 'name', 'programId'] });
    if (!template) throw new NotFoundError('Certificate template not found');

    const row = await models.CertificateVerification.findOne({
      where: { templateId, menteeId }, attributes: ['clanId', 'status']
    });
    const clanOf = await this._clanOfMentees([menteeId], template.programId);
    const clanId = row?.clanId || clanOf.get(menteeId) || null;
    if (!clanId) {
      throw new ValidationError(
        'This mentee is not in a clan, so no mentor owns their review. Only an admin can review them.'
      );
    }

    const mentors = await models.ClanMembership.findAll({
      where: {
        clanId,
        role: { [Op.in]: CertificateVerificationService.MENTOR_ROLES },
        status: 'active'
      },
      attributes: ['userId'], raw: true
    });
    const recipients = [...new Set(mentors.map((m) => m.userId))];
    if (!recipients.length) {
      throw new ValidationError('That clan has no active mentor to notify.');
    }

    const [mentee, clan] = await Promise.all([
      models.User.findByPk(menteeId, { attributes: ['firstName', 'lastName'] }),
      models.Clan.findByPk(clanId, { attributes: ['name'] })
    ]);
    const who = mentee ? `${mentee.firstName || ''} ${mentee.lastName || ''}`.trim() : 'a mentee';
    const extra = String(note || '').trim();

    try {
      await notificationOrchestrator.dispatch({
        eventKey: NOTIFICATION_EVENTS.CERTIFICATE_VERIFICATION_REQUESTED,
        recipients: recipients.map((userId) => ({ userId })),
        payload: {
          title: `${who}'s certificate grade needs your review`,
          message: extra || `${who} in ${clan?.name || 'your clan'} is still waiting on a grade for "${template.name}".`,
          actionUrl: `/mentor/certificates?verify=${templateId}&mentee=${menteeId}`,
          actionLabel: 'Review now',
          relatedEntityType: 'CertificateTemplate',
          emailSubject: `Pathment: review ${who}'s certificate grade`
        }
      });
    } catch (err) {
      logger.warn(`[certificateVerification] mentee reminder failed: ${err.message}`);
      throw new ValidationError('Could not send the notification. Try again.');
    }

    return { notified: recipients.length, clanId, clanName: clan?.name || null };
  }

  /** When a clan finishes, tell the admins it is clear to issue. */
  async _notifyAdminsIfClanComplete(templateId, clanId, actor) {
    if (!clanId) return;
    const [template, clan, historicalRows] = await Promise.all([
      models.CertificateTemplate.findByPk(templateId),
      models.Clan.findByPk(clanId, { attributes: ['name'] }),
      models.CertificateVerification.findAll({ where: { templateId, clanId } })
    ]);
    if (!template) return;
    const rows = await this._activeReviewRows(historicalRows, template.programId);
    if (!rows.length || rows.some((row) => row.status !== 'verified')) return;

    const admins = await require('./workspaceRecipients').admins();
    if (!admins.length) return;

    const overrides = rows.filter((row) => row.overridden).length;

    try {
      await notificationOrchestrator.dispatch({
        eventKey: NOTIFICATION_EVENTS.CERTIFICATE_VERIFICATION_COMPLETED,
        recipients: admins.map((a) => ({ userId: a.id })),
        payload: {
          title: `${clan?.name || 'A clan'} has verified its certificates`,
          message: overrides > 0
            ? `All grades for "${template?.name}" are signed off — ${overrides} were changed from the AI's assignment.`
            : `All grades for "${template?.name}" are signed off with no changes.`,
          actionUrl: `/admin/certificates/${templateId}/edit`,
          actionLabel: 'Open template',
          relatedEntityType: 'CertificateTemplate'
        }
      });
    } catch (err) {
      logger.warn(`[certificateVerification] admin notification failed: ${err.message}`);
    }
  }
}

module.exports = new CertificateVerificationService();
