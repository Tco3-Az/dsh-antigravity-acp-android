import { LlmError } from '@deepseek-ai/dsh-llm';
// Product compatibility policy, not a claim about an individual model's API.
// One decimal 256k window for every exact model and the server-default alias.
export const ACP_CONTEXT_WINDOW = 256_000;
export const ACP_OUTPUT_RESERVE = 16_000;
export const ACP_INTERNAL_RESERVE = 8_000;
export const ACP_INPUT_BUDGET = ACP_CONTEXT_WINDOW - ACP_OUTPUT_RESERVE - ACP_INTERNAL_RESERVE;
/** Local heuristic only: ACP has no portable tokenizer/countTokens method.
 * UTF-8 bytes / 3 accounts for JSON, CJK and tool payloads; not an exact count
 * or proof a request fits. Host metadata and official usage remain authoritative.
 */
export function estimateContextTokens(text) {
    return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}
export function contextLimitError() {
    return new LlmError('Context window limit exceeded for the 256k ACP route. Compact the DSH conversation or start a new session before retrying; history was not truncated.', 'CONTEXT_LENGTH_EXCEEDED');
}
export function assertContextBudget(text, usage) {
    const reported = usage && Number.isSafeInteger(usage.used) && usage.used >= 0 &&
        Number.isSafeInteger(usage.size) && usage.size > 0 ? usage : undefined;
    // A smaller limit actually reported by an agent still wins for this session.
    const window = reported ? Math.min(ACP_CONTEXT_WINDOW, reported.size) : ACP_CONTEXT_WINDOW;
    const budget = Math.max(0, window - ACP_OUTPUT_RESERVE - ACP_INTERNAL_RESERVE);
    if ((reported?.used ?? 0) + estimateContextTokens(text) > budget)
        throw contextLimitError();
}
