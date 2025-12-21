# Lessons Learned: Adding New Fields to RPC Responses

This document captures hard-won lessons from debugging the `isAdmin` field on comments, which took significant time to diagnose. Future developers should read this before adding new fields to RPC responses.

## The Architecture: Understanding the Data Flow

When a client requests data (e.g., `listComments`), the data flows through multiple layers:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CLIENT (UI)                                    │
│   Receives decoded RPC response with all expected fields                │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ 4. HRPC decodes response
                                    │
┌─────────────────────────────────────────────────────────────────────────┐
│                    HRPC ENCODING LAYER                                   │
│   @peartube/spec encodes/decodes messages using hyperschema             │
│   - packages/spec/spec/hrpc/messages.js (encoding logic)                │
│   - packages/spec/spec/hrpc/index.js (RPC client/server)                │
│   - Uses VERSION variable for version-gated fields                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ 3. RPC handler returns response object
                                    │
┌─────────────────────────────────────────────────────────────────────────┐
│                    RPC HANDLER LAYER                                     │
│   ⚠️  TWO SEPARATE FILES - EASY TO MISS ONE!                           │
│                                                                          │
│   MOBILE:  packages/app/backend/index.mjs                               │
│   DESKTOP: packages/app/pear-src/workers/core/index.ts                  │
│                                                                          │
│   These map raw API responses to RPC response objects.                  │
│   Fields NOT included here will be silently dropped!                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ 2. API returns data with all fields
                                    │
┌─────────────────────────────────────────────────────────────────────────┐
│                    API LAYER                                             │
│   packages/backend/src/api.js                                           │
│   Thin wrapper that calls domain logic                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ 1. Domain logic computes all fields
                                    │
┌─────────────────────────────────────────────────────────────────────────┐
│                    DOMAIN LAYER                                          │
│   e.g., packages/backend/src/channel/comments-autobase.js               │
│   Where business logic lives (e.g., determining isAdmin)                │
└─────────────────────────────────────────────────────────────────────────┘
```

## Common Pitfalls

### 1. Forgetting to Update BOTH RPC Handlers

**The #1 cause of missing fields in responses.**

When you add a new field to an RPC response, you MUST update:

- `packages/app/backend/index.mjs` (mobile backend)
- `packages/app/pear-src/workers/core/index.ts` (desktop backend)

Both files have handlers like `rpc.onListComments()` that map API responses to RPC responses. If you add a field to one but not the other, that platform won't have the field.

**Example of the bug:**
```javascript
// WRONG - isAdmin is missing!
const comments = result.comments.map((c) => ({
  videoId: c.videoId,
  commentId: c.commentId,
  text: c.text,
  authorKeyHex: c.authorKeyHex,
  timestamp: c.timestamp,
  parentId: c.parentId
  // isAdmin is not included - will be undefined!
}));

// CORRECT
const comments = result.comments.map((c) => ({
  videoId: c.videoId,
  commentId: c.commentId,
  text: c.text,
  authorKeyHex: c.authorKeyHex,
  timestamp: c.timestamp,
  parentId: c.parentId,
  isAdmin: Boolean(c.isAdmin)  // ✓ Explicitly include the field
}));
```

### 2. Rebuild the Correct Bundle

After making changes, rebuild the correct bundle:

- **Mobile:** `npm run bundle:backend` (rebuilds `packages/app/backend.bundle.js`)
- **Desktop:** `npm run pear:worker` (rebuilds `pear/build/workers/core/index.js`)
- **Full desktop rebuild:** `npm run pear:build` (does everything including worker)

### 3. Schema Version for New Fields

When adding new optional fields to hyperschema types, they may be version-gated:

```javascript
// In messages.js, new fields use version checks:
const flags = (m.timestamp ? 1 : 0) |
              (m.parentId ? 2 : 0) |
              ((version >= 2 && m.isAdmin) ? 4 : 0);  // Only encoded if version >= 2
```

The HRPC layer calls `setVersion(VERSION)` before encoding to ensure the correct version is used. If you see fields not being encoded, check that:
1. `setVersion(VERSION)` is called before encoding (in `spec/hrpc/index.js`)
2. The VERSION constant is correct (should be 2 for peartube schema)

### 4. Adding New Fields: Complete Checklist

When adding a new field to an RPC response type:

- [ ] Add field to schema in `packages/spec/schema.cjs`
- [ ] Run `node schema.cjs` to regenerate `spec/hrpc/messages.js` and `spec/schema/`
- [ ] Add field to domain logic (e.g., `comments-autobase.js`)
- [ ] Add field to API layer if needed (`api.js`)
- [ ] **Add field to MOBILE handler** (`packages/app/backend/index.mjs`)
- [ ] **Add field to DESKTOP handler** (`packages/app/pear-src/workers/core/index.ts`)
- [ ] Rebuild mobile bundle: `npm run bundle:backend`
- [ ] Rebuild desktop worker: `npm run pear:worker`
- [ ] Test on BOTH mobile and desktop platforms

## Debugging Tips

### Trace the Data Flow

Add console.logs at each layer to see where data is being lost:

```javascript
// In domain layer (comments-autobase.js)
console.log('[CommentsAutobase] isAdmin:', isAdmin);

// In RPC handler (index.mjs / index.ts)
console.log('[Worker] comment before mapping:', c);
console.log('[Worker] comment after mapping:', mappedComment);

// In encoding layer (messages.js) - for deep debugging
console.log('[Comment encode] m.isAdmin:', m.isAdmin);
```

### Check Bundle Contents

Verify your changes made it into the bundle:
```bash
# Check if field exists in mobile bundle
grep -o 'isAdmin' packages/app/backend.bundle.js | wc -l

# Check if field exists in desktop bundle
grep -o 'isAdmin' packages/app/pear/build/workers/core/index.js | wc -l
```

### Backend Logs Show True, UI Shows False?

If the backend correctly computes a value but the UI receives a different value:
1. Check the RPC handler mapping (most common cause)
2. Check the HRPC encoding (version-gated fields)
3. Check the UI is reading the correct field name

## File Reference

| Purpose | Mobile | Desktop |
|---------|--------|---------|
| RPC Handlers | `packages/app/backend/index.mjs` | `packages/app/pear-src/workers/core/index.ts` |
| Built Bundle | `packages/app/backend.bundle.js` | `pear/build/workers/core/index.js` |
| Build Command | `npm run bundle:backend` | `npm run pear:worker` |
| Schema Definition | `packages/spec/schema.cjs` | (same) |
| Generated Messages | `packages/spec/spec/hrpc/messages.js` | (same) |
| Domain Logic | `packages/backend/src/` | (same, imported) |
