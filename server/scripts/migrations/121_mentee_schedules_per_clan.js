'use strict';

/**
 * A mentee can belong to more than one clan and therefore needs one schedule
 * per clan. Migration 104 added the correct partial indexes, but installations
 * originally created through Sequelize can retain `mentee_schedules_mentee_id`.
 * Migration 114 tenant-prefixed that obsolete unique index, which still blocks
 * the second clan schedule.
 */
async function up({ db = require('./_db') } = {}) {
  await db.transaction(async (transaction) => {
    const query = (sql) => db.query(sql, { transaction });
    await query('DROP INDEX IF EXISTS mentee_schedules_mentee_id');
    await query('DROP INDEX IF EXISTS mentee_schedules_mentee_unique');
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mentee_schedules_mentee_clan_unique
      ON mentee_schedules (organization_id, mentee_id, clan_id)
      WHERE clan_id IS NOT NULL
    `);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mentee_schedules_mentee_legacy_unique
      ON mentee_schedules (organization_id, mentee_id)
      WHERE clan_id IS NULL
    `);
  });
}

async function down() {
  throw new Error('Cannot safely collapse multiple clan schedules into one schedule');
}

module.exports = { up, down };

if (require.main === module) {
  const db = require('./_db');
  (process.argv.includes('--rollback') ? down() : up({ db }))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => db.close());
}
