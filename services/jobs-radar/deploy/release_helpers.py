"""Bounded, attributable containers used only by release/rehearsal tooling.

The ledger is written before creation. Cleanup checks the full ID, exact name
and random ownership label, including a create whose client was interrupted.
No prefix search or removal of an unrecorded container is permitted.
"""
import argparse
import json
import os
from pathlib import Path
import re
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid


LABEL = 'jobs.release.operation'


class OutputLimitExceeded(RuntimeError):
    pass


class CreationPending(RuntimeError):
    """The daemon may still complete a create whose client lost its receipt."""


def bounded(args, *, env=None, timeout=180, max_output_bytes=1024 * 1024):
    """Limit combined output and stop the entire Linux CLI group on failure."""
    if not 0 < max_output_bytes <= 1024 * 1024:
        raise ValueError('Output budget must be between 1 byte and 1 MiB')
    process = subprocess.Popen([str(arg) for arg in args], env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=os.name == 'posix')
    chunks = queue.Queue(maxsize=8)
    stopped = threading.Event()
    def read_stream(index, pipe):
        while not stopped.is_set():
            data = pipe.read1(16384)
            while not stopped.is_set():
                try:
                    chunks.put((index, data), timeout=0.05)
                    break
                except queue.Full:
                    continue
            if not data:
                return
    readers = [threading.Thread(target=read_stream, args=(index, pipe), daemon=True)
               for index, pipe in enumerate((process.stdout, process.stderr))]
    for reader in readers:
        reader.start()
    output, consumed, ended = [[], []], 0, 0
    deadline = time.monotonic() + timeout
    try:
        while ended < 2 or process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(args, timeout)
            try:
                index, data = chunks.get(timeout=min(remaining, 0.05))
            except queue.Empty:
                continue
            if not data:
                ended += 1
                continue
            consumed += len(data)
            if consumed > max_output_bytes:
                raise OutputLimitExceeded('Release command exceeded its combined output budget')
            output[index].append(data)
    except BaseException:
        stopped.set()
        if os.name == 'posix':
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        else:
            if process.poll() is None:
                process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if os.name == 'posix':
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
            process.wait(timeout=5)
        if os.name == 'posix':
            # A descendant can close its pipes and ignore TERM after its parent
            # exits, so successful communicate alone does not end the group.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        raise
    finally:
        stopped.set()
        for reader in readers:
            reader.join(timeout=1)
        for reader, pipe in zip(readers, (process.stdout, process.stderr)):
            if not reader.is_alive():
                pipe.close()
    def decoded(parts):
        return b''.join(parts).decode('utf-8', errors='replace').replace('\r\n', '\n').replace('\r', '\n')
    return subprocess.CompletedProcess(args, process.returncode, decoded(output[0]), decoded(output[1]))


