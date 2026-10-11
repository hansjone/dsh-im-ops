/** Run same-process IM operations without inheriting a browser's UDS identity. */
export function runHarnessHostOperation(ctx, operation) {
  // Cordis property access requires inject even for an optional service.
  // ctx.get() supports dynamic lookup without making UDS a startup dependency.
  const auth = typeof ctx?.get === 'function' ? ctx.get('udsAuth') : ctx?.udsAuth;
  // Resolve on every call: auth can become ready or reload after IM starts.
  return typeof auth?.runAsHost === 'function'
    ? auth.runAsHost(operation)
    : operation();
}
