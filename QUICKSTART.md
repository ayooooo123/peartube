# PearTube Quick Start Guide

## Prerequisites

- Node.js 18+ installed
- Pear CLI installed (`npm install -g pear`)
- Pear v2 sidecar running (see below)

## Setup

### 1. Install Dependencies

```bash
cd /Users/jd/projects/peartube
npm install
```

### 2. Start Pear v2 Sidecar (Required)

In a separate terminal, start the Pear v2 sidecar:

```bash
pear sidecar --key pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o
```

Keep this running in the background while developing.

### 3. Run Development Mode

```bash
npm run dev
```

This will:
1. Compile TypeScript → JavaScript
2. Launch the Pear desktop app
3. Start the backend P2P worker
4. Display the React UI

## Available Scripts

### Development

```bash
npm run dev              # Build + run app
npm run dev:watch        # Build with watch mode + run
npm run compile          # Compile once
npm run compile:watch    # Compile in watch mode
```

### Quality Checks

```bash
npm run typecheck        # TypeScript type checking
npm run lint             # ESLint
npm run lint:fix         # Auto-fix lint issues
npm test                # Run all checks + tests
```

### Build

```bash
npm run build           # Production build
```

## Project Structure

```
peartube/
├── src/                    # Frontend React app
│   ├── index.tsx          # Entry point
│   ├── App.tsx            # Main component
│   └── types/pear.d.ts    # TypeScript definitions
├── workers/
│   └── core/
│       └── index.ts       # Backend P2P worker
├── build/                 # Compiled output (gitignored)
├── index.html             # HTML entry point
└── package.json           # Configuration
```

## Troubleshooting

### "Cannot find module 'chokidar'"

Install dependencies:
```bash
npm install
```

### "UNKNOWN_FLAG: version" or Pear command issues

Make sure Pear v2 sidecar is running:
```bash
pear sidecar --key pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o
```

### "Pear is not defined"

This is expected if you try to run files directly with Node.js. 
Use `npm run dev` instead, which runs files with the Pear runtime.

### Build errors

Clean and rebuild:
```bash
rm -rf build node_modules
npm install
npm run compile
```

## Current Status

✅ All dependency issues resolved
✅ Build system working
✅ TypeScript configured
✅ Pear v2 runtime ready
✅ Ready for Phase 1 development

## What's Next?

See [DEV_STATUS.md](./DEV_STATUS.md) for current development status and next steps.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for technical architecture details.

See [README.md](./README.md) for project overview and roadmap.
