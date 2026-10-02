// Native Node + Git + SSH: frontend publishing does not need WSL or Docker.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const files = ['board.css', 'board.js', 'index.html', 'manage/index.html'];
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
  const original = Object.fromEntries(files.map(name => [name, hash(read(path.join(staticRoot, name)))]));
  const id = hash(JSON.stringify({commit: info.commit, backend: info.backendFingerprint, files: original})).slice(0, 32);
  const hashes = {};
  for (const name of files) {
    let data = read(path.join(staticRoot, name));
    if (name.endsWith('.html')) data = Buffer.from(data.toString('utf8').replace(
      /(\/assets\/board\.(?:js|css))\?v=[a-f0-9]+/g, '$1?v=' + id));
    const file = path.join(target, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, data);
    hashes[name] = hash(data);
  }
  const manifest = {format: 1, id, sourceCommit: info.commit,
    backendFingerprint: info.backendFingerprint, files: hashes};
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  verifyBundle(target, info);
  return manifest;
}

export function verifyBundle(folder, info) {
  const manifest = JSON.parse(read(path.join(folder, 'manifest.json')));
  if (manifest.format !== 1 || !/^[a-f0-9]{32}$/.test(manifest.id)
      || manifest.sourceCommit !== info.commit || manifest.backendFingerprint !== info.backendFingerprint
      || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...files].sort()))
    fail('Website artifact does not match this committed source.');
  for (const name of [...files, 'manifest.json']) {
    const file = path.resolve(folder, name);
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()
      || fs.statSync(file).size > 16 * 1024 * 1024 || fs.statSync(file).size === 0)
      fail('Unsafe website artifact file.');
    if (name !== 'manifest.json' && hash(read(file)) !== manifest.files[name])
      fail('Website artifact changed: ' + name);
  }
  const html = read(path.join(folder, 'index.html')).toString('utf8');
  if (html !== read(path.join(folder, 'manage/index.html')).toString('utf8')) fail('Website entries differ.');
  const refs = [...html.matchAll(/\/assets\/(board\.(?:js|css))\?v=([a-f0-9]+)/g)];
  if (refs.length !== 2 || new Set(refs.map(m => m[1])).size !== 2 || refs.some(m => m[2] !== manifest.id))
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
    const timestamp = git(info.root, 'show', '-s', '--format=%ct', info.commit);
    git(info.root, 'archive', '--format=tar', '--mtime=@' + timestamp,
      '--output=' + archive, info.commit + ':' + servicePath);
    run(nativeTool('tar'), ['-xf', archive, '-C', context]);
    const web = path.join(context, 'web');
    npm(web, 'ci', '--no-audit', '--no-fund');
    npm(web, 'test');
    npm(web, 'run', 'build');
    npm(web, 'run', 'test:build');
    packageWebsite(path.join(context, 'jobs_radar', 'static'), path.join(folder, 'bundle'), info);
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
  const host = process.env.JOBS_RADAR_HOST || 'ubuntu@49.51.38.235';
  const key = process.env.JOBS_RADAR_KEY || path.join(os.homedir(), '.ssh', 'Siyi.pem');
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
  const archive = path.join(folder, 'website.tar');
  run(nativeTool('tar'), ['-cf', archive, '-C', bundle, 'manifest.json', ...files]);
  const data = read(archive);
  const result = remote('activate', ['--sha256', hash(data)], data);
  if (result.active !== manifest.id) fail('Server did not activate the selected website.');
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
