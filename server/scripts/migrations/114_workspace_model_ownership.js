/*
 * This is the ownership inventory at the moment migration 114 shipped.
 *
 * Never import the live tenantOwnership config here. Later migrations add new
 * workspace tables, and an older database must be able to run 114 before those
 * tables exist. In particular, standing_clan_requests is created by 116. When
 * it was added to the live inventory, importing that inventory made an upgrade
 * from 113 fail before 114 could alter a single table.
 */
const TABLES = Object.freeze([
  'skills',
  'open_source_orgs',
  'product_updates',
  'activity_sessions',
  'adaptive_recommendations',
  'analytics_events',
  'mentee_analytics',
  'mentor_analytics',
  'program_analytics',
  'skill_assessments',
  'task_analytics',
  'challenges',
  'gifts',
  'redemptions',
  'user_challenges',
  'assessments',
  'assessment_questions',
  'assessment_submissions',
  'cohort_assessments',
  'rubric_snippets',
  'interview_answers',
  'interview_assignments',
  'interview_kits',
  'interview_questions',
  'interview_sessions',
  'message_attachments',
  'message_reactions',
  'clan_change_requests',
  'clan_join_requests',
  'clan_member_permissions',
  'cross_clan_assignments',
  'program_reviews',
  'email_queue',
  'ai_evaluation_queue',
  'quiz_answers',
  'quiz_assignments',
  'quiz_kits',
  'quiz_questions',
  'quiz_sessions',
  'admin_meetings',
  'availability_rules',
  'availability_slots',
  'cohort_review_entries',
  'cohort_review_sessions',
  'cohort_review_unlock_grants',
  'cohort_review_unlock_requests',
  'meeting_notes',
  'mentee_schedules',
  'review_schedules',
  'schedule_templates',
  'scheduled_meetings',
  'announcement_reactions',
  'community_comments',
  'community_reactions',
  'community_reports',
  'feedback_reports',
  'file_uploads',
  'scheduled_jobs',
  'daily_log_entries',
  'delay_events',
  'feedback_snippets',
  'mentor_mentee_matches',
  'roadmap_links',
  'roadmap_progress',
  'task_feedback',
  'task_progress_entries',
  'task_resources',
  'task_skills',
  'task_submission_files',
  'tracks',
  'admin_profiles',
  'collaborators',
  'insights',
  'mentee_profiles',
  'mentor_profiles',
  'performance_nominations',
  'promotion_candidates',
  'user_skills',
  'mentor_style_profiles',
  'knowledge_chunks',
  'rag_ingestion_jobs',
  'message_drafts',
  'mentor_edit_histories',
]);
const quote = value => `"${String(value).replace(/"/g, '""')}"`;

