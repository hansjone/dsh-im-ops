import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer from 'react-test-renderer';

import { AccessGrantSettingsPage } from '../../../plugin-src/client/access-grant-settings.js';
import { en, setImTranslator } from '../../../plugin-src/client/i18n.js';

const { act, create } = TestRenderer;
const groupJid = '120363111111111111@g.us';
const otherGroupJid = '120363222222222222@g.us';
const ownerPhone = '8618111111111';
const textOf = node => typeof node === 'string' || typeof node === 'number'
  ? String(node) : node?.children?.map(textOf).join('') ?? '';
const button = (root, text) => root.findAllByType('button').find(node => textOf(node) === text);
const tab = (root, label) => root.findAllByProps({ role: 'tab' })
  .find(node => textOf(node).startsWith(label));
async function flush() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }

function fixture() {
  return {
    version: 1, globalAdmins: [ownerPhone],
    directMembers: [{ phone: '8618222222222', canExecuteCommands: true }],
    groups: {
      [groupJid]: { title: 'Ops', agentPreset: 'netxops', admins: [], members: [] },
      [otherGroupJid]: { title: 'Support', admins: [], members: [] },
    },
    pending: [{ id: 'p_test01', kind: 'direct', phone: '8618444444444',
      createdAt: '2026-10-11T00:00:00.000Z', status: 'pending', notifyRefs: [] }],
    contacts: Array.from({ length: 35 }, (_, index) => ({
      phone: `861900000${String(index).padStart(4, '0')}`,
      pushName: index === 34 ? 'Alice' : `Contact ${index}`,
      scenes: ['direct'], groupJids: [], lids: [], lastSeenAt: '2026-10-11T00:00:00.000Z',
    })),
  };
}

