const { models } = require('../db');
const { ClanFrozenError, NotFoundError } = require('../utils/errors/errorTypes');

/**
 * The single write boundary for completed programme clans.
 *
 * UI flags are guidance, not authorization. Every domain that mutates a clan
 * calls this service so web, mobile, old clients and direct API calls receive
 * the same answer. Standing clans deliberately remain writable even though
 * their source programme is closed.
 */
class ClanLifecycleService {
  async assertClanWritable(clanId, { transaction } = {}) {
    if (!clanId) return null;
    const clan = await models.Clan.findByPk(clanId, {
      attributes: ['id', 'name', 'kind', 'frozenAt', 'programId'],
      transaction,
    });
    if (!clan) throw new NotFoundError('Clan not found');
    if (clan.kind !== 'standing' && clan.frozenAt) {
      throw new ClanFrozenError(`${clan.name} is read-only because its programme has closed. Request a standing clan to continue mentoring.`);
    }
    return clan;
  }

  async assertEnrollmentWritable(enrollmentId, { transaction } = {}) {
    if (!enrollmentId) return null;
    const enrollment = await models.Enrollment.findByPk(enrollmentId, {
      attributes: ['id', 'programId'],
      include: [{ model: models.Program, as: 'program', attributes: ['id', 'name', 'closedAt'] }],
      transaction,
    });
    if (!enrollment) throw new NotFoundError('Enrollment not found');
    if (enrollment.program?.closedAt) {
      throw new ClanFrozenError(`${enrollment.program.name} has closed. Its programme work is read-only.`);
    }
    return enrollment;
  }

  async assertTaskWritable(taskOrId, { transaction } = {}) {
    const id = typeof taskOrId === 'object' ? taskOrId?.id : taskOrId;
    if (!id) throw new NotFoundError('Task not found');
    const task = await models.AssignedTask.findByPk(id, {
      attributes: ['id', 'clanId', 'enrollmentId'],
      transaction,
    });
    if (!task) throw new NotFoundError('Task not found');
    if (task.clanId) await this.assertClanWritable(task.clanId, { transaction });
    else if (task.enrollmentId) await this.assertEnrollmentWritable(task.enrollmentId, { transaction });
    return task;
  }
}

module.exports = new ClanLifecycleService();
