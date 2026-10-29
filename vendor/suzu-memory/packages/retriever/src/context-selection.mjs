import { isProvisionalMemory as isProvisionalNode, isStructuredStateMemory as structuredStateNode } from '@suzu-memory/core';
import { rankTemporalCandidates } from './temporal-ranking.mjs';
import { followMemoryChain, selectConvergedSeeds } from './memory-chain.mjs';
import { selectRankedContext } from './ranked-context.mjs';
import { fuseCandidateLanes, normalizedEvidenceLimit, evidenceDisclosurePolicy, selectDirectEvidence,
  selectStrongestDirectEvidence, selectDialogueEvidence, assessLifecycleClosure } from './candidate-selection.mjs';

export function selectRetrievalContext({
  agentId, queryPlan, primary, stateView, anchorCandidates, options,
  repository, database, worldScope, preparedQuery, primaryCandidate, candidates,
  convergenceCandidates, episodicCandidates, eligibleMemoryIds, plasticityPolicy, subjectConstraint, provisionalNodes,
  embeddingVectors, scoreLexical,
}) {
  const { intent, temporal, temporalOverview, relationshipIntent, representationIntent, chainIntent, lifecycleIntent, queryControlText } = queryPlan;
  const primaryIsProvisional = isProvisionalNode(primary);
  const stateCompletion = primaryIsProvisional
    ? null
    : stateView.current(primary);
  const scopeCompletion = primaryIsProvisional
    ? null
    : stateView.scopes(primary);
  const representationCompletion = !stateCompletion
    && !scopeCompletion
    && !["evidence", "counterevidence", "evidence-review", "utterance"].includes(intent)
    ? stateView.representations(primary)
    : null;
  const ordinaryContextEligible = !primaryIsProvisional
    && !anchorCandidates.length
    && !["evidence", "counterevidence", "evidence-review", "utterance"].includes(intent)
    && !temporalOverview && temporal.ordering !== "latest"
    && !stateCompletion && !scopeCompletion && !representationCompletion
    && relationshipIntent === "any" && representationIntent === "any";
  let rankedContext = ordinaryContextEligible && chainIntent.mode === 'none';
  const maximumContextMemories = Math.max(1, normalizedEvidenceLimit(options.maximumContextMemories, 5));
  const expanded = primaryIsProvisional || rankedContext
    ? { nodes: [primary], edges: [] }
    : repository.expand(agentId, [primary.id], {
      // One hop reaches explicit evidence; the second reaches the other side
      // of the same nearby exchange through followed_by edges.
      maxDepth: 2,
      maxNodes: 100,
      minimumWeight: 0.65,
      relations: [
        "supported_by", "challenged_by", "followed_by", "shares_entity",
        "corrects", "supersedes", "completes", "cancels",
      ],
      traversal: "both",
      worldId: worldScope.allowCrossWorld ? "" : worldScope.id,
      worldFrame: worldScope.allowCrossWorld ? "" : worldScope.frame,
    });
  const episodicPrimary = episodicCandidates[0]?.node || null;
  const episodicExpanded = !episodicPrimary || rankedContext
    ? { nodes: [], edges: [] }
    : episodicPrimary.id === primary.id
      ? expanded
      : repository.expand(agentId, [episodicPrimary.id], {
          maxDepth: 2,
          maxNodes: 20,
          minimumWeight: 0.65,
          relations: ["followed_by"],
          traversal: "both",
          worldId: worldScope.allowCrossWorld ? "" : worldScope.id,
          worldFrame: worldScope.allowCrossWorld ? "" : worldScope.frame,
        });
  const evidenceDisclosure = rankedContext
    ? { mode: "ranked-context", maximumMessages: maximumContextMemories,
        ordinaryMaximum: maximumContextMemories,
        expandedMaximum: normalizedEvidenceLimit(options.maximumExpandedEvidenceMessages) }
    : evidenceDisclosurePolicy(intent, options);
  const maximumEvidence = evidenceDisclosure.maximumMessages;
  const supportEvidence = intent === "evidence-review" && maximumEvidence >= 1
    ? selectStrongestDirectEvidence(primary, expanded, "supported_by", 1)
    : [];
  const counterEvidence = intent === "evidence-review" && maximumEvidence >= 1
    ? selectStrongestDirectEvidence(primary, expanded, "challenged_by", 1)
    : [];
  const directlyLinkedDialogue = !rankedContext && (
    primary.kind === "utterance" || !structuredStateNode(primary)
  )
      ? selectDialogueEvidence(primary, expanded, maximumEvidence, preparedQuery)
      : [];
  const automaticEpisodicEvidence = rankedContext ? [] : primary.kind === "utterance"
    ? directlyLinkedDialogue
    : !structuredStateNode(primary) && [
        "event", "episode", "fact", "plan", "commitment", "open_loop",
      ].includes(primary.kind)
      ? (
          directlyLinkedDialogue.length
            ? directlyLinkedDialogue
            : episodicPrimary
              ? selectDialogueEvidence(episodicPrimary, episodicExpanded, maximumEvidence, preparedQuery)
              : []
        )
      : [];
  let evidence = intent === "utterance"
    ? selectDialogueEvidence(primary, expanded, maximumEvidence, preparedQuery)
    : intent === "evidence"
      ? selectDirectEvidence(primary, expanded, maximumEvidence)
      : intent === "counterevidence"
        ? selectDirectEvidence(primary, expanded, maximumEvidence, "challenged_by")
      : intent === "evidence-review"
        ? [...supportEvidence, ...counterEvidence]
      : automaticEpisodicEvidence;
  const convergedSeeds = !rankedContext
    ? { enabled: false, candidates: [primaryCandidate], connections: [] }
    : selectConvergedSeeds({
      database,
      agentId: agentId,
      candidates: fuseCandidateLanes(convergenceCandidates, episodicCandidates,
        Number.MAX_SAFE_INTEGER),
      primaryCandidate,
      eligibleMemoryIds,
      options,
    });
  let chain;
  if (temporal.ordering === 'latest' && !anchorCandidates.length) {
    chain = { nodes: [primary], paths: [], activation: null };
  } else if (temporalOverview && !anchorCandidates.length) {
    chain = { nodes: rankTemporalCandidates([...candidates, ...episodicCandidates], temporal,
      { ...options, topicless: true }).slice(0, Math.max(1, Number(options.maximumChainMemories))).map(c => c.node),
      paths: [], activation: null };
  } else if (primaryIsProvisional || (primary.kind === "utterance" && !convergedSeeds.enabled && !rankedContext)) {
    chain = {
      nodes: [primary],
      paths: [],
      activation: null,
    };
  } else if (chainIntent.mode === "date") {
    chain = {
      nodes: candidates
        .map((candidate) => candidate.node)
        .filter((node) => node.kind !== "utterance")
        .slice(0, Math.max(1, Number(options.maximumChainMemories))),
      paths: [],
      activation: null,
    };
  } else {
    chain = followMemoryChain({
      database,
      agentId: agentId,
      primary,
      seedCandidates: convergedSeeds.enabled
        ? convergedSeeds.candidates
        : [primaryCandidate],
      chainIntent,
      discovery: rankedContext,
      subjectConstraint,
      eligibleMemoryIds,
      plasticityPolicy,
      options,
    });
  }
  if (!chain.nodes.length) chain.nodes = [primary];
  if (ordinaryContextEligible && chainIntent.mode === 'causal' && chain.nodes.length === 1) {
    // A "why" question can be answered directly by recorded wording even
    // when no reviewed causal graph edge has been established.
    rankedContext = true;
    chain = { nodes: [], paths: [], activation: null };
    Object.assign(evidenceDisclosure, { mode: 'ranked-context', maximumMessages: maximumContextMemories,
      ordinaryMaximum: maximumContextMemories });
  }
  if (rankedContext) {
    const independent = convergenceCandidates.filter(candidate => candidate.admission !== 'convergence-only');
    const admitted = new Set([...independent, ...candidates, ...episodicCandidates,
      ...convergedSeeds.candidates].map(candidate => candidate.node.id));
    const discovered = (chain.candidates || []).filter(candidate => !admitted.has(candidate.node.id));
    const selection = selectRankedContext({ database, agentId, preparedQuery, scoreLexical,
      candidates: fuseCandidateLanes([...independent, ...candidates, ...convergedSeeds.candidates, ...discovered],
        episodicCandidates, Number.MAX_SAFE_INTEGER),
      eligibleMemoryIds, subjectConstraint, embeddingVectors, maximum: maximumContextMemories, options });
    const selected = new Set(selection.nodes.map(node => node.id));
    chain.nodes = selection.nodes;
    chain.selection = selection.audit;
    delete chain.candidates;
    chain.paths = chain.paths.filter(value => selected.has(value.memoryId));
    if (chain.activation) chain.activation.selected = chain.activation.selected.filter(value => selected.has(value.memoryId));
    evidence = chain.nodes.filter(node => node.kind === "utterance");
  }
  if (stateCompletion) {
    chain.nodes = [stateCompletion, primary];
    chain.paths = [];
    chain.activation = null;
  } else if (scopeCompletion) {
    chain.nodes = scopeCompletion.nodes;
    chain.paths = [];
    chain.activation = null;
  } else if (representationCompletion) {
    chain.nodes = representationCompletion.nodes;
    chain.paths = [];
    chain.activation = null;
  }
  // All completion routes above and the final chain use the same eligible
  // nodes resolved from this read snapshot, including Event source scope.
  chain.nodes = chain.nodes.filter((node) => eligibleMemoryIds.has(node.id));
  const selectedStateIds = new Set(chain.nodes.map(node => node.id));
  const pendingStateChanges = provisionalNodes.filter(node => node.metadata?.reportedStateProposalId
    && (selectedStateIds.has(node.id)
      || selectedStateIds.has(node.metadata.reportedStatePreviousMemoryId)))
    .sort((left, right) => String(right.known_at).localeCompare(String(left.known_at))
      || String(right.recorded_at).localeCompare(String(left.recorded_at)));
  chain.nodes = [...new Map([...pendingStateChanges, ...chain.nodes].map(node => [node.id, node])).values()];
  const lifecycleClosure = assessLifecycleClosure(chain.nodes, lifecycleIntent, queryControlText);

  return { primaryIsProvisional, stateCompletion, scopeCompletion, representationCompletion, rankedContext, expanded, episodicExpanded, evidenceDisclosure, supportEvidence, counterEvidence, evidence, episodicPrimary, convergedSeeds, chain, pendingStateChanges, lifecycleClosure };
}
