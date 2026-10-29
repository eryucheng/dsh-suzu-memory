import { isProvisionalMemory as isProvisionalNode, isStructuredStateMemory as structuredStateNode } from '@suzu-memory/core';
import { lexicalScore, lexicalCoverage } from './query.mjs';
const clean = value => String(value ?? '').trim();
const EXPANDED_EVIDENCE_INTENTS = new Set([
  "utterance",
  "evidence",
  "counterevidence",
]);

function parseTimelineTime(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return Number.NaN;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    return Date.parse(`${normalized}T00:00:00.000Z`);
  }
  return Date.parse(normalized);
}

export function timelineOrderTime(node) {
  const candidates = structuredStateNode(node)
    ? [node.valid_from, node.event_start, node.event_date, node.known_at, node.recorded_at]
    : [node.event_start, node.event_date, node.known_at, node.recorded_at];
  for (const value of candidates) {
    const timestamp = parseTimelineTime(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NaN;
}

export function timelineEligibleNode(node) {
  if (!node || node.kind === "utterance" || node.kind === "topic") return false;
  if (
    node.kind === "topic_or_episode"
    && !clean(node.event_start)
    && !clean(node.event_date)
  ) return false;
  return Number.isFinite(timelineOrderTime(node));
}

export function isRepresentationStateCandidate(candidate) {
  return Boolean(
    clean(candidate?.node?.canonical_key)
    && clean(candidate?.node?.state_family)
    && ["reported", "inferred", "established"].includes(
      clean(candidate?.node?.representation_layer),
    ),
  );
}

export function sharesRepresentationStateSlot(left, right) {
  if (!isRepresentationStateCandidate(left) || !isRepresentationStateCandidate(right)) {
    return false;
  }
  return [
    "subject_role",
    "subject_key",
    "canonical_key",
    "state_family",
    "state_scope_key",
    "temporal_state",
  ].every((field) => clean(left.node[field]) === clean(right.node[field]));
}

function candidateRelevanceScore(candidate) {
  const value = Number(candidate?.score);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function candidateRecordedTimestamp(candidate) {
  const value = Date.parse(candidate?.node?.recorded_at || "");
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

export function fuseCandidateLanes(structuredCandidates, episodicCandidates, maximum) {
  const limit = Math.max(0, Math.trunc(Number(maximum) || 0));
  const byMemoryId = new Map();
  const addLane = (values, retrievalLane) => {
    values.forEach((candidate, index) => {
      const normalized = {
        ...candidate,
        retrievalLane: candidate.node.kind === "utterance" ? "episodic-evidence"
          : clean(candidate.retrievalLane) || retrievalLane || "structured-memory",
        laneRank: index + 1,
      };
      const existing = byMemoryId.get(candidate.node.id);
      if (!existing || candidateRelevanceScore(normalized) > candidateRelevanceScore(existing)) {
        byMemoryId.set(candidate.node.id, normalized);
      }
    });
  };
  addLane(structuredCandidates, "structured-memory");
  addLane(episodicCandidates, "episodic-evidence");

  // Candidate rank must express relevance, rather than alternate a structured
  // summary and raw evidence. The two lanes already use the same hybrid score
  // construction; the separate presentation formatter still decides how much
  // conclusion/evidence text reaches the model in an ordinary conversation.
  return [...byMemoryId.values()]
    .sort((left, right) => (
      candidateRelevanceScore(right) - candidateRelevanceScore(left)
      || Number(right.node.importance || 0) - Number(left.node.importance || 0)
      || candidateRecordedTimestamp(right) - candidateRecordedTimestamp(left)
      || clean(left.node.id).localeCompare(clean(right.node.id))
    ))
    .slice(0, limit);
}

function lifecycleStatus(text, query) {
  const blocked = /(?:不(?:再|是)?|没(?:有)?|未|尚未|还没|从未|并非|以为|认为|觉得|猜测|怀疑|听说|可能|也许|或许|大概|好像|似乎|估计|希望|盼望|想让|打算|计划|准备|将要|将会|即将|需要|应该|应当)|\b(?:not|never|no|cannot|can['’]t|won['’]t|(?:has|have|had|is|was|were|did|does|do)n['’]t|will|would|may|might|could|should|plan(?:s|ned|ning)?|hop(?:e[sd]?|ing)|(?:want|need|expect|intend|ask)(?:s|ed|ing)?|wish(?:es|ed|ing)?|thought|think(?:s|ing)?|believ(?:e[sd]?|ing)|assum(?:e[sd]?|ing)|guess(?:es|ed|ing)?|suspect(?:s|ed|ing)?|seem(?:s|ed)?|appear(?:s|ed)?|heard|reportedly|perhaps|maybe|apparently|supposedly|going to|scheduled to)\b/u;
  const conditional = /(?:如果|假如|假设|要是|倘若|只要|除非|是否)|\b(?:if|unless|whether|provided that|assuming)\b/u;
  const asksForArrival = /(?:到货|到达|\barriv(?:e|ed|al)\b)/iu.test(query)
    && !/(?:修好|修完|换好|完成|做完|办完|解决|恢复|结束|闭环|\b(?:finish|complete|fix|repair|resolve)(?:d|ed)?\b|\bdone\b)/iu.test(query);
  const patterns = [
    ['cancelled', /(?:取消|放弃)(?=了|完成)|(?<=(?:已经|已|后来|最终|最后|决定|确认).{0,8})(?:取消|放弃|不再继续)|\b(?:cancelled|canceled|abandoned|called off|gave up)\b/gu],
    ['completed', /(?:修好|修完|换好|完成|做完|办完|解决|恢复|结束|到货|闭环)(?=了|完成)|(?<=(?:已经|已|终于|后来|最终|成功).{0,8})(?:修好|修完|换好|完成|做完|办完|解决|恢复|结束|到货|闭环)|\b(?:finished|completed|fixed|repaired|resolved|arrived|(?:is|was|are|were|have|has|had) (?:now |finally |already )?done)\b/gu],
    ['pending', /(?:等待|等.{0,8}(?:到货|订货|处理|更换|维修|配件)|需要订货|过几天再|(?:还没(?:有)?|尚未|未|没(?:有)?|从未|从来没有)(?:能|被|完全|最终|成功|彻底){0,2}(?:修好|修完|换好|完成|做完|办完|解决|恢复|结束|到货|闭环)|待处理|待更换|待维修|进行中|(?:又|再次|重新).{0,4}(?:坏了|故障|不能用|无法使用))|\b(?:waiting|awaiting|pending|in progress|on hold|not yet|still needs?|needs? (?:to be )?(?:fixed|repaired|resolved)|(?:broke|broken|stopped working) again)\b/gu],
    ['pending', /\b(?:not|never|hasn['’]t|haven['’]t|isn['’]t|wasn['’]t|weren['’]t|didn['’]t|doesn['’]t|don['’]t)\s+(?:(?:yet|ever|still|already|actually|really|fully|been|being|be|have|had)\s+){0,4}(?:finish(?:ed)?|complete(?:d)?|fix(?:ed)?|repair(?:ed)?|resolve(?:d)?|arrive(?:d)?|done)\b/gu],
  ];
  let status = 'unknown';
  for (const clause of text.toLowerCase().split(/(?<=[.!?;。！？；])\s*|\b(?:but|however)\b|\band\s+(?=(?:now|finally|then|later|afterwards)\b)|[，,]\s*(?=(?:后来|现在|最终|终于|随后|之后|此前|之前|先前|早先|原先|(?:and\s+)?(?:now|finally|then|later|previously|earlier)\b))|[，,]?\s*(?:但是|然而|不过|可是|但(?=其实|实际|后来|现在|最终|仍|还|又|再|已|没有|并未))/u)) {
    if (/[?？]\s*$/u.test(clause) || conditional.test(clause)) continue;
    const after = clause.match(/\bafter\s+(?!which\b|that\b)/u);
    if (after?.index > 0 && blocked.test(clause.slice(0, after.index))) continue;
    // In "repaired after waiting", the final words describe earlier progress.
    const ordered = after?.index > 0
      ? [clause.slice(after.index + after[0].length), clause.slice(0, after.index)] : [clause];
    for (const part of ordered) {
      const evidence = patterns.flatMap(([value, pattern]) => [...part.matchAll(pattern)]
        .filter(match => !blocked.test(part.slice(0, match.index))
          && (value !== 'completed' || !/^(?:arrived|到货)$/u.test(match[0]) || asksForArrival))
        .map(match => ({ status: value, index: match.index })));
      evidence.sort((left, right) => left.index - right.index);
      const retrospective = /^(?:\s*(?:before that|previously|earlier|prior to that|此前|之前|先前|早先|原先))|(?:修好|完成|取消|维修)(?:之)?前/u.test(part);
      if (evidence.length && (!retrospective || status === 'unknown')) status = evidence.at(-1).status;
    }
  }
  return status;
}

export function assessLifecycleClosure(nodes, lifecycleIntent, query) {
  if (!lifecycleIntent?.matched || !nodes?.length) return null;
  const latest = [...nodes]
    .filter((node) => Number.isFinite(timelineOrderTime(node)))
    .sort((left, right) => timelineOrderTime(left) - timelineOrderTime(right))
    .at(-1) || nodes.at(-1);
  const status = lifecycleStatus(clean(latest?.content), query);
  return {
    status,
    target: lifecycleIntent.target,
    latestMemoryId: latest?.id || "",
    boundaryRequired: !["completed", "cancelled"].includes(status),
  };
}

export function relationshipStateCategory(candidate) {
  const node = candidate?.node;
  if (clean(node?.state_family) !== "relationship") return "";
  const key = clean(node.canonical_key).toLowerCase();
  const text = `${clean(node.title)} ${clean(node.content)}`.toLowerCase();
  if (
    /(?:\.lovers|\.spouse_label|\.partner|\.relationship_role|\.friend|\.family_role)$/u.test(key)
    || /(?:恋人|爱人|伴侣|老婆|老公|夫妻|情侣|男朋友|女朋友|男友|女友|朋友|家人)(?:关系)?|\b(?:partners?|lovers?|spouses?|husband|wife|boyfriend|girlfriend|friends?|family|dating|a couple)\b/u.test(text)
  ) return "role";
  if (/(?:exclusivity|exclusive|possessive)/u.test(key) || /(?:一个人的|只属于|专属|独占|排他)|\b(?:exclusive|exclusivity|only mine|only yours)\b/u.test(text)) {
    return "exclusivity";
  }
  if (/(?:understood_by|understanding)/u.test(key) || /(?:懂我|理解我|了解我|最懂|被理解)|\b(?:understands?|understood|understanding)\b/u.test(text)) {
    return "understanding";
  }
  if (/(?:affection|love)/u.test(key) || /(?:喜欢|爱我|爱你|感情|爱意)|\b(?:loves?|affection|feelings for)\b/u.test(text)) return "affection";
  return "other";
}

export function selectPrimaryCandidate(
  candidates,
  chainIntent,
  representationIntent = "any",
  relationshipIntent = "any",
) {
  let eligibleCandidates = candidates;
  if (relationshipIntent !== "any") {
    const relationshipMatches = eligibleCandidates.filter((candidate) => (
      relationshipStateCategory(candidate) === relationshipIntent
    ));
    if (relationshipMatches.length) eligibleCandidates = relationshipMatches;
  }
  if (chainIntent.mode === "associative") {
    const graphSeeds = eligibleCandidates.filter(candidate => candidate.node.kind !== "utterance");
    if (graphSeeds.length) eligibleCandidates = graphSeeds;
  }
  const fallback = eligibleCandidates[0];
  if (fallback && representationIntent === "evaluated") {
    const layerPriority = { established: 0, inferred: 1 };
    const referenceState = eligibleCandidates.find(isRepresentationStateCandidate);
    const evaluated = eligibleCandidates
      .filter((candidate) => (
        Object.hasOwn(layerPriority, clean(candidate.node.representation_layer))
        && sharesRepresentationStateSlot(referenceState, candidate)
      ))
      .sort((left, right) => (
        layerPriority[clean(left.node.representation_layer)]
        - layerPriority[clean(right.node.representation_layer)]
        || Number(right.score) - Number(left.score)
      ));
    if (evaluated.length) return evaluated[0];
  }
  if (!fallback || chainIntent.mode !== "timeline") return fallback;
  const eligible = eligibleCandidates.filter((candidate) => timelineEligibleNode(candidate.node));
  if (!eligible.length) return fallback;
  const bestScore = Math.max(...eligible.map((candidate) => Number(candidate.score)));
  const pool = eligible
    .filter((candidate) => Number(candidate.score) >= bestScore - 0.15)
    .sort((left, right) => timelineOrderTime(left.node) - timelineOrderTime(right.node));
  if (!pool.length) return fallback;
  return chainIntent.direction === "backward" ? pool.at(-1) : pool[0];
}

function directRelationIds(primary, expanded, relation, maximumDepth = 1) {
  if (!primary || primary.kind === "utterance") return new Set(primary ? [primary.id] : []);
  const visited = new Set([primary.id]);
  let frontier = [primary.id];
  const selected = new Set();
  for (let depth = 0; depth < Math.max(1, Number(maximumDepth)); depth += 1) {
    const next = [];
    for (const memoryId of frontier) {
      for (const edge of expanded.edges) {
        if (edge.relation !== relation || edge.from_memory_id !== memoryId) continue;
        if (visited.has(edge.to_memory_id)) continue;
        visited.add(edge.to_memory_id);
        selected.add(edge.to_memory_id);
        next.push(edge.to_memory_id);
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return selected;
}

export function normalizedEvidenceLimit(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Math.floor(Number(fallback) || 0));
  return Math.max(0, Math.floor(numeric));
}

export function evidenceDisclosurePolicy(intent, options) {
  const ordinaryMaximum = normalizedEvidenceLimit(options.maximumEvidenceMessages);
  const expandedMaximum = normalizedEvidenceLimit(
    options.maximumExpandedEvidenceMessages,
    ordinaryMaximum,
  );
  const explicitIntent = EXPANDED_EVIDENCE_INTENTS.has(intent);
  return {
    mode: explicitIntent ? "explicit-evidence" : "ordinary",
    maximumMessages: explicitIntent ? expandedMaximum : ordinaryMaximum,
    ordinaryMaximum,
    expandedMaximum,
  };
}

export function selectDirectEvidence(primary, expanded, maximum, relation = "supported_by") {
  const limit = Math.max(0, Math.floor(Number(maximum)));
  if (!limit) return [];
  if (primary.kind === "utterance") return [primary];
  const directIds = directRelationIds(primary, expanded, relation, 1);
  return expanded.nodes
    .filter((node) => directIds.has(node.id))
    .sort((left, right) => (
      Date.parse(left.event_start || left.recorded_at || "")
      - Date.parse(right.event_start || right.recorded_at || "")
    ))
    .slice(0, limit);
}

export function selectStrongestDirectEvidence(primary, expanded, relation, maximum = 1) {
  const limit = Math.max(0, Math.floor(Number(maximum)));
  if (!limit || !primary || primary.kind === "utterance") return [];
  const nodeById = new Map(expanded.nodes.map((node) => [node.id, node]));
  return expanded.edges
    .filter((edge) => (
      edge.relation === relation
      && edge.from_memory_id === primary.id
      && nodeById.has(edge.to_memory_id)
    ))
    .map((edge) => ({
      edge,
      node: nodeById.get(edge.to_memory_id),
      strength: Number(edge.weight) * Number(edge.confidence),
    }))
    .sort((left, right) => (
      right.strength - left.strength
      || (Number.isFinite(Date.parse(right.node.event_start || right.node.recorded_at || ""))
        ? Date.parse(right.node.event_start || right.node.recorded_at)
        : 0)
        - (Number.isFinite(Date.parse(left.node.event_start || left.node.recorded_at || ""))
          ? Date.parse(left.node.event_start || left.node.recorded_at)
          : 0)
      || left.node.id.localeCompare(right.node.id)
    ))
    .slice(0, limit)
    .map((item) => item.node);
}

export function selectDialogueEvidence(primary, expanded, maximum, preparedQuery = null) {
  const limit = Math.max(0, Math.floor(Number(maximum)));
  if (!limit) return [];
  const utterances = expanded.nodes
    .filter((node) => node.kind === "utterance")
    .sort((left, right) => (
      Date.parse(left.event_start || left.recorded_at || "")
      - Date.parse(right.event_start || right.recorded_at || "")
    ));
  if (primary.kind === "utterance" && !utterances.some((node) => node.id === primary.id)) {
    utterances.push(primary);
  }
  if (primary.kind !== "utterance") {
    const relevance = new Map(utterances.map(node => [node.id, preparedQuery
      ? lexicalCoverage(lexicalScore(preparedQuery, node.content)) : 0]));
    const supportIds = directRelationIds(primary, expanded, "supported_by", 2);
    const directIds = new Set(utterances
      .filter((node) => supportIds.has(node.id))
      .map((node) => node.id));
    if (!directIds.size) return [];
    const nodeById = new Map(utterances.map((node) => [node.id, node]));
    const pairs = [];
    for (const edge of expanded.edges.filter((item) => item.relation === "followed_by")) {
      const left = nodeById.get(edge.from_memory_id);
      const right = nodeById.get(edge.to_memory_id);
      if (!left || !right) continue;
      if (left.subject_role === right.subject_role) continue;
      if (!directIds.has(left.id) && !directIds.has(right.id)) continue;
      const leftTime = Date.parse(left.event_start || left.recorded_at || "");
      const rightTime = Date.parse(right.event_start || right.recorded_at || "");
      pairs.push({
        left,
        right,
        gap: Number.isFinite(leftTime) && Number.isFinite(rightTime)
          ? Math.abs(rightTime - leftTime)
          : Number.POSITIVE_INFINITY,
        directCount: Number(directIds.has(left.id)) + Number(directIds.has(right.id)),
      });
    }
    pairs.sort((left, right) => (
      (relevance.get(right.left.id) + relevance.get(right.right.id))
        - (relevance.get(left.left.id) + relevance.get(left.right.id))
      || right.directCount - left.directCount || left.gap - right.gap
    ));
    if (pairs.length) {
      const pair = pairs[0];
      const selected = [pair.left, pair.right]
        .sort((left, right) => Number(directIds.has(right.id)) - Number(directIds.has(left.id)))
        .slice(0, limit);
      for (const candidate of utterances) {
        if (selected.length >= limit) break;
        if (directIds.has(candidate.id) && !selected.some((node) => node.id === candidate.id)) {
          selected.push(candidate);
        }
      }
      return selected.sort((left, right) => (
        Date.parse(left.event_start || left.recorded_at || "")
        - Date.parse(right.event_start || right.recorded_at || "")
      ));
    }
    return utterances.filter((node) => directIds.has(node.id))
      .sort((left, right) => relevance.get(right.id) - relevance.get(left.id))
      .slice(0, limit);
  }
  if (utterances.length <= limit) return utterances;
  const anchor = Math.max(0, utterances.findIndex((node) => node.id === primary.id));
  const selected = [utterances[anchor]];
  const oppositeRole = utterances
    .filter(node => node.subject_role !== utterances[anchor].subject_role)
    .sort((left, right) => (
      Math.abs(utterances.indexOf(left) - anchor) - Math.abs(utterances.indexOf(right) - anchor)
    ))[0];
  if (oppositeRole && selected.length < limit && !selected.some((node) => node.id === oppositeRole.id)) selected.push(oppositeRole);
  for (let distance = 1; selected.length < limit; distance += 1) {
    const before = utterances[anchor - distance];
    const after = utterances[anchor + distance];
    if (!before && !after) break;
    for (const node of [before, after]) {
      if (node && !selected.some((item) => item.id === node.id)) selected.push(node);
      if (selected.length >= limit) break;
    }
  }
  return selected.sort((left, right) => (
    Date.parse(left.event_start || left.recorded_at || "")
    - Date.parse(right.event_start || right.recorded_at || "")
  ));
}

export function disclosureLevelFor({ intent, primary, chain, stateCompletion, scopeCompletion }) {
  if (primary?.kind === "utterance") return "evidence";
  if (["utterance", "evidence", "counterevidence", "evidence-review"].includes(intent)) {
    return "evidence";
  }
  if (stateCompletion || scopeCompletion || chain.nodes.length > 1) return "related-memories";
  return "conclusion";
}

export function forwardHistoricalStateCandidates(candidates, { includeHistorical, nodeById, stateView }) {
  if (includeHistorical) {
    return {
      candidates,
      forwarded: [],
      suppressedMemoryIds: [],
      mode: "historical-allowed",
    };
  }
  const byCurrentId = new Map();
  const retainCandidate = candidate => {
    const existing = byCurrentId.get(candidate.node.id);
    const independent = candidate.admission !== "convergence-only";
    const existingIndependent = existing?.admission !== "convergence-only";
    if (!existing || (independent && !existingIndependent)
      || (independent === existingIndependent && candidate.score > existing.score)) {
      byCurrentId.set(candidate.node.id, candidate);
    }
  };
  const forwarded = [];
  const suppressedMemoryIds = [];
  for (const candidate of candidates) {
    const pendingReportedState = isProvisionalNode(candidate.node)
      && candidate.node.metadata?.epistemicStatus === "reported_state";
    if (candidate.node.status === "active" || (!structuredStateNode(candidate.node) && !pendingReportedState)) {
      retainCandidate(candidate);
      continue;
    }
    const resolved = stateView.current(candidate.node, { includeClosed: true });
    const current = resolved ? nodeById.get(resolved.id) : null;
    if (current?.id === candidate.node.id || (!current && pendingReportedState && candidate.node.status === "archived")) {
      retainCandidate(candidate);
      continue;
    }
    if (!current) {
      suppressedMemoryIds.push(candidate.node.id);
      continue;
    }
    const bridge = {
      fromMemoryId: candidate.node.id,
      toMemoryId: current.id,
    };
    forwarded.push(bridge);
    const redirected = {
      ...candidate,
      node: current,
      matchedMemoryId: candidate.node.id,
      admission: "state-forwarded",
      stateBridge: bridge,
      routeMatches: [
        ...(candidate.routeMatches || []),
        {
          route: "state-current",
          strength: "mandatory",
          independentlyAdmissible: false,
          rawScore: 1,
          normalizedScore: 1,
          contribution: 0,
        },
      ],
      routeContributions: {
        ...(candidate.routeContributions || {}),
        "state-current": 0,
      },
    };
    retainCandidate(redirected);
  }
  return {
    candidates: [...byCurrentId.values()].sort((left, right) => (
      right.score - left.score
      || right.node.importance - left.node.importance
      || Date.parse(right.node.recorded_at || "") - Date.parse(left.node.recorded_at || "")
    )),
    forwarded,
    suppressedMemoryIds,
    mode: "current-only",
  };
}
