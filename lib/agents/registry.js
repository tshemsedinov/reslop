'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const zlib = require('node:zlib');

const REGISTRY_URL =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const INSTALLERS = {
  'antigravity-acp': {
    host: 'dl.google.com',
    path: '/agy-extensions/releases/',
  },
};
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_TAIL = 65557;
const CENTRAL_LIMIT = 64 * 1024 * 1024;
const EXPANDED_LIMIT = 4 * 1024 * 1024 * 1024;

const platformTarget = (platform = process.platform, arch = process.arch) => {
  const osName = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[
    platform
  ];
  const archName = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  return osName && archName ? `${osName}-${archName}` : '';
};

const dataHome = (env = process.env, platform = process.platform) => {
  if (env.RESLOP_AGENTS_DIR) return path.resolve(env.RESLOP_AGENTS_DIR);
  const home = env.HOME || env.USERPROFILE;
  if (!home) return '';
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, 'reslop', 'agents');
  }
  if (platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'reslop',
      'agents',
    );
  }
  const base = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'reslop', 'agents');
};

const agentRoot = (id, options = {}) => {
  const base = dataHome(options.env, options.platform);
  return base ? path.join(base, id) : '';
};

const executable = (file, platform = process.platform) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    const unixHost = process.platform !== 'win32';
    const unixFile = platform !== 'win32';
    if (unixHost && unixFile) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const readReceipt = (id, options = {}) => {
  const root = agentRoot(id, options);
  if (!root) return null;
  try {
    const file = path.join(root, 'current.json');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bin = path.resolve(root, `${receipt.command ?? ''}`);
    if (!inside(root, bin) || !executable(bin, options.platform)) return null;
    return { bin, args: Array.isArray(receipt.args) ? receipt.args : [] };
  } catch {
    return null;
  }
};

const zedRoot = (id, options = {}) => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = env.HOME || env.USERPROFILE;
  if (!home) return '';
  let base;
  if (platform === 'win32') {
    base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  } else if (platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support');
  } else {
    base = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  }
  return path.join(base, 'zed', 'external_agents', 'registry', id);
};

const serverName = (platform = process.platform) =>
  platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par';

const registryArgs = (platform = process.platform) =>
  platform === 'linux' ? ['--uid='] : [];

const findBelow = (root, name, depth = 2) => {
  if (!root || depth < 0) return '';
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return '';
  }
  entries.sort((left, right) => right.name.localeCompare(left.name));
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name && executable(full)) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findBelow(path.join(root, entry.name), name, depth - 1);
    if (found) return found;
  }
  return '';
};

const installedRegistryAgent = (id, options = {}) => {
  const installed = readReceipt(id, options);
  if (installed) return installed;
  if (id !== 'antigravity-acp') return null;
  const platform = options.platform ?? process.platform;
  const bin = findBelow(zedRoot(id, options), serverName(platform));
  return bin ? { bin, args: registryArgs(platform) } : null;
};

const registryEntry = (manifest, id, options = {}) => {
  const installer = INSTALLERS[id];
  if (!installer) throw new Error(`unsupported registry agent ${id}`);
  const target = platformTarget(options.platform, options.arch);
  if (!target) throw new Error('platform is not supported');
  const agent = (manifest.agents ?? []).find((item) => item.id === id);
  if (!agent) throw new Error(`${id} is not in the ACP registry`);
  const binary = agent.distribution?.binary?.[target];
  if (!binary) throw new Error(`${id} is not available for ${target}`);
  const url = new URL(binary.archive);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== installer.host ||
    !url.pathname.startsWith(installer.path) ||
    !url.pathname.endsWith('.zip')
  ) {
    throw new Error(`unexpected archive for ${id}`);
  }
  const version = `${agent.version ?? ''}`;
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
    throw new Error(`invalid version for ${id}`);
  }
  const command = `${binary.cmd ?? ''}`.replace(/^\.\//, '');
  if (!command || path.isAbsolute(command) || command.includes('..')) {
    throw new Error(`invalid command for ${id}`);
  }
  return {
    version,
    archive: url.href,
    command,
    args: Array.isArray(binary.args) ? binary.args.map(String) : [],
  };
};

