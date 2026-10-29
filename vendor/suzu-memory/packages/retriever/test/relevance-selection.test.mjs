import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { classifyChainIntent, closeRetrievalWorkers, collectBm25SeedScores, DEFAULT_RETRIEVAL_OPTIONS, lexicalScore, prepareLexicalQuery, retrieveMemories } from '../src/index.mjs';
import { buildOrdinarySeedCandidates } from '../src/seed-routes.mjs';

const query = '赵齐让白羽岚称呼他为什么？A 大佬 B 军人 C sensei D 小齐';
const personNames = ['赵齐', '白羽岚'];

test('naming questions request the name while questions about the reason retain their causal intent', () => {
  for (const text of ['赵齐让白羽岚称呼他为什么？', '他们把这条船命名为什么？', '她把这个项目改名为什么？']) {
    assert.equal(classifyChainIntent(text).mode, 'none', text);
  }
  for (const text of ['为什么称呼他为sensei？', '他为什么要求别人称呼他为老师？', '她为何把项目改名？',
    '这个称呼为什么不合适？', '我称呼了他，为什么？']) {
    assert.deepEqual(classifyChainIntent(text), { mode: 'causal', direction: 'backward' }, text);
  }
});

test('overlapping query spans share credit even when a document repeats the same name', () => {
  const prepared = prepareLexicalQuery(query);
  const content = '赵齐为了不让白羽岚伤心，纠正说自己是军人。';
  const match = lexicalScore(prepared, content);
  assert.equal(match.score, 5);
  assert.deepEqual(new Set(match.matchedTerms), new Set(['赵齐', '让白羽岚', '军人']));
  assert.deepEqual(lexicalScore(prepared, content.repeat(10)), match);
  assert.ok(lexicalScore(prepared, '你可以称呼我为sensei。').score > match.score);
  assert.deepEqual(lexicalScore(query, content), match);
});

test('declared people retain candidate lookup terms while topic scoring excludes their name spans', () => {
  const prepared = prepareLexicalQuery(query, { personNames });
  assert.ok(prepared.queryTerms.includes('白羽岚'));
  const office = lexicalScore(prepared, '赵齐为了不让白羽岚伤心，说自己是军人。');
  assert.deepEqual(office.matchedTerms, ['军人']);
  assert.equal(office.score, 1);
  const quote = lexicalScore(prepared, '你可以称呼我为sensei。');
  assert.deepEqual(quote.matchedTerms, ['称呼', 'sensei']);
  assert.equal(quote.score, 6);
  assert.equal(lexicalScore(prepareLexicalQuery('Anna annual report', { personNames: ['Ann'] }), 'annual report').matchedTerms.includes('annual'), true);
  assert.ok(lexicalScore(prepareLexicalQuery('赵齐', { personNames }), '赵齐的工作记录。').exactPhrase);
  const question = lexicalScore(prepareLexicalQuery('赵齐和白羽岚一起发现了什么？', { personNames }), '赵齐当时在做什么？');
  assert.deepEqual(question.matchedTerms, []);
});

test('BM25 owns the text score even when literal evidence and independent routes also match', () => {
  const nodes = ['fts', 'other'].map(id => ({ id, kind: 'event', title: '', content: '整理旧资料。', status: 'active', importance: 0.5 }));
  const options = DEFAULT_RETRIEVAL_OPTIONS;
  const input = { nodes, query: 'university education', intent: 'auto', options,
    entityScores: new Map(nodes.map(node => [node.id, 0.8])), vectorScores: new Map(nodes.map(node => [node.id, 0.7])),
    bm25Scores: new Map([['fts', { normalizedScore: 0.9, bestSearchRank: -5 }]]) };
  const [fts, other] = buildOrdinarySeedCandidates(input);
  assert.equal(fts.node.id, 'fts');
  assert.ok(fts.routeContributions.bm25 > 0);
  assert.equal(fts.routeContributions.bm25, 0.9 * options.bm25ContributionWeight);
  assert.ok(fts.score > other.score);
  const [both] = buildOrdinarySeedCandidates({ ...input, nodes: [{ ...nodes[0], content: 'University education at the local college.' }] });
  const text = both.routeMatches.filter(route => ['lexical', 'bm25'].includes(route.route));
  assert.equal(text.filter(route => route.contribution > 0).length, 1);
  assert.equal(both.routeContributions.lexical, 0);
  assert.equal(both.routeContributions.bm25, 0.9 * options.bm25ContributionWeight);
  const [ftsWithLexical] = buildOrdinarySeedCandidates({ ...input, options: { ...options, strongLexicalScore: 100 },
    nodes: [{ ...nodes[0], content: 'education' }] });
  assert.ok(ftsWithLexical.routeContributions.bm25 > 0);
  assert.equal(ftsWithLexical.routeContributions.lexical, 0);
});

test('literal fallback scores coverage rather than the number of letters in a word', () => {
  const scores = [];
  for (const [text, content] of [['tea walk', 'tea'], ['activities partake', 'activities']]) {
    const [candidate] = buildOrdinarySeedCandidates({
      nodes: [{ id: 'match', kind: 'event', title: '', content, status: 'active', importance: 0.5 }],
      query: text, intent: 'auto', options: DEFAULT_RETRIEVAL_OPTIONS,
      entityScores: new Map([['match', 0.8]]),
    });
    assert.equal(candidate.routeContributions.lexical, DEFAULT_RETRIEVAL_OPTIONS.bm25ContributionWeight / 2);
    scores.push(candidate.score);
  }
  assert.equal(scores[0], scores[1]);
});

