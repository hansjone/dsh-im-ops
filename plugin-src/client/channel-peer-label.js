import * as React from 'react';

import { h, localizeText } from './i18n.js';
import {
  unwrapRpcResult,
  WHATSAPP_ENDPOINTS,
} from './channels/whatsapp/api.js';

const CHANNEL_LABELS = Object.freeze({
  whatsapp: 'WhatsApp',
  feishu: '飞书',
  dingtalk: '钉钉',
  wecom: '企业微信',
  weixin: '微信',
  qq: 'QQ',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  office: 'AI Office',
});

/**
 * Session-header chip: channel peer for IM conversations (live or formerly bound).
 * Renders nothing when the session has no channel provenance.
 * @param {{
 *   sessionId: string,
 *   resolveChannelPeer?: (sessionId: string, signal?: AbortSignal) => Promise<object|null>,
 * }} props
 */
export function ChannelPeerLabel({ sessionId, resolveChannelPeer }) {
  const [peer, setPeer] = React.useState(null);

  React.useEffect(() => {
    if (typeof resolveChannelPeer !== 'function' || typeof sessionId !== 'string' || !sessionId) {
      setPeer(null);
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const next = await resolveChannelPeer(sessionId, controller.signal);
        if (active && !controller.signal.aborted) setPeer(next && typeof next === 'object' ? next : null);
      } catch {
        if (active && !controller.signal.aborted) setPeer(null);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [sessionId, resolveChannelPeer]);

  if (!peer?.label) return null;
  const channelName = CHANNEL_LABELS[peer.channel] || peer.channel || 'IM';
  const title = peer.kind === 'group'
    ? `${channelName} · ${peer.label}`
    : `${channelName} · ${peer.label}`;
  return h('span', {
    className: 'dim-channelPeerLabel',
    title,
    'aria-label': localizeText('渠道用户') + ` · ${title}`,
  },
  h('span', { className: 'dim-channelPeerChannel', 'aria-hidden': 'true' }, channelName),
  h('span', { className: 'dim-channelPeerText' }, peer.label));
}

/**
 * Resolve the channel peer for a session via WhatsApp (ops-first).
 * Works for live bindings and sessions unbound by `/new` (provenance retained).
 * @param {(endpoint: string, payload: object, signal?: AbortSignal) => Promise<unknown>} whatsappRpcCall
 * @param {string} sessionId
 * @param {AbortSignal} [signal]
 */
export async function resolveWhatsappChannelPeer(whatsappRpcCall, sessionId, signal) {
  if (typeof whatsappRpcCall !== 'function') return null;
  const result = await whatsappRpcCall(
    WHATSAPP_ENDPOINTS.resolveChannelPeer,
    { sessionId },
    signal,
  );
  const value = unwrapRpcResult(result);
  if (!value || typeof value !== 'object') return null;
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (!label) return null;
  return {
    channel: typeof value.channel === 'string' ? value.channel : 'whatsapp',
    botId: typeof value.botId === 'string' ? value.botId : '',
    kind: value.kind === 'group' ? 'group' : 'direct',
    label,
    phone: typeof value.phone === 'string' ? value.phone : null,
    pushName: typeof value.pushName === 'string' ? value.pushName : null,
    groupTitle: typeof value.groupTitle === 'string' ? value.groupTitle : null,
  };
}