const readAt = async (handle, length, position) => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('truncated zip archive');
  return buffer;
};

const endOffset = (tail) => {
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) === ZIP_END) return at;
  }
  return -1;
};

const centralEntries = async (handle) => {
  const { size } = await handle.stat();
  const tailSize = Math.min(size, ZIP_TAIL);
  const tail = await readAt(handle, tailSize, size - tailSize);
  const at = endOffset(tail);
  if (at < 0) throw new Error('zip directory not found');
  const count = tail.readUInt16LE(at + 10);
  const centralSize = tail.readUInt32LE(at + 12);
  const centralAt = tail.readUInt32LE(at + 16);
  if (count === 0xffff || centralAt === 0xffffffff) {
    throw new Error('zip64 archives are not supported');
  }
  if (centralSize > CENTRAL_LIMIT || centralAt + centralSize > size) {
    throw new Error('invalid zip directory');
  }
  const data = await readAt(handle, centralSize, centralAt);
  const entries = [];
  let cursor = 0;
  let expanded = 0;
  while (cursor < data.length && entries.length < count) {
    if (data.readUInt32LE(cursor) !== ZIP_CENTRAL) {
      throw new Error('invalid zip entry');
    }
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > data.length) throw new Error('truncated zip entry');
    const name = data.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const entry = {
      flags: data.readUInt16LE(cursor + 8),
      method: data.readUInt16LE(cursor + 10),
      crc: data.readUInt32LE(cursor + 16),
      compressed: data.readUInt32LE(cursor + 20),
      size: data.readUInt32LE(cursor + 24),
      attrs: data.readUInt32LE(cursor + 38),
      offset: data.readUInt32LE(cursor + 42),
      name,
    };
    expanded += entry.size;
    if (expanded > EXPANDED_LIMIT) throw new Error('zip archive is too large');
    entries.push(entry);
    cursor = end;
  }
  if (entries.length !== count) throw new Error('incomplete zip directory');
  return entries;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crcStream = (size, name) => {
  let crc = 0xffffffff;
  let written = 0;
  const stream = new Transform({
    transform(chunk, encoding, done) {
      written += chunk.length;
      if (written > size) {
        done(new Error(`zip entry is too large ${name}`));
        return;
      }
      for (const byte of chunk) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      }
      done(null, chunk);
    },
  });
  stream.digest = () => (crc ^ 0xffffffff) >>> 0;
  return stream;
};

const outputPath = (root, name) => {
  if (!name || name.includes('\0')) throw new Error('invalid zip path');
  const normalized = name.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error('absolute zip path');
  }
  const file = path.resolve(root, normalized);
  if (!inside(root, file)) throw new Error('zip path leaves install directory');
  return file;
};

const extractEntry = async (archive, handle, root, entry) => {
  const file = outputPath(root, entry.name);
  if (entry.name.endsWith('/')) {
    await fs.promises.mkdir(file, { recursive: true });
    return;
  }
  const type = (entry.attrs >>> 16) & 0o170000;
  if (type === 0o120000) throw new Error('zip symlinks are not supported');
  if (entry.flags & 1) {
    throw new Error('encrypted zip entries are not supported');
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`unsupported zip compression ${entry.method}`);
  }
  const local = await readAt(handle, 30, entry.offset);
  if (local.readUInt32LE(0) !== ZIP_LOCAL) {
    throw new Error('invalid zip header');
  }
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const start = entry.offset + 30 + nameLength + extraLength;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  if (entry.compressed === 0) {
    if (entry.size !== 0 || entry.crc !== 0) {
      throw new Error(`corrupt zip entry ${entry.name}`);
    }
    await fs.promises.writeFile(file, '');
    return;
  }
  const source = fs.createReadStream(archive, {
    start,
    end: start + entry.compressed - 1,
  });
  const crc = crcStream(entry.size, entry.name);
  const output = fs.createWriteStream(file, { mode: 0o600 });
  if (entry.method === 8) {
    await pipeline(source, zlib.createInflateRaw(), crc, output);
  } else {
    await pipeline(source, crc, output);
  }
  const stat = await fs.promises.stat(file);
  if (stat.size !== entry.size || crc.digest() !== entry.crc) {
    throw new Error(`corrupt zip entry ${entry.name}`);
  }
};

