const { models, sequelize } = require('../db');
const { NotFoundError, ValidationError } = require('../utils/errors/errorTypes');

const fullName = (u) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);

/** Rewards: gift catalog + redemptions. */
class RewardsService {
  /**
   * The catalogue, plus who has spent points recently.
   *
   * The history is scoped to the caller's own clans unless they administer the
   * programme. It used to be the latest twenty redemptions across the whole
   * organisation for everyone who could read this route, so a mentor of one
   * clan was shown the names of mentees in clans they have nothing to do with.
   * Pass no viewer and it stays org wide, which is what an admin screen wants.
   */
  async overview(viewer = null, portalRole = null) {
    const selfView = viewer && (portalRole === 'mentee' || (!portalRole && viewer.role === 'mentee'));
    const scopeToClans = viewer && !selfView && !(await require('./authzService').can(viewer, require('../config/permissions').PERMISSIONS.MENTEE_VIEW, { orgWide: true }));

    let menteeIds = null;
    if (selfView) {
      menteeIds = [viewer.id];
    } else if (scopeToClans) {
      const mine = await models.ClanMembership.findAll({
        where: { userId: viewer.id, status: 'active' },
        attributes: ['clanId']
      });
      const clanIds = [...new Set(mine.map((row) => row.clanId))];

      const members = clanIds.length
        ? await models.ClanMembership.findAll({
            where: { clanId: clanIds, role: 'mentee', status: 'active' },
            attributes: ['userId']
          })
        : [];

      menteeIds = [...new Set(members.map((row) => row.userId))];
    }

    const [gifts, redemptions] = await Promise.all([
      models.Gift.findAll({ where: { active: true }, order: [['created_at', 'DESC']] }),
      // No clan means nobody to show, rather than everybody.
      menteeIds && menteeIds.length === 0
        ? []
        : models.Redemption.findAll({
            where: menteeIds ? { menteeId: menteeIds } : undefined,
            order: [['created_at', 'DESC']],
            limit: 20,
            include: [
              { model: models.Gift, as: 'gift', attributes: ['name'] },
              { model: models.User, as: 'mentee', attributes: ['firstName', 'lastName'] }
            ]
          })
    ]);

    return {
      gifts: gifts.map((g) => ({ id: g.id, name: g.name, description: g.description, costXp: g.costXp, imageUrl: g.imageUrl, stock: g.stock })),
      redemptions: redemptions.map((r) => ({
        id: r.id,
        gift: r.gift?.name || 'Gift',
        mentee: fullName(r.mentee),
        costXp: r.costXp,
        at: r.createdAt
      }))
    };
  }

  async createGift(data, createdBy) {
    if (!data.name || !data.name.trim()) throw new ValidationError('name is required');
    return models.Gift.create({
      name: data.name.trim(),
      description: data.description || null,
      costXp: Number.isFinite(Number(data.costXp)) ? Number(data.costXp) : 0,
      imageUrl: data.imageUrl || null,
      stock: data.stock === null || data.stock === undefined || data.stock === '' ? null : Number(data.stock),
      active: true,
      createdBy
    });
  }

  async updateGift(id, data) {
    const g = await models.Gift.findByPk(id);
    if (!g) throw new NotFoundError('Gift not found');
    if (data.name !== undefined) g.name = data.name;
    if (data.description !== undefined) g.description = data.description;
    if (data.costXp !== undefined) g.costXp = Number.isFinite(Number(data.costXp)) ? Number(data.costXp) : g.costXp;
    if (data.imageUrl !== undefined) g.imageUrl = data.imageUrl || null;
    if (data.stock !== undefined) g.stock = data.stock === null || data.stock === '' ? null : Number(data.stock);
    if (data.active !== undefined) g.active = !!data.active;
    await g.save();
    return { id: g.id, name: g.name, description: g.description, costXp: g.costXp, imageUrl: g.imageUrl, stock: g.stock, active: g.active };
  }

  async removeGift(id) {
    const g = await models.Gift.findByPk(id);
    if (!g) throw new NotFoundError('Gift not found');
    g.active = false;
    await g.save();
    return { removed: true };
  }

  /** A mentee's spendable points = points earned across enrollments − points already redeemed. */
  async menteePointsBalance(menteeId) {
    const [enrollments, redemptions] = await Promise.all([
      models.Enrollment.findAll({ where: { menteeId }, attributes: ['totalPointsEarned'] }),
      models.Redemption.findAll({ where: { menteeId }, attributes: ['costXp'] })
    ]);
    const earned = enrollments.reduce((s, e) => s + (e.totalPointsEarned || 0), 0);
    const spent = redemptions.reduce((s, r) => s + (r.costXp || 0), 0);
    return { earned, spent, balance: earned - spent };
  }

  async redeem(giftId, menteeId, redeemedBy) {
    if (!giftId || !menteeId) throw new ValidationError('giftId and menteeId are required');
    return sequelize.transaction(async (transaction) => {
      const gift = await models.Gift.findByPk(giftId, { transaction });
      if (!gift || !gift.active) throw new NotFoundError('Gift not available');
      // Mentees spend points they've earned from completed work.
      const { balance } = await this.menteePointsBalance(menteeId);
      if (gift.costXp > 0 && balance < gift.costXp) {
        throw new ValidationError(`Not enough points - mentee has ${balance}, needs ${gift.costXp}`);
      }
      if (gift.stock !== null) {
        if (gift.stock <= 0) throw new ValidationError('This gift is out of stock');
        gift.stock -= 1;
        await gift.save({ transaction });
      }
      return models.Redemption.create({ giftId, menteeId, redeemedBy, costXp: gift.costXp }, { transaction });
    });
  }
}

module.exports = new RewardsService();
