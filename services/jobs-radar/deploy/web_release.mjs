// Native Node + Git + SSH: frontend publishing does not need WSL or Docker.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stageLockedVendor} from './vendor_dependency.mjs';

export const files = ['board.css', 'board.js', 'index.html', 'manage/index.html'];
const maxFiles = 256;
const assetName = name => files.includes(name) || /^chunks\/[A-Za-z0-9_-]+\.(?:js|css|woff2?|svg|png|webp)$/.test(name);
export function websiteFiles(root) {
  const names = [...files];
  const chunks = path.join(root, 'chunks');
  if (fs.existsSync(chunks)) {
    if (fs.lstatSync(chunks).isSymbolicLink()) fail('Website chunks must not be links.');
    names.push(...fs.readdirSync(chunks).map(name => 'chunks/' + name));
  }
  if (names.length > maxFiles || names.some(name => !assetName(name))) fail('Unsupported website artifact member.');
  return names.sort();
}
const servicePath = 'services/jobs-radar';
const live = '/home/ubuntu/siyi/jobs-radar';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const read = file => fs.readFileSync(file);
// Git Bash also ships tar/ssh, whose POSIX path rules misread Windows drive paths.
const nativeTool = name => process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name === 'ssh' ? 'OpenSSH/ssh.exe' : name + '.exe')
  : name;

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {encoding: 'utf8', timeout: 180000,
    maxBuffer: 8 * 1024 * 1024, ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${program} failed: ${result.stderr || result.status}`);
  return result.stdout?.trim() || '';
}

function git(root, ...args) { return run('git', ['-C', root, ...args]); }

function archiveSource(info, destination) {
  const timestamp = git(info.root, 'show', '-s', '--format=%ct', info.commit);
  if (!/^[0-9]+$/.test(timestamp)) fail('Invalid website source timestamp.');
  git(info.root, 'archive', '--format=tar', '--mtime=@' + timestamp,
    '--output=' + destination, info.commit + ':' + servicePath);
}

export function committedInputs(context, names) {
  return Object.fromEntries(names.map(name => {
    const file = path.resolve(context, name);
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile())
      fail('Website test input changed or became a link.');
    return [name, hash(read(file))];
  }));
}

export function verifySourceArchive(folder, info, expected) {
  const archive = path.resolve(folder, 'source.tar');
  if (fs.realpathSync(archive) !== archive || !fs.lstatSync(archive).isFile()
      || hash(read(archive)) !== expected) fail('Website test source archive changed.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-web-source-'));
  try {
    const reference = path.join(temporary, 'source.tar');
    archiveSource(info, reference);
    if (hash(read(reference)) !== expected)
      fail('Website test receipt differs from the exact committed source.');
  } finally {
    fs.rmSync(temporary, {recursive: true});
  }
}

export function backendInput(name) {
  return ['pyproject.toml', 'requirements-lock.txt'].includes(name)
    || /^jobs_radar\/[^/]+\.(py|json)$/.test(name)
    || /^config\/[^/]+\.json$/.test(name)
    || /^contracts\/[^/]+\.js$/.test(name);
}

export function fingerprint(names, get) {
  return hash(names.filter(backendInput).sort().map(name =>
    name + ':' + hash(get(name).toString('utf8').replaceAll('\r\n', '\n'))).join('\n'));
}

function source() {
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel');
  if (git(root, 'status', '--porcelain', '--', servicePath))
    fail('Commit service and website changes before building or publishing.');
  const commit = git(root, 'rev-parse', 'HEAD');
  const tree = git(root, 'ls-tree', '-r', commit + ':' + servicePath).split('\n');
  const names = tree.map(line => {
    const match = line.match(/^(100644|100755) blob [a-f0-9]{40}\t(.+)$/);
    if (!match) fail('Only regular committed files may enter a website build.');
    const name = match[2];
    if (!/^[a-zA-Z0-9_./@+ -]+$/.test(name) || name.split('/').some(p =>
      ['..', 'data', '.git', '.qa', '.ssh', 'secrets', 'credentials', 'source-materials'].includes(p.toLowerCase()))
      || /(?:^|\/)\.env(?:\.|$)|\.sqlite|\.pem$|\.p12$|\.pfx$/i.test(name))
      fail('Private or unsupported build input: ' + name);
    return name;
  });
  // Use exact blob bytes for the compatibility fence (git() trims command text).
  const exactFingerprint = fingerprint(names, name => {
    const result = spawnSync('git', ['-C', root, 'show', commit + ':' + servicePath + '/' + name],
      {timeout: 10000, maxBuffer: 4 * 1024 * 1024});
    if (result.status !== 0) fail('Cannot read committed backend input.');
    return result.stdout;
  });
  return {root, commit, names, backendFingerprint: exactFingerprint};
}

export function packageWebsite(staticRoot, target, info) {
  fs.mkdirSync(target, {recursive: true});
  const tests = info.tests;
  if (!tests || tests.commit !== info.commit || !/^[a-f0-9]{64}$/.test(tests.sourceSha256 || '')
      || JSON.stringify(tests.checks) !== JSON.stringify(['website-tests', 'website-build', 'website-artifacts']))
    fail('Website release requires passing tests for this committed source.');
  const names = websiteFiles(staticRoot);
  const original = Object.fromEntries(names.map(name => [name, hash(read(path.join(staticRoot, name)))]));
  const id = hash(JSON.stringify({commit: info.commit, backend: info.backendFingerprint, tests, files: original})).slice(0, 32);
  const hashes = {};
  for (const name of names) {
    let data = read(path.join(staticRoot, name));
    if (name.endsWith('.html')) data = Buffer.from(data.toString('utf8').replace(
      /\/assets\/(?:[a-f0-9]+\/)?(board\.(?:js|css))(?:\?v=[a-f0-9]+)?/g, '/assets/' + id + '/$1'));
    const file = path.join(target, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, data);
    hashes[name] = hash(data);
  }
  const manifest = {format: 2, id, sourceCommit: info.commit,
    backendFingerprint: info.backendFingerprint, tests, files: hashes};
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  verifyBundle(target, info);
  return manifest;
}

export function verifyBundle(folder, info) {
  const manifest = JSON.parse(read(path.join(folder, 'manifest.json')));
  const names = Object.keys(manifest.files || {}).sort();
  if (manifest.format === 2 && (manifest.tests?.commit !== info.commit
      || !/^[a-f0-9]{64}$/.test(manifest.tests?.sourceSha256 || '')
      || JSON.stringify(manifest.tests?.checks) !== JSON.stringify(['website-tests', 'website-build', 'website-artifacts'])))
    fail('Website has no matching passing-test receipt.');
  if (![1, 2].includes(manifest.format) || !/^[a-f0-9]{32}$/.test(manifest.id)
      || manifest.sourceCommit !== info.commit || manifest.backendFingerprint !== info.backendFingerprint
      || names.length > maxFiles || files.some(name => !names.includes(name))
      || names.some(name => !assetName(name))
      || (manifest.format === 1 && names.length !== files.length))
    fail('Website artifact does not match this committed source.');
  for (const name of [...names, 'manifest.json']) {
    const file = path.resolve(folder, name);
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()
      || fs.statSync(file).size > 16 * 1024 * 1024 || fs.statSync(file).size === 0)
      fail('Unsafe website artifact file.');
    if (name !== 'manifest.json' && hash(read(file)) !== manifest.files[name])
      fail('Website artifact changed: ' + name);
  }
  const html = read(path.join(folder, 'index.html')).toString('utf8');
  if (html !== read(path.join(folder, 'manage/index.html')).toString('utf8')) fail('Website entries differ.');
  const refs = manifest.format === 1
    ? [...html.matchAll(/\/assets\/(board\.(?:js|css))\?v=([a-f0-9]+)/g)].map(m => [m[1], m[2]])
    : [...html.matchAll(/\/assets\/([a-f0-9]+)\/(board\.(?:js|css))/g)].map(m => [m[2], m[1]]);
  if (refs.length !== 2 || new Set(refs.map(m => m[0])).size !== 2 || refs.some(m => m[1] !== manifest.id))
    fail('Website asset references are not immutable.');
  return manifest;
}

function npm(cwd, ...args) {
  // Fixed arguments only; npm.cmd needs cmd.exe on Windows, no user input is interpolated.
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args,
    {cwd, shell: process.platform === 'win32', stdio: 'inherit', timeout: 600000});
}

export function build(info = source()) {
  const base = path.join(info.root, '.qa', 'web-releases');
  fs.mkdirSync(base, {recursive: true});
  const lock = path.join(base, 'build.lock');
  const fd = fs.openSync(lock, 'wx');
  const folder = path.join(base, info.commit.slice(0, 12) + '-' + randomUUID().slice(0, 8));
  const context = path.join(folder, 'context');
  try {
    fs.mkdirSync(context, {recursive: true});
    const archive = path.join(folder, 'source.tar');
    archiveSource(info, archive);
    run(nativeTool('tar'), ['-xf', archive, '-C', context]);
    const inputs = committedInputs(context, info.names);
    stageLockedVendor(info.root, context);
    const web = path.join(context, 'web');
    npm(web, 'ci', '--no-audit', '--no-fund');
    npm(web, 'test');
    npm(web, 'run', 'build');
    npm(web, 'run', 'test:build');
    if (JSON.stringify(inputs) !== JSON.stringify(committedInputs(context, info.names)))
      fail('Website committed source changed during validation.');
    packageWebsite(path.join(context, 'jobs_radar', 'static'), path.join(folder, 'bundle'),
      {...info, tests: {commit: info.commit, sourceSha256: hash(read(archive)),
        checks: ['website-tests', 'website-build', 'website-artifacts']}});
    // Only this operation's generated checkout is removed; retain source and bundle evidence.
    if (fs.realpathSync(context) !== path.resolve(context) || !context.startsWith(base + path.sep))
      fail('Unexpected build cleanup path.');
    fs.rmSync(context, {recursive: true});
    return folder;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function remote(action, extra = [], input) {
  const host = process.env.JOBS_RADAR_HOST || '';
  const key = process.env.JOBS_RADAR_KEY || path.join(os.homedir(), '.ssh', 'Siyi.pem');
  if (!host) fail('Set JOBS_RADAR_HOST for the authorized deployment destination.');
  if (!/^[a-zA-Z0-9_.@:-]+$/.test(host)) fail('Invalid release host.');
  let output;
  try { output = run(nativeTool('ssh'), ['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
    '-i', key, host, 'python3', live + '/deploy/web_release.py', action, ...extra],
    {input, timeout: 180000}); }
  catch (error) {
    if (error.message.includes('web_release.py') && error.message.includes('No such file'))
      fail('Enable independent website releases with one full service release first.');
    throw error;
  }
  return JSON.parse(output);
}

export function archiveWebsite(bundle, archive) {
  // macOS tar otherwise adds AppleDouble files for filesystem metadata.
  run(nativeTool('tar'), ['-cf', archive, '-C', bundle, 'manifest.json', ...Object.keys(JSON.parse(read(path.join(bundle, 'manifest.json'))).files).sort()],
    {env: {...process.env, COPYFILE_DISABLE: '1'}});
  return read(archive);
}

export function main(args) {
  const [mode, ...rest] = args;
  if (mode === '--web-status' || mode === '--rollback-web') {
    if (rest.length) fail('This command accepts no artifact.');
    console.log(JSON.stringify(remote(mode === '--web-status' ? 'status' : 'rollback'), null, 2));
    return;
  }
  if (!['--build-web', '--release-web'].includes(mode)) fail('Unknown website release mode.');
  if (rest.length && (mode !== '--release-web' || rest.length !== 2 || rest[0] !== '--artifact'))
    fail('Use --release-web [--artifact <directory>] or --build-web.');
  const info = source();
  if (mode === '--release-web') {
    const current = remote('status');
    if (!current.independent) fail('Enable independent website releases with one full service release first.');
    if (current.backendFingerprint !== info.backendFingerprint)
      fail('Backend differs from this source. Release the matching service first.');
  }
  const folder = rest.length ? path.resolve(rest[1]) : build(info);
  if (mode === '--build-web') { console.log(folder); return; }
  const bundle = path.join(folder, 'bundle');
  const manifest = verifyBundle(bundle, info);
  if (manifest.format === 2) verifySourceArchive(folder, info, manifest.tests.sourceSha256);
  const archive = path.join(folder, 'website.tar');
  const data = archiveWebsite(bundle, archive);
  const result = remote('activate', ['--sha256', hash(data)], data);
  if (result.active !== manifest.id) fail('Server did not activate the selected website.');
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
