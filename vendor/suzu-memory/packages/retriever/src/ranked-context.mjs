import { fuseCandidateLanes } from './candidate-selection.mjs';
import { lexicalTerms } from './query.mjs';
import { utteranceStatements } from './query-text.mjs';
import { createSeedLexicalScorer } from './seed-routes.mjs';

const clean = value => String(value || '').normalize('NFKC').toLowerCase().trim();
const occurrenceKey = node => [node.world_id, node.world_frame, node.subject_role, node.subject_key,
  node.kind === 'utterance' ? node.metadata?.speaker : '', node.event_date, node.event_start,
  node.valid_from, node.valid_to, node.evidence_mode, node.representation_layer, node.temporal_state,
  node.state_family, node.state_phase].join('\u001f');

function evidenceCoverage(database, agentId, pool, eligibleMemoryIds, options) {
  const budget = Math.max(1, Math.trunc(Number(options.maximumActivationWork) || 100));
  const depthLimit = Math.max(1, Math.trunc(Number(options.maximumChainDepth) || 3));
  const ids = new Set(pool.map(candidate => candidate.node.id)), children = new Map();
  let frontier = [...ids], edgeRows = 0, queries = 0;
  for (let depth = 0; depth < depthLimit && frontier.length && edgeRows < budget; depth++) {
    const placeholders = frontier.map(() => '?').join(',');
    const rows = database.prepare(`
      SELECT from_memory_id AS parent, to_memory_id AS child FROM memory_edges INDEXED BY memory_edges_from
        WHERE agent_id = ? AND from_memory_id IN (${placeholders}) AND relation = 'supported_by'
      UNION ALL
      SELECT to_memory_id AS parent, from_memory_id AS child FROM memory_edges INDEXED BY memory_edges_to
        WHERE agent_id = ? AND to_memory_id IN (${placeholders}) AND relation IN ('supports_topic', 'part_of_episode')
      LIMIT ?
    `).all(agentId, ...frontier, agentId, ...frontier, budget - edgeRows);
    queries++;
    edgeRows += rows.length;
    const next = new Set();
    for (const { parent, child } of rows) {
      if (!eligibleMemoryIds.has(child)) continue;
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(child);
      if (!ids.has(child)) { ids.add(child); next.add(child); }
    }
    frontier = [...next];
  }
  const sourceRows = ids.size ? database.prepare(`SELECT memory_id, source_id FROM memory_sources
    WHERE memory_id IN (${[...ids].map(() => '?').join(',')}) LIMIT ?`).all(...ids, budget * 4) : [];
  if (ids.size) queries++;
  const direct = new Map();
  for (const row of sourceRows) {
    if (!direct.has(row.memory_id)) direct.set(row.memory_id, new Set());
    direct.get(row.memory_id).add(row.source_id);
  }
  const sources = new Map(pool.map(candidate => {
    const seen = new Set(), pending = [candidate.node.id], result = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const source of direct.get(id) || []) result.add(source);
      pending.push(...(children.get(id) || []));
    }
    return [candidate.node.id, result];
  }));
  return { sources, queries, edgeRows, sourceRows: sourceRows.length };
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const term of left) if (right.has(term)) common++;
  return common / Math.max(left.size, right.size);
}

function cosine(left, right) {
  if (!left?.length || left.length !== right?.length) return 0;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? Math.max(0, dot / Math.sqrt(leftNorm * rightNorm)) : 0;
}

/** Choose complete evidence units after discovery. Record limits apply here,
 * not to graph seeds; neighboring dialogue never bypasses this selection. */
