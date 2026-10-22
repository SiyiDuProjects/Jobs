// One integrity-checked local dependency rule shared by service and web builds.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function stageLockedVendor(root, source) {
  const name = 'heroui-pro-react-1.0.0-beta.8.tgz';
  const relative = 'web/vendor/' + name;
  const expected = 'file:vendor/' + name;
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'web/package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(source, 'web/package-lock.json'), 'utf8'));
  const pinned = lock.packages?.['node_modules/@heroui-pro/react'];
  if (manifest.dependencies?.['@heroui-pro/react'] !== expected || pinned?.resolved !== expected
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pinned?.integrity || ''))
    throw new Error('Local website dependency must be pinned by the committed npm lock');
  const original = path.resolve(root, 'services/jobs-radar', relative);
  if (!fs.existsSync(original)) throw new Error('Restore the licensed website dependency at ' + original);
  if (fs.lstatSync(original).isSymbolicLink() || fs.lstatSync(path.dirname(original)).isSymbolicLink()
      || !fs.lstatSync(original).isFile() || fs.realpathSync(original) !== original)
    throw new Error('Local website dependency must not be a link');
  const descriptor = fs.openSync(original, 'r');
  let data;
  try {
    const size = fs.fstatSync(descriptor).size;
    if (size > 64 * 1024 * 1024 || size === 0) throw new Error('Local website dependency exceeds its size bound');
    data = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const count = fs.readSync(descriptor, data, read, size - read, null);
      if (!count) throw new Error('Local website dependency changed while reading');
      read += count;
    }
    if (fs.fstatSync(descriptor).size !== size) throw new Error('Local website dependency changed while reading');
  } finally { fs.closeSync(descriptor); }
  const actual = 'sha512-' + createHash('sha512').update(data).digest('base64');
  if (actual !== pinned.integrity)
    throw new Error('Local website dependency differs from the committed npm integrity');
  const target = path.join(source, relative);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, data);
  return {[relative]: actual};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Vendor staging requires repository and context directories');
    console.log(JSON.stringify(stageLockedVendor(...process.argv.slice(2))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
