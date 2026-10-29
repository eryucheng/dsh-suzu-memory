import { isProvisionalMemory as isProvisionalNode, isStructuredStateMemory as structuredStateNode } from '@suzu-memory/core';
import { memoryCalendarDate } from './temporal-ranking.mjs';
const clean = value => String(value ?? '').trim();
const CLOSED_REPORTED_STATE_LABELS = Object.freeze({
  interrupted: "已中断", completed: "已完成", cancelled: "已取消", ended: "已结束", retired: "不再适用",
});
export const closedStateLabel = phase => CLOSED_REPORTED_STATE_LABELS[phase] || '';

export function boundedText(value, maximum) {
  const text = clean(value)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, "")
    .replace(/<local-command-(?:caveat|stdout)>[\s\S]*?<\/local-command-(?:caveat|stdout)>/giu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .split(/\r?\n/gu)
    .filter((line) => clean(line) !== "NO_REPLY")
    .join("\n")
    .trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

export function joinBoundedSections(values, maximum) {
  const sections = values.map(clean).filter(Boolean);
  if (!sections.length) return "";
  const joined = sections.join("\n");
  const limit = Math.max(1, Math.trunc(Number(maximum) || 1));
  if (joined.length <= limit) return joined;
  const separatorChars = Math.max(0, sections.length - 1);
  const available = limit - separatorChars;
  if (available < sections.length) return boundedText(joined, limit);
  const base = Math.floor(available / sections.length);
  let remainder = available - base * sections.length;
  return sections.map((section) => {
    const sectionLimit = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return boundedText(section, sectionLimit);
  }).join("\n");
}

function timestampLabel(timestamp, timeZone) {
  const date = new Date(timestamp || "");
  if (!Number.isFinite(date.getTime())) return "时间不详";
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

function formatUtterance(node, options) {
  const speaker = node.metadata?.speaker
    || (node.subject_role === "agent" ? "我" : "对方");
  const time = node.metadata?.sourceTimeKnown === false ? "时间未知" : timestampLabel(node.event_start || node.recorded_at, options.timeZone);
  return `[${time}] ${speaker}：${boundedText(node.content, options.maximumMessageChars)}`;
}

function formatEvidenceMemory(node, options) {
  if (node.kind === "utterance") return formatUtterance(node, options);
  const time = node.metadata?.sourceTimeKnown === false ? "时间未知" : node.event_date
    || timestampLabel(node.event_start || node.recorded_at, options.timeZone);
  const kind = node.kind === "event" ? "事件"
    : node.kind === "fact" ? "事实记录"
      : node.kind === "episode" ? "事件簇"
        : "支持记忆";
  return [
    evidenceNatureLine(node, options),
    `[${time}] ${kind}：${boundedText(node.content, options.maximumMessageChars)}`,
  ].filter(Boolean).join("\n");
}

function stateEvidenceNature(node) {
  if (!node || ["not_applicable", "unspecified", ""].includes(clean(node.state_family))) {
    return "";
  }
  return {
    reported: "主体明确表达",
    inferred: "基于行为与多条证据的推断",
    established: "经过专门聚合验证；仍保留来源并允许后续修正",
  }[clean(node.representation_layer)] || "";
}

function sourceEvidenceNature(node, options) {
  if (!node || node.kind === "utterance") return "";
  const authorities = new Set(
    options.sourceAuthoritiesByMemoryId?.get(node.id) || [],
  );
  if (node.evidence_mode === "inferred" || authorities.has("model_inference")) {
    return "基于关联证据的推断";
  }
  const labels = [];
  if (authorities.has("subject_firsthand")) labels.push("主体本人陈述");
  if (authorities.has("participant_firsthand")) labels.push("直接参与者陈述");
  if (authorities.has("direct_observation")) labels.push("直接观察记录");
  if (authorities.has("external_record")) labels.push("外部记录");
  if (authorities.has("verbatim_record")) labels.push("逐字记录");
  if (authorities.has("hearsay")) labels.push("转述");
  if (labels.length) {
    return labels.join("、");
  }
  if (node.evidence_mode === "manual" || authorities.has("manual")) {
    return "经人工审核整理；事实依据仍以所连来源为准";
  }
  if (node.evidence_mode === "imported" || authorities.has("legacy_unknown")) {
    return "旧资料导入；原有来源分级不完整";
  }
  if (authorities.size) return "已关联来源，但认知来源性质尚未分级";
  return "";
}

function evidenceNatureLine(node, options) {
  if (isProvisionalNode(node) && node.metadata?.epistemicStatus === "reported_state") {
    return stateEvidenceNature(node) ? `状态性质：${stateEvidenceNature(node)}` : "";
  }
  if (isProvisionalNode(node) && node.metadata?.epistemicStatus === "source_record") {
    const nature = sourceEvidenceNature(node, options);
    return nature ? `来源性质：${nature}` : "";
  }
  if (isProvisionalNode(node)) {
    return "认知性质：这是 Agent 在相处中形成、尚未审核的个人印象；可能有偏差，不是主体确认的事实，用户可以随时纠正";
  }
  const stateNature = stateEvidenceNature(node);
  if (stateNature) return `状态性质：${stateNature}`;
  const sourceNature = sourceEvidenceNature(node, options);
  return sourceNature ? `来源性质：${sourceNature}` : "";
}

export function formatPrimary(primary, evidence, options, {
  evidenceRequested = false,
  evidenceHeading = "相关原话：",
  missingEvidenceText = "未找到与这条记忆直接关联的原话证据。",
} = {}) {
  if (primary.kind === "utterance") {
    const messages = evidence.length ? evidence : [primary];
    return joinBoundedSections(
      messages.map((node) => formatEvidenceMemory(node, options)),
      options.maximumContextChars,
    );
  }
  const time = primary.metadata?.sourceTimeKnown === false ? "时间未知"
    : options.showRecallDate && structuredStateNode(primary) && memoryCalendarDate(primary, options.timeZone)
    ? `状态记录日期：${memoryCalendarDate(primary, options.timeZone)}${primary.valid_from
      ? `；状态生效时间：${timestampLabel(primary.valid_from, options.timeZone)}${primary.valid_to
        ? ` 至 ${timestampLabel(primary.valid_to, options.timeZone)}` : ''}` : ''}`
    : structuredStateNode(primary) && primary.valid_from
    ? `状态生效时间：${timestampLabel(primary.valid_from, options.timeZone)}${primary.valid_to
      ? ` 至 ${timestampLabel(primary.valid_to, options.timeZone)}`
      : ""}`
    : primary.event_date
    ? `事件日期：${primary.event_date}（已解析）${primary.known_at
      ? `；获知时间：${timestampLabel(primary.known_at, options.timeZone)}` : ""}`
    : primary.event_start
    ? `事件时间：${timestampLabel(primary.event_start, options.timeZone)}${primary.event_end
      ? ` 至 ${timestampLabel(primary.event_end, options.timeZone)}`
      : ""}`
    : primary.kind === "topic"
    ? "长期主题"
    : primary.known_at
    ? `获知时间：${timestampLabel(primary.known_at, options.timeZone)}`
    : `记录时间：${timestampLabel(primary.recorded_at, options.timeZone)}`;
  const label = primary.kind === "episode"
    ? "事件簇"
    : primary.kind === "topic" ? "主题" : "我记得";
  const closed = options.closureLabel?.(primary);
  const primarySection = [
    evidenceNatureLine(primary, options),
    closed ? `状态：${closed}；结束时间：${timestampLabel(primary.valid_to, options.timeZone)}` : "",
    `[${time}] ${label}：${boundedText(primary.content, Math.floor(options.maximumContextChars * (evidence.length ? 0.34 : 0.62)))}`,
  ].filter(Boolean).join("\n");
  const sections = [primarySection];
  if (evidence.length) {
    sections.push(...evidence.map((node, index) => [
      index === 0 ? evidenceHeading : "",
      formatEvidenceMemory(node, options),
    ].filter(Boolean).join("\n")));
  } else if (evidenceRequested) {
    sections.push(missingEvidenceText);
  }
  return joinBoundedSections(sections, options.maximumContextChars);
}

function formatMemoryChain(nodes, options, evidence = []) {
  const nodeIds = new Set(nodes.map(node => node.id));
  const additionalEvidence = evidence.filter(node => !nodeIds.has(node.id));
  return joinBoundedSections(
    [
      ...nodes.map((node) => formatPrimary(node, [], options)),
      ...additionalEvidence.map((node, index) => [
        index === 0 ? "相关原话：" : "", formatEvidenceMemory(node, options),
      ].filter(Boolean).join("\n")),
    ],
    options.maximumContextChars,
  );
}

function formatCausalChain(primary, nodes, options, direction = "backward") {
  const related = nodes.filter((node) => node.id !== primary.id);
  if (!related.length) return formatPrimary(primary, [], options);
  const limit = Math.max(80, Math.floor(options.maximumContextChars / (related.length + 1)));
  const time = (node) => node.metadata?.sourceTimeKnown === false ? "时间未知" : node.event_date
    || timestampLabel(node.event_start || node.recorded_at, options.timeZone);
  if (direction === "forward") {
    return joinBoundedSections([
      [
        evidenceNatureLine(primary, options),
        `[${time(primary)}] 原因：${boundedText(primary.content, limit)}`,
      ].filter(Boolean).join("\n"),
      ...related.map((node) => [
        evidenceNatureLine(node, options),
        `[${time(node)}] 有明确关系的后续结果：${boundedText(node.content, limit)}`,
      ].filter(Boolean).join("\n")),
    ], options.maximumContextChars);
  }
  return joinBoundedSections([
    [
      evidenceNatureLine(primary, options),
      `[${time(primary)}] 结果：${boundedText(primary.content, limit)}`,
    ].filter(Boolean).join("\n"),
    ...related.map((node) => [
      evidenceNatureLine(node, options),
      `[${time(node)}] 有明确关系的原因：${boundedText(node.content, limit)}`,
    ].filter(Boolean).join("\n")),
  ], options.maximumContextChars);
}

function stateScopeSections(completion, options) {
  const [primary, ...related] = completion.nodes;
  const limit = Math.max(80, Math.floor(options.maximumContextChars / (related.length + 1)));
  if (completion.mode === "exception-with-root") {
    return [
      [
        evidenceNatureLine(primary, options),
        `局部例外：${boundedText(primary.content, limit)}`,
      ].filter(Boolean).join("\n"),
      `它所限定的宽泛状态：${boundedText(related[0].content, limit)}`,
    ].filter(Boolean);
  }
  return [
    [
      evidenceNatureLine(primary, options),
      `宽泛状态：${boundedText(primary.content, limit)}`,
    ].filter(Boolean).join("\n"),
    ...related.map((node) => `局部例外：${boundedText(node.content, limit)}`),
  ].filter(Boolean);
}

function formatStateScopeCompletion(completion, options) {
  return joinBoundedSections(
    stateScopeSections(completion, options),
    options.maximumContextChars,
  );
}

function stateCompletionSections(current, historical, options) {
  return [
    [
      evidenceNatureLine(current, options),
      `当前状态：${boundedText(current.content, Math.floor(options.maximumContextChars * 0.46))}`,
    ].filter(Boolean).join("\n"),
    `过去的状态（已被后续更新）：${boundedText(historical.content, Math.floor(options.maximumContextChars * 0.38))}`,
  ].filter(Boolean);
}

function formatStateCompletion(current, historical, options) {
  return joinBoundedSections(
    stateCompletionSections(current, historical, options),
    options.maximumContextChars,
  );
}

function evidenceHeadingForIntent(intent) {
  if (intent === "counterevidence") return "相反依据：";
  if (intent === "evidence") return "直接依据：";
  return "相关原话：";
}

function missingEvidenceForIntent(intent) {
  if (intent === "counterevidence") {
    return "未找到与这条记忆直接关联的相反依据。";
  }
  if (intent === "evidence") {
    return "未找到与这条记忆直接关联的支持依据。";
  }
  return "未找到与这条记忆直接关联的原话证据。";
}

function formatEvidenceDisclosure({
  primary,
  evidence,
  intent,
  stateCompletion,
  scopeCompletion,
  options,
}) {
  if (!stateCompletion && !scopeCompletion) {
    return formatPrimary(primary, evidence, options, {
      evidenceRequested: true,
      evidenceHeading: evidenceHeadingForIntent(intent),
      missingEvidenceText: missingEvidenceForIntent(intent),
    });
  }
  const stateSections = stateCompletion
    ? stateCompletionSections(stateCompletion, primary, options)
    : stateScopeSections(scopeCompletion, options);
  if (!evidence.length) {
    return joinBoundedSections([
      ...stateSections,
      missingEvidenceForIntent(intent),
    ], options.maximumContextChars);
  }
  const evidenceHeading = evidenceHeadingForIntent(intent);
  return joinBoundedSections([
    ...stateSections,
    ...evidence.map((node, index) => [
      index === 0 ? evidenceHeading : "",
      formatEvidenceMemory(node, options),
    ].filter(Boolean).join("\n")),
  ], options.maximumContextChars);
}

function formatEvidenceReview({
  primary,
  supportEvidence,
  counterEvidence,
  stateCompletion,
  scopeCompletion,
  options,
}) {
  const sections = stateCompletion
    ? stateCompletionSections(stateCompletion, primary, options)
    : scopeCompletion
      ? stateScopeSections(scopeCompletion, options)
      : [formatPrimary(primary, [], options)];
  sections.push(supportEvidence.length
    ? ["最强直接依据：", formatEvidenceMemory(supportEvidence[0], options)].join("\n")
    : "未找到与这条记忆直接关联的支持依据。");
  sections.push(counterEvidence.length
    ? ["最强相反依据：", formatEvidenceMemory(counterEvidence[0], options)].join("\n")
    : "未找到与这条记忆直接关联的相反依据。");
  return joinBoundedSections(sections, options.maximumContextChars);
}

export function formatRecallText({
  intent,
  primary,
  evidence,
  supportEvidence,
  counterEvidence,
  stateCompletion,
  scopeCompletion,
  chain,
  lifecycleClosure,
  rawStateFallback,
  pendingStateChanges = [],
  options,
}) {
  if (pendingStateChanges.length) {
    const actionLabels = { create: "新增", reinforce: "再次确认", progress_update: "进展更新",
      supersede: "已变更", narrow_scope: "适用范围已调整", add_scoped_exception: "新增例外",
      pause: "已暂停", resume: "已恢复", complete: "已完成", cancel: "已取消", end: "已结束",
      retire: "不再适用", interrupt: "已中断", stop: "已停止", revoke: "已撤回",
      correct_attribution: "归属已更正" };
    // Review status does not outrank time: newer accepted states also take precedence.
    const ordered = [...chain.nodes].sort((left, right) =>
      String(right.known_at || right.recorded_at).localeCompare(String(left.known_at || left.recorded_at)));
    const sections = ordered.map(node => {
      const time = node.metadata?.sourceTimeKnown === false ? "时间未知" : timestampLabel(node.known_at || node.recorded_at, options.timeZone);
      if (!node.metadata?.reportedStateProposalId || !isProvisionalNode(node)) {
        const closed = options.closureLabel?.(node);
        return `[${time}] 记录${closed ? `（${closed}）` : ""}：${node.content}`;
      }
      const label = options.closureLabel?.(node) || actionLabels[node.metadata.reportedStateAction] || "更新";
      return `[${time}] ${node.title || "状态"}（${label}）：${node.content}`;
    });
    if (["evidence", "counterevidence", "evidence-review", "utterance"].includes(intent)) {
      sections.push(...evidence.map(node => formatEvidenceMemory(node, options)));
    }
    return joinBoundedSections(sections, options.maximumContextChars);
  }
  const recallText = intent === "evidence-review"
    ? formatEvidenceReview({
      primary,
      supportEvidence,
      counterEvidence,
      stateCompletion,
      scopeCompletion,
      options,
    })
    : ["evidence", "counterevidence", "utterance"].includes(intent)
    ? formatEvidenceDisclosure({
      primary,
      evidence,
      intent,
      stateCompletion,
      scopeCompletion,
      options,
    })
    : stateCompletion
    ? formatStateCompletion(stateCompletion, primary, options)
    : scopeCompletion
    ? formatStateScopeCompletion(scopeCompletion, options)
    : chain.mode === "causal" && chain.nodes.length > 1
    ? formatCausalChain(primary, chain.nodes, options, chain.direction)
    : chain.nodes.length > 1
    ? formatMemoryChain(chain.nodes, options, evidence)
    : formatPrimary(primary, evidence, options);
  const stateBoundary = rawStateFallback
    ? "记忆边界：以下是主体当时的原始陈述；可以据此复述其明确说法，但它尚未经过状态整理，不能自行扩大或更新为更强的稳定结论。"
    : "";
  if (!lifecycleClosure?.boundaryRequired) {
    return stateBoundary
      ? joinBoundedSections([stateBoundary, recallText], options.maximumContextChars)
      : recallText;
  }
  const boundary = lifecycleClosure.status === "pending"
    ? "记忆边界：最后已知进度仍在等待处理，没有后续闭环记忆；不能据此断言后来已经完成或取消。"
    : "记忆边界：这里只记得相关过程，没有明确的完成、取消或失败结局；不要猜测后来结果。";
  return joinBoundedSections(
    [stateBoundary, boundary, recallText].filter(Boolean),
    options.maximumContextChars,
  );
}

export function renderRecallOutput(input, options) {
  const available = Math.max(1, Number(options.maximumContextChars) - options.heading.length - options.guidance.length - 4);
  const formatOptions = { ...options, maximumContextChars: available };
  const requiredText = formatRecallText({ ...input, options: { ...formatOptions, maximumContextChars: 1_000_000 } });
  const budgeted = formatRecallText({ ...input, options: formatOptions });
  const text = boundedText(budgeted, available);
  return { text, context: options.heading + '\n' + options.guidance + '\n\n' + text, formatOptions,
    outputBudget: { maximumContextChars: Number(options.maximumContextChars), availableTextChars: available,
      requiredTextChars: requiredText.length, budgetedTextChars: budgeted.length, finalTextChars: text.length,
      sectionTruncationApplied: requiredText.length > budgeted.length, safetyTruncationApplied: budgeted.length > available } };
}
