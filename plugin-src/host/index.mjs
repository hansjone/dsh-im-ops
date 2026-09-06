import { apply as applyDingtalk } from './channels/dingtalk/index.mjs';
import { apply as applyDiscord } from './channels/discord/index.mjs';
import { apply as applyOffice } from './channels/office/index.mjs';
import { apply as applyFeishu } from './channels/feishu/index.mjs';
import { apply as applyQq } from './channels/qq/index.mjs';
import { apply as applySlack } from './channels/slack/index.mjs';
import { apply as applyTelegram } from './channels/telegram/index.mjs';
import { apply as applyWecom } from './channels/wecom/index.mjs';
import { apply as applyWeixin } from './channels/weixin/index.mjs';
import { apply as applyWhatsapp } from './channels/whatsapp/index.mjs';
import { installOutboundArtifactTool } from '../../src/channels/shared/semantic/artifact.mjs';
import { setImHostLanguage } from '../../src/channels/shared/i18n.mjs';
import {
  conversationKeysFromDeliveryTarget,
} from '../../src/channels/shared/delivery-session-keys.mjs';
import { installDeliveryRpc } from './delivery-rpc.mjs';
import { installDeliveryHttp } from './delivery-http.mjs';
import { createDeliveryService } from './delivery-service.mjs';
import { installUpdateRpc } from './update-rpc.mjs';

export const name = 'dsh-im-host';
export const inject = [
  'connection',
  'credentials',
  'typertGateway',
];

function channelConfig(config, name, deliveryService) {
  const channel = config[name] ?? {};
  const withAuthority = config.rpcAuthority === undefined
    ? channel
    : { ...channel, rpcAuthority: config.rpcAuthority };
  return name === 'office' ? withAuthority : { ...withAuthority, deliveryService };
}

