import React from 'react';
import { createRoot } from 'react-dom/client';

// Only the DSH client services are substituted. The component is registered
// through the plugin's actual public client entry, with real React DOM events.
const request = async (pathname, value) => {
  const response = await fetch(pathname, value === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error('Test host request failed: ' + response.status);
  return response.json();
};
const initial = await request('/api/bootstrap');
let snapshot = initial.snapshot;
const listeners = new Set();
const settingsForm = {
  getSnapshot: () => snapshot,
  subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  async mutate(operations, revision) {
    const result = await request('/api/config', { operations, revision });
    if (result.accepted) {
      snapshot = result.snapshot;
      for (const listener of listeners) listener();
    }
    return result.accepted;
  },
};
let registration, dictionaries;
const ctx = {
  effect: fn => fn(),
  locale: { register(_name, values) { dictionaries = values; }, bind: () => key => dictionaries.zh[key] },
  configForms: { get: () => settingsForm },
  sidebarRight: { mounted: {} }, sessions: { list: {} },
  remote: { commands: { execute: (sessionId, command) => request('/api/command', { sessionId, command }) } },
  slots: {
    inject: (_name, fn) => fn(),
    register(metadata, Component) { if (metadata.name === 'settings.section') registration = { metadata, Component }; },
  },
};
window.__ModuleLoader__ = { load(entry) {
  entry.factory(name => {
    if (name !== 'react') throw new Error('Unexpected client dependency: ' + name);
    return React;
  }).apply(ctx);
} };
await import('/client.js');
const props = registration.metadata.inject();
createRoot(document.getElementById('root')).render(React.createElement(registration.Component, {
  ...props, t: ctx.locale.bind(),
  useSelectedSession: select => select(initial.sessions.ids[0]),
  useMemorySessions: select => select(initial.sessions),
}));
