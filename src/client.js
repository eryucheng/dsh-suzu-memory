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
    };
    const css = `
      .suzu-memory {color:var(--dsw-alias-label-primary);font:inherit;padding:20px;overflow:auto;height:100%;box-sizing:border-box;}
      .suzu-memory * {box-sizing:border-box;}
      .suzu-memory h2 {font-size:16px;margin:0 0 12px;font-weight:600;}
      .suzu-memory section+section {border-top:1px solid var(--dsw-alias-border-l3);margin-top:24px;padding-top:24px;}
      .suzu-memory p {color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;margin:8px 0;overflow-wrap:anywhere;}
      .suzu-memory label {display:grid;gap:6px;font-size:13px;margin:14px 0;}
      .suzu-memory input:not([type=checkbox]) {font:inherit;width:100%;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}
      .suzu-memory .suzu-check {display:flex;align-items:center;gap:8px;}
      .suzu-memory fieldset {border:0;padding:0;margin:0;min-width:0;}
      .suzu-memory button,.suzu-memory a {font:inherit;font-size:13px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:7px 11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;text-decoration:none;}
      .suzu-memory button:disabled {opacity:.5;cursor:default;}
      .suzu-memory :focus-visible {outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;}
      .suzu-memory-actions {display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;}
      .suzu-memory-message {white-space:pre-wrap;}
    `;
    const style = () => h('style', null, css);

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

    function MemoryPanel({ t, sessionId, executeCommand, settingsForm }) {
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const generation = React.useRef(0);
      const currentStatus = status?.sessionId === sessionId ? status : null;
      async function load(maintain = false) {
        const current = ++generation.current;
        setBusy(true); setError('');
        try {
          if (maintain) await executeCommand(sessionId, 'suzu-memory-maintain');
          const value = await executeCommand(sessionId, 'suzu-memory-status');
          if (current === generation.current) setStatus({ ...value, sessionId });
        } catch { if (current === generation.current) setError('failed'); }
        finally { if (current === generation.current) setBusy(false); }
      }
      React.useEffect(() => {
        setStatus(null); setBusy(false); setError('');
        if (sessionId) void load();
        return () => { generation.current++; };
      }, [sessionId]);
      return h('div', { className: 'suzu-memory' }, style(), h('section', null,
        h('h2', null, t('status')),
        h('p', { role: 'status' }, !sessionId ? t('noSession')
          : currentStatus ? t(currentStatus.processing ? 'processing' : currentStatus.pending ? 'pending' : 'ready') : t('loading')),
        currentStatus?.error && h('p', { role: 'alert' }, t('error')),
        error && h('p', { role: 'alert' }, t(error)),
        h('div', { className: 'suzu-memory-actions' },
          currentStatus?.consoleUrl && h('a', { href: currentStatus.consoleUrl, target: '_blank', rel: 'noopener noreferrer' }, t('review')),
          h('button', { type: 'button', onClick: () => { void load(); }, disabled: busy || !sessionId }, t('refresh')),
          h('button', { type: 'button', onClick: () => { void load(true); }, disabled: busy || !sessionId }, t(busy ? 'working' : 'maintain'))),
        currentStatus && !currentStatus.consoleUrl && h('p', null, t('noConsole'))),
        h(EmbeddingForm, { t, settingsForm }));
    }

    function MemorySettingsPage(props) {
      const sessionId = props.useSelectedSession(value => value);
      return h(MemoryPanel, { ...props, sessionId });
    }

    function SettingsPage(props) {
      if (props.view === 'summary') return props.t('description');
      return h('div', { className: 'suzu-memory' }, style(), h(EmbeddingForm, props));
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'configForms', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }));
        const t = ctx.locale.bind(NS);
        const settingsForm = ctx.configForms.get('suzu-memory');
        const executeCommand = async (sessionId, name) => {
          const response = await ctx.remote.commands.execute(sessionId, `/${name}`, []);
          if (!response.ok || response.value?.result.kind !== 'success') throw new Error('Memory operation failed');
          return JSON.parse(response.value.result.text);
        };
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: TAB, order: 25, label: () => t('title'), locale: NS,
          inject: () => ({ settingsForm, executeCommand, hooks: { selectedSession: ctx.sidebarRight.mounted } }),
        }, MemorySettingsPage));
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: TAB, locale: NS, inject: () => ({ settingsForm }),
        }, SettingsPage));
      },
    };
  },
});