async function up({ db = require('./_db'), maintenance = process.env.MIGRATION_114_MAINTENANCE === 'true' } = {}) {
  if (!maintenance) throw new Error('Migration 114 requires MIGRATION_114_MAINTENANCE=true with all writers stopped');
  if (process.env.MULTI_TENANT_WORKSPACES_ENABLED === 'true') {
    throw new Error('Disable workspace onboarding before migration 114');
  }
  await db.transaction(async transaction => {
    const query = (sql, replacements) => db.query(sql, { transaction, replacements });
    await query("SET LOCAL lock_timeout = '5s'");
    await query("SET LOCAL statement_timeout = '2min'");
    await query("SELECT pg_advisory_xact_lock(hashtext('pathment:workspace-ownership:114'))");
    await query('CREATE TABLE IF NOT EXISTS migration_114_completion (id INTEGER PRIMARY KEY CHECK (id = 1), completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const [[marker]] = await query('SELECT count(*)::int AS count FROM migration_114_completion');
    if (marker.count) return;
    const [[organization]] = await query("SELECT id FROM organizations WHERE slug = 'devweekends'");
    if (!organization) throw new Error('DevWeekends foundation migration must run first');
    for (const table of TABLES) {
      const [[state]] = await query(`SELECT to_regclass(:table) IS NOT NULL AS present,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=:table AND column_name='organization_id') AS owned`, { table });
      if (!state.present || state.owned) throw new Error(`Unexpected schema for ${table}; reconcile before migrating`);
      await query(`ALTER TABLE ${quote(table)} ADD COLUMN organization_id UUID NOT NULL DEFAULT CAST(:id AS uuid)`, { id: organization.id });
      await query(`ALTER TABLE ${quote(table)} ALTER COLUMN organization_id DROP DEFAULT`);
      await query(`ALTER TABLE ${quote(table)} ADD CONSTRAINT ${quote(`${table}_organization_fk`)} FOREIGN KEY (organization_id) REFERENCES organizations(id)`);
      await query(`CREATE INDEX ${quote(`${table}_organization_idx`)} ON ${quote(table)} (organization_id)`);
    }

    // Inherit ownership from actual database relationships. This also handles
    // staging fixtures whose parents already belong to a nondefault workspace.
    const [links] = await query(`SELECT child.relname AS child, parent.relname AS parent,
      ca.attname AS child_key, pa.attname AS parent_key
      FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid
      JOIN pg_class parent ON parent.oid=c.confrelid
      JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=c.confkey[1]
      WHERE child.relnamespace='public'::regnamespace AND parent.relnamespace='public'::regnamespace AND c.contype='f' AND cardinality(c.conkey)=1 AND child.relname IN (:tables)
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=parent.oid AND a.attname='organization_id' AND NOT a.attisdropped)`, { tables: TABLES });
    let settled = false;
    for (let pass = 0; pass <= TABLES.length; pass++) {
      let changed = 0;
      for (const link of links) {
        const [[row]] = await query(`WITH changed AS (
          UPDATE ${quote(link.child)} child SET organization_id=parent.organization_id
          FROM ${quote(link.parent)} parent WHERE child.${quote(link.child_key)}=parent.${quote(link.parent_key)}
          AND child.organization_id<>parent.organization_id RETURNING child.id
        ) SELECT count(*)::int AS count FROM changed`);
        changed += row.count;
      }
      if (!changed) { settled = true; break; }
    }
    if (!settled) throw new Error('Conflicting parent workspace ownership; migration rolled back');

    // Account-scoped unique keys (profiles, daily activity, job names) must allow
    // the same account to participate independently in another workspace.
    const [indexes] = await query(`SELECT t.relname AS table_name, i.relname AS name,
      c.conname AS constraint_name, c.condeferrable AS deferred,
      pg_get_expr(x.indpred, x.indrelid) AS predicate,
      ARRAY(SELECT pg_get_indexdef(x.indexrelid, n, true) FROM generate_series(1, x.indnkeyatts) n) AS keys
      FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
      LEFT JOIN pg_constraint c ON c.conindid=x.indexrelid AND c.contype='u'
      WHERE t.relnamespace='public'::regnamespace AND t.relname IN (:tables) AND x.indisunique AND NOT x.indisprimary`, { tables: TABLES });
    for (const index of indexes) {
      if (index.deferred) throw new Error(`Deferrable key ${index.name} needs explicit migration`);
      if (index.constraint_name) await query(`ALTER TABLE ${quote(index.table_name)} DROP CONSTRAINT ${quote(index.constraint_name)}`);
      else await query(`DROP INDEX ${quote(index.name)}`);
      await query(`CREATE UNIQUE INDEX ${quote(index.name)} ON ${quote(index.table_name)} (organization_id, ${index.keys.join(', ')})${index.predicate ? ` WHERE ${index.predicate}` : ''}`);
    }
    await query('INSERT INTO migration_114_completion(id) VALUES(1)');
  });
}

async function down() {
  throw new Error('Workspace ownership cannot be removed after onboarding; restore a reviewed backup instead');
}
module.exports = { up, down, TABLES };
if (require.main === module) {
  const db = require('./_db');
  (process.argv.includes('--rollback') ? down() : up({ db }))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => db.close());
}
