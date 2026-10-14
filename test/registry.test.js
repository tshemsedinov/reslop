'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const zlib = require('node:zlib');

const registry = require('../lib/agents/registry.js');
const helperName = ['localharness', 'external'].join('_');
const installTest = [
  'registry install downloads, extracts',
  'and discovers Antigravity ACP',
].join(' ');
const unsafePathTest = [
  'registry zip extraction rejects a path',
  'outside its directory',
].join(' ');
const {
  REGISTRY_URL,
  platformTarget,
  installedRegistryAgent,
  registryEntry,
  extractZip,
  installRegistryAgent,
} = registry;

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const zipArchive = (files, method = 0) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const body = Buffer.from(text);
    const packed = method === 8 ? zlib.deflateRawSync(body) : body;
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + packed.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
};

const manifest = {
  agents: [
    {
      id: 'antigravity-acp',
      version: '1.3.0',
      distribution: {
        binary: {
          'linux-x86_64': {
            archive:
              'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip',
            cmd: './agy_acp_server.par',
            args: ['--uid='],
          },
        },
      },
    },
  ],
};

test('ACP registry selects the Antigravity binary for this platform', () => {
  assert.equal(platformTarget('linux', 'x64'), 'linux-x86_64');
  assert.equal(platformTarget('darwin', 'arm64'), 'darwin-aarch64');
  assert.equal(platformTarget('freebsd', 'x64'), '');
  assert.deepEqual(
    registryEntry(manifest, 'antigravity-acp', {
      platform: 'linux',
      arch: 'x64',
    }),
    {
      version: '1.3.0',
      archive:
        'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip',
      command: 'agy_acp_server.par',
      args: ['--uid='],
    },
  );
});

test(installTest, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-registry-'));
  const archive = zipArchive(
    {
      'agy_acp_server.par': 'hello',
      [helperName]: 'hello',
    },
    8,
  );
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    if (url === REGISTRY_URL) {
      return { ok: true, status: 200, json: async () => manifest };
    }
    return {
      ok: true,
      status: 200,
      body: Readable.toWeb(Readable.from(archive)),
    };
  };
  const env = { RESLOP_AGENTS_DIR: dir };
  const output = [];
  try {
    const installed = await installRegistryAgent('antigravity-acp', {
      fetch,
      env,
      platform: 'linux',
      arch: 'x64',
      log: (line) => output.push(line),
    });
    assert.deepEqual(installed.args, ['--uid=']);
    assert.equal(fs.readFileSync(installed.bin, 'utf8'), 'hello');
    const helper = path.join(path.dirname(installed.bin), helperName);
    assert.equal(fs.statSync(helper).isFile(), true);
    if (process.platform !== 'win32') {
      const bits = (file) => fs.statSync(file).mode & 0o111;
      assert.equal(bits(installed.bin), 0o111);
      assert.equal(bits(helper), 0o111);
    }
    assert.deepEqual(
      installedRegistryAgent('antigravity-acp', { env, platform: 'linux' }),
      installed,
    );
    assert.deepEqual(urls, [
      REGISTRY_URL,
      manifest.agents[0].distribution.binary['linux-x86_64'].archive,
    ]);
    assert.match(output.join('\n'), /Installed Google Antigravity ACP 1\.3\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Antigravity ACP installed by Zed is discovered', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-zed-'));
  const dir = path.join(
    home,
    '.local',
    'share',
    'zed',
    'external_agents',
    'registry',
    'antigravity-acp',
    'v_1.3.0_test',
  );
  const bin = path.join(dir, 'agy_acp_server.par');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bin, 'hello', { mode: 0o755 });
  try {
    assert.deepEqual(
      installedRegistryAgent('antigravity-acp', {
        env: { HOME: home },
        platform: 'linux',
      }),
      { bin, args: ['--uid='] },
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test(unsafePathTest, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reslop-registry-'));
  const archive = path.join(dir, 'bad.zip');
  const output = path.join(dir, 'out');
  fs.writeFileSync(archive, zipArchive({ '../outside': 'hello' }));
  fs.mkdirSync(output);
  try {
    await assert.rejects(
      extractZip(archive, output),
      /leaves install directory/,
    );
    assert.equal(fs.existsSync(path.join(dir, 'outside')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
