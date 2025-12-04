# PearTube Setup Guide

## Dependency Resolution - COMPLETED ✓

All dependency issues have been resolved. The project is now ready for development.

### Issues Fixed

1. **ESLint Plugin Conflict**
   - **Problem**: `eslint-plugin-react-hooks@^5.2.0` conflicted with `eslint-config-airbnb@^19.0.4`
   - **Solution**: Downgraded to `eslint-plugin-react-hooks@^4.6.2` with package overrides

2. **Missing Dependencies**
   - Added `corestore` (required by backend worker)

3. **Updated Hyper Module Versions**
   - `hyperdrive`: ^11.6.0 → ^13.0.0 (latest stable)
   - `hyperbee`: ^2.20.0 → ^2.26.0 (latest stable)
   - `hyperswarm`: ^4.8.0 → ^4.15.0 (latest stable)
   - `corestore`: Added ^6.18.0

4. **TypeScript Declarations**
   - Created `src/types/pear.d.ts` with type declarations for Pear/Hyper modules
   - Updated `tsconfig.json` to include custom type definitions

5. **Configuration Files Added**
   - `.eslintrc.cjs` - ESLint configuration
   - `.eslintignore` - ESLint ignore patterns
   - `jest.config.js` - Jest test configuration
   - `jest.setup.js` - Jest setup file

## Verification

All build and test commands pass successfully:

```bash
✓ npm install          # All dependencies installed
✓ npm run compile      # TypeScript → JavaScript compilation
✓ npm run typecheck    # Type checking passes
✓ npm run lint         # Linting passes
✓ npm test            # Full test suite passes
```

## Project Structure

```
peartube/
├── src/
│   ├── types/
│   │   └── pear.d.ts         # TypeScript declarations
│   ├── App.tsx               # Main React component
│   └── index.tsx             # Frontend entry point
├── workers/
│   └── core/
│       └── index.ts          # Backend P2P worker
├── node_modules/             # Dependencies (1007 packages)
├── build/                    # Compiled output (gitignored)
├── .eslintrc.cjs            # ESLint config
├── .eslintignore            # ESLint ignore
├── .swcrc                   # SWC compiler config
├── .gitignore               # Git ignore
├── tsconfig.json            # TypeScript config
├── jest.config.js           # Jest config
├── jest.setup.js            # Jest setup
├── package.json             # Dependencies & scripts
├── package-lock.json        # Locked dependency versions
├── index.html               # HTML entry point
├── ARCHITECTURE.md          # Technical architecture
├── README.md                # Project overview
└── SETUP.md                 # This file
```

## Installed Packages

### Core Dependencies (17)
- `@reduxjs/toolkit@2.11.0` - State management
- `autobase@7.23.0` - Multi-writer coordination
- `b4a@1.7.3` - Buffer utilities
- `corestore@6.18.4` - Hypercore storage
- `framed-stream@1.0.1` - Stream framing
- `hyperbee@2.26.5` - Key-value database
- `hypercore@10.38.2` - Append-only log
- `hypercore-crypto@3.6.1` - Cryptographic primitives
- `hyperdrive@13.0.2` - Distributed file system
- `hyperswarm@4.15.1` - P2P networking
- `pear-bridge@1.2.4` - IPC bridge
- `pear-electron@1.7.25` - Desktop runtime
- `pear-ipc-client@1.0.0` - IPC client
- `react@19.2.0` - UI framework
- `react-dom@19.2.0` - React DOM renderer
- `react-redux@9.2.0` - Redux bindings
- `react-router-dom@7.9.6` - Routing
- `tiny-buffer-rpc@2.3.1` - RPC communication

