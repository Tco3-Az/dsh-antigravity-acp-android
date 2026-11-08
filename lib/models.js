export function selectValues(option) {
    if (option.type !== 'select')
        return [];
    return option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
}
export function modelOption(session) {
    return (session.configOptions?.find((c) => c.type === 'select' && c.category === 'model') ??
        session.configOptions?.find((c) => c.type === 'select' && c.id === 'model'));
}
export function modelCatalog(session) {
    const option = modelOption(session);
    const modern = option ? selectValues(option).map((c) => ({ id: c.value, name: c.name })) : [];
    const legacy = session.models?.availableModels;
    const source = modern.length ? modern : Array.isArray(legacy)
        ? legacy.filter((c) => c && typeof c === 'object').map((c) => ({ id: c.modelId, name: c.name })) : [];
    return [...new Map(source
            .filter((c) => typeof c.id === 'string' && c.id.trim() && typeof c.name === 'string' && c.name.trim())
            .map((c) => [c.id, c])).values()];
}
export function currentModel(session) {
    const option = modelOption(session);
    const id = option?.type === 'select' ? option.currentValue : session.models?.currentModelId;
    return modelCatalog(session).find((m) => m.id === id);
}
/** Native DSH's two highest effort levels use ACP's supported high tier. */
export function acpReasoningEffort(effort) {
    return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}
