"""One-shot fault injection; all nonfailed Docker/rsync operations are real.

Installed only in a random rehearsal's private PATH. It refuses production tag
destinations, containers and filesystem paths before invoking the real binary.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

from release_helpers import Containers, bounded


def verify_resources(info):
    host = info['HostConfig']
    if (host.get('Memory') != 512 * 1024**2 or host.get('MemorySwap') != 512 * 1024**2 or
            host.get('NanoCpus') != 500000000 or host.get('PidsLimit') != 128 or
            host.get('NetworkMode') != 'none' or host.get('PortBindings')):
        raise ValueError('Actual rehearsal container resources/network differ')


def inspect_budget(invoke, docker, container, *, timeout=20):
    result = invoke([docker, 'inspect', container], timeout=timeout)
    if result.returncode: raise RuntimeError('Cannot verify rehearsal container resources')
    info = json.loads(result.stdout)[0]
    if info['Id'] != container: raise ValueError('Rehearsal container ID changed')
    verify_resources(info)
    return info


def execute(command, args, environment=None):
    env = environment or os.environ
    root = Path(env['JOBS_RELEASE_REHEARSAL_ROOT']).resolve(strict=True)
    namespace = env['JOBS_RELEASE_IMAGE_PREFIX']
    suffix = root.name.removeprefix('rehearsal-')
    if root.parent.name != 'jobs-radar-stage' or namespace != 'jobs-radar-rehearsal-' + suffix:
        raise ValueError('Invalid rehearsal namespace')
    if command == 'docker':
        if not args or args[0] not in {'tag', 'image', 'inspect', 'ps', 'exec', 'rm', 'run', 'create', 'start', 'compose'}:
            raise ValueError('Unsupported Docker operation in rehearsal')
        if args[0] == 'image' and args[1:2] != ['inspect']:
            raise ValueError('Only image inspection is supported here')
        if args[:1] == ['tag'] and not args[-1].startswith(namespace + ':'):
            raise ValueError('Cannot change a non-rehearsal image tag')
        if args[:1] in (['exec'], ['rm'], ['start']):
            names = [args[1]] if args[0] == 'exec' else [name for name in args[1:] if not name.startswith('-')]
            owned_ids = {value.get('id') for folder in ('containers', 'service-containers')
                         for file in (root / folder).glob('*.json')
                         if (value := json.loads(file.read_text())).get('namespace') == namespace}
            if not names or any(not name.startswith(namespace + '-') and name not in owned_ids for name in names):
                raise ValueError('Cannot target a non-rehearsal container')
        if args[:1] in (['run'], ['create']):
            if ('--network' not in args or args[args.index('--network') + 1] != 'none'
                    or any(value in args for value in ('--privileged', '--mount', '--volumes-from', '-p', '--publish', '--network=host'))):
                raise ValueError('Docker run escaped isolated network/mount policy')
            image_index = args.index('--entrypoint') + 2
            # Only tighten the known production migration-helper request.
            # Reject inconsistent or unexpected resource flags; never silently
            # repair them and pretend that the production driver passed.
            def option(flag):
                if args.count(flag) != 1 or args.index(flag) + 1 >= len(args):
                    raise ValueError('Missing or duplicate rehearsal resource flag')
                return args[args.index(flag) + 1]
            memory, swap = option('--memory'), option('--memory-swap')
            if (memory, swap) not in {('512m', '512m'), ('768m', '768m')} or option('--cpus') != '0.5' or option('--pids-limit') != '128':
                raise ValueError('Unexpected rehearsal resource request')
            if memory == '768m':
                args = list(args)
                args[args.index('--memory') + 1] = '512m'
                args[args.index('--memory-swap') + 1] = '512m'
            pinned = any(value.get('namespace') == namespace and value.get('image') == args[image_index]
                         and '--name' in args and value.get('name') == args[args.index('--name') + 1]
                         for file in (root / 'containers').glob('*.json')
                         if (value := json.loads(file.read_text())))
            if not args[image_index].startswith(namespace + ':') and not pinned:
                raise ValueError('Cannot run a non-rehearsal image')
            for index, arg in enumerate(args):
                if arg == '-v' and not Path(args[index+1].split(':')[0]).resolve().is_relative_to(root):
                    raise ValueError('Docker mount escaped rehearsal root')
    elif command == 'rsync':
        if any(not Path(path).resolve().is_relative_to(root) for path in args[-2:]):
            raise ValueError('Rsync escaped rehearsal root')
    else:
        raise ValueError('Unsupported rehearsal wrapper')
    state_file = root / 'fault.json'
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    point = None
    if command == 'docker' and args[:1] == ['start']:
        inspect_budget(bounded, env['REHEARSAL_REAL_DOCKER'], args[-1])
        phase = next((value['phase'] for file in (root / 'containers').glob('*.json')
                      if (value := json.loads(file.read_text())).get('id') == args[-1]), None)
        point = phase if phase in {'backup', 'dry_run', 'apply'} else None
    elif command == 'docker' and args[:1] == ['run']:
        if any(value.endswith('/verify_restore.py') for value in args):
            point = 'backup'
        elif any(value.endswith('/migrate_release.py') for value in args):
            point = 'apply' if '--apply' in args else 'dry_run'
    elif command == 'rsync':
        point = 'code_copy'
    elif command == 'docker' and args[:1] == ['exec'] and '-release-probe-' in args[1] and 'for path' in args[-1]:
        point = 'probe'
    fail = point is not None and state.get('point') is not None and state['point'] == point and not state.get('fired')
    if fail:
        state['fired'] = True
        state_file.write_text(json.dumps(state))
    # Apply/code-copy failures occur AFTER the real mutation, proving that
    # restoration handles an actual committed migration and replaced website.
    containers = None
    planned = None
    if command == 'docker' and args[:1] == ['compose'] and 'up' in args:
        # Production helper cleanup must not delete the service it just
        # restored/activated. Only the rehearsal orchestrator owns this ledger.
        containers = Containers(root / 'service-containers', namespace, env['REHEARSAL_REAL_DOCKER'])
        planned = containers.track_name(namespace + '-mcp-1', namespace)
    result = subprocess.run([env['REHEARSAL_REAL_' + command.upper()], *args], timeout=330) if not fail or point in {'apply', 'code_copy', 'probe'} else None
    if planned and result.returncode == 0:
        containers.inspect_owned(planned, json.loads(planned.read_text()))
    name = None
    if result and result.returncode == 0 and command == 'docker':
        if args[0] == 'run' and '--name' in args:
            name = args[args.index('--name') + 1]
        elif args[0] == 'compose' and 'up' in args:
            name = namespace + '-mcp-1'
    if name:
        if not name.startswith(namespace + '-'):
            raise ValueError('Created container escaped rehearsal namespace')
        inspected = subprocess.run([env['REHEARSAL_REAL_DOCKER'], 'inspect', name], capture_output=True, text=True, check=True, timeout=20)
        info = json.loads(inspected.stdout)[0]
        if info['Name'] != '/' + name:
            raise ValueError('Created container name changed')
        with (root / 'owned-containers.jsonl').open('a') as ledger:
            ledger.write(json.dumps({'id': info['Id'], 'name': name}) + '\n')
    if fail:
        print('Injected rehearsal failure: ' + point, file=sys.stderr)
        return 77
    return result.returncode


if __name__ == '__main__':
    sys.exit(execute(sys.argv[1], sys.argv[2:]))
