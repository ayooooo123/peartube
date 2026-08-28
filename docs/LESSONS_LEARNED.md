# Lessons Learned

This document captures recurring implementation traps that have caused slow debugging in PearTube.

## Adding New Fields To RPC Responses

When a client requests data, the value crosses several layers:

```text
Domain logic in packages/backend/src/*
  -> API surface in packages/backend/src/api.js
  -> shared HRPC handlers in packages/backend/src/hrpc-handlers.js
  -> generated HRPC encoding from packages/spec/schema.cjs
  -> protocol/platform client facades
  -> UI shell
```

Runtime-specific entrypoints still matter:

- Mobile entrypoint: `packages/app/backend/index.mjs`
- Electrobun worker entrypoint: `packages/app/workers/desktop/index.ts`

Most shared request/response handlers should be registered through `packages/backend/src/hrpc-handlers.js` and `packages/backend/src/backend-entry.js`. Only add platform-specific mappings in an entrypoint when the operation genuinely depends on that runtime.

### Common Pitfall: Field Exists In Domain Logic But Not On The Wire

When adding a response field:

1. Add it to `packages/spec/schema.cjs`.
2. Run `npm run schema:full`.
3. Ensure the backend API returns it from `packages/backend/src/api.js` or the relevant domain module.
4. Ensure `packages/backend/src/hrpc-handlers.js` maps it into the HRPC response.
5. Update protocol/platform/UI types if they consume the field directly.
6. Rebuild affected bundles.

Example:

```javascript
const comments = result.comments.map((comment) => ({
  videoId: comment.videoId,
  commentId: comment.commentId,
  text: comment.text,
  authorKeyHex: comment.authorKeyHex,
  timestamp: comment.timestamp,
  parentId: comment.parentId,
  isAdmin: Boolean(comment.isAdmin)
}))
```

If the new field is missing in the UI, first check the shared handler mapping, then the generated HRPC message encoding, then the UI field name.

### Rebuild The Right Artifacts

```bash
npm run schema:full                 # schema + generated Swift support
npm run bundle:backend              # mobile BareKit backend bundle
npm run desktop:build               # Electrobun web export + desktop worker bundle
npm run desktop:smoke --prefix packages/app
```

Desktop worker output is now under `packages/app/desktop-build/build/workers/core/`, not the old `pear/build` path.

### Schema Version Checks

`packages/host/src/contracts.js` owns the shared `PROTOCOL_VERSION`. Clients should reject unsupported versions before applying backend data. If a field appears to be dropped, check:

- the field in `packages/spec/schema.cjs`;
- the generated `packages/spec/spec/hrpc/messages.js`;
- app RPC metadata in `packages/spec/spec/hrpc/app-rpc-adapter.mjs`;
- protocol readiness/version handling in `packages/host/src/create-client.js`;
- native bridge generated Swift support if the field crosses into Swift.

### Debugging Tips

Trace the value at each layer:

```javascript
console.log('[domain] value:', value)
console.log('[api] response:', response)
console.log('[hrpc handler] mapped:', mapped)
console.log('[ui] received:', received)
```

Check generated or packed artifacts when needed:

```bash
grep -o 'isAdmin' packages/spec/spec/hrpc/messages.js | wc -l
grep -o 'isAdmin' packages/app/backend.bundle.js | wc -l
grep -o 'isAdmin' packages/app/desktop-build/build/workers/core/index.bundle | wc -l
```

## VideoToolbox Decode Can Corrupt Memory On Pear Runtime

During HLS transcoding on the desktop Pear/Bare runtime, enabling VideoToolbox hardware decode can trigger malloc corruption crashes. The likely root cause is an invalid hardware-to-software transfer path in the local `bare-ffmpeg` fork, not the JS layer.

Use software decode by default unless actively validating VideoToolbox.

Controls:

- UI: Settings -> Transcoding -> VideoToolbox Decode
- Env override: `PEARTUBE_ENABLE_VT_DECODE=1|0`
- HW map override: `PEARTUBE_ENABLE_VT_HWMAP=1|0`

Safer hardware-decode testing guidance:

- Prefer HW map (`av_hwframe_map`) over transferData when transfer errors appear.
- Select the transfer format from `hwFramesCtx.getConstraints().validSwFormats`.
- Do not hardcode `NV12`; HEVC 10-bit often requires `P010`.
- Do not pre-allocate the transfer frame for VideoToolbox; set format/size and let FFmpeg map or allocate.
- Always use the actual transfer-frame format and size when deciding whether to scale.
- Keep hardware-decode runs short and capture crash reports.
