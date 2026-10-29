import { dateKeyInTimeZone } from '@suzu-memory/core';
import { asksForHistoricalState, resolveTemporalQuery, retrievalQueryText, requestedQueryText, recallCorePhrases,
  classifyRecallIntent, classifyRepresentationIntent, classifyRelationshipQueryIntent, classifyLifecycleCompletionIntent,
  classifyChainIntent, isGenericQuery } from './query.mjs';

export function createRetrievalQueryPlan({ query, now, timeZone, genericQueries }) {
  const temporal = resolveTemporalQuery(query, now, timeZone);
  const today = dateKeyInTimeZone(now, timeZone);
  const historicalStateRequested = asksForHistoricalState(query, { temporal, today });
  const exactTemporal = temporal.matched && temporal.precision === 'exact';
  const retrievalQuery = retrievalQueryText(temporal.matched ? temporal.remainingQuery : query);
  const queryControlText = requestedQueryText(query);
  const temporalOverview = temporal.matched && !recallCorePhrases(retrievalQuery).length;
  const softTemporal = temporal.matched && (!exactTemporal || !temporalOverview);
  const requestedIntent = classifyRecallIntent(query);
  const intent = temporalOverview && requestedIntent === 'auto' ? 'event' : requestedIntent;
  const representationIntent = classifyRepresentationIntent(query);
  const relationshipIntent = classifyRelationshipQueryIntent(query);
  const lifecycleIntent = classifyLifecycleCompletionIntent(query);
  const chainIntent = classifyChainIntent(query, temporal);
  return { temporal, today, historicalStateRequested, exactTemporal, retrievalQuery, queryControlText, temporalOverview, softTemporal, requestedIntent, intent, representationIntent, relationshipIntent, lifecycleIntent, chainIntent, generic: isGenericQuery(query, genericQueries) };
}
