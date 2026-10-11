export const WHATSAPP_STYLE_ID = 'xmanrui-dsh-im-whatsapp-settings';

const CSS = String.raw`
.dwa-page { --ddt-accent: #128c7e; --ddt-accent-deep: #075e54; --ddt-accent-wash: color-mix(in srgb, #128c7e 10%, var(--dsw-alias-bg-layer-1, #fff)); }
.dwa-avatar { color: #fff; background: #25d366; }
.dwa-avatar svg { display: block; }
.dwa-sessionSettings { min-width: 0; display: grid; gap: 10px; margin-top: 16px; }
.dwa-settingsHeading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; }
.dwa-settingsHeading h4 { font-size: 13px; line-height: 20px; font-weight: 650; }
.dwa-settingsHeading > span, .dwa-settingsHint { color: var(--dsw-alias-label-tertiary, #8f959e); font-size: 11px; line-height: 18px; }
.dwa-settingsGrid { min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.dim-panel .dwa-settingsGrid > .dim-workspace { grid-column: 1 / -1; }
.dim-panel .dwa-settingsGrid > .dim-workspace, .dim-panel .dwa-settingsGrid > .dim-preset { margin-top: 0; padding: 10px 12px; }
.dwa-settingsHint { margin: 0; }
.dwa-settingsHint code { color: var(--dsw-alias-label-secondary, #646a73); }
@container (max-width: 520px) {
  .dwa-settingsGrid { grid-template-columns: minmax(0, 1fr); }
}
`;

export function installWhatsappStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${WHATSAPP_STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = 'dsh-im-ops';
  style.dataset.pluginCss = WHATSAPP_STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}
