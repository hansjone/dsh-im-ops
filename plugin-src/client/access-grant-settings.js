import * as React from 'react';

import {
  normalizeAccessGrant,
  normalizeAccessPhone,
  validateAccessGrant,
} from '../../src/channels/shared/access-grant.mjs';
import {
  DEFAULT_GROUP_SESSION_SCOPE,
  normalizeGroupSessionScope,
  validateGroupSessionScope,
} from '../../src/channels/shared/session-scope.mjs';
import { h, localizeText } from './i18n.js';

export const ACCESS_GRANT_ENDPOINT = 'bot.access-grant.set';
export const ACCESS_PENDING_RESOLVE_ENDPOINT = 'bot.access-pending.resolve';
export const GROUP_SESSION_SCOPE_ENDPOINT = 'bot.group-session-scope.set';

function unwrapRpcResult(result) {
  if (result?.ok === true) return result.value;
  if (result?.ok === false) {
    const error = new Error(result.error?.message || '访问授权保存失败，请稍后重试。');
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

function grantFromSnapshot(value, botId) {
  const source = value?.snapshot ?? value;
  const bot = Array.isArray(source?.bots)
    ? source.bots.find((entry) => entry?.botId === botId)
    : null;
  return normalizeAccessGrant(bot?.accessGrant ?? source?.accessGrant ?? source?.grant);
}

function ownerPhoneFromAccount(account) {
  return normalizeAccessPhone(account?.accountJid) ?? normalizeAccessPhone(account?.phone) ?? '';
}

function emptyDraft(ownerPhone) {
  return {
    version: 1,
    globalAdmins: ownerPhone ? [ownerPhone] : [],
    directMembers: [],
    groups: {},
    pending: [],
    contacts: [],
  };
}

function cloneGrant(grant, ownerPhone) {
  const base = grant ?? emptyDraft(ownerPhone);
  return {
    version: 1,
    globalAdmins: [...(base.globalAdmins ?? [])],
    directMembers: (base.directMembers ?? []).map((m) => ({ ...m })),
    groups: Object.fromEntries(Object.entries(base.groups ?? {}).map(([jid, group]) => [jid, {
      title: group.title ?? '',
      admins: [...(group.admins ?? [])],
      members: (group.members ?? []).map((m) => ({ ...m })),
    }])),
    pending: [...(base.pending ?? [])],
    contacts: [...(base.contacts ?? [])],
  };
}

function contactLabel(contact) {
  const name = contact.pushName || '未命名';
  const phone = contact.phone || '待补电话';
  return `${name} · ${phone}`;
}

function PhoneTypeahead({
  value,
  onChange,
  contacts,
  placeholder,
  disabled,
  requirePhone = true,
}) {
  const [query, setQuery] = React.useState(value || '');
  React.useEffect(() => { setQuery(value || ''); }, [value]);
  const q = query.trim().toLowerCase();
  const suggestions = (contacts ?? [])
    .filter((contact) => {
      if (requirePhone && !contact.phone) return false;
      if (!q) return Boolean(contact.phone);
      return (contact.phone ?? '').includes(q.replace(/[^\d]/g, ''))
        || (contact.pushName ?? '').toLowerCase().includes(q);
    })
    .slice(0, 8);

  return h('div', { className: 'dim-accessTypeahead' },
    h('input', {
      value: query,
      disabled,
      placeholder,
      maxLength: 32,
      autoCapitalize: 'none',
      autoCorrect: 'off',
      spellCheck: false,
      onChange: (event) => {
        setQuery(event.target.value);
        onChange(event.target.value);
      },
    }),
    suggestions.length === 0 ? null : h('ul', { className: 'dim-accessSuggestList' },
      suggestions.map((contact) => h('li', { key: `${contact.phone}-${contact.lids?.[0] ?? ''}` },
        h('button', {
          type: 'button',
          className: 'dim-deliveryButton',
          disabled: disabled || (requirePhone && !contact.phone),
          onClick: () => {
            if (!contact.phone) return;
            setQuery(contact.phone);
            onChange(contact.phone);
          },
        }, contactLabel(contact))))));
}

function MemberRows({
  title,
  members,
  contacts,
  disabled,
  onChange,
}) {
  return h('fieldset', { className: 'dim-accessScene', disabled },
    h('legend', null, title),
    h('ul', { className: 'dim-accessUserList' }, members.map((member, index) =>
      h('li', { key: `member-${index}`, className: 'dim-accessUserRow' },
        h('label', { className: 'dim-accessField dim-accessUserId' },
          h('span', null, '电话'),
          h(PhoneTypeahead, {
            value: member.phone,
            contacts,
            disabled,
            placeholder: '8613800000000',
            onChange: (phone) => onChange(members.map((entry, i) => (
              i === index ? { ...entry, phone } : entry
            ))),
          })),
        h('label', { className: 'dim-accessField dim-accessUserCommand' },
          h('span', null, '命令权限'),
          h('select', {
            value: member.canExecuteCommands ? 'allow' : 'deny',
            onChange: (event) => onChange(members.map((entry, i) => (
              i === index
                ? { ...entry, canExecuteCommands: event.target.value === 'allow' }
                : entry
            ))),
          },
          h('option', { value: 'allow' }, '可以执行命令'),
          h('option', { value: 'deny' }, '不可以执行命令'))),
        h('button', {
          type: 'button',
          className: 'dim-deliveryButton',
          'data-kind': 'danger',
          onClick: () => onChange(members.filter((_, i) => i !== index)),
        }, '删除')))),
    h('button', {
      type: 'button',
      className: 'dim-deliveryButton',
      onClick: () => onChange([...members, { phone: '', canExecuteCommands: true }]),
    }, '新增用户'));
}

function AdminPhones({
  title,
  help,
  phones,
  contacts,
  disabled,
  lockedPhone,
  onChange,
}) {
  return h('fieldset', { className: 'dim-accessScene', disabled },
    h('legend', null, title),
    help ? h('p', { className: 'dim-accessUsersEmpty' }, help) : null,
    h('ul', { className: 'dim-accessUserList' }, phones.map((phone, index) => {
      const locked = lockedPhone && phone === lockedPhone;
      return h('li', { key: `admin-${index}`, className: 'dim-accessUserRow' },
        h('label', { className: 'dim-accessField dim-accessUserId' },
          h('span', null, locked ? '绑定账号（全局管理员）' : '电话'),
          h(PhoneTypeahead, {
            value: phone,
            contacts,
            disabled: disabled || locked,
            placeholder: '8613800000000',
            onChange: (next) => onChange(phones.map((entry, i) => (i === index ? next : entry))),
          })),
        locked ? null : h('button', {
          type: 'button',
          className: 'dim-deliveryButton',
          'data-kind': 'danger',
          onClick: () => onChange(phones.filter((_, i) => i !== index)),
        }, '删除'));
    })),
    h('button', {
      type: 'button',
      className: 'dim-deliveryButton',
      onClick: () => onChange([...phones, '']),
    }, '新增管理员'));
}

/**
 * WhatsApp graded access settings (phone-canonical).
 */
export function AccessGrantSettingsPage({ channel, account, rpcCall, onSaved }) {
  if (channel !== 'whatsapp') {
    return h('div', { className: 'dim-accessState', role: 'alert' },
      '当前渠道仍使用旧版访问设置。');
  }
  const ownerPhone = ownerPhoneFromAccount(account);
  const initialGrant = normalizeAccessGrant(account?.accessGrant);
  const initialKey = JSON.stringify(initialGrant);
  const initialScope = normalizeGroupSessionScope(account?.groupSessionScope);
  const [draft, setDraft] = React.useState(() => cloneGrant(initialGrant, ownerPhone));
  const [groupSessionScope, setGroupSessionScope] = React.useState(initialScope);
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState(null);
  const [newGroupJid, setNewGroupJid] = React.useState('');

  React.useEffect(() => {
    setDraft(cloneGrant(normalizeAccessGrant(account?.accessGrant), ownerPhone));
    setGroupSessionScope(normalizeGroupSessionScope(account?.groupSessionScope));
  }, [account?.botId, initialKey, account?.groupSessionScope, ownerPhone]);

  const contacts = draft.contacts ?? [];
  const knownGroupJids = React.useMemo(() => {
    const set = new Set(Object.keys(draft.groups ?? {}));
    for (const contact of contacts) {
      for (const jid of contact.groupJids ?? []) set.add(jid);
    }
    for (const pending of draft.pending ?? []) {
      if (pending.groupJid) set.add(pending.groupJid);
    }
    return [...set].sort();
  }, [draft.groups, draft.pending, contacts]);

  const resolvePending = async (pendingId, action) => {
    setFeedback(null);
    setSaving(true);
    try {
      if (typeof rpcCall !== 'function') throw new Error('访问授权暂不可用。');
      const resolvedByPhone = ownerPhone || draft.globalAdmins[0];
      if (!resolvedByPhone) throw new Error('缺少可用于审批的全局管理员电话。');
      const value = unwrapRpcResult(await rpcCall(ACCESS_PENDING_RESOLVE_ENDPOINT, {
        botId: account.botId,
        pendingId,
        action,
        resolvedByPhone,
      }));
      const saved = grantFromSnapshot(value, account.botId);
      if (!saved) throw new Error('服务没有返回已保存的访问授权。');
      setDraft(cloneGrant(saved, ownerPhone));
      onSaved?.(saved);
      setFeedback({
        tone: 'success',
        message: action === 'approve' ? '已批准申请。' : '已拒绝申请。',
      });
    } catch (error) {
      setFeedback({ tone: 'error', message: error?.message || '审批失败。' });
    } finally {
      setSaving(false);
    }
  };

  const save = async (event) => {
    event.preventDefault();
    setFeedback(null);
    setSaving(true);
    try {
      const admins = [...new Set(draft.globalAdmins
        .map((phone) => normalizeAccessPhone(phone))
        .filter(Boolean))];
      if (ownerPhone && !admins.includes(ownerPhone)) admins.unshift(ownerPhone);
      const grant = validateAccessGrant({
        ...draft,
        globalAdmins: admins,
        directMembers: draft.directMembers
          .map((m) => ({ ...m, phone: normalizeAccessPhone(m.phone) }))
          .filter((m) => m.phone),
        groups: Object.fromEntries(Object.entries(draft.groups).map(([jid, group]) => [jid, {
          title: group.title,
          admins: group.admins.map(normalizeAccessPhone).filter(Boolean),
          members: group.members
            .map((m) => ({ ...m, phone: normalizeAccessPhone(m.phone) }))
            .filter((m) => m.phone),
        }])),
      });
      const scope = validateGroupSessionScope(groupSessionScope);
      if (typeof rpcCall !== 'function') throw new Error('访问授权暂不可用。');
      const value = unwrapRpcResult(await rpcCall(ACCESS_GRANT_ENDPOINT, {
        botId: account.botId,
        grant,
      }));
      unwrapRpcResult(await rpcCall(GROUP_SESSION_SCOPE_ENDPOINT, {
        botId: account.botId,
        groupSessionScope: scope,
      }));
      const saved = grantFromSnapshot(value, account.botId) ?? grant;
      setDraft(cloneGrant(saved, ownerPhone));
      setGroupSessionScope(scope);
      onSaved?.(saved);
      setFeedback({ tone: 'success', message: '分级访问设置已保存。' });
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error?.message || '访问授权保存失败，请稍后重试。',
      });
    } finally {
      setSaving(false);
    }
  };

  return h('form', {
    className: 'dim-accessPage',
    onSubmit: (event) => void save(event),
  },
  h('p', { className: 'dim-accessUsersEmpty' },
    'WhatsApp 按电话号码授权：全局管理员管私聊；群管理员只批本群。成员不可跨群、有群权也不自动获得私聊权。'),
  h(AdminPhones, {
    title: '全局管理员',
    help: '绑定账号自动为全局管理员，至少保留一位。',
    phones: draft.globalAdmins,
    contacts,
    disabled: saving,
    lockedPhone: ownerPhone || null,
    onChange: (globalAdmins) => {
      setDraft((current) => ({ ...current, globalAdmins }));
      setFeedback(null);
    },
  }),
  h(MemberRows, {
    title: '私聊授权用户',
    members: draft.directMembers,
    contacts,
    disabled: saving,
    onChange: (directMembers) => {
      setDraft((current) => ({ ...current, directMembers }));
      setFeedback(null);
    },
  }),
  h('fieldset', { className: 'dim-accessScene', disabled: saving },
    h('legend', null, '待审批'),
    (draft.pending ?? []).filter((entry) => entry.status === 'pending' || !entry.status).length === 0
      ? h('div', { className: 'dim-accessUsersEmpty' }, '暂无待批申请')
      : h('ul', { className: 'dim-accessUserList' },
          (draft.pending ?? [])
            .filter((entry) => entry.status === 'pending' || !entry.status)
            .map((entry) => h('li', { key: entry.id, className: 'dim-accessUserRow' },
              h('div', { className: 'dim-accessField' },
                h('span', null, entry.kind === 'group'
                  ? ['群聊', ' ', entry.groupJid].join('')
                  : '私聊'),
                h('strong', null, entry.pushName || entry.phone || entry.lid || entry.id),
                entry.unresolved
                  ? h('span', null, '（电话未解析，请先在联系人中确认）')
                  : null,
                entry.requestText
                  ? h('p', null, entry.requestText.slice(0, 120))
                  : null),
              h('button', {
                type: 'button',
                className: 'dim-deliveryButton',
                'data-kind': 'primary',
                disabled: saving || entry.unresolved,
                onClick: () => void resolvePending(entry.id, 'approve'),
              }, '批准'),
              h('button', {
                type: 'button',
                className: 'dim-deliveryButton',
                'data-kind': 'danger',
                disabled: saving,
                onClick: () => void resolvePending(entry.id, 'deny'),
              }, '拒绝'))))),
  h('fieldset', { className: 'dim-accessScene', disabled: saving },
    h('legend', null, '群授权'),
    knownGroupJids.length === 0
      ? h('div', { className: 'dim-accessUsersEmpty' },
          '尚无已知群。可在下方粘贴群 JID（…@g.us），或等群内有人 @ 机器人后自动出现。')
      : knownGroupJids.map((groupJid) => {
          const group = draft.groups[groupJid] ?? { title: '', admins: [], members: [] };
          return h('div', { key: groupJid, className: 'dim-accessScene', 'data-scene': 'group-grant' },
            h('h3', null, group.title || groupJid),
            h('label', { className: 'dim-accessField' },
              h('span', null, '群备注名'),
              h('input', {
                value: group.title ?? '',
                maxLength: 128,
                onChange: (event) => setDraft((current) => ({
                  ...current,
                  groups: {
                    ...current.groups,
                    [groupJid]: { ...group, title: event.target.value },
                  },
                })),
              })),
            h(AdminPhones, {
              title: '本群管理员',
              help: '未配置时，本群申请回落给全局管理员审批（仍只授予本群权）。',
              phones: group.admins ?? [],
              contacts,
              disabled: saving,
              lockedPhone: null,
              onChange: (admins) => setDraft((current) => ({
                ...current,
                groups: {
                  ...current.groups,
                  [groupJid]: { ...group, admins },
                },
              })),
            }),
            h(MemberRows, {
              title: '本群授权成员',
              members: group.members ?? [],
              contacts,
              disabled: saving,
              onChange: (members) => setDraft((current) => ({
                ...current,
                groups: {
                  ...current.groups,
                  [groupJid]: { ...group, members },
                },
              })),
            }));
        }),
    h('div', { className: 'dim-accessControls' },
      h('label', { className: 'dim-accessField' },
        h('span', null, '添加群 JID'),
        h('input', {
          value: newGroupJid,
          placeholder: '120363…@g.us',
          onChange: (event) => setNewGroupJid(event.target.value),
        })),
      h('button', {
        type: 'button',
        className: 'dim-deliveryButton',
        onClick: () => {
          const jid = newGroupJid.trim();
          if (!/^\d{5,32}@g\.us$/.test(jid)) {
            setFeedback({ tone: 'error', message: '群 JID 格式无效。' });
            return;
          }
          setDraft((current) => ({
            ...current,
            groups: {
              ...current.groups,
              [jid]: current.groups[jid] ?? { title: '', admins: [], members: [] },
            },
          }));
          setNewGroupJid('');
          setFeedback(null);
        },
      }, '添加群'))),
  h('fieldset', { className: 'dim-accessScene', disabled: saving },
    h('legend', null, '最近联系人（自动沉淀）'),
    h('p', { className: 'dim-accessUsersEmpty' },
      '仅记录私聊机器人，或在群里 @ 机器人的人。电话是唯一授权键，可一键加入私聊/本群授权。'),
    contacts.length === 0
      ? h('div', { className: 'dim-accessUsersEmpty' }, '暂无联系人。有人私聊或 @ 机器人后会出现在此。')
      : h('ul', { className: 'dim-accessUserList' }, contacts.slice(0, 30).map((contact) => {
          const phone = contact.phone || '';
          const alreadyDirect = phone && draft.directMembers.some((m) => m.phone === phone);
          const groupTargets = (contact.groupJids ?? []).filter((jid) => knownGroupJids.includes(jid));
          return h('li', {
            key: `${contact.phone ?? ''}-${(contact.lids ?? []).join(',')}`,
            className: 'dim-accessUserRow',
          },
          h('div', { className: 'dim-accessField' },
            h('strong', null, contactLabel(contact)),
            h('span', null, (contact.scenes ?? []).join(' / ')),
            phone ? null : h('span', null, '待补电话')),
          phone ? h('button', {
            type: 'button',
            className: 'dim-deliveryButton',
            'data-kind': 'primary',
            disabled: saving || alreadyDirect,
            onClick: () => {
              setDraft((current) => {
                if (current.directMembers.some((m) => m.phone === phone)) return current;
                return {
                  ...current,
                  directMembers: [
                    ...current.directMembers,
                    { phone, canExecuteCommands: true },
                  ],
                };
              });
              setFeedback({ tone: 'success', message: '已加入私聊授权，记得点保存。' });
            },
          }, alreadyDirect ? '已在私聊' : '加私聊') : null,
          ...groupTargets.map((groupJid) => {
            const group = draft.groups[groupJid] ?? { admins: [], members: [] };
            const already = group.admins.includes(phone)
              || group.members.some((m) => m.phone === phone);
            return h('button', {
              key: `add-${groupJid}`,
              type: 'button',
              className: 'dim-deliveryButton',
              disabled: saving || !phone || already,
              onClick: () => {
                setDraft((current) => {
                  const existing = current.groups[groupJid] ?? { title: '', admins: [], members: [] };
                  if (existing.admins.includes(phone)
                    || existing.members.some((m) => m.phone === phone)) {
                    return current;
                  }
                  return {
                    ...current,
                    groups: {
                      ...current.groups,
                      [groupJid]: {
                        ...existing,
                        members: [
                          ...existing.members,
                          { phone, canExecuteCommands: true },
                        ],
                      },
                    },
                  };
                });
                setFeedback({ tone: 'success', message: '已加入本群授权，记得点保存。' });
              },
            }, already ? '已在本群' : '加本群');
          }));
        }))),
  h('fieldset', { className: 'dim-accessScene', disabled: saving },
    h('legend', null, '群会话策略'),
    h('label', { className: 'dim-accessField' },
      h('span', null, '群内 Session 绑定'),
      h('select', {
        value: groupSessionScope || DEFAULT_GROUP_SESSION_SCOPE,
        onChange: (event) => setGroupSessionScope(event.target.value),
      },
      h('option', { value: 'user_in_chat' }, '按发言人拆分（推荐）'),
      h('option', { value: 'chat' }, '整群共享一个 Session')))),
  feedback ? h('p', {
    className: 'dim-accessFeedback',
    'data-tone': feedback.tone,
    role: feedback.tone === 'error' ? 'alert' : 'status',
  }, feedback.message) : null,
  h('div', { className: 'dim-accessActions' },
    h('button', {
      type: 'submit',
      className: 'dim-deliveryButton',
      'data-kind': 'primary',
      disabled: saving,
    }, saving ? '正在保存…' : '保存分级访问设置')));
}
