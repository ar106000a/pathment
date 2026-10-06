/* eslint-disable no-console */

/**
 * A mentee can participate in more than one clan. Migration 104 added the two
 * correct partial keys, but databases originally created by Sequelize also
 * retained `daily_log_entries_mentee_id_date_key`. Migration 114 later prefixed
 * that broad key with organization_id, but it still allowed only one daily log
 * across every clan on a date.
 */
async function up({ db = require('./_db') } = {}) {
  await db.transaction(async (transaction) => {
    const query = (sql) => db.query(sql, { transaction });

    await query('DROP INDEX IF EXISTS daily_log_entries_mentee_id_date_key');
    await query('DROP INDEX IF EXISTS daily_log_mentee_date_unique');

    await query(`CREATE UNIQUE INDEX IF NOT EXISTS daily_log_entries_mentee_date_clan_unique
      ON daily_log_entries (organization_id, mentee_id, date_key, clan_id)
      WHERE clan_id IS NOT NULL`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS daily_log_entries_mentee_date_legacy_unique
      ON daily_log_entries (organization_id, mentee_id, date_key)
      WHERE clan_id IS NULL`);
  });
  console.log('✓ Daily logs are unique per workspace, mentee, day, and clan');
}

async function down() {
  throw new Error('Cannot safely collapse multiple clan logs into one daily log');
}

module.exports = { up, down };

if (require.main === module) {
  const db = require('./_db');
  (process.argv.includes('--rollback') ? down() : up({ db }))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => db.close());
}
