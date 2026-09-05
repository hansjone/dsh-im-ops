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
export const ACCESS_GROUP_TITLES_REFRESH_ENDPOINT = 'bot.access-group-titles.refresh';
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

function nicknameForPhone(contacts, phone) {
  const digits = digitsOnly(phone);
  if (!digits) return '';
  const hit = (contacts ?? []).find((contact) => contact.phone === digits || contact.phone === phone);
  return typeof hit?.pushName === 'string' ? hit.pushName.trim() : '';
}

function NicknameHint({ contacts, phone, shortEmpty = false }) {
  const nickname = nicknameForPhone(contacts, phone);
  return h('span', {
    className: nickname ? 'dim-accessNickname' : 'dim-accessNickname dim-accessNicknameEmpty',
  }, nickname || (shortEmpty ? '暂无昵称' : '暂无昵称（私聊/@ 后会自动补齐）'));
}

function groupDisplayName(groupJid, groups) {
  const title = groups?.[groupJid]?.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  return '未命名群';
}

/**
 * Keep contacts that still need a grant action (DM and/or a known group).
 * Fully authorized people are hidden from the quick-grant list.
 * @param {{ phone?: string, groupJids?: string[] }} contact
 * @param {object} draft
 * @param {string[]} knownGroupJids
 */
function contactNeedsGrantAction(contact, draft, knownGroupJids) {
  const phone = contact?.phone || '';
  if (!phone) return true;
  if ((draft.globalAdmins ?? []).includes(phone)) return false;

  const alreadyDirect = (draft.directMembers ?? []).some((m) => m.phone === phone);
  const pendingGroups = (contact.groupJids ?? [])
    .filter((jid) => knownGroupJids.includes(jid))
    .filter((groupJid) => {
      const group = draft.groups?.[groupJid] ?? { admins: [], members: [] };
      return !(group.admins ?? []).includes(phone)
        && !(group.members ?? []).some((m) => m.phone === phone);
    });

  return !alreadyDirect || pendingGroups.length > 0;
}

function digitsOnly(value) {
  return String(value ?? '').replace(/[^\d]/g, '');
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
  const [open, setOpen] = React.useState(false);
  const blurTimer = React.useRef(null);
  React.useEffect(() => { setQuery(value || ''); }, [value]);
  React.useEffect(() => () => {
    if (blurTimer.current) window.clearTimeout(blurTimer.current);
  }, []);

  const q = query.trim().toLowerCase();
  const queryDigits = digitsOnly(query);
  const suggestions = (contacts ?? [])
    .filter((contact) => {
      if (requirePhone && !contact.phone) return false;
      // Exact current value: hide the redundant chip that was covering the next field.
      if (contact.phone && contact.phone === queryDigits && contact.phone === digitsOnly(value)) {
        return false;
      }
      if (!q) return Boolean(contact.phone);
      return (contact.phone ?? '').includes(queryDigits)
        || (contact.pushName ?? '').toLowerCase().includes(q);
    })
    .slice(0, 8);
  const showSuggestions = open && !disabled && suggestions.length > 0;

  return h('div', { className: 'dim-accessTypeahead' },
    h('input', {
      value: query,
      disabled,
      placeholder,
      maxLength: 32,
      autoCapitalize: 'none',
      autoCorrect: 'off',
      spellCheck: false,
      autoComplete: 'off',
      onFocus: () => {
        if (blurTimer.current) window.clearTimeout(blurTimer.current);
        setOpen(true);
      },
      onBlur: () => {
        blurTimer.current = window.setTimeout(() => setOpen(false), 120);
      },
      onChange: (event) => {
        setQuery(event.target.value);
        onChange(event.target.value);
        setOpen(true);
      },
    }),
    showSuggestions ? h('ul', { className: 'dim-accessSuggestList', role: 'listbox' },
      suggestions.map((contact) => h('li', { key: `${contact.phone}-${contact.lids?.[0] ?? ''}` },
        h('button', {
          type: 'button',
          className: 'dim-accessSuggestItem',
          disabled: disabled || (requirePhone && !contact.phone),
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => {
            if (!contact.phone) return;
            setQuery(contact.phone);
            onChange(contact.phone);
            setOpen(false);
          },
        }, contactLabel(contact))))) : null);
}