const extractZip = async (archive, root) => {
  const handle = await fs.promises.open(archive, 'r');
  try {
    const entries = await centralEntries(handle);
    for (const entry of entries) {
      await extractEntry(archive, handle, root, entry);
    }
  } finally {
    await handle.close();
  }
};

const responseError = (response, label) => {
  if (response && response.ok) return;
  const status = response ? ` (${response.status})` : '';
  throw new Error(`${label} failed${status}`);
};

const download = async (url, file, fetchImpl) => {
  const response = await fetchImpl(url);
  responseError(response, 'download');
  if (!response.body) throw new Error('download returned no body');
  const source = Readable.fromWeb(response.body);
  await pipeline(source, fs.createWriteStream(file, { mode: 0o600 }));
};

const installRegistryAgent = async (id, options = {}) => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available');
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const log = options.log ?? (() => {});
  log('Checking the ACP registry…');
  const manifestResponse = await fetchImpl(REGISTRY_URL);
  responseError(manifestResponse, 'ACP registry');
  const entry = registryEntry(await manifestResponse.json(), id, {
    platform,
    arch,
  });
  const root = agentRoot(id, { env, platform });
  if (!root) throw new Error('cannot find the user data directory');
  const destination = path.join(root, entry.version);
  const command = path.join(destination, entry.command);
  if (!executable(command, platform)) {
    await fs.promises.mkdir(root, { recursive: true });
    const stage = await fs.promises.mkdtemp(path.join(root, '.install-'));
    try {
      const archive = path.join(stage, 'agent.zip');
      const expanded = path.join(stage, 'expanded');
      await fs.promises.mkdir(expanded);
      log(`Downloading Google Antigravity ACP ${entry.version}…`);
      await download(entry.archive, archive, fetchImpl);
      log('Extracting Google Antigravity ACP…');
      await extractZip(archive, expanded);
      const stagedCommand = path.join(expanded, entry.command);
      if (!fs.existsSync(stagedCommand)) {
        throw new Error('agent command is missing');
      }
      if (platform !== 'win32') {
        await fs.promises.chmod(stagedCommand, 0o755);
        const helper = path.join(
          path.dirname(stagedCommand),
          'localharness_external',
        );
        if (fs.existsSync(helper)) await fs.promises.chmod(helper, 0o755);
      }
      if (fs.existsSync(destination)) {
        await fs.promises.rm(destination, { recursive: true, force: true });
      }
      await fs.promises.rename(expanded, destination);
    } finally {
      await fs.promises.rm(stage, { recursive: true, force: true });
    }
  }
  const receipt = {
    version: entry.version,
    command: path.relative(root, command),
    args: entry.args,
  };
  const tempReceipt = path.join(root, `current-${process.pid}.json`);
  const currentReceipt = path.join(root, 'current.json');
  await fs.promises.writeFile(tempReceipt, `${JSON.stringify(receipt)}\n`);
  if (platform === 'win32') {
    await fs.promises.rm(currentReceipt, { force: true });
  }
  await fs.promises.rename(tempReceipt, currentReceipt);
  log(`Installed Google Antigravity ACP ${entry.version}\n`);
  return { bin: command, args: entry.args };
};

const main = async () => {
  const id = process.argv[2];
  try {
    await installRegistryAgent(id, {
      log: (line) => process.stdout.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
};

if (require.main === module) void main();

module.exports = {
  REGISTRY_URL,
  platformTarget,
  agentRoot,
  installedRegistryAgent,
  registryEntry,
  extractZip,
  installRegistryAgent,
};
