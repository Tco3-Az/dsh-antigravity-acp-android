import { LlmError } from '@deepseek-ai/dsh-llm';
export declare const ACP_CONTEXT_WINDOW = 256000;
export declare const ACP_OUTPUT_RESERVE = 16000;
export declare const ACP_INTERNAL_RESERVE = 8000;
export declare const ACP_INPUT_BUDGET: number;
export interface AcpContextUsage {
    used: number;
    size: number;
}
/** Local heuristic only: ACP has no portable tokenizer/countTokens method.
 * UTF-8 bytes / 3 accounts for JSON, CJK and tool payloads; not an exact count
 * or proof a request fits. Host metadata and official usage remain authoritative.
 */
export declare function estimateContextTokens(text: string): number;
export declare function contextLimitError(): LlmError;
export declare function assertContextBudget(text: string, usage?: AcpContextUsage): void;