test('a literal match outside indexed results does not bypass BM25 ranking', () => {
  const nodes = ['indexed', 'outside'].map(id => ({ id, kind: 'event', title: '',
    content: 'University education', status: 'active', importance: 0.5 }));
  const result = buildOrdinarySeedCandidates({ nodes, query: 'university education', intent: 'auto',
    options: DEFAULT_RETRIEVAL_OPTIONS,
    bm25Scores: new Map([['indexed', { normalizedScore: 0.3, bestSearchRank: -1 }]]),
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(c => c.node.id), ['indexed', 'outside']);
  assert.ok(result[0].score > result[1].score);
  assert.equal(result[1].routeContributions.lexical, 0);
  assert.equal(result[1].routeContributions.bm25, undefined);
});

test('short Chinese terms retain a fallback when another query term has indexed matches', () => {
  const nodes = [
    { id: 'short', content: '咖啡' },
    { id: 'indexed', content: 'Museum' },
  ].map(n => ({ ...n, kind: 'event', title: '', status: 'active', importance: 0.5 }));
  const result = buildOrdinarySeedCandidates({ nodes, query: '咖啡 museum', intent: 'auto',
    options: DEFAULT_RETRIEVAL_OPTIONS, entityScores: new Map(nodes.map(n => [n.id, 0.8])),
    bm25Scores: new Map([['indexed', { normalizedScore: 0.8, bestSearchRank: -1 }]]),
  });
  const short = result.find(c => c.node.id === 'short');
  assert.ok(short.routeContributions.lexical > 0);
  assert.ok(short.routeContributions.lexical <= DEFAULT_RETRIEVAL_OPTIONS.bm25ContributionWeight);
  assert.equal(result.find(c => c.node.id === 'indexed').routeContributions.lexical, 0);
});

test('BM25 reuses the prepared topic terms instead of querying a configured person name alone', () => {
  const calls = [];
  const preparedQuery = prepareLexicalQuery('What did Melanie paint?', { personNames: ['Melanie'] });
  const result = collectBm25SeedScores({ query: 'What did Melanie paint?', preparedQuery, agentId: 'person-query',
    repository: { search(_agent, text) { calls.push(text); return []; } },
  });
  assert.ok(calls.length > 0);
  assert.ok(!calls.some(text => text.toLowerCase() === 'melanie'));
  assert.ok(calls.some(text => text.toLowerCase() === 'paint'));
  assert.equal(result.audit.queryCount, calls.length);
});

test('equal BM25 scores remain equal regardless of index return order', () => {
  const rows = ['older', 'newer'].map(id => ({ id, content: 'Museum', search_rank: -2 }));
  const score = values => collectBm25SeedScores({ query: 'museum', agentId: 'ties',
    repository: { search() { return values; } },
  });
  const forward = score(rows), backward = score([...rows].reverse());
  assert.equal(forward.scores.get('older').normalizedScore, forward.scores.get('newer').normalizedScore);
  assert.deepEqual(forward.scores.get('older'), backward.scores.get('older'));
  assert.deepEqual(forward.scores.get('newer'), backward.scores.get('newer'));
});

test('configured person names in a phrase do not invalidate its matching topic words', () => {
  const query = 'Melanie pottery class';
  const result = collectBm25SeedScores({ query, agentId: 'phrase-person',
    preparedQuery: prepareLexicalQuery(query, { personNames: ['Melanie'] }),
    repository: { search() { return [{ id: 'pottery', content: query, search_rank: -2 }]; } },
  });
  assert.equal(result.scores.has('pottery'), true);
  assert.equal(result.audit.rejectedWordBoundaryCount, 0);
});

test('current-state priority requires matching question content as well as the person', () => {
  const node = { id: 'preference', kind: 'preference', title: '', content: 'Melanie finds blue calming.',
    status: 'active', importance: 0.5, state_family: 'preference', temporal_state: 'current',
    subject_role: 'agent', subject_key: 'melanie', canonical_key: 'melanie:blue', representation_layer: 'reported' };
  const input = { nodes: [node], query: 'Melanie activities', intent: 'auto', options: DEFAULT_RETRIEVAL_OPTIONS,
    preparedQuery: prepareLexicalQuery('Melanie activities', { personNames: ['Melanie'] }),
    entityScores: new Map([[node.id, 0.8]]) };
  const personal = { matched: true, mode: 'personal', role: 'agent', key: 'melanie' };
  const [event] = buildOrdinarySeedCandidates({ ...input, querySubject: { ...personal, focus: 'event' } });
  const [state] = buildOrdinarySeedCandidates({ ...input, querySubject: { ...personal, focus: 'state' } });
  const [generic] = buildOrdinarySeedCandidates(input);
  assert.equal(event.score, generic.score);
  assert.equal(state.score, event.score);
  const relevant = { ...node, content: 'Melanie activities include running and painting.' };
  const match = { ...input, nodes: [relevant], querySubject: { ...personal, focus: 'state' } };
  const [relevantState] = buildOrdinarySeedCandidates(match);
  const [relevantEvent] = buildOrdinarySeedCandidates({ ...match, querySubject: { ...personal, focus: 'event' } });
  assert.ok(Math.abs(relevantState.score - relevantEvent.score - 0.1) < 1e-12);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-relevance-'));
  const databasePath = path.join(root, 'memory.db');
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  t.after(async () => { database.close(); await closeRetrievalWorkers(); fs.rmSync(root, { recursive: true, force: true }); });
  return { databasePath, repository };
}

function add(repository, id, content, { kind = 'event', similarity = 0.8, ...extra } = {}) {
  const node = repository.upsertMemory({ id, agentId: 'relevance-agent', kind, layer: kind === 'utterance' ? 'evidence' : 'episodic',
    content, importance: 0.5, subjectRole: 'user', subjectKey: 'user', worldId: 'story', worldFrame: 'fictional',
    recordedAt: '2026-10-20T08:00:00Z', eventStart: '2026-10-20T08:00:00Z', metadata: { speaker: '赵齐' }, ...extra });
  repository.upsertEmbedding({ memoryId: id, model: 'fixture', vector: [similarity, Math.sqrt(1 - similarity ** 2)] });
  return node;
}

function recall(databasePath, options = {}, text = query) {
  return retrieveMemories({ databasePath, agentId: 'relevance-agent', query: text, now: new Date('2026-10-25T00:00:00Z'),
    world: { id: 'story', frame: 'fictional' },
    queryPerspective: { speakerNames: ['赵齐'], addresseeNames: ['白羽岚'] }, options,
    embeddingProvider: async () => ({ model: 'fixture', vector: new Float32Array([1, 0]) }) });
}

for (const language of [
  { name: 'English', person: 'Avery', query: 'Which musical artists has Avery seen?',
    concert: 'Avery attended a Theo Reed concert.', unrelated: 'Avery paints landscapes.',
    quote: 'It was Theo Reed. His songs were amazing.', organization: 'Harbor Music',
    topicalQuery: 'Which musical artists has Avery seen at Harbor Music?' },
  { name: 'Chinese', person: '小禾', query: '小禾看过哪些歌手的演出？',
    concert: '小禾去看了林舟的演唱会。', unrelated: '小禾经常画山水画。',
    quote: '唱歌的是林舟，歌声很棒。', organization: '海湾音乐节',
    topicalQuery: '小禾在海湾音乐节看过哪些歌手？' },
]) {
  for (const actorRole of ['user', 'agent']) {
    test(`person entity lookup is neutral to topic ranking for ${actorRole}: ${language.name}`, async t => {
      const { databasePath, repository } = fixture(t);
      const actorKey = actorRole === 'agent' ? 'relevance-agent' : 'user';
      repository.ensureActorEntity({ agentId: 'relevance-agent', actorRole, actorKey, displayName: language.person });
      for (const [id, content, kind] of [
        ['concert', language.concert, 'event'], ['unrelated', language.unrelated, 'event'],
        ['quote', language.quote, 'utterance'],
      ]) add(repository, id, content, { kind, subjectRole: actorRole, subjectKey: actorKey });

      const result = await recall(databasePath, {}, language.query);
      const withoutName = await recall(databasePath, {}, language.query.replace(language.person, ''));
      assert.equal(result.matchedEntities.length, 1);
      assert.equal(result.matchedEntities[0].kind, actorRole === 'agent' ? 'agent' : 'person');
      for (const id of ['concert', 'unrelated', 'quote']) {
        const candidate = result.candidates.find(value => value.memoryId === id);
        assert.ok(candidate, `${id} remains eligible through identity lookup`);
        const entity = candidate.routeMatches.find(route => route.route === 'entity');
        assert.equal(entity.independentlyAdmissible, true);
        assert.equal(candidate.score, withoutName.candidates.find(value => value.memoryId === id).score,
          `${id} must not gain topical credit from the actor name`);
        assert.equal(candidate.lexicalOverlap,
          withoutName.candidates.find(value => value.memoryId === id).lexicalOverlap);
      }

      const organization = repository.upsertEntity({ agentId: 'relevance-agent', kind: 'organization',
        canonicalName: language.organization });
      repository.linkMemoryEntity({ memoryId: 'concert', entityId: organization.id, role: 'participant' });
      const topical = await recall(databasePath, {}, language.topicalQuery);
      assert.ok(topical.candidates.find(value => value.memoryId === 'concert').score
        > result.candidates.find(value => value.memoryId === 'concert').score);
      assert.equal(topical.candidates.find(value => value.memoryId === 'unrelated').score,
        result.candidates.find(value => value.memoryId === 'unrelated').score);
    });
  }
}

for (const kind of ['event', 'utterance']) {
  test(`ordinary matching can fill its shared budget with five ${kind} records`, async t => {
    const { databasePath, repository } = fixture(t);
    for (let index = 0; index < 6; index++) {
      add(repository, `rank-${index}`, `量子航海记录，独立片段${index}。`, {
        kind, similarity: 1 - index * 0.06, importance: 1 - index * 0.05,
      });
    }
    const expansions = [];
    const expand = MemoryRepository.prototype.expand;
    MemoryRepository.prototype.expand = function (agentId, ids, options) {
      const result = expand.call(this, agentId, ids, options);
      expansions.push({ ids, depth: options.maxDepth, maximum: options.maxNodes, returned: result.nodes.length });
      return result;
    };
    let result;
    try { result = await recall(databasePath, { maximumContextMemories: 5, maximumContextChars: 2000 }, '量子航海记录'); }
    finally { MemoryRepository.prototype.expand = expand; }
    assert.equal(result.graph.selectedMemoryIds[0], 'rank-0');
    assert.deepEqual(new Set(result.graph.selectedMemoryIds), new Set(['rank-0', 'rank-1', 'rank-2', 'rank-3', 'rank-4']));
    for (let index = 0; index < 5; index++) assert.ok(result.context.includes(`独立片段${index}`));
    assert.ok(!result.context.includes('独立片段5'));
    assert.equal(new Set(result.graph.selectedMemoryIds).size, 5);
    assert.ok(result.context.length <= 2000);
    assert.ok(expansions.length <= 4);
    assert.ok(expansions.every(value => value.depth <= 1 && value.maximum <= 20 && value.returned <= 20));
    assert.equal(new Set(expansions.flatMap(value => value.ids)).size, expansions.length);
    if (kind === 'event') assert.equal(expansions.length, 0);
    t.diagnostic(JSON.stringify({ kind, expansionCalls: expansions.length, returnedNodes: expansions.reduce((n, value) => n + value.returned, 0) }));
  });
}

test('ordinary mixed records share relevance and novelty selection without a category reservation', async t => {
  const { databasePath, repository } = fixture(t);
  for (const [index, kind] of ['utterance', 'event', 'utterance', 'fact', 'event', 'utterance'].entries()) {
    add(repository, `mixed-${index}`, `量子航海记录，资料编号${index}。`, {
      kind, similarity: 1 - index * 0.06, importance: 1 - index * 0.05,
    });
  }
  const result = await recall(databasePath, { maximumContextMemories: 4, maximumContextChars: 2000 }, '量子航海记录');
  assert.equal(result.graph.selectedMemoryIds[0], 'mixed-0');
  assert.deepEqual(new Set(result.graph.selectedMemoryIds), new Set(['mixed-0', 'mixed-1', 'mixed-2', 'mixed-3']));
  assert.ok(!result.context.includes('资料编号4'));
  for (let index = 0; index < 4; index++) assert.equal(result.context.split(`资料编号${index}`).length - 1, 1);
});

test('a nearby answer consumes the same total context budget as ranked memories', async t => {
  const { databasePath, repository } = fixture(t);
  const text = '量子航海记录里的帆船叫什么名字？';
  add(repository, 'question', text, { kind: 'utterance', similarity: 1, importance: 1 });
  add(repository, 'reply', '叫逐浪号。', { kind: 'utterance', similarity: 0.1,
    subjectRole: 'agent', subjectKey: 'relevance-agent', eventStart: '2026-10-20T08:00:01Z' });
  add(repository, 'other', '量子航海记录里还讲了帆船的名字。', { similarity: 0.8, importance: 0.1 });
  repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId: 'question', toMemoryId: 'reply',
    relation: 'followed_by', weight: 1, confidence: 1 });
  const result = await recall(databasePath, { maximumContextMemories: 2 }, text);
  assert.deepEqual(result.graph.selectedMemoryIds, ['question', 'reply']);
  assert.ok(result.context.includes('叫逐浪号'));
  assert.ok(!result.context.includes('里还讲了'));
  assert.equal(result.context.split('叫逐浪号').length - 1, 1);
  const single = await recall(databasePath, { maximumContextMemories: 1 }, text);
  assert.deepEqual(single.graph.selectedMemoryIds, ['reply']);
  assert.ok(single.context.includes('叫逐浪号'));
});

