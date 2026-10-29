import { mountBrainCanvas } from "./renderer.js";
const $ = (selector) => document.querySelector(selector);
const english = new URL(location.href).searchParams.get("lang") === "en";
const copy = english ? {
  graph: "Memory graph",
  workspace: "Conversation memory",
  actors: "People",
  episodes: "Experiences",
  states: "States",
  events: "Events",
  review: "Review console",
  refresh: "Refresh graph",
  pause: "Pause motion",
  resume: "Enable motion",
  search: "Find a person, topic or memory…",
  hint: "Drag to rotate, scroll to zoom, double-click to reset. Select a node to explore its links and original sources.",
  loading: "Loading…",
  empty: "Memory nodes appear here after processing.",
  failed: "Unable to load. Please retry.",
  sources: "Original sources",
  nodes: "nodes",
  edges: "links"
} : {
  graph: "记忆图谱",
  workspace: "会话记忆工作台",
  actors: "人物",
  episodes: "经历",
  states: "状态",
  events: "事件",
  review: "审核台",
  refresh: "刷新图谱",
  pause: "暂停动态",
  resume: "开启动效",
  search: "查找人物、话题或记忆…",
  hint: "拖动旋转 · 滚轮缩放 · 双击回到全景；点击节点查看关联与原话。",
  loading: "正在读取…",
  empty: "记忆整理完成后，节点会在这里出现。",
  failed: "读取未完成，请重试。",
  sources: "原话来源",
  nodes: "节点",
  edges: "连线"
};
Object.assign(copy, english ? { conversation: "Conversation", sessionsLoading: "Loading conversations…", sessionsRefresh: "Refresh conversations", switching: "Switching conversation…", sessionsFailed: "Unable to load conversations. Please refresh." }
  : { conversation: "查看会话", sessionsLoading: "正在读取会话…", sessionsRefresh: "刷新会话列表", switching: "正在切换会话…", sessionsFailed: "会话读取失败，请刷新重试。" });
