const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { sequelize } = require('../src/db');

async function checkDatabase() {
  try {
    await sequelize.authenticate();
    const [[result]] = await sequelize.query(
      `SELECT current_database() AS database,
              COUNT(*)::int AS applied_migrations
         FROM schema_migrations`,
    );
    console.log(`✓ Connected to ${result.database}`);
    console.log(`✓ ${result.applied_migrations} migrations recorded`);
  } catch (error) {
    console.error(`✗ Database check failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

void checkDatabase();
