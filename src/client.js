window.__ModuleLoader__.load({
  id: 'dsh-suzu-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'suzuMemory';
    const TAB = 'dsh-suzu-memory';
    const zh = {
      title: 'Suzu Memory', description: '管理记忆与向量模型。',
      status: '当前会话', loading: '正在读取…', refresh: '刷新状态', processing: '正在整理',
      pending: '有待整理的对话', ready: '暂无待整理对话', review: '打开记忆审核台',
      maintain: '立即整理', working: '正在处理…', failed: '操作未完成，请重试。',
      embedding: 'Embedding 向量模型', scope: '此配置用于本 DSH 配置下的各个会话，记忆数据仍各自保存。',
      enabled: '启用向量检索', baseUrl: 'API 地址', model: '模型名称', dimensions: '向量维度',
      dimensionsHint: '留空使用服务默认值', key: 'API Key', keyHint: '留空保留已保存的密钥',
      save: '保存', saving: '正在保存…', saved: '已保存，下次检索和整理使用新配置。',
      conflict: '保存未被接受，可能已被其他页面修改。草稿已保留，请重新载入后再试。',
      unavailable: '当前无法修改配置。', invalid: '请填写 HTTP(S) 地址、模型名称和有效的正整数维度。',
      reload: '重新载入配置', noConsole: '审核台未启用。', error: '整理未完成',
      noSession: '先选择一个会话，即可在这里管理它的记忆。',
      conversation: '会话', chooseSession: '请选择会话', sessionLoading: '正在读取会话列表…',
      persona: '人设', personaDsh: '沿用 DSH 人设', personaCustom: '使用本会话人设',
      personaText: '人设内容', personaHint: '描述身份、性格、说话方式和关系设定。',
      compaction: '压缩提示词', compactDsh: '沿用 DSH 原模板', compactChat: '聊天模板', compactCustom: '自定义',
      compactText: '压缩提示词内容', promptSaved: '已保存。人设从下一次模型请求生效，压缩设置用于下一次压缩。',
      promptHint: '人设和压缩设置仅用于上方选中的会话。', promptInvalid: '请填写启用的自定义提示词，最长 32000 字符。',
      unsaved: '有未保存的修改，请先保存或重新载入，再切换会话。',
    };
    const en = {
      title: 'Suzu Memory', description: 'Manage memory and the embedding model.',
      status: 'This conversation', loading: 'Loading…', refresh: 'Refresh status', processing: 'Processing',
      pending: 'Conversation awaiting processing', ready: 'No conversation awaiting processing', review: 'Open memory console',
      maintain: 'Process now', working: 'Working…', failed: 'The operation failed. Please retry.',
      embedding: 'Embedding model', scope: 'These settings apply to this DSH profile. Each conversation retains its own memory.',
      enabled: 'Enable vector search', baseUrl: 'API URL', model: 'Model name', dimensions: 'Vector dimensions',
      dimensionsHint: 'Leave blank for the service default', key: 'API key', keyHint: 'Leave blank to keep the saved key',
      save: 'Save', saving: 'Saving…', saved: 'Saved. New settings apply to the next search and processing run.',
      conflict: 'The save was refused, possibly due to another edit. Your draft is retained; reload before retrying.',
      unavailable: 'Settings cannot be edited right now.', invalid: 'Enter an HTTP(S) URL, a model name, and valid positive integer dimensions.',
      reload: 'Reload settings', noConsole: 'The memory console is disabled.', error: 'Processing did not finish',
      noSession: 'Select a conversation to manage its memory here.',
      conversation: 'Conversation', chooseSession: 'Select a conversation', sessionLoading: 'Loading conversations…',
      persona: 'Persona', personaDsh: 'Use DSH persona', personaCustom: 'Use this conversation’s persona',
      personaText: 'Persona text', personaHint: 'Describe identity, personality, speaking style, and relationship.',
      compaction: 'Compaction prompt', compactDsh: 'Use DSH template', compactChat: 'Chat template', compactCustom: 'Custom',
      compactText: 'Compaction prompt text', promptSaved: 'Saved. Persona applies to the next model request; compaction settings apply to the next compaction.',
      promptHint: 'Persona and compaction settings apply only to the conversation selected above.',
      promptInvalid: 'Enter each enabled custom prompt, up to 32,000 characters.',
      unsaved: 'Save or reload your changes before switching conversations.',
    };
    Object.assign(zh, {
      controls: '运行与费用', memoryEnabled: '插件总开关', memoryDisabled: '记忆运行已暂停，已有内容仍可查看和审核。',
      disableHint: '总开关控制整个插件。各会话默认关闭，需要在上方单独启用。',
      sessionMemory: '启用此会话的 Suzu Memory',
      sessionCostHint: '默认关闭。开启后会补录此会话已有的聊天；随时整理或波谷整理模式下会调用模型处理，产生费用。关闭保留已有数据，并停止此会话的采集、召回、整理和提示词替换。',
      openMemoryPage: '打开记忆图谱与审核台',
      maintenanceMode: '自动整理', automatic: '随时整理', 'off-peak': '仅波谷整理', manual: '手动整理',
      offPeakHint: '高峰期只保存对话，进入可整理时段后自动处理。默认按北京时间工作日 09–12、14–18 暂停，周末全天可整理；节假日仍按周内规则，可自行调整。立即整理按当前时段计费。',
      billingZone: '时段使用的时区', windows: '每日可整理时段', weekends: '周末全天允许整理',
      batchedCompaction: '启用分段压缩', compactionBatch: '每段原文字符上限（可选）', compactionAuto: '自动：按压缩模型容量',
      compactionParallel: '压缩并发数',
      compactionBatchHint: '留空按压缩模型的可用上下文分批，预留提示词和输出空间；也可填写不小于 4000 的字符上限。独立分段并行摘要，再按原顺序合并；最近原文仍由 DSH 决定。',
      controlInvalid: '请检查时区、时段（如 22:00-08:00）、字符上限（留空或不小于 4000）和并发数（1–8）。', controlsSaved: '已保存，运行设置立即生效。',
      nativePersona: 'DSH 当前人设', nativeSystem: '查看 DSH 当前完整系统提示词', emptyPersona: 'DSH 未配置独立人设。',
      nativeCompaction: 'DSH 压缩模板', nativeReference: '官方参考模板 · 0.2.1-rc.3', nativeCaptured: '本会话最近使用的原始模板',
      waitingOffPeak: '等待波谷时段', manualPending: '等待手动整理',
      compactSummarizing: '分段摘要', compactMerging: '合并摘要', compactCompleted: '压缩完成', compactFailed: '压缩未完成，原文已保留',
    });
    Object.assign(en, {
      controls: 'Operation & cost', memoryEnabled: 'Plugin master switch', memoryDisabled: 'Memory processing is paused. Saved content remains available to view and review.',
      disableHint: 'The master switch controls the whole plugin. Each conversation starts disabled and must be enabled above.',
      sessionMemory: 'Enable Suzu Memory for this conversation',
      sessionCostHint: 'Off by default. Enabling imports this conversation’s existing history. Automatic or off-peak processing calls the model and incurs charges. Disabling retains saved data and stops capture, recall, processing and prompt overrides for this conversation.',
      openMemoryPage: 'Open memory graph & console',
      maintenanceMode: 'Automatic processing', automatic: 'Any time', 'off-peak': 'Off-peak only', manual: 'Manual',
      offPeakHint: 'Dialogue is saved during peak hours and processed in the allowed windows. The default excludes 09–12 and 14–18 on weekdays in Beijing time and allows weekends. Holidays follow the weekday schedule unless adjusted. Process now uses current rates.',
      billingZone: 'Schedule time zone', windows: 'Daily processing windows', weekends: 'Allow all day on weekends',
      batchedCompaction: 'Enable batched compaction', compactionBatch: 'Optional source character limit per batch', compactionAuto: 'Automatic: use compaction model capacity',
      compactionParallel: 'Concurrent compaction requests',
      compactionBatchHint: 'Leave blank to batch within the compaction model’s context, reserving space for instructions and output, or enter a character cap of at least 4,000. Summarize independent batches concurrently, then merge in order. DSH controls the retained original text.',
      controlInvalid: 'Check the time zone, windows (e.g. 22:00-08:00), optional character cap (at least 4,000), and concurrency (1–8).', controlsSaved: 'Saved. Operation settings apply immediately.',
      nativePersona: 'Current DSH persona', nativeSystem: 'View the current complete DSH system prompt', emptyPersona: 'DSH has no separate persona.',
      nativeCompaction: 'DSH compaction template', nativeReference: 'Official reference · 0.2.1-rc.3', nativeCaptured: 'Original template last used in this conversation',
      waitingOffPeak: 'Waiting for an off-peak window', manualPending: 'Waiting for manual processing',
      compactSummarizing: 'Summarizing batches', compactMerging: 'Merging summaries', compactCompleted: 'Compaction complete', compactFailed: 'Compaction failed; original history retained',
    });
    const css = `
      .suzu-memory {color:var(--dsw-alias-label-primary);font:inherit;padding:20px;overflow:auto;height:100%;box-sizing:border-box;}
      .suzu-memory * {box-sizing:border-box;}
      .suzu-memory h2 {font-size:16px;margin:0 0 12px;font-weight:600;}
      .suzu-memory section+section {border-top:1px solid var(--dsw-alias-border-l3);margin-top:24px;padding-top:24px;}
      .suzu-memory p {color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;margin:8px 0;overflow-wrap:anywhere;}
      .suzu-memory label {display:grid;gap:6px;font-size:13px;margin:14px 0;}
      .suzu-memory input:not([type=checkbox]),.suzu-memory select,.suzu-memory textarea {font:inherit;width:100%;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}
      .suzu-memory textarea {resize:vertical;min-height:140px;line-height:1.6;}
      .suzu-memory .suzu-check {display:flex;align-items:center;gap:8px;}
      .suzu-memory fieldset {border:0;padding:0;margin:0;min-width:0;}
      .suzu-memory button,.suzu-memory a {font:inherit;font-size:13px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:7px 11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;text-decoration:none;}
      .suzu-memory button:disabled {opacity:.5;cursor:default;}
      .suzu-memory :focus-visible {outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;}
      .suzu-memory-actions {display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;}
      .suzu-memory-message {white-space:pre-wrap;}
      .suzu-prompt-reference {font-size:12px;line-height:1.65;white-space:pre-wrap;max-height:280px;overflow:auto;padding:14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);margin:8px 0;}
      @media(max-width:700px){.suzu-memory{padding:14px;}}
    `;
    const style = () => h('style', null, css);

    function ControlForm({ t, settingsForm }) {
      const snapshot = React.useSyncExternalStore(React.useCallback(fn => settingsForm.subscribe(fn), [settingsForm]),
        React.useCallback(() => settingsForm.getSnapshot(), [settingsForm]));
      const valueOf = value => ({ enabled: value.enabled !== false,
        mode: value.automaticMaintenance === false ? 'manual' : value.offPeakOnly ? 'off-peak' : 'automatic',
        batchedCompaction: value.batchedCompaction !== false, compactionBatchCharacters: value.compactionBatchCharacters || '',
        compactionConcurrency: value.compactionConcurrency ?? 3,
        timeZone: value.offPeakSchedule?.timeZone || 'Asia/Shanghai', weekends: value.offPeakSchedule?.weekends !== false,
        windows: (value.offPeakSchedule?.windows || [{ start: '00:00', end: '09:00' }, { start: '12:00', end: '14:00' }, { start: '18:00', end: '24:00' }])
          .map(item => item.start + '-' + item.end).join(', ') });
      const [draft, setDraft] = React.useState(() => valueOf(snapshot.value || {}));
      const [revision, setRevision] = React.useState(snapshot.revision);
      const [dirty, setDirty] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const mounted = React.useRef(true);
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
      React.useEffect(() => { if (!dirty) { setDraft(valueOf(snapshot.value || {})); setRevision(snapshot.revision); } }, [snapshot, dirty]);
      const change = (key, value) => { setDraft(old => ({ ...old, [key]: value })); setDirty(true); setMessage(''); };
      async function save(event) {
        event.preventDefault();
        let windows;
        try {
          new Intl.DateTimeFormat('en', { timeZone: draft.timeZone });
          windows = draft.windows.split(/[,，]/u).map(text => {
            const match = /^\s*((?:[01]\d|2[0-3]):[0-5]\d)\s*-\s*((?:[01]\d|2[0-3]):[0-5]\d|24:00)\s*$/u.exec(text);
            if (!match || match[1] === match[2]) throw new Error('time');
            return { start: match[1], end: match[2] };
          });
          const cap = Number(draft.compactionBatchCharacters);
          if (!Number.isSafeInteger(cap) || (cap !== 0 && cap < 4000)) throw new Error('batch');
          if (!Number.isSafeInteger(Number(draft.compactionConcurrency)) || draft.compactionConcurrency < 1 || draft.compactionConcurrency > 8) throw new Error('concurrency');
        } catch { setMessage('controlInvalid'); return; }
        const values = { enabled: draft.enabled, automaticMaintenance: draft.mode !== 'manual', offPeakOnly: draft.mode === 'off-peak',
          offPeakSchedule: { timeZone: draft.timeZone, weekends: draft.weekends, windows },
          batchedCompaction: draft.batchedCompaction, compactionBatchCharacters: Number(draft.compactionBatchCharacters),
          compactionConcurrency: Number(draft.compactionConcurrency) };
        setSaving(true);
        try {
          const accepted = await settingsForm.mutate(Object.entries(values).map(([key, value]) => ({ op: 'set', path: [key], value })), revision);
          if (mounted.current) { setMessage(accepted ? 'controlsSaved' : 'conflict'); if (accepted) setDirty(false); }
        } catch { if (mounted.current) setMessage('failed'); }
        finally { if (mounted.current) setSaving(false); }
      }
      return h('section', null, h('h2', null, t('controls')), h('form', { onSubmit: save },
        h('fieldset', { disabled: saving || snapshot.status !== 'ready' || !snapshot.writable },
          h('label', { className: 'suzu-check' }, h('input', { type: 'checkbox', checked: draft.enabled, onChange: e => change('enabled', e.target.checked) }), t('memoryEnabled')),
          h('p', null, t('disableHint')),
          h('label', null, t('maintenanceMode'), h('select', { value: draft.mode, onChange: e => change('mode', e.target.value) },
            ['automatic', 'off-peak', 'manual'].map(mode => h('option', { key: mode, value: mode }, t(mode))))),
          draft.mode === 'off-peak' && h(React.Fragment, null,
            h('p', null, t('offPeakHint')),
            h('label', null, t('billingZone'), h('input', { value: draft.timeZone, onChange: e => change('timeZone', e.target.value) })),
            h('label', null, t('windows'), h('input', { value: draft.windows, onChange: e => change('windows', e.target.value) })),
            h('label', { className: 'suzu-check' }, h('input', { type: 'checkbox', checked: draft.weekends, onChange: e => change('weekends', e.target.checked) }), t('weekends'))),
          h('label', { className: 'suzu-check' }, h('input', { type: 'checkbox', checked: draft.batchedCompaction, onChange: e => change('batchedCompaction', e.target.checked) }), t('batchedCompaction')),
          h('label', null, t('compactionBatch'), h('input', { type: 'number', min: 0, step: 1, placeholder: t('compactionAuto'), value: draft.compactionBatchCharacters,
            disabled: !draft.batchedCompaction, onChange: e => change('compactionBatchCharacters', e.target.value) })),
          h('label', null, t('compactionParallel'), h('input', { type: 'number', min: 1, max: 8, step: 1, value: draft.compactionConcurrency,
            disabled: !draft.batchedCompaction, onChange: e => change('compactionConcurrency', e.target.value) })),
          h('p', null, t('compactionBatchHint')),
          h('button', { type: 'submit', disabled: !dirty || saving }, t(saving ? 'saving' : 'save')))),
        snapshot.status !== 'ready' || !snapshot.writable ? h('p', { role: 'alert' }, t(snapshot.status === 'loading' ? 'loading' : 'unavailable')) : null,
        message && h('p', { role: message === 'controlsSaved' ? 'status' : 'alert' }, t(message)));
    }


    function draftOf(snapshot) {
      const value = snapshot.value?.embedding;
      return { enabled: Boolean(value && value.enabled !== false), baseUrl: value?.baseUrl || '', model: value?.model || '',
        dimensions: value?.dimensions ? String(value.dimensions) : '', apiKey: '' };
    }

    function EmbeddingForm({ t, settingsForm }) {
      const subscribe = React.useCallback(listener => settingsForm.subscribe(listener), [settingsForm]);
      const getSnapshot = React.useCallback(() => settingsForm.getSnapshot(), [settingsForm]);
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);
      const [draft, setDraft] = React.useState(() => draftOf(snapshot));
      const [revision, setRevision] = React.useState(snapshot.revision);
      const [dirty, setDirty] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const mounted = React.useRef(true);
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
      React.useEffect(() => {
        if (!dirty) { setDraft(draftOf(snapshot)); setRevision(snapshot.revision); }
      }, [snapshot, dirty]);
      const change = (field, value) => { setDirty(true); setMessage(''); setDraft(old => ({ ...old, [field]: value })); };
      const available = snapshot.status === 'ready' && snapshot.writable;
      async function save(event) {
        event.preventDefault();
        let validUrl = false;
        try { validUrl = ['http:', 'https:'].includes(new URL(draft.baseUrl.trim()).protocol); } catch { /* The field error is rendered below. */ }
        if (draft.enabled && (!validUrl || !draft.model.trim()
          || (draft.dimensions && (!Number.isSafeInteger(Number(draft.dimensions)) || Number(draft.dimensions) < 1)))) {
          setMessage('invalid'); return;
        }
        let operations;
        if (!draft.enabled) operations = snapshot.value?.embedding
          ? [{ op: 'set', path: ['embedding', 'enabled'], value: false }]
          : [{ op: 'set', path: ['embedding'], value: null }];
        else {
          operations = snapshot.value?.embedding ? [] : [{ op: 'set', path: ['embedding'], value: {} }];
          for (const [key, value] of Object.entries({ enabled: true, baseUrl: draft.baseUrl.trim(), model: draft.model.trim(),
            dimensions: draft.dimensions ? Number(draft.dimensions) : undefined })) {
            operations.push(value === undefined ? { op: 'unset', path: ['embedding', key] } : { op: 'set', path: ['embedding', key], value });
          }
          if (draft.apiKey.trim()) operations.push({ op: 'set', path: ['embedding', 'apiKey'], value: draft.apiKey.trim() });
        }
        setSaving(true); setMessage('');
        try {
          const accepted = await settingsForm.mutate(operations, revision);
          if (!mounted.current) return;
          if (accepted) { setDirty(false); setDraft(draftOf(settingsForm.getSnapshot())); setMessage('saved'); }
          else setMessage('conflict');
        } catch { if (mounted.current) setMessage('failed'); }
        finally { if (mounted.current) setSaving(false); }
      }
      function field(key, label, options = {}) {
        return h('label', { key }, t(label), h('input', {
          type: 'text', ...options, value: draft[key], onChange: event => change(key, event.target.value),
          disabled: !draft.enabled || saving || !available,
        }));
      }
      return h('section', null, h('h2', null, t('embedding')), h('p', null, t('scope')),
        h('form', { onSubmit: save }, h('fieldset', { disabled: !available || saving },
          h('label', { className: 'suzu-check' }, h('input', { type: 'checkbox', checked: draft.enabled,
            onChange: event => change('enabled', event.target.checked) }), t('enabled')),
          field('baseUrl', 'baseUrl', { type: 'url', autoComplete: 'url', placeholder: 'https://…/v1' }),
          field('model', 'model'), field('dimensions', 'dimensions', { inputMode: 'numeric', placeholder: t('dimensionsHint') }),
          field('apiKey', 'key', { type: 'password', autoComplete: 'new-password', placeholder: t('keyHint') }),
          h('div', { className: 'suzu-memory-actions' },
            h('button', { type: 'submit', disabled: !dirty || saving }, t(saving ? 'saving' : 'save')),
            h('button', { type: 'button', onClick: () => { setDirty(false); setMessage(''); }, disabled: saving }, t('reload'))))),
        !available && h('p', { role: 'status' }, t(snapshot.status === 'loading' ? 'loading' : 'unavailable')),
        message && h('p', { role: message === 'saved' ? 'status' : 'alert', className: 'suzu-memory-message' }, t(message)));
    }

    function PromptForm({ t, sessionId, revision, executeCommand, onEditing, onSaved }) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [template, setTemplate] = React.useState('');
      const [native, setNative] = React.useState(null);
      const [dirty, setDirty] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const generation = React.useRef(0);
      const editing = React.useRef(false);
      editing.current = dirty || saving;
      const valueOf = value => ({ personaMode: value.personaMode, persona: value.persona,
        compactionMode: value.compactionMode, compactionPrompt: value.compactionPrompt });
      React.useEffect(() => {
        onEditing(dirty || saving);
        return () => onEditing(false);
      }, [dirty, saving, onEditing]);
      React.useEffect(() => {
        if (dirty || saving || (snapshot && snapshot.revision === revision)) return;
        const current = ++generation.current;
        if (sessionId) void executeCommand(sessionId, 'suzu-memory-prompts').then(result => {
          if (current !== generation.current || editing.current) return;
          setSnapshot(result.value); setDraft(valueOf(result.value)); setTemplate(result.chatTemplate); setNative(result.native);
        }).catch(() => { if (current === generation.current) setMessage('failed'); });
      }, [sessionId, revision]);
      React.useEffect(() => () => { generation.current++; }, [sessionId]);
      const change = (key, value) => { setDraft(old => ({ ...old, [key]: value })); setDirty(true); setMessage(''); };
      async function save(event) {
        event.preventDefault();
        if (!draft || !snapshot || !sessionId) return;
        if ((draft.personaMode === 'custom' && !draft.persona.trim())
          || (draft.compactionMode === 'custom' && !draft.compactionPrompt.trim())
          || draft.persona.length > 32000 || draft.compactionPrompt.length > 32000) { setMessage('promptInvalid'); return; }
        const current = ++generation.current;
        setSaving(true); setMessage('');
        try {
          const result = await executeCommand(sessionId, 'suzu-memory-save-prompts', { value: draft, revision: snapshot.revision });
          if (current !== generation.current) return;
          if (result.saved) { setSnapshot(result.value); setDraft(valueOf(result.value)); setDirty(false); setMessage('promptSaved'); onSaved(); }
          else setMessage('conflict');
        } catch { if (current === generation.current) setMessage('failed'); }
        finally { if (current === generation.current) setSaving(false); }
      }
      async function reload() {
        const current = ++generation.current;
        setSaving(true);
        try {
          const result = await executeCommand(sessionId, 'suzu-memory-prompts');
          if (current !== generation.current) return;
          setSnapshot(result.value); setDraft(valueOf(result.value)); setTemplate(result.chatTemplate); setNative(result.native); setDirty(false); setMessage('');
        } catch { if (current === generation.current) setMessage('failed'); }
        finally { if (current === generation.current) setSaving(false); }
      }
      function mode(key, label, choices) {
        return h('label', null, t(label), h('select', { disabled: !draft, value: draft?.[key] || 'dsh',
          onChange: event => {
            if (key === 'compactionMode' && event.target.value === 'custom' && !draft.compactionPrompt) {
              setDraft(old => ({ ...old, compactionMode: 'custom', compactionPrompt: draft.compactionMode === 'chat' ? template : native?.compaction || '' })); setDirty(true); setMessage('');
            } else if (key === 'personaMode' && event.target.value === 'custom' && !draft.persona) {
              setDraft(old => ({ ...old, personaMode: 'custom', persona: native?.persona || '' })); setDirty(true); setMessage('');
            } else change(key, event.target.value);
          } }, choices.map(([value, text]) => h('option', { key: value, value }, t(text)))));
      }
      return h('section', null, h('h2', null, t('persona')), h('p', null, t('promptHint')),
        h('form', { onSubmit: save }, h('fieldset', { disabled: saving || !sessionId },
          mode('personaMode', 'persona', [['dsh', 'personaDsh'], ['custom', 'personaCustom']]),
          native && h('details', { open: draft?.personaMode === 'dsh' }, h('summary', null, t('nativePersona')),
            h('pre', { className: 'suzu-prompt-reference' }, native.persona || t('emptyPersona')),
            h('details', null, h('summary', null, t('nativeSystem')), h('pre', { className: 'suzu-prompt-reference' }, native.systemPrompt))),
          draft?.personaMode === 'custom' && h('label', null, t('personaText'), h('textarea', {
            value: draft.persona, maxLength: 32000, placeholder: t('personaHint'), onChange: event => change('persona', event.target.value) })),
          mode('compactionMode', 'compaction', [['dsh', 'compactDsh'], ['chat', 'compactChat'], ['custom', 'compactCustom']]),
          native && h('details', { open: draft?.compactionMode === 'dsh' }, h('summary', null, t('nativeCompaction')),
            h('p', null, t(native.compactionSource === 'session' ? 'nativeCaptured' : 'nativeReference')),
            h('pre', { className: 'suzu-prompt-reference' }, native.compaction)),
          draft && draft.compactionMode !== 'dsh' && h('label', null, t('compactText'), h('textarea', {
            value: draft.compactionMode === 'chat' ? template : draft.compactionPrompt, readOnly: draft.compactionMode === 'chat',
            maxLength: 32000, onChange: event => change('compactionPrompt', event.target.value) })),
          h('div', { className: 'suzu-memory-actions' },
            h('button', { type: 'submit', disabled: !dirty || saving }, t(saving ? 'saving' : 'save')),
            h('button', { type: 'button', disabled: saving, onClick: () => { void reload(); } }, t('reload'))))),
        sessionId && !draft && !message && h('p', { role: 'status' }, t('loading')),
        message && h('p', { role: message === 'promptSaved' ? 'status' : 'alert' }, t(message)));
    }

    function MemoryPanel({ t, sessionId, executeCommand, settingsForm, children, onEditing, editing }) {
      const settingsSnapshot = React.useSyncExternalStore(React.useCallback(fn => settingsForm.subscribe(fn), [settingsForm]),
        React.useCallback(() => settingsForm.getSnapshot(), [settingsForm]));
      const enabled = settingsSnapshot.value?.enabled !== false;
      const [switching, setSwitching] = React.useState(false);
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const generation = React.useRef(0);
      const currentStatus = status?.sessionId === sessionId ? status : null;
      const activeSession = React.useRef(sessionId);
      activeSession.current = sessionId;
      async function load(maintain = false) {
        const current = ++generation.current;
        setBusy(true); setError('');
        try {
          if (maintain) await executeCommand(sessionId, 'suzu-memory-maintain');
          if (current !== generation.current) return;
          const value = await executeCommand(sessionId, 'suzu-memory-status');
          if (current === generation.current) { setStatus({ ...value, sessionId });  }
        } catch { if (current === generation.current) setError('failed'); }
        finally { if (current === generation.current) setBusy(false); }
      }
      async function toggleMemory(checked) {
        generation.current++;
        setSwitching(true); setError('');
        try {
          const result = await executeCommand(sessionId, 'suzu-memory-enable', { enabled: checked, revision: currentStatus.settingsRevision });
          if (sessionId !== activeSession.current) return;
          if (!result.saved) { setError('conflict'); return; }
          await load();
        } catch { if (sessionId === activeSession.current) setError('failed'); }
        finally { setSwitching(false); }
      }
      React.useEffect(() => {
        activeSession.current = sessionId;
        setStatus(value => value?.sessionId === sessionId ? value : null); setBusy(false); setError('');
        if (sessionId) void load();
        return () => { generation.current++; activeSession.current = null; };
      }, [sessionId, settingsSnapshot.revision]);
      return h('div', { className: 'suzu-memory' }, style(), children, h('section', null,
        h('h2', null, t('status')),
        h('label', { className: 'suzu-check' }, h('input', { type: 'checkbox', checked: currentStatus?.sessionEnabled === true,
          disabled: !sessionId || !currentStatus || busy || switching || editing || !enabled,
          onChange: event => { void toggleMemory(event.target.checked); } }), t('sessionMemory')),
        h('p', null, t('sessionCostHint')),
        h('p', { role: 'status' }, !sessionId ? t('noSession')
          : !enabled ? t('memoryDisabled') : currentStatus ? t(currentStatus.enabled === false ? 'memoryDisabled' : currentStatus.processing ? 'processing' : currentStatus.deferred ? 'waitingOffPeak'
            : currentStatus.pending && !currentStatus.policy?.automatic ? 'manualPending' : currentStatus.pending ? 'pending' : 'ready') : t('loading')),
        currentStatus?.compaction && h('p', null, t({ summarizing: 'compactSummarizing', merging: 'compactMerging', completed: 'compactCompleted', failed: 'compactFailed' }[currentStatus.compaction.phase])
          + (['summarizing', 'merging'].includes(currentStatus.compaction.phase) ? ` ${currentStatus.compaction.completed || 0}/${currentStatus.compaction.total || 0}` : '')),
        currentStatus?.error && h('p', { role: 'alert' }, t('error')),
        error && h('p', { role: 'alert' }, t(error)),
        h('div', { className: 'suzu-memory-actions' },
          currentStatus?.consoleUrl && h('a', { href: currentStatus.consoleUrl, target: '_blank', rel: 'noopener noreferrer' }, t('openMemoryPage')),
          h('button', { type: 'button', onClick: () => { void load(); }, disabled: busy || switching || !sessionId }, t('refresh')),
          h('button', { type: 'button', onClick: () => { void load(true); }, disabled: busy || switching || !sessionId || !enabled || currentStatus?.enabled !== true }, t(busy ? 'working' : 'maintain'))),
        currentStatus?.enabled && !currentStatus.consoleUrl && h('p', null, t('noConsole'))),
        h(ControlForm, { t, settingsForm }),
        h(PromptForm, { key: sessionId || 'none', t, sessionId, revision: currentStatus?.settingsRevision, executeCommand, onEditing, onSaved: () => { void load(); } }),
        h(EmbeddingForm, { t, settingsForm }));
    }

    function MemorySettingsPage(props) {
      const activeId = props.useSelectedSession(value => value);
      const sessions = props.useMemorySessions(value => value);
      const [selection, setSelection] = React.useState(activeId || '');
      const [editing, setEditing] = React.useState(false);
      const sessionId = selection;
      React.useEffect(() => { if (!selection && activeId && !editing) setSelection(activeId); }, [activeId, selection, editing]);
      const onEditing = React.useCallback(value => setEditing(value), []);
      const ids = sessions.ids || [];
      const available = sessionId && ids.includes(sessionId);
      return h(MemoryPanel, { ...props, sessionId: available ? sessionId : '', onEditing, editing },
        h('section', null, h('label', null, props.t('conversation'), h('select', {
          value: available ? sessionId : '', disabled: editing || sessions.phase === 'pending',
          onChange: event => setSelection(event.target.value),
        }, h('option', { value: '', disabled: true }, props.t(sessions.phase === 'pending' ? 'sessionLoading' : 'chooseSession')),
        ids.map(id => h('option', { key: id, value: id }, sessions.byId[id]?.displayTitle || id)))),
        editing && h('p', { role: 'status' }, props.t('unsaved'))));
    }

    function SettingsPage(props) {
      if (props.view === 'summary') return props.t('description');
      return h('div', { className: 'suzu-memory' }, style(), h(ControlForm, props), h(EmbeddingForm, props));
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'configForms', 'sessions', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }));
        const t = ctx.locale.bind(NS);
        const settingsForm = ctx.configForms.get('suzu-memory');
        const executeCommand = async (sessionId, name, payload) => {
          const response = await ctx.remote.commands.execute(sessionId, `/${name}${payload === undefined ? '' : ' ' + JSON.stringify(payload)}`, []);
          if (!response.ok || response.value?.result.kind !== 'success') throw new Error('Memory operation failed');
          return JSON.parse(response.value.result.text);
        };
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: TAB, order: 25, label: () => t('title'), locale: NS,
          inject: () => ({ settingsForm, executeCommand, hooks: { selectedSession: ctx.sidebarRight.mounted, memorySessions: ctx.sessions.list } }),
        }, MemorySettingsPage));
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: TAB, locale: NS, inject: () => ({ settingsForm }),
        }, SettingsPage));
      },
    };
  },
});
