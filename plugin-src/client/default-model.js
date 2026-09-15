import * as React from 'react';

import {
  defaultModelKey,
  normalizeDefaultModel,
  normalizeModelCatalog,
} from '../../src/channels/shared/default-model.mjs';
import { h } from './i18n.js';

export const SET_DEFAULT_MODEL_ENDPOINT = 'bot.model.set';

export const EMPTY_MODEL_CATALOG = Object.freeze({
  groups: Object.freeze([]),
  failures: Object.freeze([]),
  items: Object.freeze([]),
});

export const ModelCatalogContext = React.createContext(EMPTY_MODEL_CATALOG);

export function normalizeDefaultModelSelection(value) {
  return normalizeDefaultModel(value);
}

export function normalizeHostModelCatalog(value) {
  return normalizeModelCatalog(value);
}

export function DefaultModelEditor({ defaultModel = null, disabled = false, onSave }) {
  const catalog = React.useContext(ModelCatalogContext) ?? EMPTY_MODEL_CATALOG;
  const helpId = React.useId();
  const current = normalizeDefaultModel(defaultModel);
  const currentKey = defaultModelKey(current);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  const items = [];
  const seen = new Set();
  for (const item of Array.isArray(catalog.items) ? catalog.items : []) {
    if (!item?.key || seen.has(item.key)) continue;
    seen.add(item.key);
    items.push(item);
  }
  const currentUnavailable = Boolean(currentKey && !seen.has(currentKey));
  if (currentUnavailable && current) {
    items.push({
      key: currentKey,
      provider: current.provider,
      model: current.model,
      label: currentKey,
      unavailable: true,
    });
  }

  const change = async (event) => {
    const nextKey = event.target.value;
    if (nextKey === currentKey || saving || disabled) return;
    setSaving(true);
    setError(null);
    try {
      await onSave?.(nextKey ? normalizeDefaultModel(nextKey) : null);
    } catch (cause) {
      setError(cause?.message ?? '默认模型修改失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return h('div', { className: 'dim-preset' },
    h('div', { className: 'dim-presetHeader' },
      h('span', { className: 'dim-presetTitle' },
        h('span', null, '默认模型'),
        h('span', { className: 'dim-presetHelp' },
          h('button', {
            type: 'button',
            className: 'dim-presetHelpButton',
            'aria-label': '查看默认模型说明',
            'aria-describedby': helpId,
          }, h('span', { 'aria-hidden': 'true' }, '?')),
          h('span', {
            id: helpId,
            className: 'dim-presetTooltip',
            role: 'tooltip',
          }, '为该 WhatsApp 机器人的新建会话指定模型，避免每人各自 /model。已有会话需先 /new 再发消息才会生效。'))),
      saving ? h('span', { className: 'dim-presetStatus' }, '保存中…') : null),
    React.createElement('select', {
      className: 'dim-presetSelect',
      value: currentKey,
      disabled: disabled || saving,
      'aria-label': '默认模型',
      onChange: (event) => { void change(event); },
    },
      h('option', { value: '' }, '跟随 Host 默认'),
      ...items.map((item) => h(
        'option',
        { key: item.key, value: item.key },
        item.unavailable ? [item.key, '（已不可用）'] : item.label,
      )),
    ),
    error || currentUnavailable ? h(
      'p',
      { className: 'dim-presetError', role: error ? 'alert' : 'status' },
      error ?? '当前默认模型已不可用，请选择其他模型或跟随 Host 默认。',
    ) : null,
  );
}