test('independently matched vector evidence needs no lexical overlap with the question', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'question', '量子航海记录里问起了帆船名字。', { similarity: 1, importance: 1 });
  add(repository, 'answer', '逐浪号。', { kind: 'utterance', similarity: 0.99, importance: 0.9 });
  const result = await recall(databasePath, { maximumContextMemories: 2 }, '量子航海记录里的帆船叫什么？');
  assert.ok(result.graph.selectedMemoryIds.includes('answer'));
  assert.ok(result.context.includes('逐浪号'));
});

test('ranked quotes and their nearby reply preserve world and agent boundaries', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'office', '赵齐为了不让白羽岚伤心，说自己是军人。', { importance: 1, similarity: 1 });
  add(repository, 'address', '你可以称呼我为sensei。', { kind: 'utterance', similarity: 0.5, importance: 0.1 });
  add(repository, 'reply', '好的，sensei。', { kind: 'utterance', similarity: 0.5, subjectRole: 'agent', subjectKey: 'relevance-agent',
    eventStart: '2026-10-20T08:00:01Z', metadata: { speaker: '白羽岚' } });
  add(repository, 'garden', '赵齐和白羽岚在院子吃饭。', { similarity: 0.95 });
  add(repository, 'other-world', '你可以称呼我为FORBIDDEN_WORLD。', { kind: 'utterance', similarity: 1, worldId: 'other-story' });
  add(repository, 'other-agent', '你可以称呼我为FORBIDDEN_AGENT。', { kind: 'utterance', similarity: 1, agentId: 'other-agent' });
  const person = repository.upsertEntity({ agentId: 'relevance-agent', kind: 'person', canonicalName: '赵齐' });
  for (const id of ['office', 'address', 'garden']) repository.linkMemoryEntity({ memoryId: id, entityId: person.id, role: 'participant' });
  repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId: 'address', toMemoryId: 'reply', relation: 'followed_by', weight: 1, confidence: 1 });
  const expansions = [];
  const expand = MemoryRepository.prototype.expand;
  MemoryRepository.prototype.expand = function (agentId, ids, options) {
    expansions.push({ ids, maxNodes: options.maxNodes });
    return expand.call(this, agentId, ids, options);
  };
  let result;
  try { result = await recall(databasePath); }
  finally { MemoryRepository.prototype.expand = expand; }
  assert.ok(expansions.length <= 2);
  assert.equal(expansions.filter(value => value.ids.includes('address')).length, 0,
    'A self-contained statement does not require reading its adjacent acknowledgement.');
  assert.ok(expansions.every(value => value.maxNodes <= 100));
  assert.equal(result.status, 'ready');
  assert.equal(result.seedRouting.primaryMemoryId, 'office');
  assert.match(result.context, /赵齐：你可以称呼我为sensei/u);
  assert.match(result.context, /白羽岚：好的，sensei/u);
  assert.doesNotMatch(result.context, /FORBIDDEN/u);
  assert.ok(result.candidates.find(value => value.memoryId === 'garden').score
    > result.candidates.find(value => value.memoryId === 'address').score);
  assert.match(result.context, /院子吃饭/u);
  assert.ok(result.graph.selectedMemoryIds.includes('address'));
  assert.equal(result.graph.paths.some(value => value.memoryId === 'address'), false);
  assert.deepEqual(result.graph.convergedSeeds.connections, []);
  assert.equal(new Set(result.graph.evidenceMemoryIds).size, result.graph.evidenceMemoryIds.length);
  assert.ok(result.graph.evidenceMemoryIds.length <= 2);
  assert.equal((result.context.match(/你可以称呼我为sensei/gu) || []).length, 1);
});