export function createImHostPlugin(internals = {}) {
  const startUpdate = internals.installUpdateRpc ?? installUpdateRpc;
  const startDelivery = internals.installDeliveryRpc ?? installDeliveryRpc;
  const startDeliveryHttp = internals.installDeliveryHttp ?? installDeliveryHttp;
  const makeDeliveryService = internals.createDeliveryService ?? createDeliveryService;
  const startFeishu = internals.applyFeishu ?? applyFeishu;
  const startWeixin = internals.applyWeixin ?? applyWeixin;
  const startDingtalk = internals.applyDingtalk ?? applyDingtalk;
  const startWecom = internals.applyWecom ?? applyWecom;
  const startQq = internals.applyQq ?? applyQq;
  const startSlack = internals.applySlack ?? applySlack;
  const startTelegram = internals.applyTelegram ?? applyTelegram;
  const startDiscord = internals.applyDiscord ?? applyDiscord;
  const startOffice = internals.applyOffice ?? applyOffice;
  const startWhatsapp = internals.applyWhatsapp ?? applyWhatsapp;
  const channels = [
    ['feishu', startFeishu],
    ['weixin', startWeixin],
    ['dingtalk', startDingtalk],
    ['wecom', startWecom],
    ['qq', startQq],
    ['slack', startSlack],
    ['telegram', startTelegram],
    ['discord', startDiscord],
    ['whatsapp', startWhatsapp],
    ['office', startOffice],
  ];
  return Object.freeze({
    name,
    inject,
    async apply(ctx, config = {}) {
      const deliveryService = makeDeliveryService();
      const peerResolvers = [];
      const conversationSessionResolvers = [];

      async function resolveConversationSession(botId, conversationKey) {
        const id = typeof botId === 'string' ? botId.trim() : '';
        const key = typeof conversationKey === 'string' ? conversationKey.trim() : '';
        if (!id || !key) return null;
        for (const resolve of conversationSessionResolvers) {
          try {
            const sessionId = await resolve(id, key);
            if (typeof sessionId === 'string' && sessionId.trim()) {
              return { sessionId: sessionId.trim(), botId: id, conversationKey: key };
            }
          } catch {
            // try next channel
          }
        }
        return null;
      }

      /**
       * Prefer an exact conversationKey binding; for group targets also accept
       * the first live `group:<jid>:user:…` binding when scope is user_in_chat.
       */
      async function resolveTargetSession(botId, targetId) {
        const id = typeof botId === 'string' ? botId.trim() : '';
        const tid = typeof targetId === 'string' ? targetId.trim() : '';
        if (!id || !tid) return null;
        let targets = [];
        try {
          const listed = await deliveryService.listTargets(id);
          targets = Array.isArray(listed?.targets) ? listed.targets : [];
        } catch {
          return null;
        }
        const target = targets.find((row) => row?.targetId === tid);
        if (!target) return null;

        const keys = conversationKeysFromDeliveryTarget(target);
        for (const key of keys) {
          const hit = await resolveConversationSession(id, key);
          if (hit) return hit;
        }

        // Group deliveries may only have per-speaker bindings (user_in_chat).
        for (const resolve of conversationSessionResolvers) {
          if (typeof resolve.findByTarget !== 'function') continue;
          try {
            const hit = await resolve.findByTarget(id, target);
            const sessionId = typeof hit?.sessionId === 'string' ? hit.sessionId.trim() : '';
            const conversationKey = typeof hit?.conversationKey === 'string'
              ? hit.conversationKey.trim()
              : '';
            if (sessionId && conversationKey) {
              return { sessionId, botId: id, conversationKey };
            }
          } catch {
            // try next
          }
        }
        return null;
      }

      if (typeof ctx?.provide === 'function') {
        ctx.provide('dshIm', Object.freeze({
          send: (botId, targetId, text, options) => (
            deliveryService.send(botId, targetId, text, options)
          ),
          listTargets: async (botId) => (await deliveryService.listTargets(botId)).targets,
          listDeliveryCatalog: async () => deliveryService.listCatalog(),
          createTarget: (botId, target) => deliveryService.createTarget(botId, target),
          /**
           * Resolve the IM channel peer for a Harness session (botId + conversationKey).
           * Used by ops schedulers to default proactive delivery back to the caller.
           */
          resolveSessionPeer: async (sessionId) => {
            const id = typeof sessionId === 'string' ? sessionId.trim() : '';
            if (!id) return null;
            for (const resolve of peerResolvers) {
              try {
                const peer = await resolve(id);
                if (peer && typeof peer.botId === 'string' && peer.botId.trim()) return peer;
              } catch {
                // try next channel
              }
            }
            return null;
          },
          /** @param {(sessionId: string) => Promise<object|null>} resolve */
          registerPeerResolver: (resolve) => {
            if (typeof resolve !== 'function') return () => {};
            peerResolvers.push(resolve);
            return () => {
              const index = peerResolvers.indexOf(resolve);
              if (index >= 0) peerResolvers.splice(index, 1);
            };
          },
          /**
           * Resolve the live Harness session bound to a conversationKey for a bot.
           * @param {string} botId
           * @param {string} conversationKey
           */
          resolveConversationSession,
          /**
           * Resolve the live Harness session for a proactive-delivery target.
           * @param {string} botId
           * @param {string} targetId
           */
          resolveTargetSession,
          /**
           * @param {(botId: string, conversationKey: string) => Promise<string|null>} resolve
           *   Optional `resolve.findByTarget(botId, target)` for group prefix matches.
           */
          registerConversationSessionResolver: (resolve) => {
            if (typeof resolve !== 'function') return () => {};
            conversationSessionResolvers.push(resolve);
            return () => {
              const index = conversationSessionResolvers.indexOf(resolve);
              if (index >= 0) conversationSessionResolvers.splice(index, 1);
            };
          },
        }));
      }
      const activate = async (readyCtx) => {
        await activateChannels(readyCtx, config, deliveryService);
      };
      if (typeof ctx?.inject === 'function') {
        const modern = typeof ctx?.typertGateway?.stream === 'function';
        await ctx.inject(
          modern ? ['sessionController', 'workspaceController'] : ['apiProxy'],
          activate,
        );
        ctx.inject(['webServer'], (httpCtx) => {
          startDeliveryHttp(httpCtx, deliveryService);
        });
        return;
      }
      await activate(ctx);
      if (ctx?.webServer?.register && typeof ctx?.effect === 'function') {
        startDeliveryHttp(ctx, deliveryService);
      }
    },
  });

  async function activateChannels(ctx, config, deliveryService) {
    setImHostLanguage(config.language ?? process.env.DSH_IM_LANGUAGE);
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['tools', 'systemPrompt'], (artifactCtx) => {
        installOutboundArtifactTool(artifactCtx);
      });
    } else {
      installOutboundArtifactTool(ctx);
    }
    const logger = typeof ctx?.logger === 'function'
      ? ctx.logger(name)
      : (ctx?.logger ?? console);
    if (ctx?.connection?.rpc) {
      try {
        startUpdate(ctx);
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate update management; continuing with channels', error);
      }
      try {
        startDelivery(ctx, deliveryService, { authority: config.rpcAuthority });
      } catch (error) {
        logger.error?.('[dsh-im] failed to activate delivery management; continuing with channels', error);
      }
    }
    const failures = [];
    for (const [channel, start] of channels) {
      try {
        await start(ctx, channelConfig(config, channel, deliveryService));
      } catch (error) {
        failures.push(error);
        logger.error?.(`[dsh-im] failed to activate ${channel}; continuing with the remaining channels`, error);
      }
    }
    if (failures.length === channels.length) {
      throw new AggregateError(failures, 'dsh-im failed to activate every channel');
    }
  }
}

export async function apply(ctx, config = {}) {
  return createImHostPlugin().apply(ctx, config);
}