class Containers:
    def __init__(self, state, namespace, docker='docker', invoke=None):
        if not re.fullmatch(r'jobs-radar(?:-rehearsal-[a-f0-9]{12,32})?', namespace):
            raise ValueError('Invalid release container namespace')
        self.state = Path(state).resolve()
        self.namespace, self.docker, self.invoke = namespace, docker, invoke or bounded
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)

    def call(self, args, *, timeout=30, check=True):
        result = self.invoke([self.docker, *args], timeout=timeout)
        if check and result.returncode:
            raise RuntimeError('Release container command failed: ' + result.stderr.strip())
        return result

    def save(self, path, value):
        temporary = path.with_suffix('.pending')
        with temporary.open('w', encoding='utf-8') as destination:
            json.dump(value, destination)
            destination.flush()
            os.fsync(destination.fileno())
        temporary.replace(path)
        self.sync_directory()

    def sync_directory(self):
        if os.name == 'posix':
            descriptor = os.open(self.state, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    def new_plan(self, path, plan):
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as destination:
            json.dump(plan, destination)
            destination.flush()
            os.fsync(destination.fileno())
        self.sync_directory()

    def inspect_owned(self, path, plan):
        # List by the exact recorded name so daemon failure remains distinct
        # from confirmed absence. Inspect errors never mean safe absence.
        target = plan.get('id') or plan['name']
        query = 'id=' + plan['id'] if plan.get('id') else 'name=^/' + plan['name'] + '$'
        listed = self.call(['ps', '-a', '--filter', query, '--format', '{{.ID}}'])
        if not listed.stdout.strip():
            return None
        info = json.loads(self.call(['inspect', target]).stdout)[0]
        if (info['Name'] != '/' + plan['name']
                or info['Config'].get('Labels', {}).get(LABEL) != plan['operation']
                or plan.get('id') and plan['id'] != info['Id']):
            raise ValueError('Release container ownership changed; refused cleanup')
        cidfile = Path(plan['cidfile'])
        if cidfile.exists() and cidfile.read_text().strip() != info['Id']:
            raise ValueError('Release container ID differs from its creation receipt')
        if not plan.get('id'):
            plan['id'] = info['Id']
            plan['creation'] = 'known'
            self.save(path, plan)
        return info

    def remove(self, path):
        plan = json.loads(path.read_text())
        if plan['namespace'] != self.namespace or not plan['name'].startswith(self.namespace + '-'):
            raise ValueError('Release container ledger escaped its namespace')
        if plan.get('removed') and plan.get('id'):
            return
        info = self.inspect_owned(path, plan)
        if info is not None:
            self.call(['rm', '-f', info['Id']])
        elif not plan.get('id'):
            # A successful empty list is only a point-in-time observation. A
            # timed-out create may still be running inside the Docker daemon.
            # This also repairs old receipts marked removed without an ID.
            plan.update(creation='pending', removed=False)
            self.save(path, plan)
            raise CreationPending('Container creation remains unresolved: ' + plan['name'])
        plan['removed'] = True
        self.save(path, plan)

    def cleanup(self, name=None):
        errors = []
        for path in sorted(self.state.glob('*.json')):
            try:
                plan = json.loads(path.read_text())
                if name is not None and plan['name'] != name:
                    continue
                self.remove(path)
            except Exception as error:
                errors.append(type(error).__name__ + ': ' + str(error))
        if errors:
            raise RuntimeError('Some release containers remain for review: ' + '; '.join(errors))

    def track_name(self, name, operation):
        """Record an owned Compose create before invoking its CLI."""
        if not name.startswith(self.namespace + '-') or operation != self.namespace:
            raise ValueError('External container escaped rehearsal ownership')
        entry = uuid.uuid4().hex
        path = self.state / (entry + '.json')
        plan = dict(operation=operation, namespace=self.namespace, name=name,
                    cidfile=str(self.state / (entry + '.cid')), phase='other', creation='pending', removed=False)
        self.new_plan(path, plan)
        return path

    def clone_stopped(self, image):
        """An owned, never-started image clone for code export/variant commit."""
        if not image.startswith(self.namespace + ':'):
            raise ValueError('Image escaped release namespace')
        operation = uuid.uuid4().hex
        path = self.state / (operation + '.json')
        plan = dict(operation=operation, namespace=self.namespace,
                    name=self.namespace + '-release-export-' + operation,
                    cidfile=str(self.state / (operation + '.cid')), phase='other', creation='pending', removed=False)
        self.new_plan(path, plan)
        try:
            result = self.call(['create', '--name', plan['name'], '--label', LABEL + '=' + operation,
                '--cidfile', plan['cidfile'], '--network', 'none', '--memory', '512m', '--memory-swap', '512m',
                '--cpus', '0.5', '--pids-limit', '128', image])
            plan['id'] = result.stdout.strip()
            if not re.fullmatch('[a-f0-9]{64}', plan['id']):
                raise ValueError('Docker did not return a full container ID')
            plan['creation'] = 'known'
            self.save(path, plan)
            return path, plan['id']
        except BaseException:
            self.remove(path)
            raise

    def start(self, image, args, *, mounts=(), environment=(), memory=512, name=None, detached=False, timeout=300, user='10001:10001', image_id=None):
        if memory not in {512, 768} or user not in {'10001:10001', '0:0'} or not image.startswith(self.namespace + ':'):
            raise ValueError('Invalid helper image/resource budget')
        if image_id is not None and not re.fullmatch('sha256:[a-f0-9]{64}', image_id):
            raise ValueError('Invalid immutable helper image ID')
        operation = uuid.uuid4().hex
        name = name or self.namespace + '-release-helper-' + operation
        if not re.fullmatch(re.escape(self.namespace) + r'-[a-zA-Z0-9-]+', name):
            raise ValueError('Invalid helper container name')
        path = self.state / (operation + '.json')
        phase = ('backup' if any(value.endswith('/verify_restore.py') for value in args)
                 else ('apply' if '--apply' in args else 'dry_run')
                 if any(value.endswith('/migrate_release.py') for value in args) else 'other')
        plan = dict(operation=operation, namespace=self.namespace, name=name,
                    cidfile=str(self.state / (operation + '.cid')), phase=phase, creation='pending', removed=False)
        if image_id:
            plan['image'] = image_id
        self.new_plan(path, plan)
        command = ['create', '--name', name, '--label', LABEL + '=' + operation, '--cidfile', plan['cidfile'],
                   '--network', 'none', '--user', user, '--read-only',
                   '--tmpfs', '/tmp:size=32m,mode=1777', '--memory', str(memory) + 'm',
                   '--memory-swap', str(memory) + 'm', '--cpus', '0.5', '--pids-limit', '128']
        for mount in mounts:
            command += ['-v', str(mount)]
        for value in environment:
            command += ['-e', value]
        command += ['--entrypoint', 'python', image_id or image, *args]
        retained = False
        try:
            result = self.call(command)
            plan['id'] = result.stdout.strip()
            if not re.fullmatch('[a-f0-9]{64}', plan['id']):
                raise ValueError('Docker did not return a full container ID')
            plan['creation'] = 'known'
            self.save(path, plan)
            result = self.call(['start', *([] if detached else ['-a']), plan['id']], timeout=timeout, check=False)
            if result.returncode:
                raise RuntimeError('Release helper failed: ' + result.stderr.strip())
            retained = detached
            return result
        finally:
            if not retained:
                self.remove(path)


def main():
    os.umask(0o077)
    if sys.argv[1:2] == ['docker-command']:
        parser = argparse.ArgumentParser(description='Bound a Docker daemon command and its output')
        parser.add_argument('--timeout', type=float, default=30)
        parser.add_argument('args', nargs=argparse.REMAINDER)
        options = parser.parse_args(sys.argv[2:])
        if not 0 < options.timeout <= 180:
            parser.error('Docker command deadline must be at most 180 seconds')
        args = options.args[1:] if options.args[:1] == ['--'] else options.args
        if not args:
            parser.error('A Docker command is required')
        result = bounded(['docker', *args], timeout=options.timeout)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        raise SystemExit(result.returncode)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--namespace', required=True)
    parser.add_argument('--docker', default='docker')
    commands = parser.add_subparsers(dest='mode', required=True)
    cleanup = commands.add_parser('cleanup')
    cleanup.add_argument('--name')
    for mode in ('run', 'start'):
        child = commands.add_parser(mode)
        child.add_argument('--image', required=True)
        child.add_argument('--image-id')
        child.add_argument('--name')
        child.add_argument('--memory', type=int, choices=(512, 768), default=512)
        child.add_argument('--mount', action='append', default=[])
        child.add_argument('--env', action='append', default=[])
        child.add_argument('args', nargs=argparse.REMAINDER)
    options = parser.parse_args()
    containers = Containers(options.state, options.namespace, options.docker)
    if options.mode == 'cleanup':
        containers.cleanup(options.name)
    else:
        result = containers.start(options.image, options.args[1:] if options.args[:1] == ['--'] else options.args,
            mounts=options.mount, environment=options.env, memory=options.memory, name=options.name,
            detached=options.mode == 'start', image_id=options.image_id)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)


if __name__ == '__main__':
    if os.name == 'posix':
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(InterruptedError('Release helper interrupted')))
    main()