for (const scenario of [
  {
    name: 'the answer to an already recalled question',
    query: '小宁喜欢什么性别的小孩？ A 儿子 B 女儿 C 双胞胎 D 不喜欢小孩',
    primary: '你喜欢儿子还是女儿呢', primaryKind: 'utterance',
    answer: '谈到孩子时，双方明确说喜欢女儿。', answerKind: 'event',
  },
  {
    name: 'a negative reply sharing words with the preceding positive preference',
    query: '微符不喜欢看什么类型的书？ A 小说 B 历史和科学书籍 C 漫画 D 传记',
    primary: '我喜欢阅读，尤其是关于历史和科学的书籍。', primaryKind: 'utterance',
    answer: '我跟你相反，不喜欢看有关这些看了会想睡觉的书', answerKind: 'utterance',
  },
  {
    name: 'a completed action sharing words with an unrelated offer of help',
    query: '叶安宁帮李鱼做了什么？ A 找工作 B 找女朋友 C 找房子 D 找猫',
    primary: '叶安宁询问李鱼工作困难并表示或许能帮忙，李鱼说女朋友已经解决了。', primaryKind: 'event',
    answer: '叶安宁答应帮李鱼找女朋友，挑出几位女孩并打电话约她们过来。', answerKind: 'event',
  },
]) {
  test(`retains ${scenario.name} without requiring a new query term`, async t => {
    const { databasePath, repository } = fixture(t);
    add(repository, 'primary', scenario.primary, { kind: scenario.primaryKind, similarity: 1, importance: 1 });
    add(repository, 'answer', scenario.answer, { kind: scenario.answerKind, similarity: 0.99, importance: 0.5 });
    const result = await recall(databasePath, {}, scenario.query);
    assert.ok(result.candidates.some(candidate => candidate.memoryId === 'answer'));
    assert.ok(result.graph.selectedMemoryIds.includes('answer'));
    assert.ok(result.context.includes(scenario.answer));
    assert.equal(result.context.split(scenario.answer).length - 1, 1);
    assert.ok(result.graph.selectedMemoryIds.length <= DEFAULT_RETRIEVAL_OPTIONS.maximumContextMemories);
    assert.ok(result.graph.evidenceMemoryIds.length <= DEFAULT_RETRIEVAL_OPTIONS.maximumContextMemories);
    assert.ok(result.context.length <= DEFAULT_RETRIEVAL_OPTIONS.maximumContextChars);
  });
}

