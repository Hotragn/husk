#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pack the same tarballs a user installs. No workspace symlinks or dev tools go
// into the extension, and no global Node/npm installation is needed at runtime.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this with npm run bundle:mcpb.');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
await mkdir(join(root, 'build'), { recursive: true });
const stage = await mkdtemp(join(root, 'build', 'mcpb-'));
const packed = join(stage, 'tarballs');
const bundle = join(stage, 'extension');
await mkdir(packed);
await mkdir(join(bundle, 'server'), { recursive: true });
const tarballs = {};
for (const dir of await readdir(join(root, 'packages'))) {
  const pkg = JSON.parse(await readFile(join(root, 'packages', dir, 'package.json'), 'utf8'));
  if (pkg.private) continue;
  const { stdout } = await run(process.execPath, [npm, 'pack', '--json', '--pack-destination', packed], { cwd: join(root, 'packages', dir), maxBuffer: 8 * 1024 * 1024 });
  tarballs[pkg.name] = `file:${join(packed, JSON.parse(stdout)[0].filename).replaceAll('\\', '/')}`;
}
await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'husk-desktop-bundle', private: true, version, type: 'module', dependencies: { '@husk-ai/mcp': tarballs['@husk-ai/mcp'] }, overrides: tarballs }, null, 2));
console.log('Installing the packed production dependency graph…');
await run(process.execPath, [npm, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: bundle, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
// Runtime files are self-contained; do not ship local tarball paths or usernames.
await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'husk-desktop-bundle', private: true, version, type: 'module', dependencies: { '@husk-ai/mcp': version } }, null, 2));
await rm(join(bundle, 'package-lock.json'), { force: true });
await rm(join(bundle, 'node_modules', '.package-lock.json'), { force: true });
await writeFile(join(bundle, 'server', 'index.mjs'), "import '../node_modules/@husk-ai/mcp/dist/bin.js';\n");
const manifest = {
  manifest_version: '0.3', name: 'husk', display_name: 'Husk Workspaces', version,
  description: 'Keep sources and AI results in local workspaces you can reopen and download.',
  long_description: 'Create a named workspace, capture public web sources, ask Claude to synthesize a cited result, and download it. No Husk account, extra API key, Docker or terminal is required for workspace tasks. Computer tools are optional and require explicit enablement in the local viewer. Tool results are shared with your AI host. Public URLs are fetched directly from your device. Husk collects no product telemetry.',
  author: { name: 'Husk contributors', url: 'https://github.com/Hotragn/husk' },
  repository: { type: 'git', url: 'https://github.com/Hotragn/husk' },
  homepage: 'https://github.com/Hotragn/husk', support: 'https://github.com/Hotragn/husk/issues', license: 'Apache-2.0',
  server: { type: 'node', entry_point: 'server/index.mjs', mcp_config: { command: 'node', args: ['${__dirname}/server/index.mjs', '--profile', 'starter'] } },
  tools_generated: true,
  compatibility: { platforms: ['win32', 'darwin', 'linux'], runtimes: { node: '>=20.10.0' } },
};
await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await copyFile(join(root, 'LICENSE'), join(bundle, 'LICENSE'));
const packagerDir = join(root, 'node_modules', '@anthropic-ai', 'mcpb');
const packager = JSON.parse(await readFile(join(packagerDir, 'package.json'), 'utf8'));
const cli = join(packagerDir, typeof packager.bin === 'string' ? packager.bin : packager.bin.mcpb);
await run(process.execPath, [cli, 'validate', join(bundle, 'manifest.json')], { cwd: root });
const output = join(root, 'build', `husk-${version}.mcpb`);
const result = await run(process.execPath, [cli, 'pack', bundle, output], { cwd: root, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
console.log(result.stdout.trim());
const checksum = createHash('sha256').update(await readFile(output)).digest('hex');
await writeFile(`${output}.sha256`, `${checksum}  husk-${version}.mcpb\n`);
await writeFile(join(root, 'build', 'mcpb-build.json'), JSON.stringify({ version, output, entry: join(bundle, 'server', 'index.mjs'), bundle }, null, 2));
console.log(`Bundle: ${output}\nRun npm run smoke:starter -- --bundle to verify this exact package.`);
