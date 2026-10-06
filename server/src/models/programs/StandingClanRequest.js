module.exports = (sequelize, D) => {
  const model = sequelize.define('StandingClanRequest', {
    id: { type: D.UUID, defaultValue: D.UUIDV4, primaryKey: true },
    programId: { type: D.UUID, allowNull: false, field: 'program_id' },
    mentorId: { type: D.UUID, allowNull: false, field: 'mentor_id' },
    name: { type: D.STRING(150), allowNull: false },
    description: { type: D.TEXT },
    status: { type: D.STRING(20), allowNull: false, defaultValue: 'pending', validate: { isIn: [['pending', 'approved', 'rejected']] } },
    reviewedBy: { type: D.UUID, field: 'reviewed_by' },
    reviewedAt: { type: D.DATE, field: 'reviewed_at' },
    decisionNote: { type: D.TEXT, field: 'decision_note' },
    createdClanId: { type: D.UUID, field: 'created_clan_id' },
  }, { tableName: 'standing_clan_requests', underscored: true, indexes: [
    { unique: true, fields: ['mentor_id', 'program_id'], where: { status: 'pending' }, name: 'standing_request_pending_unique' },
    { unique: true, fields: ['created_clan_id'] },
  ] });
  model.associate = m => {
    model.belongsTo(m.Program, { foreignKey: 'programId', as: 'program' });
    model.belongsTo(m.User, { foreignKey: 'mentorId', as: 'mentor' });
    model.belongsTo(m.User, { foreignKey: 'reviewedBy', as: 'reviewer' });
    model.belongsTo(m.Clan, { foreignKey: 'createdClanId', as: 'createdClan' });
  };
  return model;
};
