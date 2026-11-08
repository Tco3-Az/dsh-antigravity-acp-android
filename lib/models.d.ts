import type { NewSessionResponse, SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';
export interface DiscoveredModel {
    id: string;
    name: string;
}
export interface ModelSession extends NewSessionResponse {
    models?: {
        currentModelId: string;
        availableModels: Array<{
            modelId: string;
            name: string;
        }>;
    } | null;
}
export declare function selectValues(option: SessionConfigOption): SessionConfigSelectOption[];
export declare function modelOption(session: NewSessionResponse): SessionConfigOption | undefined;
export declare function modelCatalog(session: NewSessionResponse): DiscoveredModel[];
export declare function currentModel(session: NewSessionResponse): DiscoveredModel | undefined;
/** Native DSH's two highest effort levels use ACP's supported high tier. */
export declare function acpReasoningEffort(effort?: string): string | undefined;