function MemberRows({
  title,
  members,
  contacts,
  disabled,
  onChange,
  nested = false,
}) {
  return h(nested ? 'div' : 'fieldset', {
    className: nested ? 'dim-accessSubblock' : 'dim-accessScene',
    ...(nested ? {} : { disabled }),
  },
    nested ? h('h4', { className: 'dim-accessSubblockTitle' }, title) : h('legend', null, title),
    h('div', { className: 'dim-accessTableWrap' },
      h('table', { className: 'dim-accessTable', 'data-kind': 'member' },
        h('thead', null,
          h('tr', null,
            h('th', { scope: 'col' }, '昵称'),
            h('th', { scope: 'col' }, '电话'),
            h('th', { scope: 'col' }, '命令权限'),
            h('th', { scope: 'col', className: 'dim-accessTableActions' }, '操作'))),
        h('tbody', null, members.length === 0
          ? h('tr', null, h('td', { colSpan: 4, className: 'dim-accessTableEmpty' }, '暂无用户，可点下方新增。'))
          : members.map((member, index) =>
            h('tr', { key: `member-${index}` },
              h('td', { className: 'dim-accessTableNick' },
                h(NicknameHint, { contacts, phone: member.phone, shortEmpty: true })),
              h('td', { className: 'dim-accessTablePhone' },
                h(PhoneTypeahead, {
                  value: member.phone,
                  contacts,
                  disabled,
                  placeholder: '8613800000000',
                  onChange: (phone) => onChange(members.map((entry, i) => (
                    i === index ? { ...entry, phone } : entry
                  ))),
                })),
              h('td', { className: 'dim-accessTablePerm' },
                h('select', {
                  className: 'dim-accessCompactSelect',
                  title: '命令权限',
                  'aria-label': '命令权限',
                  value: member.canExecuteCommands ? 'allow' : 'deny',
                  disabled,
                  onChange: (event) => onChange(members.map((entry, i) => (
                    i === index
                      ? { ...entry, canExecuteCommands: event.target.value === 'allow' }
                      : entry
                  ))),
                },
                h('option', { value: 'allow' }, '可执行命令'),
                h('option', { value: 'deny' }, '不可执行命令'))),
              h('td', { className: 'dim-accessTableActions' },
                h('button', {
                  type: 'button',
                  className: 'dim-deliveryButton dim-accessCompactDelete',
                  'data-kind': 'danger',
                  disabled,
                  onClick: () => onChange(members.filter((_, i) => i !== index)),
                }, '删除'))))))),
    h('button', {
      type: 'button',
      className: 'dim-deliveryButton',
      disabled,
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
  nested = false,
}) {
  return h(nested ? 'div' : 'fieldset', {
    className: nested ? 'dim-accessSubblock' : 'dim-accessScene',
    ...(nested ? {} : { disabled }),
  },
    nested ? h('h4', { className: 'dim-accessSubblockTitle' }, title) : h('legend', null, title),
    help ? h('p', { className: 'dim-accessHint' }, help) : null,
    h('div', { className: 'dim-accessTableWrap' },
      h('table', { className: 'dim-accessTable', 'data-kind': 'admin' },
        h('thead', null,
          h('tr', null,
            h('th', { scope: 'col' }, '昵称'),
            h('th', { scope: 'col' }, '电话'),
            h('th', { scope: 'col', className: 'dim-accessTableActions' }, '操作'))),
        h('tbody', null, phones.length === 0
          ? h('tr', null, h('td', { colSpan: 3, className: 'dim-accessTableEmpty' }, '暂无管理员，可点下方新增。'))
          : phones.map((phone, index) => {
            const locked = lockedPhone && phone === lockedPhone;
            return h('tr', {
              key: `admin-${index}`,
              ...(locked ? { 'data-locked': 'true' } : {}),
            },
              h('td', { className: 'dim-accessTableNick' },
                locked
                  ? h('span', { className: 'dim-accessNickname' }, '绑定账号')
                  : h(NicknameHint, { contacts, phone, shortEmpty: true })),
              h('td', { className: 'dim-accessTablePhone' },
                h(PhoneTypeahead, {
                  value: phone,
                  contacts,
                  disabled: disabled || locked,
                  placeholder: '8613800000000',
                  onChange: (next) => onChange(phones.map((entry, i) => (i === index ? next : entry))),
                })),
              h('td', { className: 'dim-accessTableActions' },
                locked
                  ? h('span', { className: 'dim-accessTableLocked' }, '不可删除')
                  : h('button', {
                    type: 'button',
                    className: 'dim-deliveryButton dim-accessCompactDelete',
                    'data-kind': 'danger',
                    disabled,
                    onClick: () => onChange(phones.filter((_, i) => i !== index)),
                  }, '删除')));
          })))),
    h('button', {
      type: 'button',
      className: 'dim-deliveryButton',
      disabled,
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
  const [loadingGrant, setLoadingGrant] = React.useState(!initialGrant);

  React.useEffect(() => {
    setDraft(cloneGrant(normalizeAccessGrant(account?.accessGrant), ownerPhone));
    setGroupSessionScope(normalizeGroupSessionScope(account?.groupSessionScope));
  }, [account?.botId, initialKey, account?.groupSessionScope, ownerPhone]);

  // Settings open payload historically omitted accessGrant; always refresh from status.
  React.useEffect(() => {
    if (typeof rpcCall !== 'function' || !account?.botId) return undefined;
    let cancelled = false;
    setLoadingGrant(true);
    void (async () => {
      try {
        const value = unwrapRpcResult(await rpcCall('connection.status', {}));
        if (cancelled) return;
        const bot = Array.isArray(value?.bots)
          ? value.bots.find((entry) => entry?.botId === account.botId)
          : null;
        let grant = normalizeAccessGrant(bot?.accessGrant);
        if (grant) {
          setDraft(cloneGrant(grant, ownerPhone));
          onSaved?.(grant);
        }
        if (bot?.groupSessionScope) {
          setGroupSessionScope(normalizeGroupSessionScope(bot.groupSessionScope));
        }

        const missingTitles = Object.entries(grant?.groups ?? {})
          .filter(([, group]) => !(typeof group?.title === 'string' && group.title.trim()))
          .map(([jid]) => jid);
        const pendingGroupJids = (grant?.pending ?? [])
          .map((entry) => entry.groupJid)
          .filter((jid) => typeof jid === 'string' && jid.endsWith('@g.us'));
        const toSync = [...new Set([...missingTitles, ...pendingGroupJids])];
        if (toSync.length > 0) {
          try {
            const refreshed = unwrapRpcResult(await rpcCall(ACCESS_GROUP_TITLES_REFRESH_ENDPOINT, {
              botId: account.botId,
              groupJids: toSync,
            }));
            if (cancelled) return;
            const next = grantFromSnapshot(refreshed, account.botId);
            if (next) {
              setDraft(cloneGrant(next, ownerPhone));
              onSaved?.(next);
            }
          } catch {
            // Title sync is best-effort while the bot is offline.
          }
        }
      } catch (error) {
        if (!cancelled) {
          setFeedback({
            tone: 'error',
            message: error?.message || '无法读取访问授权，请返回刷新后重试。',
          });
        }
      } finally {
        if (!cancelled) setLoadingGrant(false);
      }
    })();
    return () => { cancelled = true; };
  }, [account?.botId, rpcCall, ownerPhone]);

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
  const actionableContacts = React.useMemo(
    () => contacts.filter((contact) => contactNeedsGrantAction(contact, draft, knownGroupJids)),
    [contacts, draft, knownGroupJids],
  );

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
  loadingGrant
    ? h('div', { className: 'dim-accessState', 'aria-busy': 'true' }, '正在读取分级访问设置…')
    : null,
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
                h('span', null, ...(entry.kind === 'group'
                  ? ['群聊 · ', groupDisplayName(entry.groupJid, draft.groups)]
                  : ['私聊'])),
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
          return h('div', { key: groupJid, className: 'dim-accessGroupCard' },
            h('div', { className: 'dim-accessGroupHeading' },
              h('h3', null, groupDisplayName(groupJid, draft.groups)),
              h('code', { className: 'dim-accessGroupJid' }, groupJid)),
            h('div', { className: 'dim-accessGroupTitleRow' },
              h('label', { className: 'dim-accessField' },
                h('span', null, '群名称'),
                h('input', {
                  value: group.title ?? '',
                  maxLength: 128,
                  placeholder: '填写便于识别的群名称',
                  onChange: (event) => setDraft((current) => ({
                    ...current,
                    groups: {
                      ...current.groups,
                      [groupJid]: { ...group, title: event.target.value },
                    },
                  })),
                })),
              h('button', {
                type: 'button',
                className: 'dim-deliveryButton',
                disabled: saving,
                onClick: () => void (async () => {
                  setSaving(true);
                  setFeedback(null);
                  try {
                    const refreshed = unwrapRpcResult(await rpcCall(
                      ACCESS_GROUP_TITLES_REFRESH_ENDPOINT,
                      { botId: account.botId, groupJids: [groupJid] },
                    ));
                    const next = grantFromSnapshot(refreshed, account.botId);
                    if (!next) throw new Error('服务没有返回已保存的访问授权。');
                    setDraft(cloneGrant(next, ownerPhone));
                    onSaved?.(next);
                    const title = next.groups?.[groupJid]?.title;
                    setFeedback({
                      tone: title ? 'success' : 'error',
                      message: title
                        ? ['已同步群名：', title].join('')
                        : '未能从 WhatsApp 读取群名，请确认机器人在线且仍在该群。',
                    });
                  } catch (error) {
                    setFeedback({
                      tone: 'error',
                      message: error?.message || '同步群名失败，请稍后重试。',
                    });
                  } finally {
                    setSaving(false);
                  }
                }),
              }, '同步群名')),
            h(AdminPhones, {
              title: '本群管理员',
              help: '未配置时，本群申请回落给全局管理员审批（仍只授予本群权）。',
              phones: group.admins ?? [],
              contacts,
              disabled: saving,
              lockedPhone: null,
              nested: true,
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
              nested: true,
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
    h('p', { className: 'dim-accessHint' },
      '仅记录私聊机器人，或在群里 @ 机器人的人。已有对应权限的人会自动隐藏；电话是唯一授权键，可一键加入私聊/本群授权。'),
    actionableContacts.length === 0
      ? h('div', { className: 'dim-accessUsersEmpty' },
          contacts.length === 0
            ? '暂无联系人。有人私聊或 @ 机器人后会出现在此。'
            : '当前联系人均已具备对应权限，无需再授权。')
      : h('div', { className: 'dim-accessTableWrap' },
          h('table', { className: 'dim-accessTable', 'data-kind': 'contact' },
            h('thead', null,
              h('tr', null,
                h('th', { scope: 'col' }, '昵称'),
                h('th', { scope: 'col' }, '电话'),
                h('th', { scope: 'col' }, '来源'),
                h('th', { scope: 'col', className: 'dim-accessTableActions' }, '操作'))),
            h('tbody', null, actionableContacts.slice(0, 30).map((contact) => {
              const phone = contact.phone || '';
              const nickname = (typeof contact.pushName === 'string' && contact.pushName.trim())
                ? contact.pushName.trim()
                : '暂无昵称';
              const alreadyDirect = Boolean(phone)
                && ((draft.directMembers ?? []).some((m) => m.phone === phone)
                  || (draft.globalAdmins ?? []).includes(phone));
              const groupTargets = (contact.groupJids ?? [])
                .filter((jid) => knownGroupJids.includes(jid))
                .filter((groupJid) => {
                  if (!phone) return true;
                  const group = draft.groups[groupJid] ?? { admins: [], members: [] };
                  return !(group.admins ?? []).includes(phone)
                    && !(group.members ?? []).some((m) => m.phone === phone);
                });
              return h('tr', {
                key: `${contact.phone ?? ''}-${(contact.lids ?? []).join(',')}`,
              },
                h('td', { className: 'dim-accessTableNick' },
                  h('span', {
                    className: nickname === '暂无昵称'
                      ? 'dim-accessNickname dim-accessNicknameEmpty'
                      : 'dim-accessNickname',
                  }, nickname)),
                h('td', { className: 'dim-accessTablePhone' },
                  phone || h('span', { className: 'dim-accessNicknameEmpty' }, '待补电话')),
                h('td', { className: 'dim-accessTableSource' },
                  (contact.scenes ?? []).join(' / ') || '—'),
                h('td', { className: 'dim-accessTableActions dim-accessContactActions' },
                  phone && !alreadyDirect ? h('button', {
                    type: 'button',
                    className: 'dim-deliveryButton',
                    'data-kind': 'primary',
                    disabled: saving,
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
                  }, '加私聊') : null,
                  ...groupTargets.map((groupJid) => {
                    const name = groupDisplayName(groupJid, draft.groups);
                    return h('button', {
                      key: `add-${groupJid}`,
                      type: 'button',
                      className: 'dim-deliveryButton',
                      disabled: saving || !phone,
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
                        setFeedback({
                          tone: 'success',
                          message: ['已加入群授权：', name, '。记得点保存。'].join(''),
                        });
                      },
                    }, ['加入群：', name].join(''));
                  })));
            }))))),
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
