const { requireWorkspaceId } = require('../utils/workspaceExecution');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../db');

/** Count people, not assignments: a mentor may lead several clans or also have a legacy match. */
async function programMentorCounts(programIds, transaction) {
  if (!programIds.length) return new Map();
  const rows = await sequelize.query(`
    SELECT program_id, COUNT(DISTINCT mentor_id)::integer AS count
    FROM (
      SELECT c.program_id, cm.user_id AS mentor_id
      FROM clans c JOIN clan_memberships cm ON cm.clan_id = c.id
      WHERE c.organization_id=:organizationId AND cm.organization_id=:organizationId AND c.program_id IN (:programIds) AND c.status = 'active'
        AND c.kind = 'cohort'
        AND cm.status = 'active' AND cm.role IN ('lead_mentor', 'co_mentor')
      UNION
      SELECT program_id, lead_mentor_id AS mentor_id FROM clans
      WHERE organization_id=:organizationId AND program_id IN (:programIds) AND status = 'active' AND lead_mentor_id IS NOT NULL
        AND kind = 'cohort'
      UNION
      SELECT e.program_id, mm.mentor_id
      FROM mentor_mentee_matches mm JOIN enrollments e ON e.id = mm.enrollment_id
      WHERE e.organization_id=:organizationId AND mm.organization_id=:organizationId AND e.program_id IN (:programIds) AND mm.status = 'active'
    ) assignments GROUP BY program_id`, {
    replacements: { programIds, organizationId: requireWorkspaceId() }, type: QueryTypes.SELECT, transaction,
  });
  return new Map(rows.map(row => [row.program_id, Number(row.count)]));
}
module.exports = { programMentorCounts };
