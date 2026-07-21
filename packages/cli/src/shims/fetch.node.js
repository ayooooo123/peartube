// Node (18+) ships a global fetch; the TMDB classifier/discover client use it
// directly. Exposed through the `#fetch` shim so the relay runtime can swap in a
// Bare-compatible implementation (Bare has no global fetch).
export default (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
