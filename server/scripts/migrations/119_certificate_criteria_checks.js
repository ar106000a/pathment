/** Store the mentor/admin checklist attested during certificate review. */
const sequelize = require('./_db');

async function up() {
  await sequelize.query(`
    ALTER TABLE certificate_verifications
      ADD COLUMN IF NOT EXISTS criteria_checks JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
  console.log('✓ certificate_verifications.criteria_checks is ready');
}

async function down() {
  await sequelize.query('ALTER TABLE certificate_verifications DROP COLUMN IF EXISTS criteria_checks');
  console.log('✓ certificate_verifications.criteria_checks removed');
}

module.exports = { up, down };

if (require.main === module) {
  (process.argv.includes('--rollback') ? down() : up())
    .catch(error => { console.error('Migration failed:', error.message); process.exitCode = 1; })
    .finally(() => sequelize.close());
}