document.documentElement.lang = english ? "en" : "zh-CN";
for (const [id, value] of Object.entries({ "graph-tab": copy.graph, "review-tab": copy.review, "graph-title": copy.graph, "workspace-label": copy.workspace, "legend-actors": copy.actors, "legend-episodes": copy.episodes, "legend-states": copy.states, "legend-events": copy.events, refresh: copy.refresh, motion: copy.pause, hint: copy.hint })) $("#" + id).textContent = value;
$("#search").placeholder = copy.search;
$("#search").setAttribute("aria-label", copy.search);
$("#conversation-label").textContent = copy.conversation;
$("#conversation option").textContent = copy.sessionsLoading;
$("#refresh-sessions").title = copy.sessionsRefresh;
$("#refresh-sessions").setAttribute("aria-label", copy.sessionsRefresh);
let currentSession, sessionRequest;
let graph, renderer, selected, graphRequest, detailRequest, view = "graph", animate = true, evidence = [];
const lifetime = new AbortController();
function sessionMessage(message = "") {
  $("#session-message").hidden = !message;
  $("#session-message").textContent = message;
}
async function loadSessions() {
  $("#conversation").disabled = true;
  $("#refresh-sessions").disabled = true;
  try {
    const data = await api("/memory/sessions");
    currentSession = data.currentId;
    $("#conversation").replaceChildren(...data.items.map(item => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.title;
      return option;
    }));
    $("#conversation").value = currentSession;
    sessionMessage();
  } catch (error) {
    if (!lifetime.signal.aborted) sessionMessage(copy.sessionsFailed);
  } finally {
    $("#conversation").disabled = !currentSession;
    $("#refresh-sessions").disabled = false;
  }
}
async function switchSession(id) {
  if (id === currentSession) return;
  sessionRequest?.abort();
  const request = sessionRequest = new AbortController();
  sessionMessage(copy.switching);
  $("#conversation").disabled = true;
  $("#refresh-sessions").disabled = true;
  try {
    const { url } = await api("/memory/sessions/" + encodeURIComponent(id), AbortSignal.any([request.signal, lifetime.signal]));
    if (request !== sessionRequest) return;
    const target = new URL(url);
    target.hash = view;
    if (english) target.searchParams.set("lang", "en");
    location.assign(target.href);
  } catch (error) {
    if (!request.signal.aborted && !lifetime.signal.aborted) {
      $("#conversation").value = currentSession;
      sessionMessage(copy.sessionsFailed);
      $("#conversation").disabled = false;
      $("#refresh-sessions").disabled = false;
    }
  }
}
async function api(path, signal = lifetime.signal) {
  const response = await fetch(path, { signal });
  const payload = await response.json();
  if (!response.ok || payload.status !== "success") throw new Error(payload.error?.message || copy.failed);
  return payload.data;
}
function paint() {
  if (view !== "graph" || !graph) return;
  renderer?.destroy();
  renderer = graph.nodes.length ? mountBrainCanvas($("canvas"), graph, select, selectEvidence) : null;
  renderer?.update({ animate, selected: selected?.id, evidence, query: $("#search").value.trim().toLocaleLowerCase() });
  $("#message").textContent = graph.nodes.length ? "" : copy.empty;
  $("#counts").textContent = `${graph.counts.nodes} ${copy.nodes} · ${graph.counts.edges} ${copy.edges}`;
}
async function load() {
  graphRequest?.abort();
  const request = graphRequest = new AbortController();
  $("#refresh").disabled = true;
  $("#message").textContent = copy.loading;
  try {
    const value = await api("/v1/brain", AbortSignal.any([request.signal, lifetime.signal]));
    if (request !== graphRequest) return;
    graph = value;
    select(null);
    paint();
    search();
  } catch (error) {
    if (!request.signal.aborted && !lifetime.signal.aborted) $("#message").textContent = error.message;
  } finally {
    if (request === graphRequest) $("#refresh").disabled = false;
  }
}
async function select(node) {
  detailRequest?.abort();
  selected = node;
  evidence = [];
  renderer?.update({ selected: node?.id, evidence });
  $("#detail").hidden = !node;
  $("#sources").replaceChildren();
  if (!node) return;
  $("#detail h2").textContent = node.title;
  $("#detail .content").textContent = node.preview || "";
  if (node.graphNodeType === "actor") return;
  const request = detailRequest = new AbortController();
  try {
    const detail = await api("/v1/memories/" + encodeURIComponent(node.id), AbortSignal.any([request.signal, lifetime.signal]));
    if (request !== detailRequest) return;
    $("#detail .content").textContent = detail?.memory?.content || node.preview || "";
    evidence = detail?.sources || [];
    renderer?.update({ evidence });
    if (evidence.length) {
      const heading = document.createElement("h3");
      heading.textContent = copy.sources;
      $("#sources").append(heading);
      for (const source of evidence) {
        const p = document.createElement("p");
        p.dataset.evidenceId = String(source.id || source.external_id || "");
        p.textContent = (source.speaker ? source.speaker + ": " : "") + source.content;
        $("#sources").append(p);
      }
    }
  } catch (error) {
    if (!request.signal.aborted && !lifetime.signal.aborted) $("#detail .content").textContent = error.message;
  }
}
function selectEvidence(source) {
  for (const element of $("#sources").querySelectorAll("[data-evidence-id]")) {
    const active = element.dataset.evidenceId === String(source.id || source.external_id || "");
    element.classList.toggle("is-selected", active);
    if (active) element.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
}
function search() {
  const query = $("#search").value.trim().toLocaleLowerCase();
  renderer?.update({ query });
  $("#matches").replaceChildren();
  if (!graph || !query) return;
  for (const node of graph.nodes.filter((node2) => `${node2.title || ""} ${node2.preview || ""}`.toLocaleLowerCase().includes(query))) {
    const button = document.createElement("button");
    button.textContent = node.title;
    button.onclick = () => {
      void select(node);
    };
    $("#matches").append(button);
  }
}
function show(next) {
  view = next;
  history.replaceState(null, "", "#" + next);
  $("#counts").hidden = next !== "graph";
  $("#graph-tab").setAttribute("aria-pressed", String(next === "graph"));
  $("#review-tab").setAttribute("aria-pressed", String(next === "review"));
  $("#graph-view").hidden = next !== "graph";
  $("#review-view").hidden = next !== "review";
  if (next === "review") {
    renderer?.destroy();
    renderer = null;
    if (!$("iframe").hasAttribute("src")) $("iframe").src = "/console/";
  } else if (graph) paint();
  else if (!graphRequest) void load();
}
$("#graph-tab").onclick = () => show("graph");
$("#conversation").onchange = event => { void switchSession(event.target.value); };
$("#refresh-sessions").onclick = () => { void loadSessions(); };
$("#review-tab").onclick = () => show("review");
$("#refresh").onclick = () => {
  void load();
};
$("#search").oninput = search;
$("#close-detail").onclick = () => {
  void select(null);
};
$("#motion").onclick = () => {
  animate = !animate;
  renderer?.update({ animate });
  $("#motion").textContent = animate ? copy.pause : copy.resume;
  $("#motion").setAttribute("aria-pressed", String(animate));
};
for (const button of document.querySelectorAll("[data-action]")) button.onclick = () => renderer?.control(button.dataset.action);
addEventListener("pagehide", () => {
  lifetime.abort();
  graphRequest?.abort();
  detailRequest?.abort();
  sessionRequest?.abort();
  renderer?.destroy();
});
show(location.hash === "#review" ? "review" : "graph");
void loadSessions();
