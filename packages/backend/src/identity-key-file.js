let fs = null;
let path = null;
try { fs = (await import('bare-fs')).default || (await import('bare-fs')); } catch {}
if (!fs) { try { fs = (await import('node:fs')).default || (await import('node:fs')); } catch {} }
try { path = (await import('bare-path')).default || (await import('bare-path')); } catch {}
if (!path) { try { path = (await import('node:path')).default || (await import('node:path')); } catch {} }

const IDENTITY_KEY_FILENAME = 'identity-key';
const IDENTITY_KEY_FILE_VERSION = 1;

function getIdentityKeyFilePath(storagePath) {
  if (!path || !storagePath) return null;
  return path.join(storagePath, IDENTITY_KEY_FILENAME);
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

export function identityKeyFileExists(storagePath) {
  if (!fs) return false;
  const filePath = getIdentityKeyFilePath(storagePath);
  if (!filePath) return false;

  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function readIdentityKeyFile(storagePath) {
  if (!fs) return null;
  const filePath = getIdentityKeyFilePath(storagePath);
  if (!filePath) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== IDENTITY_KEY_FILE_VERSION) return null;

    const primaryKey = parseHexKey(parsed.primaryKey);
    const identityPublicKey = parseHexKey(parsed.identityPublicKey);
    if (!primaryKey || !identityPublicKey) return null;

    return { primaryKey, identityPublicKey };
  } catch {
    return null;
  }
}

export function writeIdentityKeyFile(storagePath, { primaryKey, identityPublicKey }) {
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