test('a nearby answer remains in context when another independent quote shares the total budget', async t => {
  const { databasePath, repository } = fixture(t);
  const question = '小宁喜欢什么性别的小孩？ A 儿子 B 女儿 C 双胞胎 D 不喜欢小孩';
  add(repository, 'question', '你喜欢儿子还是女儿呢', { kind: 'utterance', similarity: 1, importance: 1,
    subjectRole: 'agent', subjectKey: 'relevance-agent' });
  add(repository, 'answer', '很巧我也喜欢女儿', { kind: 'utterance', similarity: 0.99, importance: 0.9,
    eventStart: '2026-10-20T08:00:01Z' });
  add(repository, 'other-quote', '孩子性别的问题我也喜欢讨论', { kind: 'utterance', similarity: 0.85, importance: 0.3 });
  repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId: 'question', toMemoryId: 'answer',
    relation: 'followed_by', weight: 1, confidence: 1 });
  const result = await recall(databasePath, {}, question);
  assert.equal(result.seedRouting.primaryMemoryId, 'question');
  assert.ok(result.context.includes('很巧我也喜欢女儿'));
  assert.equal(result.context.split('很巧我也喜欢女儿').length - 1, 1);
  assert.ok(result.graph.selectedMemoryIds.length <= DEFAULT_RETRIEVAL_OPTIONS.maximumContextMemories);
});

