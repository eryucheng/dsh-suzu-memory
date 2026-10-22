// Native compaction appends this directive after an exact replayed conversation prefix.
const NATIVE_DIRECTIVE = 'You are now acting as a compaction engine';

/** Route the native auxiliary call with a new directive, without mutating its input or backend. */
export function installCompactionPrompts(ctx, prompts) {
  const redirected = new WeakSet();
  ctx.on('llm/stream', (options, next) => {
    const last = options.messages?.at(-1);
    if (options.purpose !== 'compaction' || !options.sessionId || redirected.has(options)
      || last?.role !== 'user' || last.content?.length !== 1
      || last.content[0].type !== 'text' || !last.content[0].text.startsWith(NATIVE_DIRECTIVE)) return next();
    const instruction = prompts.compactionInstruction(options.sessionId);
    if (instruction === null) return next();
    // A fresh routed call preserves the caller's immutable input, model,
    // cancellation and budget options, including preset-scoped compaction.
    const routed = { ...options, messages: [...options.messages.slice(0, -1),
      Object.freeze({ ...last, content: Object.freeze([Object.freeze({ type: 'text', text: instruction })]) })] };
    redirected.add(routed);
    return ctx.llm.stream(routed);
  });
}
