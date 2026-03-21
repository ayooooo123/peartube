const IDENTITY_KEY_FILENAME = 'identity-key';
const IDENTITY_KEY_FILE_VERSION = 1;

let fs = null;
let path = null;

async function initModules() {
  if (fs && path) return;
  try { fs = (await import('bare-fs')).default || (await import('bare-fs')); } catch {}
  if (!fs) {
    try {
      const nodeFsName = 'node:' + 'fs';
      const mod = await import(nodeFsName);
      fs = mod.default || mod;
    } catch {}
  }
  try { path = (await import('bare-path')).default || (await import('bare-path')); } catch {}
  if (!path) {
    try {
      const nodePathName = 'node:' + 'path';
      const mod = await import(nodePathName);
      path = mod.default || mod;
    } catch {}
  }
}

function getIdentityKeyFilePath(storagePath) {
  if (!path || !storagePath) return null;
  return path.join(storagePath, IDENTITY_KEY_FILENAME);
}

function getLegacyIdentityKeyFilePath(storagePath) {
  if (!path || !storagePath) return null;
  return path.join(storagePath, 'db', IDENTITY_KEY_FILENAME);
}

function getIdentityKeyFileCandidates(storagePath) {
  const canonicalPath = getIdentityKeyFilePath(storagePath);
  const legacyPath = getLegacyIdentityKeyFilePath(storagePath);
  return [canonicalPath, legacyPath].filter(Boolean);
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
  await initModules();
  if (!fs) return null;

  for (const filePath of getIdentityKeyFileCandidates(storagePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.version !== IDENTITY_KEY_FILE_VERSION) continue;

      const primaryKey = parseHexKey(parsed.primaryKey);
      const identityPublicKey = parseHexKey(parsed.identityPublicKey);
      if (!primaryKey || !identityPublicKey) continue;

      return { primaryKey, identityPublicKey };
    } catch {}
  }

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
