/**
 * Consolidated Certificate Models
 *
 * Defines CertificateTemplate and CertificateInstance together in one file.
 */
module.exports = (sequelize, DataTypes) => {
  // 1. CertificateTemplate Model (Design Blueprint)
  const CertificateTemplate = sequelize.define('CertificateTemplate', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    organizationId: { type: DataTypes.UUID, allowNull: false, field: 'organization_id' },
    name: { type: DataTypes.STRING(255), allowNull: false },
    bgImageUrl: { type: DataTypes.TEXT, field: 'bg_image_url' },
    logoUrl: { type: DataTypes.TEXT, field: 'logo_url' },
    logoConfig: { type: DataTypes.JSONB, field: 'logo_config' },
    config: { type: DataTypes.JSONB, allowNull: false },
    criteria: { type: DataTypes.JSONB },
    createdBy: { type: DataTypes.UUID, allowNull: false, field: 'created_by' },
    programId: { type: DataTypes.UUID, allowNull: false, field: 'program_id' },
    status: { type: DataTypes.STRING(20), defaultValue: 'active' },
    aiEvaluation: { type: DataTypes.JSONB, field: 'ai_evaluation' },
    aiEvaluationRanAt: { type: DataTypes.DATE, field: 'ai_evaluation_ran_at' },
    // When mentors are asked to have finished reviewing the AI's tier
    // assignments. A nudge, never a gate — nothing issues on its own when it
    // passes; the admin's banner simply starts saying "overdue".
    verificationDeadline: { type: DataTypes.DATE, field: 'verification_deadline' }
  }, { tableName: 'certificate_templates', underscored: true });

  CertificateTemplate.associate = function (models) {
    if (models.User) {
      CertificateTemplate.belongsTo(models.User, { foreignKey: 'createdBy', as: 'creator' });
    }
    if (models.Program) {
      CertificateTemplate.belongsTo(models.Program, { foreignKey: 'programId', as: 'program' });
    }
    if (models.Organization) CertificateTemplate.belongsTo(models.Organization, { foreignKey: 'organizationId', as: 'organization' });
  };

  // 2. CertificateInstance Model (Issued Credential)
  const CertificateInstance = sequelize.define('CertificateInstance', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    organizationId: { type: DataTypes.UUID, allowNull: false, field: 'organization_id' },
    templateId: { type: DataTypes.UUID, allowNull: false, field: 'template_id' },
    menteeId: { type: DataTypes.UUID, allowNull: false, field: 'mentee_id' },
    mentorId: { type: DataTypes.UUID, field: 'mentor_id' },
    issuedBy: { type: DataTypes.UUID, allowNull: false, field: 'issued_by' },
    imageUrl: { type: DataTypes.TEXT, field: 'image_url' },
    tier: { type: DataTypes.STRING(50), defaultValue: 'participation' },
    /**
     * The credential's public identity: opaque, unambiguous, unique, and
     * printed on the certificate itself. Assigned at issuance and never
     * reused — a recipient quotes it on a CV and anybody can resolve it at
     * /verify/<number>.
     */
    certificateNumber: { type: DataTypes.STRING(32), field: 'certificate_number', unique: true },
    metadata: { type: DataTypes.JSONB }
  }, { tableName: 'certificate_instances', underscored: true });

  CertificateInstance.associate = function (models) {
    if (models.CertificateTemplate) {
      CertificateInstance.belongsTo(models.CertificateTemplate, { foreignKey: 'templateId', as: 'template' });
    }
    if (models.User) {
      CertificateInstance.belongsTo(models.User, { foreignKey: 'menteeId', as: 'mentee' });
      CertificateInstance.belongsTo(models.User, { foreignKey: 'mentorId', as: 'mentor' });
      CertificateInstance.belongsTo(models.User, { foreignKey: 'issuedBy', as: 'issuer' });
    }
  };

  // 3. CertificateVerification (the mentor's review of an AI tier assignment)
  const CertificateVerification = sequelize.define('CertificateVerification', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    organizationId: { type: DataTypes.UUID, allowNull: false, field: 'organization_id' },
    templateId: { type: DataTypes.UUID, allowNull: false, field: 'template_id' },
    menteeId: { type: DataTypes.UUID, allowNull: false, field: 'mentee_id' },
    clanId: { type: DataTypes.UUID, field: 'clan_id' },
    /** What the AI proposed — kept after an override so the change stays visible. */
    aiTier: { type: DataTypes.STRING(50), field: 'ai_tier' },
    aiMatchScore: { type: DataTypes.DECIMAL(5, 2), field: 'ai_match_score' },
    /** What will actually be issued. */
    finalTier: { type: DataTypes.STRING(50), field: 'final_tier' },
    decision: { type: DataTypes.STRING(20), defaultValue: 'undecided', allowNull: false,
      validate: { isIn: [['award', 'no_certificate', 'undecided']] } },
    aiDecision: { type: DataTypes.STRING(20), field: 'ai_decision', defaultValue: 'undecided', allowNull: false,
      validate: { isIn: [['award', 'no_certificate', 'undecided']] } },
    decisionHistory: { type: DataTypes.JSONB, field: 'decision_history', defaultValue: [], allowNull: false },
    overridden: { type: DataTypes.BOOLEAN, defaultValue: false },
    overrideReason: { type: DataTypes.TEXT, field: 'override_reason' },
    /** Reviewer attestations for the selected tier's optional admin checklist. */
    criteriaChecks: { type: DataTypes.JSONB, field: 'criteria_checks', defaultValue: [], allowNull: false },
    status: {
      type: DataTypes.STRING(20),
      defaultValue: 'pending',
      validate: { isIn: [['pending', 'verified']] }
    },
    /**
     * How far this review has actually got. `status` answers only "has somebody
     * signed off", and a mentor's sign-off and an admin's both wrote 'verified'
     * — so an admin working through a whole cohort saw the same badge on their
     * own decisions as on everyone else's, and could not tell them apart.
     *
     *   ai_evaluated     the AI graded it; no human has been asked yet
     *   awaiting_mentor  sent to the clans, nobody has signed off
     *   mentor_verified  a mentor signed off
     *   admin_approved   an admin signed off the row, or released its clan
     *
     * `status` is kept in sync ('verified' for the last two) so existing
     * queries keep working; this is the richer fact on top, not a replacement.
     */
    stage: {
      type: DataTypes.STRING(20),
      defaultValue: 'awaiting_mentor',
      allowNull: false,
      validate: { isIn: [['ai_evaluated', 'awaiting_mentor', 'mentor_verified', 'admin_approved']] }
    },
    verifiedBy: { type: DataTypes.UUID, field: 'verified_by' },
    verifiedAt: { type: DataTypes.DATE, field: 'verified_at' }
  }, { tableName: 'certificate_verifications', underscored: true });

  CertificateVerification.associate = function (models) {
    if (models.CertificateTemplate) {
      CertificateVerification.belongsTo(models.CertificateTemplate, { foreignKey: 'templateId', as: 'template' });
    }
    if (models.User) {
      CertificateVerification.belongsTo(models.User, { foreignKey: 'menteeId', as: 'mentee' });
      CertificateVerification.belongsTo(models.User, { foreignKey: 'verifiedBy', as: 'verifier' });
    }
    if (models.Clan) {
      CertificateVerification.belongsTo(models.Clan, { foreignKey: 'clanId', as: 'clan' });
    }
  };

  /**
   * CertificateReviewQuestion — the admin asking a mentor to explain a grade.
   *
   * An admin who disagrees with a mentor could only accept the grade or
   * overrule it, and overruling discards both the mentor's judgement and the
   * reason behind it. Often the mentor simply knows something the record does
   * not. This puts the question on the record and the answer next to it.
   *
   * It is NOT a stage. The grade does not move while a question is open — a
   * questioned row is still `mentor_verified`, and folding this into `stage`
   * would mean answering had to guess which stage to restore.
   */
  const CertificateReviewQuestion = sequelize.define('CertificateReviewQuestion', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    organizationId: { type: DataTypes.UUID, allowNull: false, field: 'organization_id' },
    templateId: { type: DataTypes.UUID, allowNull: false, field: 'template_id' },
    /** Null for a report request, which is about a clan rather than a person. */
    menteeId: { type: DataTypes.UUID, field: 'mentee_id' },
    clanId: { type: DataTypes.UUID, field: 'clan_id' },
    /**
     * Which way this thread runs.
     *   question        admin → mentor   "why did you give this grade?"
     *   change_request  mentor → admin   "may I change it, because…"
     *   report_request  mentor → admin   "please send me the report"
     */
    kind: {
      type: DataTypes.STRING(20),
      defaultValue: 'question',
      allowNull: false,
      validate: { isIn: [['question', 'change_request', 'report_request']] }
    },
    /** What a change request is asking for, so the admin can grant it in one press. */
    requestedTier: { type: DataTypes.STRING(50), field: 'requested_tier' },
    requestedDecision: {
      type: DataTypes.STRING(20),
      field: 'requested_decision',
      validate: { isIn: [['award', 'no_certificate']] }
    },
    /** Which way the admin went. `answer` holds their note either way. */
    resolution: {
      type: DataTypes.STRING(20),
      validate: { isIn: [['approved', 'declined']] }
    },
    askedBy: { type: DataTypes.UUID, allowNull: false, field: 'asked_by' },
    askedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'asked_at' },
    question: { type: DataTypes.TEXT, allowNull: false },
    /** The mentor whose decision is in question — who is asked, and notified. */
    addressedTo: { type: DataTypes.UUID, field: 'addressed_to' },
    answeredBy: { type: DataTypes.UUID, field: 'answered_by' },
    answeredAt: { type: DataTypes.DATE, field: 'answered_at' },
    answer: { type: DataTypes.TEXT },
    status: {
      type: DataTypes.STRING(20),
      defaultValue: 'open',
      allowNull: false,
      validate: { isIn: [['open', 'answered', 'withdrawn']] }
    }
  }, { tableName: 'certificate_review_questions', underscored: true });

  CertificateReviewQuestion.associate = function (models) {
    if (models.CertificateTemplate) {
      CertificateReviewQuestion.belongsTo(models.CertificateTemplate, { foreignKey: 'templateId', as: 'template' });
    }
    if (models.User) {
      CertificateReviewQuestion.belongsTo(models.User, { foreignKey: 'menteeId', as: 'mentee' });
      CertificateReviewQuestion.belongsTo(models.User, { foreignKey: 'askedBy', as: 'asker' });
      CertificateReviewQuestion.belongsTo(models.User, { foreignKey: 'addressedTo', as: 'addressee' });
      CertificateReviewQuestion.belongsTo(models.User, { foreignKey: 'answeredBy', as: 'answerer' });
    }
    if (models.Clan) {
      CertificateReviewQuestion.belongsTo(models.Clan, { foreignKey: 'clanId', as: 'clan' });
    }
  };

  // 4. CertificateClanApproval — the admin recording approval of a clan's review.
  //
  // Verified and approved are different facts. "My mentors have finished
  // checking" is the mentors' statement; approval is the admin's finalization
  // milestone and lets the clan's mentors perform the separate send action.
  const CertificateClanApproval = sequelize.define('CertificateClanApproval', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    organizationId: { type: DataTypes.UUID, allowNull: false, field: 'organization_id' },
    templateId: { type: DataTypes.UUID, allowNull: false, field: 'template_id' },
    clanId: { type: DataTypes.UUID, allowNull: false, field: 'clan_id' },
    approvedBy: { type: DataTypes.UUID, field: 'approved_by' },
    approvedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'approved_at' },
    /** Released while mentors were still reviewing — allowed, but worth seeing. */
    approvedBeforeVerified: {
      type: DataTypes.BOOLEAN, defaultValue: false, field: 'approved_before_verified'
    },
    note: { type: DataTypes.TEXT }
  }, { tableName: 'certificate_clan_approvals', underscored: true });

  CertificateClanApproval.associate = function (models) {
    if (models.CertificateTemplate) {
      CertificateClanApproval.belongsTo(models.CertificateTemplate, { foreignKey: 'templateId', as: 'template' });
    }
    if (models.Clan) {
      CertificateClanApproval.belongsTo(models.Clan, { foreignKey: 'clanId', as: 'clan' });
    }
    if (models.User) {
      CertificateClanApproval.belongsTo(models.User, { foreignKey: 'approvedBy', as: 'approver' });
    }
  };

  return [CertificateTemplate, CertificateInstance, CertificateVerification, CertificateClanApproval, CertificateReviewQuestion];
};