test('a matched source exchange shares the total budget with an independent quote', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'summary', '赵齐让白羽岚称呼自己为sensei，白羽岚答应了。', { similarity: 1, importance: 1 });
  add(repository, 'source', '你可以称呼我为sensei。', { kind: 'utterance', similarity: 0.5, importance: 0.1 });
  add(repository, 'source-reply', '好的，sensei。', { kind: 'utterance', similarity: 0.5,
    subjectRole: 'agent', subjectKey: 'relevance-agent', eventStart: '2026-10-20T08:00:01Z' });
  add(repository, 'other-quote', '军人有时候也用小齐这个称呼。', { kind: 'utterance', similarity: 0.95, importance: 0.8 });
  add(repository, 'other-reply', '是这样的。', { kind: 'utterance', similarity: 0.5,
    subjectRole: 'agent', subjectKey: 'relevance-agent', eventStart: '2026-10-20T08:00:02Z' });
  repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId: 'summary', toMemoryId: 'source',
    relation: 'supported_by', weight: 1, confidence: 1 });
  for (const [fromMemoryId, toMemoryId] of [['source', 'source-reply'], ['other-quote', 'other-reply']]) {
    repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId, toMemoryId, relation: 'followed_by', weight: 1, confidence: 1 });
  }
  const result = await recall(databasePath);
  assert.ok(result.graph.selectedMemoryIds.includes('other-quote'));
  assert.deepEqual(new Set(result.graph.selectedMemoryIds), new Set(['summary', 'other-quote', 'other-reply', 'source', 'source-reply']));
  assert.deepEqual(new Set(result.graph.evidenceMemoryIds), new Set(['other-quote', 'other-reply', 'source', 'source-reply']));
  assert.equal(result.context.split('你可以称呼我为sensei。').length - 1, 1);
  assert.ok(result.context.includes('好的，sensei。'));
  assert.ok(result.graph.selectedMemoryIds.length <= DEFAULT_RETRIEVAL_OPTIONS.maximumContextMemories);
  assert.ok(result.context.length <= DEFAULT_RETRIEVAL_OPTIONS.maximumContextChars);
});

test('ordinary selection respects the shared record and character limits', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'office', '赵齐为了不让白羽岚伤心，说自己是军人。', { importance: 1, similarity: 1 });
  add(repository, 'address', '你可以称呼我为sensei。', { kind: 'utterance', similarity: 0.9 });
  add(repository, 'another-quote', '赵齐说小齐这个称呼也有人使用。', { kind: 'utterance', similarity: 0.85 });
  const result = await recall(databasePath, { maximumContextMemories: 2, maximumContextChars: 450 });
  assert.ok(result.context.length <= 450);
  assert.ok(result.graph.selectedMemoryIds.length <= 2);
  assert.ok(result.graph.evidenceMemoryIds.length <= 2);
  const single = await recall(databasePath, { maximumContextMemories: 1 });
  assert.deepEqual(single.graph.selectedMemoryIds, [single.seedRouting.primaryMemoryId]);
});

test('source exchange selection ranks question relevance ahead of the earliest attached exchange', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'summary', '赵齐让白羽岚称呼自己为sensei，白羽岚答应了。', { similarity: 1, importance: 1 });
  for (const [id, text, role, second] of [
    ['old-user', '今天去院子转一转。', 'user', '00'], ['old-agent', '好呀。', 'agent', '01'],
    ['new-user', '你可以称呼我为sensei。', 'user', '10'], ['new-agent', '好的，sensei。', 'agent', '11'],
  ]) {
    add(repository, id, text, { kind: 'utterance', similarity: 0.5, subjectRole: role, eventStart: `2026-10-20T08:00:${second}Z` });
    repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId: 'summary', toMemoryId: id, relation: 'supported_by', weight: 1, confidence: 1 });
  }
  for (const [fromMemoryId, toMemoryId] of [['old-user', 'old-agent'], ['new-user', 'new-agent']]) {
    repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId, toMemoryId, relation: 'followed_by', weight: 1, confidence: 1 });
  }
  const result = await recall(databasePath, { maximumContextMemories: 3 });
  assert.equal(result.seedRouting.primaryMemoryId, 'summary');
  assert.deepEqual(new Set(result.graph.evidenceMemoryIds), new Set(['new-user', 'new-agent']));
  assert.doesNotMatch(result.context, /院子转一转/u);
});