export function selectRankedContext({
  database, agentId, candidates, eligibleMemoryIds, subjectConstraint,
  preparedQuery, scoreLexical = createSeedLexicalScorer(preparedQuery), embeddingVectors = new Map(), maximum, options = {},
}) {
  const pool = fuseCandidateLanes(candidates, [], Number.MAX_SAFE_INTEGER);
  const byId = new Map(pool.map(candidate => [candidate.node.id, candidate]));
  const coverage = evidenceCoverage(database, agentId, pool, eligibleMemoryIds, options);
  const allowed = node => node && eligibleMemoryIds.has(node.id)
    && !subjectConstraint.hardExcludedMemoryIds.has(node.id);
  const features = new Map();
  const describe = node => {
    if (!features.has(node.id)) {
      const text = clean(node.kind === 'utterance' ? utteranceStatements(node.content).text : node.content);
      features.set(node.id, { key: occurrenceKey(node), text,
        identityKnown: Boolean((node.subject_role && node.subject_role !== 'unknown' && node.subject_key)
          || (node.kind === 'utterance' && node.metadata?.speaker)),
        world: [node.world_id, node.world_frame].join('\u001f'),
        sources: coverage.sources.get(node.id) || new Set(),
        terms: new Set(lexicalTerms(text)), vector: embeddingVectors.get(node.id) });
    }
    return features.get(node.id);
  };
  // One indexed lookup per question-bearing candidate. Only a forward reply
  // from this agent/snapshot can complete the exchange.
  const nextReply = database.prepare(`
    SELECT node.* FROM memory_edges AS edge
    JOIN memory_nodes AS node ON node.id = edge.to_memory_id AND node.agent_id = edge.agent_id
    WHERE edge.agent_id = ? AND edge.from_memory_id = ? AND edge.relation = 'followed_by'
      AND edge.weight >= 0.65 AND node.kind = 'utterance' AND node.status = 'active'
    ORDER BY edge.weight DESC, node.event_start, node.id LIMIT 20
  `);
  const units = [], replyReads = new Set();
  let replyRows = 0;
  for (const candidate of pool) {
    const node = candidate.node;
    if (!allowed(node)) continue;
    if (node.kind !== 'utterance') {
      units.push({ nodes: [node], relevance: candidate.score });
      continue;
    }
    const parts = scoreLexical.dialogue(node);
    const needsReply = parts.hasQuestion && (!parts.text.trim()
      || parts.questionRelevance > parts.statementRelevance);
    if (!needsReply) {
      units.push({ nodes: [node], relevance: candidate.score });
      continue;
    }
    replyReads.add(node.id);
    const rows = nextReply.all(agentId, node.id);
    replyRows += rows.length;
    const reply = rows.find(row => allowed(row)
      && row.world_id === node.world_id && row.world_frame === node.world_frame
      && (row.subject_role !== node.subject_role || row.subject_key !== node.subject_key));
    if (!reply) {
      // A topic-matching question is a discovery anchor, not an answer.
      // Explicit original-wording/evidence requests use their own disclosure.
      continue;
    }
    const parsed = byId.get(reply.id)?.node || { ...reply, metadata: JSON.parse(reply.metadata_json || '{}') };
    // With a one-record budget, retain the available answer rather than
    // spending the only slot on the question we already have in the query.
    units.push({ nodes: maximum === 1 ? [parsed] : [node, parsed],
      relevance: Math.max(candidate.score, byId.get(reply.id)?.score || 0) });
  }
  const selected = new Map(), decisions = [], remaining = new Set(units), similarities = new Map();
  const similarity = (node, other) => {
    const key = [node.id, other.id].sort().join('\u001f');
    if (similarities.has(key)) return similarities.get(key);
    const left = describe(node), right = describe(other);
    if (left.world !== right.world) return 0;
    if (left.identityKnown && left.key === right.key && left.text && left.text === right.text) return 1;
    // Related subject matter is not duplicate information. A shared source
    // is required before semantic similarity lowers a distinct fact's rank.
    const sharedEvidence = overlap(left.sources, right.sources);
    if (!sharedEvidence) return 0;
    const textOverlap = overlap(left.terms, right.terms);
    const value = sharedEvidence * (left.vector && right.vector
      ? (textOverlap + cosine(left.vector, right.vector)) / 2 : textOverlap);
    similarities.set(key, value);
    return value;
  };
  while (remaining.size && selected.size < maximum) {
    let best = null;
    for (const unit of remaining) {
      const fresh = unit.nodes.filter(node => !selected.has(node.id));
      if (!fresh.length || selected.size + fresh.length > maximum) continue;
      // Identical wording for the same holder/world adds no new information.
      // Other overlap only lowers priority; different facts are never deleted.
      const duplicate = fresh.every(node => [...selected.values()].some(other => {
        const a = describe(node), b = describe(other);
        return a.identityKnown && a.key === b.key && a.text && a.text === b.text;
      }));
      if (duplicate) continue;
      const redundancy = fresh.reduce((sum, node) => sum + Math.max(0,
        ...[...selected.values()].map(other => similarity(node, other))), 0) / fresh.length;
      const utility = unit.relevance * (1 - redundancy / 2);
      if (!best || utility > best.utility) best = { unit, fresh, redundancy, utility };
    }
    if (!best) break;
    remaining.delete(best.unit);
    for (const node of best.fresh) selected.set(node.id, node);
    decisions.push({ memoryIds: best.fresh.map(node => node.id), relevance: best.unit.relevance,
      redundancy: best.redundancy, utility: best.utility });
  }
  return { nodes: [...selected.values()], audit: {
    candidateCount: pool.length, unitCount: units.length, selectedRecordCount: selected.size,
    coverageQueries: coverage.queries, coverageEdgeRows: coverage.edgeRows, coverageSourceRows: coverage.sourceRows,
    replyLookupCount: replyReads.size, replyRows, decisions,
  } };
}
