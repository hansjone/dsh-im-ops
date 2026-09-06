import { createProductionController } from './production.mjs';
import { installWhatsappRpc } from './rpc.mjs';
import { conversationKeyMatchesTarget } from '../../../../src/channels/shared/delivery-session-keys.mjs';

export const name = 'dsh-im-whatsapp-host';
export const inject = ['connection', 'typertGateway'];

export async function apply(ctx, config = {}) {
  if (config?.controller) {
    return installWhatsappRpc(ctx, config.controller, config.rpcOptions, config.rpcAuthority);
  }
  const production = await createProductionController(ctx, config, config.internals ?? {});
  const unregisterDelivery = config.deliveryService && production.deliveryAdapter
    ? config.deliveryService.registerAdapter(production.deliveryAdapter) : undefined;
  const disposeRpc = installWhatsappRpc(
    ctx,
    production.controller,
    config.rpcOptions,
    config.rpcAuthority,
  );
  let unregisterPeer = () => {};
  let unregisterConversation = () => {};
  try {
    const dshIm = typeof ctx.get === 'function' ? ctx.get('dshIm') : undefined;
    if (dshIm && typeof dshIm.registerPeerResolver === 'function'
      && typeof production.controller?.resolveChannelPeer === 'function') {
      unregisterPeer = dshIm.registerPeerResolver((sessionId) => (
        production.controller.resolveChannelPeer(sessionId)
      ));
    }
    if (dshIm && typeof dshIm.registerConversationSessionResolver === 'function'
      && typeof production.stateFor === 'function') {
      const resolve = async (botId, conversationKey) => {
        try {
          const state = await production.stateFor(botId);
          const sessionId = state?.sessionFor?.(conversationKey);
          return typeof sessionId === 'string' && sessionId ? sessionId : null;
        } catch {
          return null;
        }
      };
      resolve.findByTarget = async (botId, target) => {
        try {
          const state = await production.stateFor(botId);
          const rows = typeof state?.listLiveSessions === 'function'
            ? state.listLiveSessions()
            : [];
          for (const row of rows) {
            if (conversationKeyMatchesTarget(row.conversationKey, target)) {
              return row;
            }
          }
        } catch {
          return null;
        }
        return null;
      };
      unregisterConversation = dshIm.registerConversationSessionResolver(resolve);
    }
  } catch {
    // dshIm optional during partial boots
  }
  ctx.effect(() => async () => {
    unregisterConversation?.();
    unregisterPeer?.();
    await unregisterDelivery?.();
    await production.close();
  }, 'dsh-im: close WhatsApp Web connections');
  return disposeRpc;
}

export function createWhatsappHostPlugin(config) {
  return Object.freeze({ name, inject, apply: (ctx) => apply(ctx, config) });
}

export { createProductionController } from './production.mjs';
export {
  WHATSAPP_ENDPOINTS,
  WHATSAPP_RPC_CHANNEL,
  WHATSAPP_RPC_ENDPOINTS,
  createWhatsappRpcHandler,
  installWhatsappRpc,
} from './rpc.mjs';
export { WhatsappController } from '../../../../src/channels/whatsapp/whatsapp-controller.mjs';
export { WhatsappRuntime } from '../../../../src/channels/whatsapp/whatsapp-runtime.mjs';