### Dev Dependencies (16)
- `@swc/cli@0.5.2` - SWC command line
- `@swc/core@1.15.3` - Fast TypeScript compiler
- `@swc/jest@0.2.39` - Jest SWC transformer
- `@types/jest@30.0.0` - Jest types
- `@types/react@19.2.7` - React types
- `@types/react-dom@19.2.3` - React DOM types
- `@typescript-eslint/eslint-plugin@8.48.0` - TS ESLint plugin
- `@typescript-eslint/parser@8.48.0` - TS ESLint parser
- `concurrently@8.2.2` - Run commands concurrently
- `eslint@8.57.1` - Linter
- `eslint-plugin-import@2.32.0` - Import linting
- `eslint-plugin-jsx-a11y@6.10.2` - Accessibility linting
- `eslint-plugin-react@7.37.5` - React linting
- `eslint-plugin-react-hooks@4.6.2` - Hooks linting
- `jest@29.7.0` - Testing framework
- `jest-environment-jsdom@29.7.0` - DOM test environment
- `typescript@5.9.3` - Type checking

Total: **1007 packages** (including transitive dependencies)

## Available Scripts

```bash
# Development
npm run dev              # Start development mode (compile + watch + pear run)
npm run dev:run          # Run with Pear runtime
npm run compile          # Compile TypeScript to JavaScript
npm run compile:watch    # Compile in watch mode

# Quality Checks
npm run typecheck        # Run TypeScript type checking
npm run typecheck:watch  # Type check in watch mode
npm run lint             # Run ESLint
npm run lint:fix         # Auto-fix ESLint issues
npm test                # Run all tests (lint + typecheck + jest)
npm run test:jest        # Run Jest tests only

# Build
npm run build           # Production build (alias for compile)
```

## ✅ RESOLVED: npm run dev Issues (2025-11-26)

### Issues Found and Fixed:

1. **Missing `chokidar` dependency**
   - **Problem**: SWC watch mode requires `chokidar` but it wasn't installed
   - **Solution**: Added `chokidar@^3.6.0` to devDependencies

2. **Incorrect Pear CLI flag**
   - **Problem**: Used `-d` flag which doesn't exist in Pear v2
   - **Solution**: Updated to `--dev` flag (`pear run --dev .`)

3. **Build path configuration**
   - **Problem**: Worker file not being compiled correctly
   - **Solution**: Updated compile script to build entire project structure
   - **Before**: `swc ./src -d ./build`
   - **After**: `swc . -d ./build --copy-files --ignore 'node_modules/**,build/**'`

4. **Pear entrypoint paths**
   - **Problem**: package.json referenced wrong worker path
   - **Solution**: Updated to `/build/workers/core/index.js`

### Verified Working:

```bash
✓ npm install         # 1013 packages installed
✓ npm run compile     # Compiles frontend + backend (6 files)
✓ npm run typecheck   # Type checking passes
✓ npm run lint        # Linting passes
✓ npm test           # All checks pass
✓ Build structure     # Correct paths in build/
```

### Pear v2 Setup:

The Pear runtime has been upgraded to v2 using:
```bash
pear sidecar --key pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o
```

This enables Pear v2 features needed for the app.

## Next Steps

The project is now ready for Phase 1 development:

1. ✓ Dependencies installed and resolved
2. ✓ TypeScript configuration complete
3. ✓ Build system working
4. ✓ Linting and type checking passing
5. ✓ Pear runtime configured
6. ✓ Watch mode working
7. ✓ npm run dev fixed
8. → Ready to test the app and start implementing features

### Phase 1 Tasks (Weeks 1-3)
- [ ] Complete Pear app initialization
- [ ] Implement identity management (keypair generation)
- [ ] Set up RPC communication between frontend and backend
- [ ] Test P2P networking basics

## Troubleshooting

### If you encounter issues:

1. **Clean reinstall**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

2. **Clear build cache**
   ```bash
   npm run compile
   ```

3. **Verify Pear CLI**
   ```bash
   pear --version
   ```

4. **Check Node version**
   ```bash
   node --version  # Should be 18+
   ```

## Notes

- **Deprecation warnings**: Some packages show deprecation warnings (e.g., eslint@8, glob@7). These are non-critical and don't affect functionality.
- **Peer dependencies**: Using package overrides to ensure compatibility.
- **Type safety**: Custom type definitions provided for Pear/Hyper modules that lack official types.

---

**Status**: ✅ All dependency issues resolved - Ready for development
