const IDENTITY_KEY_FILENAME = 'identity-key';
const IDENTITY_KEY_FILE_VERSION = 1;
const PRIMARY_KEY_FILENAME = 'primary-key';
const PRIMARY_KEY_FILE_VERSION = 1;

import {
  loadBareOrNodeFsModule,
  loadBareOrNodePathModule,
  resolveBareOrNodeFsModuleSync,
  resolveBareOrNodePathModuleSync,
} from './runtime-modules.js'

let fs = null;
let path = null;

function debugIdentityKeyFile(step, detail) {
  if (detail === undefined) {
    console.log(`[IdentityKeyFile] ${step}`)
    return
  }

  console.log(`[IdentityKeyFile] ${step}:`, detail)
}

async function initModules() {
  if (fs && path) return;
  debugIdentityKeyFile('initModules start')
  fs = resolveBareOrNodeFsModuleSync()
  path = resolveBareOrNodePathModuleSync()

  if (fs) {
    debugIdentityKeyFile('loaded bare-fs via sync require', true)
  } else {
    try {
      debugIdentityKeyFile('loading bare-fs fallback')
      fs = await loadBareOrNodeFsModule()
      debugIdentityKeyFile('loaded bare-fs fallback', Boolean(fs))
    } catch (error) {
      debugIdentityKeyFile('bare-fs unavailable', error?.message || String(error))
    }
  }

  if (path) {
    debugIdentityKeyFile('loaded bare-path via sync require', true)
  } else {
    try {
      debugIdentityKeyFile('loading bare-path fallback')
      path = await loadBareOrNodePathModule()
      debugIdentityKeyFile('loaded bare-path fallback', Boolean(path))
    } catch (error) {
      debugIdentityKeyFile('bare-path unavailable', error?.message || String(error))
    }
  }
  debugIdentityKeyFile('initModules complete')
}

function getIdentityKeyFilePath(storagePath) {
  if (!path || !storagePath) return null;
  return path.join(storagePath, IDENTITY_KEY_FILENAME);
}

function getLegacyIdentityKeyFilePath(storagePath) {
  if (!path || !storagePath) return null;
  return path.join(storagePath, 'db', IDENTITY_KEY_FILENAME);
}

function getPrimaryKeyFilePath(storagePath) {
  if (!path || !storagePath) return null;
  return path.join(storagePath, PRIMARY_KEY_FILENAME);
}

function hasCanonicalCorestore(storagePath) {
  if (!fs || !path || !storagePath) return false;

  try {
    const canonicalCorestorePath = path.join(storagePath, 'CORESTORE')
    debugIdentityKeyFile('checking canonical corestore', canonicalCorestorePath)
    const exists = fs.existsSync(canonicalCorestorePath)
    debugIdentityKeyFile('canonical corestore exists', exists)
    return exists
  } catch {
    debugIdentityKeyFile('canonical corestore exists check failed')
    return false;
  }
}

function getIdentityKeyFileCandidates(storagePath) {
  const canonicalPath = getIdentityKeyFilePath(storagePath);
  const candidates = canonicalPath ? [canonicalPath] : [];
  debugIdentityKeyFile('canonical identity candidate', canonicalPath)

  if (!hasCanonicalCorestore(storagePath)) {
    const legacyPath = getLegacyIdentityKeyFilePath(storagePath);
    if (legacyPath) candidates.push(legacyPath);
    debugIdentityKeyFile('legacy identity candidate', legacyPath)
  }

  debugIdentityKeyFile('identity candidates', candidates)

  return candidates;
}

function parseHexKey(value) {
  if (typeof value !== 'string') return null;
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) return null;

  try {
    const key = Buffer.from(value, 'hex');
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export async function identityKeyFileExists(storagePath) {
  await initModules();
  if (!fs) return false;

  try {
    return getIdentityKeyFileCandidates(storagePath).some((filePath) => fs.existsSync(filePath));
  } catch {
    return false;
  }
}

export async function readIdentityKeyFile(storagePath) {
  debugIdentityKeyFile('readIdentityKeyFile start', storagePath)
  await initModules();
  if (!fs) return null;

  for (const filePath of getIdentityKeyFileCandidates(storagePath)) {
    try {
      debugIdentityKeyFile('checking candidate', filePath)
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.version !== IDENTITY_KEY_FILE_VERSION) continue;

      const primaryKey = parseHexKey(parsed.primaryKey);
      const identityPublicKey = parseHexKey(parsed.identityPublicKey);
      if (!primaryKey || !identityPublicKey) continue;

      return { primaryKey, identityPublicKey };
    } catch {}
  }

  debugIdentityKeyFile('readIdentityKeyFile miss')
  return null;
}

export async function readPrimaryKeyFile(storagePath) {
  debugIdentityKeyFile('readPrimaryKeyFile start', storagePath)
  await initModules();
  if (!fs) return null;

  const filePath = getPrimaryKeyFilePath(storagePath);
  if (!filePath) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== PRIMARY_KEY_FILE_VERSION) return null;

    const primaryKey = parseHexKey(parsed.primaryKey);
    return primaryKey || null;
  } catch {}

  debugIdentityKeyFile('readPrimaryKeyFile miss')
  return null;
}

export async function writeIdentityKeyFile(storagePath, { primaryKey, identityPublicKey }) {
  await initModules();
  if (!fs || !path) {
    throw new Error('File system unavailable for identity key persistence');
  }

  const filePath = getIdentityKeyFilePath(storagePath);
  if (!filePath) {
    throw new Error('Invalid storage path for identity key persistence');
  }

  if (!Buffer.isBuffer(primaryKey) || primaryKey.length === 0) {
    throw new Error('primaryKey must be a non-empty Buffer');
  }
  if (!Buffer.isBuffer(identityPublicKey) || identityPublicKey.length === 0) {
    throw new Error('identityPublicKey must be a non-empty Buffer');
  }

  const tmpPath = `${filePath}.tmp`;
  const payload = {
    version: IDENTITY_KEY_FILE_VERSION,
    primaryKey: primaryKey.toString('hex'),
    identityPublicKey: identityPublicKey.toString('hex'),
    createdAt: Date.now()
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw error;
  }
}

export async function writePrimaryKeyFile(storagePath, primaryKey) {
  await initModules();
  if (!fs || !path) {
    throw new Error('File system unavailable for primary key persistence');
  }

  const filePath = getPrimaryKeyFilePath(storagePath);
  if (!filePath) {
    throw new Error('Invalid storage path for primary key persistence');
  }

  if (!Buffer.isBuffer(primaryKey) || primaryKey.length === 0) {
    throw new Error('primaryKey must be a non-empty Buffer');
  }

  const tmpPath = `${filePath}.tmp`;
  const payload = {
    version: PRIMARY_KEY_FILE_VERSION,
    primaryKey: primaryKey.toString('hex'),
    createdAt: Date.now()
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw error;
  }
}
