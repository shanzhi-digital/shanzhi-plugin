import { KEY, SQL_TOOL, readSqlTrust } from './trust.js';

/** Attach metadata only after downstream policy accepts the successful SQL call. */
export function registerHostBridge(ctx, createUserMessage) {
  return ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (exec.name !== SQL_TOOL || decision.kind === 'block' || result.isError ||
      (result.error != null && result.error !== false)) return decision;
    const summary = readSqlTrust(Object.hasOwn(decision, 'value') ? decision.value : result.value, exec.callId);
    if (!summary) return decision;
    const message = createUserMessage({
      content: [{ type: 'text', text: JSON.stringify(summary) }],
      source: { kind: KEY, form: 'notice', summary: 'DataHub 查询可信度' },
    });
    return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], message] };
  });
}
