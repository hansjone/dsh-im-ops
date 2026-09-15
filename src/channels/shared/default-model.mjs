/** Per-bot default Session model (provider + model id), applied on session.create. */

export function normalizeDefaultModel(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const slash = trimmed.indexOf('/');
    if (slash <= 0 || slash === trimmed.length - 1) return null;
    return {
      provider: trimmed.slice(0, slash),
      model: trimmed.slice(slash + 1),
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!provider || !model) return null;
  const selection = { provider, model };
  if (value.reasoningEffort !== undefined) {
    if (typeof value.reasoningEffort !== 'string' || !value.reasoningEffort.trim()) return null;
    selection.reasoningEffort = value.reasoningEffort.trim();
  }
  return selection;
}

export function validateDefaultModel(value) {
  if (value == null || value === '') return null;
  const normalized = normalizeDefaultModel(value);
  if (!normalized) {
    const error = new Error('默认模型无效。');
    error.code = 'default-model-invalid';
    throw error;
  }
  return normalized;
}

export function defaultModelKey(selection) {
  const normalized = normalizeDefaultModel(selection);
  return normalized ? `${normalized.provider}/${normalized.model}` : '';
}

export function modelCatalogItems(catalog) {
  const items = [];
  const seen = new Set();
  for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
    const provider = typeof group?.id === 'string' ? group.id.trim() : '';
    if (!provider || !Array.isArray(group.models)) continue;
    for (const model of group.models) {
      const modelId = typeof model?.id === 'string' ? model.id.trim() : '';
      if (!modelId) continue;
      const key = `${provider}/${modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = typeof model.name === 'string' && model.name.trim()
        ? model.name.trim()
        : modelId;
      items.push({
        provider,
        model: modelId,
        key,
        label: label === modelId ? key : `${label}（${key}）`,
      });
    }
  }
  return items;
}

export function catalogHasModel(catalog, selection) {
  const normalized = normalizeDefaultModel(selection);
  if (!normalized) return false;
  return modelCatalogItems(catalog).some((item) => (
    item.provider === normalized.provider && item.model === normalized.model
  ));
}

export function normalizeModelCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { groups: [], failures: [], items: [] };
  }
  const groups = Array.isArray(value.groups) ? value.groups : [];
  const failures = Array.isArray(value.failures) ? value.failures : [];
  return {
    groups,
    failures,
    items: modelCatalogItems({ groups, failures }),
  };
}
