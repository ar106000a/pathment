module.exports = (sequelize, DataTypes) => {
  const Enrollment = sequelize.define('Enrollment', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    organizationId: { type: DataTypes.UUID, allowNull: false, field: 'organization_id' },
    menteeId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'mentee_id'
    },
    programId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'program_id'
    },
    // Intake batch this enrollment came from (stamped at registration when the
    // invite carried a cohort). Nullable for direct/admin enrollments.
    cohortId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'cohort_id'
    },
    status: {
      type: DataTypes.STRING(25),
      defaultValue: 'pending_approval',
      validate: {
        isIn: [['pending_approval', 'approved', 'rejected', 'pending_match', 'matched', 'active', 'pending_completion', 'level_completed', 'program_completed', 'dropped']]
      }
    },
    currentWeek: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      field: 'current_week'
    },
    tasksCompleted: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'tasks_completed'
    },
    tasksTotal: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'tasks_total'
    },
    overallProgressPercentage: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0.00,
      field: 'overall_progress_percentage'
    },
    completionRequestedAt: {
      type: DataTypes.DATE,
      field: 'completion_requested_at'
    },
    completionRequestedBy: {
      type: DataTypes.UUID,
      field: 'completion_requested_by'
    },
    completionRequestedByRole: {
      type: DataTypes.STRING(20),
      field: 'completion_requested_by_role'
    },
    completionApprovedAt: {
      type: DataTypes.DATE,
      field: 'completion_approved_at'
    },
    completionApprovedBy: {
      type: DataTypes.UUID,
      field: 'completion_approved_by'
    },
    completionApprovedByRole: {
      type: DataTypes.STRING(20),
      field: 'completion_approved_by_role'
    },
    completionRejectionReason: {
      type: DataTypes.TEXT,
      field: 'completion_rejection_reason'
    },
    nextLevelEnrolledAt: {
      type: DataTypes.DATE,
      field: 'next_level_enrolled_at'
    },
    enrolledAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      field: 'enrolled_at'
    },
    startedAt: {
      type: DataTypes.DATE,
      field: 'started_at'
    },
    completedAt: {
      type: DataTypes.DATE,
      field: 'completed_at'
    },
    droppedAt: {
      type: DataTypes.DATE,
      field: 'dropped_at'
    },
    expectedCompletionDate: {
      type: DataTypes.DATEONLY,
      field: 'expected_completion_date'
    },
    avgTaskRating: {
      type: DataTypes.DECIMAL(3, 2),
      field: 'avg_task_rating'
    },
    totalPointsEarned: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'total_points_earned'
    },
    // When a roadmap completes, auto-assign the next one in the chain. Mentors
    // can turn this off for a mentee whose path they want to hand-pick.
    autoAdvanceRoadmaps: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: 'auto_advance_roadmaps'
    }
  }, {
    tableName: 'enrollments',
    underscored: true,
    indexes: [
      { unique: true, fields: ['mentee_id', 'program_id'] },
      { fields: ['mentee_id'] },
      { fields: ['program_id'] },
      { fields: ['status'] },
      // FK on a high-volume table — indexed for cohort-scoped queries + cascades.
      { fields: ['cohort_id'] }
    ],
    hooks: {
      afterCreate: async (enrollment, options) => {
        // Increment program's current_enrollments counter
        const program = await sequelize.models.Program.findByPk(enrollment.programId, { transaction: options.transaction });
        if (program) {
          await program.increment('currentEnrollments', { transaction: options.transaction });
        }
        
        // Increment mentee's total_programs_enrolled
        const menteeProfile = await sequelize.models.MenteeProfile.findOne({
          where: { user_id: enrollment.menteeId }, transaction: options.transaction
        });
        if (menteeProfile) {
          await menteeProfile.increment('totalProgramsEnrolled', { transaction: options.transaction });
        }
      }
    }
  });

  Enrollment.associate = (models) => {
    Enrollment.belongsTo(models.User, { foreignKey: 'mentee_id', as: 'mentee' });
    Enrollment.belongsTo(models.Program, { foreignKey: 'program_id', as: 'program' });
    Enrollment.belongsTo(models.Cohort, { foreignKey: 'cohort_id', as: 'cohort' });
    Enrollment.hasMany(models.MentorMenteeMatch, { foreignKey: 'enrollment_id', as: 'matches' });
  };

  return Enrollment;
};
