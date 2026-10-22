import { createHash } from 'node:crypto';

export function sessionMemoryId(sessionId) {
  return `dsh-${createHash('sha256').update(String(sessionId)).digest('hex')}`;
}

export function sourceScope(session, upperBound = Number(session.seq)) {
  return { owner: 'deepseek-harness', agentId: sessionMemoryId(session.id), eventUpperBound: upperBound, clears: [] };
}

/** Converts committed conversational text, keeping the host's message identity. */
export function memoryEvent(session, event, identity) {
  const user = event.type === 'user/message';
  if (!user && event.type !== 'assistant/message') return null;
  const message = user ? event.data : event.data.message;
  if (user && message.source.kind !== 'user') return null;
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  if (!text.trim()) return null;
  const occurredAt = new Date(event.time).toISOString();
  return {
    occurredAt,
    content: { text },
    source: {
      version: 1, owner: 'deepseek-harness', recipientAgentId: identity.agentId,
      eventId: `dsh:${encodeURIComponent(session.id)}:${event.seq}:${encodeURIComponent(message.id)}`,
      spaceId: session.id, commitSequence: Number(event.seq) + 1, eventType: event.type,
      sender: { id: user ? identity.userId : identity.agentId, kind: user ? 'local-user' : 'agent', name: user ? identity.userName : identity.memoryOwner },
      topology: { kind: 'direct-user-agent-dm', participants: [{ kind: 'local-user', id: identity.userId }, { kind: 'agent', id: identity.agentId }] },
      dsh: { sessionId: session.id, messageId: message.id, sequence: Number(event.seq), ...(event.data.interrupted ? { interrupted: true } : {}) },
    },
  };
}
