// Internal policy-control plane for retained index services.
// Not re-exported from scoped-runtime or package public entry points.
// scoped-session-runtime registers; api/policy.js consumes.

const controls = new WeakMap()

export function registerIndexServicePolicyControl (runtime, control) {
  if (!runtime || !control) return
  controls.set(runtime, control)
}

export function getIndexServicePolicyControl (runtime) {
  return controls.get(runtime) || null
}
