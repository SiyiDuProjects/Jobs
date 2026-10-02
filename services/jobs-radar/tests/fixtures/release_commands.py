"""Isolated command stand-ins for exercising the real release shell transaction.

No network, Docker daemon, system service or production path is accessed.
Database content is an opaque marker here; SQLite restoration is tested separately.
"""
import json
import hashlib
import os
from pathlib import Path
import shutil
import sys
import time

root = Path(os.environ['RELEASE_TEST_ROOT']).resolve()
state_path = root / 'state.json'
state = json.loads(state_path.read_text())
command, *args = sys.argv[1:]
state['calls'].append([command, *args])
image_prefix = os.environ.get('JOBS_RELEASE_IMAGE_PREFIX', 'jobs-radar')
for label in state['images'].values():
    state.setdefault('image_labels', {})['sha256:' + hashlib.sha256(label.encode()).hexdigest()] = label


def image_label(image):
    return state['images'].get(image) or state['image_labels'][image]


def local(value):
    path = Path(value).resolve()
    if not path.is_relative_to(root):
        raise ValueError('Test command escaped its sandbox')
    return path


def fail(name):
    if state.get('fail') == name and not state.get('failed'):
        state['failed'] = True
        raise RuntimeError('Injected ' + name)


def copy_code(source, destination):
    source, destination = local(source), local(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for path in destination.iterdir():
        if path.name == 'data' or path.name.startswith('.'):
            continue
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    for path in source.iterdir():
        if path.name == 'data' or path.name.startswith('.'):
            continue
        if path.is_dir():
            shutil.copytree(path, destination / path.name)
        else:
            shutil.copy2(path, destination / path.name)


def execute():
    live = root / 'live'
    data = live / 'data'
    flag = data / '.release-maintenance'
    if command == 'sudo':
        state['calls'].append(args)
        return
    if command == 'systemctl':
        if args[-1].endswith('.service'):
            fail('writer_unit_error')
            if state.get('fail') == 'writer_unit_unknown':
                print('unknown')
                raise SystemExit(4)
            print('inactive')
            raise SystemExit(3)
        print('active')
        return
    if command in {'flock', 'sleep'}:
        if command == 'flock' and state.get('busy_lock') == args[-1]:
            raise RuntimeError('Fixture lock is already held')
        return
    if command == 'curl':
        fail('public_verify')
        if state['active'] == 'bbbbbbbbbbbb':
            fail('health')
        return
    if command == 'tar':
        if args[0] == 'czf':
            archive = local(args[1])
            archive.write_text('archive marker')
            copy_code(live, Path(str(archive) + '.contents'))
        elif args[0] == 'xzf':
            copy_code(Path(str(local(args[1])) + '.contents'), local(args[3]))
        elif args[0] == '-xOf':
            print((Path(str(local(args[1])) + '.contents') / 'RELEASE').read_text())
        else:
            raise ValueError(args)
        return
    if command == 'rsync':
        copy_code(args[-2], args[-1])
        fail('code_copy')
        return
    if command != 'docker':
        raise ValueError(command)
    if args[0] == 'create':
        name = args[args.index('--name') + 1]
        container_id = hashlib.sha256(name.encode()).hexdigest()
        image_index = args.index('--entrypoint') + 2
        labels = dict([args[args.index('--label') + 1].split('=', 1)])
        state.setdefault('containers', {})[container_id] = dict(Id=container_id, Name='/' + name,
            Config={'Labels': labels}, image=args[image_index], payload=args[image_index + 1:])
        local(args[args.index('--cidfile') + 1]).write_text(container_id)
        print(container_id)
        return
    if args[0] == 'start':
        container = state['containers'][args[-1]]
        translated = ['run', '--entrypoint', 'python', container['image'], *container['payload']]
        if container['payload'][:3] == ['-m', 'jobs_radar.cli', 'serve']:
            translated[1:1] = ['--name', container['Name'][1:], '--network', 'none']
        args[:] = translated
    if args[0] == 'compose' and 'config' in args:
        print((root / 'compose.yaml').read_text())
        return
    if args[:2] == ['image', 'inspect']:
        label = image_label(args[2])
        if '--format' in args:
            print(state.get('image_ids', {}).get(args[2], 'sha256:' + hashlib.sha256(label.encode()).hexdigest()) if args[-1] == '{{.Id}}' else label)
    elif args[0] == 'tag':
        state['images'][args[2]] = image_label(args[1])
        if state.get('mutate_candidate_tag') and args[2] == image_prefix + ':aaaaaaaaaaaa':
            state['images'][image_prefix + ':bbbbbbbbbbbb'] = 'cccccccccccc'
    elif args[0] == 'ps':
        if '--filter' not in args:
            fail('writer_inventory')
        if '--filter' in args:
            query = args[args.index('--filter') + 1]
            for container in state.get('containers', {}).values():
                if query == 'name=^' + container['Name'] + '$' or query == 'id=' + container['Id']:
                    print(container['Id'])
        return
    elif args[0] == 'inspect':
        if '-f' in args:
            print('healthy' if 'Health' in args[2] else state['active'])
        else:
            print(json.dumps([container for container in state.get('containers', {}).values()
                              if args[1] in (container['Id'], container['Name'][1:])]))
    elif args[0] == 'rm':
        container = state.get('containers', {}).pop(args[-1], None)
        if container and container['payload'][:3] == ['-m', 'jobs_radar.cli', 'serve']:
            state.pop('probe', None)
    elif args[0] == 'exec':
        if state.get('probe') == 'bbbbbbbbbbbb' and 'for path' in args[-1]:
            fail('probe')
    elif args[:2] == ['compose', 'stop']:
        state['running'] = False
    elif args[:2] == ['compose', 'up']:
        state['running'] = True
        state['active'] = state['images'][image_prefix + ':0.1.0']
        if state.get('write_on_start') == state['active']:
            (data / 'jobs.sqlite').write_text('accepted owner write after public start')
            state['accepted_write'] = True
        if state.get('fail') == 'daemon_public_start' and not state.get('failed'):
            state['failed'] = True
            state_path.write_text(json.dumps(state))
            time.sleep(12)
            (data / 'late-daemon-cli-write').write_text('must not happen')
        fail('public_start')
    elif args[0] == 'run':
        image_index = args.index('--entrypoint') + 2
        image = args[image_index]
        payload = args[image_index + 1:]
        if '--name' in args:
            if '--network' not in args or args[args.index('--network') + 1] != 'none' or '-p' in args or '--publish' in args:
                raise ValueError('Probe exposed to a network')
            state['probe'] = image_label(image)
        elif payload[0] == '-c':
            script = payload[1]
            if 'release_compatibility' in script:
                print(state.get('schemas', {}).get(image_label(image), 'v2'))
            elif '.write_text' in script:
                if flag.exists():
                    raise ValueError('Existing pause')
                flag.write_text('paused')
            elif '.unlink' in script:
                flag.unlink()
            elif '.stat()' in script:
                fail('maintenance_check')
                if flag.exists():
                    raise ValueError('Maintenance remains active')
            else:
                raise ValueError(script)
        elif payload[0].endswith('verify_restore.py'):
            destination = data / payload[1].removeprefix('/data/')
            destination.parent.mkdir(parents=True, exist_ok=True)
            fail('backup')
            shutil.copyfile(data / 'jobs.sqlite', destination)
        elif payload[0].endswith('migrate_release.py'):
            if '--apply' in payload:
                (data / 'jobs.sqlite').write_text('new schema with preserved data')
                fail('apply')
            else:
                fail('dry_run')
        elif payload[0].endswith('restore_release.py'):
            if not flag.exists():
                raise ValueError('Restore without pause')
            shutil.copyfile(data / payload[1].removeprefix('/data/'), data / 'jobs.sqlite')
        else:
            raise ValueError(payload)
    else:
        raise ValueError(args)


try:
    execute()
except Exception as error:
    print(str(error), file=sys.stderr)
    code = 1
else:
    code = 0
finally:
    state_path.write_text(json.dumps(state))
sys.exit(code)