async function mount(t, options = {}) {
  const calls = [];
  let savedGrant = fixture();
  let savedScope = 'user_in_chat';
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'connection.status' && options.load) return options.load;
    if (endpoint === 'bot.access-grant.set') {
      if (options.failSave) throw new Error('Save rejected');
      savedGrant = payload.grant;
    }
    if (endpoint === 'bot.group-session-scope.set') savedScope = payload.groupSessionScope;
    return { ok: true, value: {
      bots: [{ botId: 'wa-test', accessGrant: savedGrant, groupSessionScope: savedScope }],
      agentPresetCatalog: { defaultId: 'netxops', items: [{ id: 'netxops' }, { id: 'safe' }] },
    } };
  };
  function Page() {
    const [accessGrant, setAccessGrant] = React.useState(savedGrant);
    return React.createElement(AccessGrantSettingsPage, {
      channel: 'whatsapp', account: {
        botId: 'wa-test', phone: ownerPhone, accessGrant, groupSessionScope: 'user_in_chat',
      }, rpcCall, onSaved: setAccessGrant,
    });
  }
  let renderer;
  await act(async () => { renderer = create(React.createElement(Page)); await flush(); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  return { renderer, calls };
}

test('access sections support keyboard navigation and preserve edits across sections', async t => {
  const { renderer, calls } = await mount(t);
  const root = renderer.root;
  assert.equal(root.findAllByProps({ role: 'tabpanel' }).filter(node => !node.props.hidden).length, 1);
  assert.equal(button(root, '保存分级访问设置').props.disabled, true);
  await act(async () => tab(root, '私聊与管理员').props.onKeyDown({ key: 'ArrowRight', preventDefault() {} }));
  assert.equal(tab(root, '群授权').props['aria-selected'], true);
  const preset = root.findAllByType('select').find(node => node.props['aria-label'] === '群 Agent Preset');
  await act(async () => preset.props.onChange({ target: { value: 'safe' } }));
  await act(async () => tab(root, '最近联系人').props.onClick());
  await act(async () => tab(root, '群授权').props.onClick());
  assert.equal(root.findAllByType('select').find(node => node.props['aria-label'] === '群 Agent Preset').props.value, 'safe');
  assert.match(textOf(root.findByProps({ className: 'dim-waAccessSaveState' })), /未保存/);
  assert.equal(calls.filter(call => call.endpoint !== 'connection.status').length, 0);
});

test('saving retains the group preset and session scope when the parent updates its grant', async t => {
  const { renderer, calls } = await mount(t);
  const root = renderer.root;
  await act(async () => {
    root.findAllByType('select').find(node => node.props['aria-label'] === '群 Agent Preset')
      .props.onChange({ target: { value: 'safe' } });
    root.findAllByType('select').find(node => node.props.value === 'user_in_chat')
      .props.onChange({ target: { value: 'chat' } });
  });
  await act(async () => { root.findByType('form').props.onSubmit({ preventDefault() {} }); await flush(); });
  const grantCall = calls.find(call => call.endpoint === 'bot.access-grant.set');
  assert.equal(grantCall.payload.grant.groups[groupJid].agentPreset, 'safe');
  assert.deepEqual(calls.find(call => call.endpoint === 'bot.group-session-scope.set').payload,
    { botId: 'wa-test', groupSessionScope: 'chat' });
  assert.ok(root.findAllByType('select').some(node => node.props.value === 'chat'));
  assert.equal(button(root, '保存分级访问设置').props.disabled, true);
  assert.match(textOf(root.findByProps({ className: 'dim-waAccessSaveState' })), /所有修改已保存/);
});

test('unsaved edits block approval and group sync; discard restores the last saved configuration', async t => {
  const { renderer, calls } = await mount(t);
  const root = renderer.root;
  await act(async () => root.findAllByType('input').find(node => node.props.value === 'Ops')
    .props.onChange({ target: { value: 'Draft title' } }));
  assert.equal(button(root, '批准').props.disabled, true);
  assert.equal(button(root, '同步群名').props.disabled, true);
  await act(async () => { button(root, '批准').props.onClick(); button(root, '同步群名').props.onClick(); await flush(); });
  assert.equal(calls.filter(call => call.endpoint !== 'connection.status').length, 0);
  await act(async () => button(root, '撤销修改').props.onClick());
  assert.ok(root.findAllByType('input').some(node => node.props.value === 'Ops'));
  assert.equal(button(root, '批准').props.disabled, false);
  assert.equal(button(root, '同步群名').props.disabled, false);
  assert.equal(button(root, '保存分级访问设置').props.disabled, true);
});

test('contact search reaches beyond the first thirty contacts and groups match names or JIDs', async t => {
  const { renderer } = await mount(t);
  const root = renderer.root;
  const contactTable = () => root.findByProps({ 'data-kind': 'contact' });
  assert.doesNotMatch(textOf(contactTable()), /Alice/);
  await act(async () => button(root, '显示更多联系人').props.onClick());
  assert.match(textOf(contactTable()), /Alice/);
  const contactSearch = root.findAllByType('input').find(node => node.props.placeholder === '搜索昵称、电话或群名称');
  await act(async () => contactSearch.props.onChange({ target: { value: 'alice' } }));
  assert.match(textOf(contactTable()), /Alice/);
  assert.doesNotMatch(textOf(contactTable()), /Contact 0/);
  const groupSearch = root.findAllByType('input').find(node => node.props.placeholder === '搜索群名称或 JID');
  await act(async () => groupSearch.props.onChange({ target: { value: 'Support' } }));
  assert.equal(root.findAllByType('details').length, 1);
  assert.match(textOf(root.findByType('details')), /Support/);
  await act(async () => groupSearch.props.onChange({ target: { value: groupJid } }));
  assert.match(textOf(root.findByType('details')), /Ops/);
});

test('failed saves retain the draft, keep it dirty and expose the error', async t => {
  const { renderer } = await mount(t, { failSave: true });
  const root = renderer.root;
  await act(async () => root.findAllByType('input').find(node => node.props.value === 'Ops')
    .props.onChange({ target: { value: 'Unsaved title' } }));
  await act(async () => { root.findByType('form').props.onSubmit({ preventDefault() {} }); await flush(); });
  assert.equal(textOf(root.findByProps({ role: 'alert' })), 'Save rejected');
  assert.ok(root.findAllByType('input').some(node => node.props.value === 'Unsaved title'));
  assert.equal(button(root, '保存分级访问设置').props.disabled, false);
});

test('phone suggestions filter names without matching every contact through an empty digit query', async t => {
  const { renderer } = await mount(t);
  const input = renderer.root.findAllByType('input').find(node => node.props.value === '8618222222222');
  await act(async () => {
    input.props.onFocus();
    input.props.onChange({ target: { value: 'Alice' } });
  });
  const suggestions = renderer.root.findByProps({ role: 'listbox' });
  assert.match(textOf(suggestions), /Alice/);
  assert.doesNotMatch(textOf(suggestions), /Contact 0/);
});

test('access editing waits for status and new section labels translate into English', async t => {
  let resolveLoad;
  const load = new Promise(resolve => { resolveLoad = resolve; });
  setImTranslator(key => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const { renderer, calls } = await mount(t, { load });
  assert.equal(renderer.root.findByProps({ className: 'dim-waAccessEditor' }).props.disabled, true);
  assert.doesNotMatch(textOf(renderer.root.findByProps({ role: 'tablist' })), /[\p{Script=Han}]/u);
  await act(async () => { renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); await flush(); });
  assert.equal(calls.length, 1);
  await act(async () => {
    resolveLoad({ ok: true, value: { bots: [{ botId: 'wa-test', accessGrant: fixture(), groupSessionScope: 'user_in_chat' }] } });
    await flush();
  });
  assert.equal(renderer.root.findByProps({ className: 'dim-waAccessEditor' }).props.disabled, false);
  assert.equal(textOf(renderer.root.findByProps({ className: 'dim-waAccessSaveState' })), 'All changes saved');
});
