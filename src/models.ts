import type {
  NewSessionResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk';

export interface DiscoveredModel { id: string; name: string }
// ACP 1.3-era agents may announce the older session models extension instead
// of configOptions. Accept only advertised IDs; never invent a Gemini catalog.
export interface ModelSession extends NewSessionResponse {
  models?: {
    currentModelId: string;
    availableModels: Array<{ modelId: string; name: string }>;
  } | null;
}
export function selectValues(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type !== 'select') return [];
  return option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
}
export function modelOption(session: NewSessionResponse): SessionConfigOption | undefined {
  return (
    session.configOptions?.find((c) => c.type === 'select' && c.category === 'model') ??
    session.configOptions?.find((c) => c.type === 'select' && c.id === 'model')
  );
}
export function modelCatalog(session: NewSessionResponse): DiscoveredModel[] {
  const option = modelOption(session);
  const modern = option ? selectValues(option).map((c) => ({ id: c.value, name: c.name })) : [];
  const legacy = (session as ModelSession).models?.availableModels;
  const source = modern.length ? modern : Array.isArray(legacy)
    ? legacy.filter((c) => c && typeof c === 'object').map((c) => ({ id: c.modelId, name: c.name })) : [];
  return [...new Map(source
    .filter((c) => typeof c.id === 'string' && c.id.trim() && typeof c.name === 'string' && c.name.trim())
    .map((c) => [c.id, c])).values()];
}
export function currentModel(session: NewSessionResponse): DiscoveredModel | undefined {
  const option = modelOption(session);
  const id = option?.type === 'select' ? option.currentValue : (session as ModelSession).models?.currentModelId;
  return modelCatalog(session).find((m) => m.id === id);
}

/** Native DSH's two highest effort levels use ACP's supported high tier. */
export function acpReasoningEffort(effort?: string): string | undefined {
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}
