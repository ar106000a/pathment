const { models, sequelize } = require('../db');

/** Merge by recipient, never by run: a clan run is only a partial update. */
function mergeResults(previous, incoming) {
  const merged = new Map();
  for (const result of [...(Array.isArray(previous) ? previous : []), ...incoming]) {
    const id = result?.mentee_id || result?.id;
    if (!id || result._failed || result._skipped) continue;
    const existing = merged.get(id);
    // An older, slower run must not replace a newer decision.
    if (existing?.evaluatedAt && result.evaluatedAt &&
        new Date(existing.evaluatedAt) > new Date(result.evaluatedAt)) continue;
    merged.set(id, { ...result, mentee_id: id });
  }
  return [...merged.values()];
}

async function saveResults(templateId, results, { transaction: existingTransaction } = {}) {
  if (!results.length) return;
  const save = async transaction => {
    const template = await models.CertificateTemplate.findByPk(templateId, {
      transaction, lock: transaction.LOCK.UPDATE
    });
    if (!template) return;
    const previous = template.aiEvaluation || {};
    const merged = mergeResults(previous.results, results);
    const ranAt = new Date().toISOString();
    await template.update({
      aiEvaluation: { ...previous, results: merged, ranAt },
      aiEvaluationRanAt: ranAt
    }, { transaction });
  };
  return existingTransaction ? save(existingTransaction) : sequelize.transaction(save);
}

module.exports = { mergeResults, saveResults };