test('an incidental state seed does not block independent event evidence for an event question', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'incidental-state', '赵齐说自己是军人。', { kind: 'fact', similarity: 1, importance: 1,
    canonicalKey: 'user:identity:occupation', stateFamily: 'identity', statePhase: 'active', stateScopeKey: 'root',
    representationLayer: 'reported', temporalState: 'current' });
  add(repository, 'address', '赵齐让白羽岚称呼自己为sensei。', { kind: 'event', similarity: 0.5, importance: 0.1 });
  const result = await recall(databasePath);
  assert.equal(result.seedRouting.primaryMemoryId, 'incidental-state');
  assert.match(result.context, /称呼自己为sensei/u);
  assert.ok(result.graph.selectedMemoryIds.includes('address'));
  assert.deepEqual(result.graph.convergedSeeds.connections, []);
});

test('an unconnected weak text clue requires independent admission before it can enter context', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'museum', '用户去了科技馆。');
  add(repository, 'dinner', '后来一起吃了晚饭。');
  const input = { databasePath, agentId: 'relevance-agent', query: '还记得科技馆和那顿晚饭吗',
    options: { strongBm25Score: 1 }, world: { id: 'story', frame: 'fictional' } };
  const result = await retrieveMemories(input);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.graph.selectedMemoryIds, ['museum']);
  assert.doesNotMatch(result.context, /吃了晚饭/u);
  repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId: 'museum', toMemoryId: 'dinner', relation: 'timeline_next', weight: 1, confidence: 1 });
  const connected = await retrieveMemories(input);
  assert.match(connected.context, /吃了晚饭/u);
  assert.equal(connected.graph.convergedSeeds.connections[0].relation, 'timeline_next');
});

for (const [query, unrelated, relevant] of [
  ["What are Avery's adoption plans?", "Avery likes abstract art.", "Avery is applying for adoption."],
  ["小禾的领养计划是什么？", "小禾喜欢画抽象画。", "小禾已经向领养机构提交了申请。"],
]) {
  test("person-only matches receive no current-state topic bonus: " + query, () => {
    const person = { matched: true, mode: "personal", focus: "state", role: "user", key: "person" };
    const nodes = [unrelated, relevant].map((content, i) => ({ id: "state-" + i, content, kind: "fact", title: "",
      status: "active", importance: 0.5, state_family: "identity", temporal_state: "current",
      subject_role: "user", subject_key: "person", canonical_key: "key-" + i, representation_layer: "reported" }));
    const input = { nodes, query, intent: "auto", options: DEFAULT_RETRIEVAL_OPTIONS,
      preparedQuery: prepareLexicalQuery(query, { personNames: [query.includes("Avery") ? "Avery" : "小禾"] }),
      querySubject: person, entityScores: new Map(nodes.map(node => [node.id, 0.8])),
      vectorScores: new Map([["state-0", 0.45], ["state-1", 0.7]]) };
    const state = buildOrdinarySeedCandidates(input);
    const event = buildOrdinarySeedCandidates({ ...input, querySubject: { ...person, focus: "event" } });
    const score = (values,id) => values.find(candidate => candidate.node.id === id).score;
    assert.equal(score(state, "state-0"), score(event, "state-0"));
    assert.ok(Math.abs(score(state, "state-1") - score(event, "state-1") - 0.1) < 1e-12);
  });
}

