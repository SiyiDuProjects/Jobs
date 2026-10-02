"""Private shell-entry fixture; never contacts SSH or a Docker daemon."""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(os.environ['RELEASE_ENTRY_ROOT'])
config = json.loads((root / 'config.json').read_text())
command, *args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps([command, *args]) + '\n')
if command == 'git':
    if args == ['rev-parse', '--show-toplevel']:
        print(root.as_posix())
    elif args[:1] == ['status']:
        if config.get('dirty'):
            print(' M services/jobs-radar/changed.py')
    elif args[:2] == ['rev-parse', '--short=12']:
        print(config['commit'])
    elif args[:2] == ['rev-parse', '--verify']:
        print(config.get('resolved', config['full_commit']))
    elif args == ['rev-parse', 'HEAD']:
        print(config['full_commit'])
    elif args[:1] == ['archive']:
        assert args[2] == config['full_commit'], 'Source upload must pin the already checked full commit'
        print('private archive fixture')
    else:
        raise ValueError(args)
elif command == 'docker':
    assert args[:2] == ['image', 'inspect'], 'Entry must never build or run a container'
    if config.get('missing_image'):
        sys.exit(1)
    if 'Labels' in args[-1]:
        print(config.get('image_commit', config['commit']))
    else:
        print(config.get('tag_id', config['image_id']) if args[2].startswith('jobs-radar:') else config['image_id'])
elif command == 'python3':
    if args[0].endswith('/host_command.py'):
        sys.exit(subprocess.run([sys.executable, *args]).returncode)
    elif args[0].endswith('/local_rehearsal.py'):
        assert args[1] == '--artifact' and '--old-image' in args
        print('private local rehearsal fixture')
    elif args[0].endswith('/local_build.py'):
        if args[1] == 'build':
            print(root / 'local-artifact')
        elif args[1] == 'verify':
            if config.get('artifact_invalid'):
                sys.exit(1)
            print(config['image_id'])
        else:
            raise ValueError(args)
    elif args[0] == '-c' and 'secrets.token_hex' in args[1]:
        print('123456abcdef')
    else:
        raise ValueError(args)
elif command == 'node':
    assert args[0].endswith('/web_release.mjs')
    assert args[1] in ('--build-web', '--release-web', '--web-status', '--rollback-web')
elif command == 'timeout':
    # Simulate the Linux remote's GNU timeout even on a macOS test host.
    while args[0].startswith('--'):
        args.pop(0)
    seconds = float(args.pop(0).removesuffix('s'))
    sys.exit(subprocess.run(args, timeout=seconds).returncode)
elif command == 'ssh':
    remote = args[args.index('fixture@local') + 1:]
    data = sys.stdin.read()
    if remote[:2] == ['bash', '-s']:
        if remote[3].endswith('/source.tar'):
            assert 'sha256sum' in data and 'tar -xf' in data
            sys.exit(0)
        # Execute the actual read-only preflight shell, with fake Docker only.
        result = subprocess.run([os.environ['RELEASE_ENTRY_BASH'], *remote[1:]], input=data, text=True)
        sys.exit(result.returncode)
    elif remote[0] == 'bash' and remote[1].endswith('/switch_release.sh'):
        if remote[2] == '--rollback':
            print('verified recorded rollback fixture')
        else:
            assert remote[2] == config['commit'] and remote[-1] == config['image_id']
            print('Released ' + config['commit'] + ' (fixture)')
    elif remote[0].startswith('mkdir -p '):
        assert data.strip() == 'private archive fixture'
    elif remote[0].startswith('umask 077;'):
        assert 'import-' in remote[0]
        if 'cat >' in remote[0]:
            assert data == 'private artifact fixture'
    elif remote[0] == 'python3' and remote[1].endswith('/import_image.py'):
        assert remote[-1] == config['full_commit']
        print(config['image_id'])
    elif remote[0].startswith("printf '%s"):
        assert '/RELEASE' in remote[0]
    else:
        raise ValueError(remote)
else:
    raise ValueError(command)
