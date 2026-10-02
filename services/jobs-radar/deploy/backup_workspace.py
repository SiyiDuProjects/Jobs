"""Preflight recovery archives; never send unresolved captures or credential containers.

This is not permission to transfer private materials. Opaque history and captured
evidence require separate content review; an incomplete plan never opens SSH.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import subprocess
import tarfile
import time
import uuid
from contextlib import contextmanager

TRANSFER_SECONDS = 300
TRANSFER_BYTES = 2 * 1024**3

SKIP_DIRS = {'.git', '.private', 'node_modules', '.venv', '.venv-v2', '.pytest_cache', '__pycache__', '.npm-cache', 'npm-cache', 'dist'}
REVIEW_DIRS = {'.qa', 'artifacts', 'reports', 'work'}
BROWSER_DIRS = {'user data', 'local storage', 'session storage', 'indexeddb', 'local extension settings', 'sync extension settings', 'sessionstore-backups'}
SKIP_NAMES = {'.git', '.npmrc', '.pypirc', '.netrc', 'private-connection.js', 'cookies', 'login data', 'web data', 'local state', 'preferences', 'secure preferences'}
OPAQUE_SUFFIXES = {'.bundle', '.zip', '.gz', '.tar', '.tgz', '.7z', '.rar', '.sqlite', '.sqlite3', '.db', '.ldb', '.docx', '.xlsx', '.pptx'}
SECRET_PATTERNS = [
    re.compile(rb'-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----'),
    re.compile(rb'\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b'),
    re.compile(rb'(?i)authorization["\x27]?\s*[:=]\s*["\x27]?\s*(?:bearer|basic)\s+[A-Za-z0-9_./+=-]{8,}'),
    re.compile(rb'(?i)["\x27](?:password|passwd|secret|token|api[_-]?key|access_token|refresh_token)["\x27]\s*:\s*["\x27][^"\x27\r\n]+["\x27]'),
    re.compile(rb'(?i)\b(?:password|passwd|secret|token|api[_-]?key|access_token|refresh_token)\s*=\s*["\x27][^"\x27\r\n]+["\x27]'),
]


def _sources(root, extra_roots):
    sources, labels = [], set()
    for label, path in [('', root), *extra_roots]:
        if label and (not re.fullmatch(r'[a-z0-9_-]+', label) or label in labels):
            raise ValueError('Unique simple retired-worktree labels are required')
        labels.add(label)
        path = Path(path)
        if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
            raise ValueError('Recovery roots may not be links')
        source = path.resolve(strict=True)
        if not source.is_dir():
            raise ValueError('Recovery roots must be directories')
        if any(source == old or source in old.parents or old in source.parents for old, _ in sources):
            raise ValueError('Recovery roots must not overlap')
        sources.append((source, 'retired-worktrees/' + label + '/' if label else ''))
    return sources


def _content_auditor():
    import importlib.util
    source = Path(__file__).with_name('audit_workspace.py')
    spec = importlib.util.spec_from_file_location('_recovery_auditor', source)
    auditor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(auditor)
    return auditor


def _reviewed_manifest(path):
    path = Path(path).resolve(strict=True)
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if manifest.get('version') != 1 or not isinstance(manifest.get('files'), list):
        raise ValueError('Invalid recovery review manifest')
    rows = {}
    for row in manifest['files']:
        name = row.get('path', '')
        item = PurePosixPath(name)
        if not name or item.is_absolute() or '..' in item.parts or '\\' in name or name in rows:
            raise ValueError('Invalid recovery review path')
        rows[name] = row
    return path, rows, _content_auditor()


def prepare(root, extra_roots=(), *, review_manifest=None):
    sources = _sources(root, extra_roots)
    reviewed = _reviewed_manifest(review_manifest) if review_manifest else None
    auditor = reviewed[2] if reviewed else _content_auditor()
    encountered = set()
    files, excluded = [], []
    def omit(path, reason, review=False):
        excluded.append({'path': path, 'reason': reason, 'requiresReview': review})
    def failed_walk(error):
        raise error
    for source, prefix in sources:
        for directory, dirs, names in os.walk(source, onerror=failed_walk):
            parent, kept = Path(directory), []
            for name in sorted(dirs):
                path = parent / name
                relative = prefix + path.relative_to(source).as_posix() + '/'
                lower = name.casefold()
                if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
                    omit(relative, 'linked-directory', True)
                elif lower in REVIEW_DIRS and not reviewed:
                    omit(relative, 'captured-evidence-or-history-needs-content-review', True)
                elif not reviewed and (lower in BROWSER_DIRS or lower == 'default' or re.fullmatch(r'profile \d+', lower)):
                    omit(relative, 'browser-storage-needs-content-review', True)
                elif lower in SKIP_DIRS or lower.startswith('.build-'):
                    omit(relative, 'credential-container-or-reproducible-output')
                else:
                    kept.append(name)
            dirs[:] = kept
            for name in sorted(names):
                path = parent / name
                relative, lower = prefix + path.relative_to(source).as_posix(), name.casefold()
                if lower == 'recovery-manifest.json' or relative.startswith('retired-worktrees/') and not prefix:
                    raise ValueError('Recovery archive reserved path collision')
                if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
                    omit(relative, 'non-regular-file', True)
                    continue
                if lower == '.env' or lower.startswith('.env.') or lower in SKIP_NAMES or lower.endswith(('.pem', '.key', '.p12', '.pfx')):
                    omit(relative, 'credential-file')
                    continue
                if reviewed:
                    manifest_path, review_rows, auditor = reviewed
                    if path.resolve() == manifest_path:
                        omit(relative, 'recovery-review-metadata')
                        continue
                    row = review_rows.get(relative)
                    encountered.add(relative)
                    if not row or row.get('status') != 'reviewed':
                        omit(relative, 'missing-or-unresolved-file-review', True)
                        continue
                    try:
                        data = auditor.read_file_bytes(path)
                    except (OSError, auditor.Unresolved):
                        omit(relative, 'unreadable-or-oversize-source', True)
                        continue
                    if row.get('size') != len(data) or row.get('sha256') != hashlib.sha256(data).hexdigest():
                        omit(relative, 'content-changed-since-review', True)
                        continue
                    # A hand-edited manifest is not a credential bypass. Re-run
                    # the supported nested scan on exactly the bytes being held.
                    current = auditor.audit_bytes(data, path.name)
                    if current['status'] != 'reviewed':
                        omit(relative, 'content-audit-no-longer-passes', True)
                        continue
                    files.append({'source': path, 'path': relative, 'size': len(data), 'sha256': row['sha256']})
                    continue
                if path.suffix.casefold() in OPAQUE_SUFFIXES or lower.endswith(('.db-wal', '.db-shm', '.sqlite-wal', '.sqlite-shm')):
                    omit(relative, 'opaque-archive-history-or-database-needs-content-review', True)
                    continue
                try:
                    data = auditor.read_file_bytes(path)
                except (OSError, auditor.Unresolved):
                    omit(relative, 'unreadable-or-oversize-source', True)
                    continue
                if any(pattern.search(data) for pattern in SECRET_PATTERNS):
                    omit(relative, 'possible-credential-content', True)
                    continue
                if auditor.audit_bytes(data, path.name)['status'] != 'reviewed':
                    omit(relative, 'content-needs-complete-review', True)
                    continue
                files.append({'source': path, 'path': relative, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    if reviewed:
        for missing in sorted(set(reviewed[1]) - encountered):
            omit(missing, 'reviewed-source-missing', True)
    return {'files': files, 'excluded': excluded}


def summary(plan):
    incomplete = [row for row in plan['excluded'] if row['requiresReview']]
    return {'files': len(plan['files']), 'bytes': sum(row['size'] for row in plan['files']), 'excluded': len(plan['excluded']), 'complete': not incomplete, 'incomplete': incomplete}


def archive(root, output, extra_roots=(), *, plan=None):
    plan = prepare(root, extra_roots) if plan is None else plan
    manifest = []
    with tarfile.open(fileobj=output, mode='w|gz', compresslevel=3) as tar:
        for row in plan['files']:
            # The stat in preflight is not a bound on a source that changes
            # while the stream is being constructed.
            with row['source'].open('rb') as source:
                data = source.read(row['size'] + 1)
            if len(data) != row['size'] or hashlib.sha256(data).hexdigest() != row['sha256']:
                raise ValueError('Recovery source changed after preflight')
            info = tarfile.TarInfo(row['path'])
            info.size, info.mode = len(data), 0o600
            tar.addfile(info, io.BytesIO(data))
            manifest.append({key: row[key] for key in ('path', 'size', 'sha256')})
        data = json.dumps({'version': 2, 'files': manifest, 'excluded': plan['excluded'], 'complete': summary(plan)['complete']}, ensure_ascii=False).encode()
        info = tarfile.TarInfo('RECOVERY-MANIFEST.json')
        info.size, info.mode = len(data), 0o600
        tar.addfile(info, io.BytesIO(data))
    return summary(plan)


def verify_archive(path, *, deadline=None, max_expanded=8 * 1024**3):
    import gzip
    import time
    import zlib
    deadline = deadline if deadline is not None else time.monotonic() + 300
    def remaining():
        if time.monotonic() >= deadline:
            raise TimeoutError('Recovery verification deadline exceeded')
    # GzipFile deliberately accepts concatenated members; recovery permits
    # exactly one gzip member and no bytes hidden after it.
    inflater, expanded = zlib.decompressobj(16 + zlib.MAX_WBITS), 0
    with Path(path).open('rb') as compressed:
        while block := compressed.read(65536):
            remaining()
            if inflater.eof:
                raise ValueError('Trailing recovery gzip member or data')
            try:
                while block:
                    plain = inflater.decompress(block, 1024 * 1024)
                    expanded += len(plain)
                    if expanded > max_expanded:
                        raise ValueError('Recovery expanded-byte limit exceeded')
                    remaining()
                    if inflater.unused_data:
                        raise ValueError('Trailing recovery gzip member or data')
                    block = inflater.unconsumed_tail
            except zlib.error:
                raise ValueError('Invalid recovery gzip checksum or stream') from None
    if not inflater.eof:
        raise ValueError('Truncated recovery gzip stream')
    with tarfile.open(path, mode='r:gz') as tar:
        members = []
        for member in tar:
            remaining()
            if len(members) >= 200001:
                raise ValueError('Recovery member limit exceeded')
            members.append(member)
        names = [item.name for item in members]
        if len(names) != len(set(names)) or names[-1:] != ['RECOVERY-MANIFEST.json']:
            raise ValueError('Incomplete recovery archive')
        for member in members:
            name = PurePosixPath(member.name)
            if not member.isfile() or name.is_absolute() or '..' in name.parts or '\\' in member.name:
                raise ValueError('Unsafe recovery member')
        if members[-1].size > 64 * 1024 * 1024:
            raise ValueError('Recovery manifest is too large')
        manifest = json.load(tar.extractfile(members[-1]))
        if manifest.get('version') != 2 or manifest.get('complete') is not True:
            raise ValueError('Recovery archive has unresolved exclusions')
        files = manifest['files']
        if [row['path'] for row in files] != names[:-1]:
            raise ValueError('Recovery manifest does not cover every file')
        total = 0
        for row, member in zip(files, members[:-1]):
            digest = hashlib.sha256()
            with tar.extractfile(member) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    remaining()
                    digest.update(block)
            if member.size != row['size'] or digest.hexdigest() != row['sha256']:
                raise ValueError('Recovery file checksum mismatch')
            total += member.size
        end = tar.offset
    # Tar readers stop at the first zero header. Everything after the last
    # manifested entry must be zero padding, even within the same gzip member.
    with gzip.open(path, 'rb') as compressed:
        compressed.seek(end)
        for block in iter(lambda: compressed.read(1024 * 1024), b''):
            remaining()
            if any(block):
                raise ValueError('Unmanifested data after recovery tar')
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            remaining()
            digest.update(block)
    return {'files': len(files), 'bytes': total, 'sha256': digest.hexdigest()}


def receive(destination, stream, *, timeout=300, max_bytes=2 * 1024**3):
    import tempfile
    import time
    import select
    if timeout <= 0 or max_bytes <= 0:
        raise ValueError('Positive recovery byte/time limits are required')
    deadline, received = time.monotonic() + timeout, 0
    destination = Path(destination)
    parent = destination.parent
    parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if parent.resolve() != parent or os.name == 'posix' and parent.stat().st_mode & 0o077:
        raise ValueError('Recovery destination must be a private real directory')
    if destination.exists() or destination.is_symlink():
        raise ValueError('Recovery destination already exists')
    descriptor, temporary = tempfile.mkstemp(prefix='.recovery-', suffix='.partial', dir=parent)
    try:
        with os.fdopen(descriptor, 'wb') as target:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Recovery receive deadline exceeded')
                if isinstance(stream, io.BytesIO):
                    block = stream.read(65536)
                else:
                    if os.name != 'posix':
                        raise ValueError('Streaming recovery receiver requires POSIX pipe deadlines')
                    descriptor_in = stream.fileno()
                    if not select.select([descriptor_in], [], [], remaining)[0]:
                        raise TimeoutError('Recovery receive deadline exceeded')
                    block = os.read(descriptor_in, 65536)
                if time.monotonic() >= deadline:
                    raise TimeoutError('Recovery receive deadline exceeded')
                if not block:
                    break
                received += len(block)
                if received > max_bytes:
                    raise ValueError('Recovery receive byte limit exceeded')
                target.write(block)
            target.flush()
            os.fsync(target.fileno())
        result = verify_archive(temporary, deadline=deadline)
        if time.monotonic() >= deadline:
            raise TimeoutError('Recovery receive deadline exceeded')
        os.link(temporary, destination)
        if os.name == 'posix':
            directory = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        return result
    finally:
        Path(temporary).unlink(missing_ok=True)


def receive_limited(destination, stream, *, memory_bytes=256 * 1024**2, cpu_seconds=30):
    """Dedicated Linux subprocess entry; these process limits are permanent."""
    import math
    import resource
    import signal
    import sys
    if sys.platform != 'linux':
        raise ValueError('Resource-limited recovery receiver requires Linux')
    if not 0 < memory_bytes <= 256 * 1024**2 or not 0 < cpu_seconds <= 30:
        raise ValueError('Recovery receiver resource budget cannot be raised')
    def tightened(kind, soft, hard):
        previous_soft, previous_hard = resource.getrlimit(kind)
        if previous_soft != resource.RLIM_INFINITY:
            soft = min(soft, previous_soft)
        if previous_hard != resource.RLIM_INFINITY:
            hard = min(hard, previous_hard)
        resource.setrlimit(kind, (min(soft, hard), hard))
    def cpu_exceeded(_signum, _frame):
        raise TimeoutError('Recovery receiver CPU budget exceeded')
    signal.signal(signal.SIGXCPU, cpu_exceeded)
    tightened(resource.RLIMIT_CORE, 0, 0)
    tightened(resource.RLIMIT_AS, memory_bytes, memory_bytes)
    used = resource.getrusage(resource.RUSAGE_SELF)
    deadline = math.ceil(used.ru_utime + used.ru_stime + cpu_seconds)
    tightened(resource.RLIMIT_CPU, deadline, deadline + 1)
    return receive(destination, stream)


def arguments(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--host', required=True)
    parser.add_argument('--key', type=Path, required=True)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--retired-worktree', action='append', default=[], metavar='LABEL=PATH')
    parser.add_argument('--review-manifest', type=Path)
    args = parser.parse_args(argv)
    if not re.fullmatch(r'(?:[A-Za-z0-9_.]+@)?[A-Za-z0-9][A-Za-z0-9.-]*', args.host):
        raise ValueError('Use a plain SSH host, optionally with a username')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+\.tar\.gz', args.destination) or '..' in args.destination.split('/') or str(PurePosixPath(args.destination).parent) == '/':
        raise ValueError('Use an absolute recovery archive inside a private directory')
    args.key = args.key.resolve(strict=True)
    if not args.key.is_file():
        raise ValueError('SSH identity must be a file')
    extra = []
    for item in args.retired_worktree:
        if '=' not in item or not all(item.split('=', 1)):
            raise ValueError('Use LABEL=PATH for retired worktrees')
        label, path = item.split('=', 1)
        extra.append((label, Path(path)))
    return args, extra


class DigestWriter:
    def __init__(self, stream, *, deadline=None, max_bytes=2 * 1024**3):
        self.stream, self.digest = stream, hashlib.sha256()
        self.deadline, self.max_bytes, self.written = deadline, max_bytes, 0
    def write(self, data):
        if self.deadline is not None and time.monotonic() >= self.deadline:
            raise TimeoutError('Recovery archive deadline exceeded')
        if self.written + len(data) > self.max_bytes:
            raise ValueError('Recovery archive byte limit exceeded')
        count = self.stream.write(data)
        if count != len(data):
            raise OSError('Incomplete recovery archive write')
        self.written += count
        self.digest.update(data)
        return count


def require_sender_environment():
    if os.name != 'posix' or 'microsoft' not in Path('/proc/version').read_text().lower():
        raise ValueError('Real recovery transfer requires WSL for verified process-group cleanup; local audit/archive remains available')


@contextmanager
def staged_archive(root, plan, *, deadline):
    import shutil
    root = Path(root).resolve(strict=True)
    stage = root / '.qa' / 'recovery-transfer'
    for path in (root / '.qa', stage):
        if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
            raise ValueError('Recovery staging directory may not be a link')
        path.mkdir(mode=0o700, exist_ok=True)
    if os.name == 'posix' and stage.stat().st_mode & 0o077:
        raise ValueError('Recovery staging directory must be private')
    if list(stage.iterdir()):
        raise ValueError('Previous recovery staging artifacts require review')
    manifest = [{key: row[key] for key in ('path', 'size', 'sha256')} for row in plan['files']]
    # Conservative incompressible upper bound, including tar headers/padding.
    estimate = sum(((row['size'] + 511) // 512 + 1) * 512 for row in plan['files'])
    estimate += len(json.dumps(manifest).encode()) + len(json.dumps(plan['excluded']).encode()) + 65536
    estimate += estimate // 1000 + 65536
    if estimate > TRANSFER_BYTES:
        raise ValueError('Recovery archive byte limit would be exceeded')
    if shutil.disk_usage(stage).free < estimate + 64 * 1024**2:
        raise ValueError('Insufficient free space for private recovery staging')
    token = uuid.uuid4().hex
    temporary, receipt = stage / (token + '.partial'), stage / (token + '.json')
    metadata = {'archive': temporary.relative_to(root).as_posix(), 'planSha256': hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()}
    def record():
        with receipt.open('w', encoding='utf-8') as target:
            json.dump(metadata, target)
            target.flush()
            os.fsync(target.fileno())
        if os.name == 'posix':
            directory = os.open(stage, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    descriptor = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    try:
        record()
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            writer = DigestWriter(output, deadline=deadline, max_bytes=TRANSFER_BYTES)
            archive(root, writer, plan=plan)
            output.flush()
            os.fsync(output.fileno())
        verified = verify_archive(temporary, deadline=deadline)
        if verified['sha256'] != writer.digest.hexdigest():
            raise ValueError('Private staged archive checksum changed')
        metadata['archiveSha256'] = verified['sha256']
        record()
        with temporary.open('rb') as stream:
            yield stream, verified
    finally:
        temporary.unlink(missing_ok=True)
        receipt.unlink(missing_ok=True)


def transfer(command, source, *, deadline, max_output=65536):
    """No parent pipe writes; bound SSH and drain both output streams together."""
    import queue
    import signal
    import threading
    if time.monotonic() >= deadline:
        raise TimeoutError('Recovery transfer deadline exceeded')
    child = subprocess.Popen(command, stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=os.name == 'posix')
    chunks, stopped = queue.Queue(maxsize=8), threading.Event()
    def read(index, pipe):
        while not stopped.is_set():
            block = pipe.read1(4096)
            while not stopped.is_set():
                try:
                    chunks.put((index, block), timeout=0.05)
                    break
                except queue.Full:
                    pass
            if not block:
                break
    readers = [threading.Thread(target=read, args=(index, pipe), daemon=True)
               for index, pipe in enumerate((child.stdout, child.stderr))]
    for reader in readers:
        reader.start()
    output, size, ended = [], 0, 0
    try:
        while ended < 2 or child.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Recovery transfer deadline exceeded')
            try:
                index, block = chunks.get(timeout=min(remaining, 0.05))
            except queue.Empty:
                continue
            if not block:
                ended += 1
                continue
            size += len(block)
            if size > max_output:
                raise ValueError('Recovery transfer output limit exceeded')
            if index == 0:
                output.append(block)
        if child.returncode != 0:
            raise RuntimeError('Recovery archive transfer or remote validation failed')
        return b''.join(output)
    except BaseException:
        if os.name == 'posix':
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        elif child.poll() is None:
            child.kill()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            if os.name == 'posix':
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                child.kill()
            child.wait(timeout=3)
        if os.name == 'posix':
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        raise
    finally:
        stopped.set()
        for reader in readers:
            reader.join(timeout=1)
        for reader, pipe in zip(readers, (child.stdout, child.stderr)):
            if not reader.is_alive():
                pipe.close()


def main(argv=None):
    args, extra = arguments(argv)
    plan = prepare(args.root, extra, review_manifest=args.review_manifest)
    result = summary(plan)
    if not result['complete']:
        print(json.dumps(result))
        raise ValueError('Recovery preflight is incomplete; no SSH connection was opened')
    require_sender_environment()
    deadline = time.monotonic() + TRANSFER_SECONDS
    import inspect
    remote = 'import os,io,json,hashlib,tarfile,sys\nfrom pathlib import Path,PurePosixPath\n' + inspect.getsource(verify_archive) + '\n' + inspect.getsource(receive) + '\n' + inspect.getsource(receive_limited)
    remote += '\ntry:\n print(json.dumps(receive_limited(sys.argv[1],sys.stdin.buffer)))\nexcept BaseException:\n print("Recovery validation failed",file=sys.stderr)\n sys.exit(1)\n'
    command = 'python3 -c ' + shlex.quote(remote) + ' ' + shlex.quote(args.destination)
    with staged_archive(args.root, plan, deadline=deadline) as (source, verified):
        stdout = transfer(['ssh', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', str(args.key), '--', args.host, command], source, deadline=deadline)
        received = json.loads(stdout)
        if received != verified or received['files'] != result['files'] or received['bytes'] != result['bytes']:
            raise RuntimeError('Recovery archive acknowledgement mismatch')
    print(json.dumps({**result, 'verified': True, 'sha256': received['sha256']}))


if __name__ == '__main__':
    main()