for (const language of [
  { name: 'English', query: 'What musical artist did Avery see?',
    statement: "It was Theo Reed. His songs were amazing. What have you been up to?",
    question: 'What musical artist did you see?',
    topic: 'Avery remembers a concert and a conversation about music.',
    source: 'Theo Reed performed that night.',
    activities: 'What activities does Avery enjoy?',
    first: 'Avery attends drawing classes and paints landscapes.',
    repeated: 'Avery paints landscapes and takes drawing classes.',
    distinct: 'Avery kayaks with cousins on weekends.' },
  { name: 'Chinese', query: '小禾看过哪位歌手的演出？',
    statement: '唱歌的是林舟，歌声很棒。你最近怎么样？',
    question: '你看过哪位歌手的演出？',
    topic: '小禾记得一场演唱会，以及关于音乐的交谈。',
    source: '那晚登台表演的歌手是林舟。',
    activities: '小禾喜欢哪些活动？',
    first: '小禾参加绘画课，画山水画。',
    repeated: '小禾画山水画，也参加绘画课。',
    distinct: '小禾周末会与表亲划皮艇。' },
]) {
  test(`mixed factual statements need no first-person pronoun: ${language.name}`, async t => {
    const { databasePath, repository } = fixture(t);
    add(repository, 'statement', language.statement, { kind: 'utterance', similarity: 0.9 });
    const result = await recall(databasePath, { maximumContextMemories: 1 }, language.query);
    assert.deepEqual(result.graph.selectedMemoryIds, ['statement']);
    assert.ok(result.context.includes(language.statement));
    assert.equal(result.graph.contextSelection.replyLookupCount, 0);
  });

  test(`ordinary unanswered questions are not factual answers: ${language.name}`, async t => {
    const { databasePath, repository } = fixture(t);
    add(repository, 'question', language.question, { kind: 'utterance', similarity: 0.99 });
    const result = await recall(databasePath, {}, language.query);
    assert.equal(result.status, 'no-match');
    assert.equal(result.context, '');
    const quoted = await recall(databasePath, {}, language.name === 'English'
      ? 'What did I say about music?' : '我说过的关于歌手的原话是什么？');
    assert.equal(quoted.status, 'ready');
    assert.ok(quoted.context.includes(language.question));
  });

  test(`overlapping summaries leave room for another fact: ${language.name}`, async t => {
    const { databasePath, repository } = fixture(t);
    add(repository, 'first', language.first, { kind: 'topic', similarity: 0.99, importance: 0.9 });
    add(repository, 'repeated', language.repeated, { kind: 'event', similarity: 0.98, importance: 0.8 });
    add(repository, 'distinct', language.distinct, { kind: 'utterance', similarity: 0.95, importance: 0.7 });
    const source = repository.upsertSource({ agentId: 'relevance-agent', sourceKind: 'conversation',
      externalId: 'drawing', content: language.first, worldId: 'story', worldFrame: 'fictional' });
    for (const id of ['first', 'repeated']) repository.linkSource(id, source.id, 'evidence');
    const result = await recall(databasePath, { maximumContextMemories: 2 }, language.activities);
    assert.equal(result.graph.selectedMemoryIds.filter(id => ['first', 'repeated'].includes(id)).length, 1);
    assert.ok(result.graph.selectedMemoryIds.includes('distinct'));
    assert.ok(result.context.includes(language.distinct));
    assert.ok(result.graph.contextSelection.coverageEdgeRows <= DEFAULT_RETRIEVAL_OPTIONS.maximumActivationWork);
  });

  test(`graph discovery and source evidence are independent of output slots: ${language.name}`, async t => {
    const { databasePath, repository } = fixture(t);
    add(repository, 'topic', language.topic, { similarity: 0.99 });
    add(repository, 'source', language.source, { kind: 'utterance', similarity: 0.1 });
    add(repository, 'foreign-world', 'FORBIDDEN_WORLD', { similarity: 0.1, worldId: 'other-story' });
    add(repository, 'foreign-agent', 'FORBIDDEN_AGENT', { similarity: 0.1, agentId: 'other-agent' });
    for (const id of ['source', 'foreign-world']) repository.upsertEdge({
      agentId: 'relevance-agent', fromMemoryId: 'topic', toMemoryId: id,
      relation: 'supported_by', weight: 1, confidence: 1,
    });
    assert.throws(() => repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId: 'topic',
      toMemoryId: 'foreign-agent', relation: 'supported_by', weight: 1 }), /same Agent/u);
    const result = await recall(databasePath, { maximumCandidates: 1, maximumContextMemories: 2,
      maximumActivationWork: 4 }, language.query);
    assert.ok(!result.candidates.some(candidate => candidate.memoryId === 'source'));
    assert.deepEqual(new Set(result.graph.selectedMemoryIds), new Set(['topic', 'source']));
    assert.ok(result.graph.paths.some(value => value.memoryId === 'source'));
    assert.ok(result.graph.activationField.processedStates <= 4);
    assert.ok(result.context.includes(language.source));
    assert.doesNotMatch(result.context, /FORBIDDEN/u);
    assert.equal(result.graph.contextSelection.replyLookupCount, 0);
  });
}

test('graph discovery reaches a new fact through more than one association', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'start', '量子航海记录里提到一座灯塔。', { similarity: 0.99 });
  add(repository, 'bridge', '港口曾经改过名字。', { similarity: 0.1 });
  add(repository, 'destination', '改名后的港口叫银湾。', { similarity: 0.1 });
  for (const [fromMemoryId, toMemoryId] of [['start', 'bridge'], ['bridge', 'destination'], ['destination', 'start']]) {
    repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId, toMemoryId,
      relation: 'associated_with', weight: 1, confidence: 1 });
  }
  const result = await recall(databasePath, { maximumCandidates: 1, maximumContextMemories: 3,
    maximumActivationWork: 8, fanoutSuppressionExponent: 0 }, '量子航海记录');
  assert.ok(result.graph.selectedMemoryIds.includes('destination'));
  assert.ok(result.graph.activationField.processedStates <= 8);
  assert.ok(result.context.includes('银湾'));
  assert.ok(result.graph.selectedMemoryIds.length <= 3);
});

for (const content of ['I like coffee.', '我喜欢咖啡。']) {
  test(`identical words retain different speakers and occurrence times: ${content}`, async t => {
    const { databasePath, repository } = fixture(t);
    add(repository, 'speaker-one', content, { kind: 'utterance', similarity: 0.99,
      subjectRole: 'unknown', subjectKey: '', metadata: { speaker: 'Avery' } });
    add(repository, 'speaker-two', content, { kind: 'utterance', similarity: 0.98,
      subjectRole: 'unknown', subjectKey: '', metadata: { speaker: 'Blair' } });
    add(repository, 'another-time', content, { kind: 'utterance', similarity: 0.97,
      subjectRole: 'unknown', subjectKey: '', metadata: { speaker: 'Avery' }, eventStart: '2026-10-21T08:00:00Z' });
    const result = await recall(databasePath, { maximumContextMemories: 3 }, 'coffee 咖啡');
    assert.deepEqual(new Set(result.graph.selectedMemoryIds), new Set(['speaker-one', 'speaker-two', 'another-time']));
  });
}
