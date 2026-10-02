"""Exercise the committed release driver with REAL Docker and synthetic data.

Linux host only. Uses a random jobs-radar-stage/rehearsal-* directory, independent
image tags and Compose project, no ports/network/secrets/timers. Keeps archives.
Build/package through release.sh; this entry is used only by local_rehearsal.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time

from release_helpers import Containers, LABEL, bounded


HERE = Path(__file__).resolve().parent


def validate_stage_root(path):
    root = Path(path).resolve(strict=True)
    if root.name != 'jobs-radar-stage' or not root.is_dir():
        raise ValueError('Use the existing jobs-radar-stage directory')
    return root


class Rehearsal:
    def __init__(self, stage_root, old_image, candidate_image, *, deadline=None, register=None):
        if sys.platform != 'linux':
            raise ValueError('Real Docker rehearsal requires the Linux release host')
        self.docker = shutil.which('docker')
        self.rsync = shutil.which('rsync')
        if not self.docker or not self.rsync:
            raise ValueError('Docker and rsync are required')
        self.root = validate_stage_root(stage_root) / ('rehearsal-' + secrets.token_hex(8))
        self.root.mkdir(mode=0o700)
        self.namespace = 'jobs-radar-' + self.root.name
        self.live, self.archive, self.stages = [self.root / value for value in ('live', 'archive', 'stages')]
        for folder in (self.live, self.archive, self.stages, self.root / 'bin'):
            folder.mkdir()
        self.case = 'setup'
        self.results = []
        self.deadline = deadline or time.monotonic() + 3240
        self.total_deadline = self.deadline + 360
        self.finalized = False
        self.old = self.candidate = self.newer = None
        self.candidate_image_id = candidate_image
        self.image_ids = {}
        self.containers = Containers(self.root / 'containers', self.namespace, self.docker, invoke=self.invoke)
        self.services = Containers(self.root / 'service-containers', self.namespace, self.docker, invoke=self.invoke)
        self.env = dict(os.environ, JOBS_RELEASE_REHEARSAL_ROOT=str(self.root),
            JOBS_RELEASE_IMAGE_PREFIX=self.namespace, JOBS_RELEASE_COMPOSE_PROJECT=self.namespace,
            JOBS_RELEASE_VERIFY_MODE='container', JOBS_RELEASE_MANAGE_TIMERS='0',
            COMPOSE_PROJECT_NAME=self.namespace, COMPOSE_FILE=str(self.root / 'compose.yaml'),
            REHEARSAL_REAL_DOCKER=self.docker, REHEARSAL_REAL_RSYNC=self.rsync)
        for name in ('docker', 'rsync'):
            wrapper = self.root / 'bin' / name
            wrapper.write_text('#!/bin/sh\nexec ' + self.shell_quote(sys.executable) + ' ' + self.shell_quote(str(HERE / 'rehearsal_command.py')) + ' ' + name + ' "$@"\n')
            wrapper.chmod(0o700)
        self.env['PATH'] = str(self.root / 'bin') + os.pathsep + self.env.get('PATH', '')
        if register is not None: register(self.root, self.namespace)
        # Full independent config: production compose and secret paths are never
        # parsed or mounted. JSON is a valid Compose/YAML document.
        service = dict(image=self.namespace + ':0.1.0', user='10001:10001', read_only=True,
            labels={LABEL: self.namespace},
            cap_drop=['ALL'], security_opt=['no-new-privileges:true'], network_mode='none',
            tmpfs=['/tmp:size=32m,mode=1777'], mem_limit='512m', memswap_limit='512m', cpus=0.5, pids_limit=128,
            environment=dict(JOBS_DB='/data/jobs.sqlite', JOBS_ORIGIN='https://jobs.siyidu.com', JOBS_HOST='127.0.0.1', JOBS_PORT='8796'),
            volumes=[dict(type='bind', source=str(self.live / 'data'), target='/data')],
            command=['serve'], healthcheck=dict(test=['CMD', 'python', '-c', 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8796/healthz",timeout=3).close()'], interval='2s', timeout='4s', retries=10))
        (self.root / 'compose.yaml').write_text(json.dumps(dict(name=self.namespace, services={'mcp': service}), indent=2))
        self.old = self.import_image(old_image)
        self.candidate = self.import_image(candidate_image)
        if self.old == self.candidate:
            raise ValueError('Old and candidate releases must be distinct immutable releases')
        self.newer = self.build_compatible_variant()
        for release in (self.old, self.candidate, self.newer):
            self.export_code(release)
        self.schema = HERE.parent / 'tests' / 'fixtures' / 'legacy-release-schema.sql'
        if not self.schema.is_file():
            raise ValueError('Run the committed staged source with its legacy-schema fixture')
        shutil.copy2(self.schema, self.root / 'legacy-schema.sql')
        shutil.copy2(HERE / 'rehearsal_data.py', self.root / 'rehearsal_data.py')

    @staticmethod
    def shell_quote(value):
        return "'" + value.replace("'", "'\"'\"'") + "'"

    def command(self, args, *, capture=False, check=True, timeout=180):
        result = self.invoke(args, timeout=timeout)
        with (self.archive / (self.case + '.log')).open('a') as log:
            log.write('$ ' + ' '.join(map(str, args)) + '\n' + result.stdout + result.stderr)
        if check and result.returncode:
            raise RuntimeError('Rehearsal command failed; inspect ' + str(self.archive / (self.case + '.log')))
        return result.stdout.strip() if capture else result

    def invoke(self, args, *, timeout=30):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('Local rehearsal total deadline exceeded')
        if len(args) > 2 and str(args[0]) == self.docker and args[1] == 'start':
            from rehearsal_command import inspect_budget
            inspect_budget(lambda command, timeout: bounded(command, env=self.env, timeout=min(timeout, remaining)),
                           self.docker, args[-1])
            remaining = self.deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError('Local rehearsal total deadline exceeded')
        return bounded(args, env=self.env, timeout=min(timeout, remaining))

    def inspect(self, image):
        return json.loads(self.command([self.docker, 'image', 'inspect', image], capture=True))[0]

    def import_image(self, image):
        value = self.inspect(image)
        label = value['Config'].get('Labels', {}).get('release', '')
        if not re.fullmatch('[a-f0-9]{12,40}', label):
            raise ValueError('A verified release label is required')
        self.command([self.docker, 'tag', value['Id'], self.namespace + ':' + label])
        self.image_ids[label] = value['Id']
        return label

    def build_compatible_variant(self):
        label = hashlib.sha256((self.namespace + ':variant').encode()).hexdigest()[:12]
        folder = self.root / 'variant'
        folder.mkdir()
        # A stopped clone permits a real website/image difference without an
        # unbudgeted BuildKit worker or any running build container.
        plan, container_id = self.containers.clone_stopped(self.namespace + ':' + self.candidate)
        try:
            self.verify_clone(container_id, self.candidate)
            website = folder / 'board.js'
            self.command([self.docker, 'cp', container_id + ':/app/jobs_radar/static/board.js', website])
            website.write_bytes(website.read_bytes() + b'\n// isolated rehearsal variant\n')
            self.command([self.docker, 'cp', website, container_id + ':/app/jobs_radar/static/board.js'])
            self.command([self.docker, 'commit', '--change', 'LABEL release=' + label,
                          container_id, self.namespace + ':' + label], timeout=120)
            self.image_ids[label] = self.inspect(self.namespace + ':' + label)['Id']
        finally:
            self.containers.remove(plan)
        return label

    def export_code(self, release):
        destination = self.stages / release
        destination.mkdir()
        plan, container_id = self.containers.clone_stopped(self.namespace + ':' + release)
        try:
            self.verify_clone(container_id, release)
            self.command([self.docker, 'cp', container_id + ':/app/.', destination])
        finally:
            self.containers.remove(plan)
        (destination / 'RELEASE').write_text(release + '\n')

    def verify_clone(self, container_id, release):
        from rehearsal_command import inspect_budget
        value = inspect_budget(self.invoke, self.docker, container_id)
        if value['Image'] != self.image_ids[release]: raise ValueError('Export clone image differs')

    def remove_container(self, container_id, expected_name):
        value = self.command([self.docker, 'inspect', container_id], capture=True, check=False)
        if not value:
            return
        values = json.loads(value)
        if not values:
            return
        info = values[0]
        if info['Id'] != container_id or info['Name'] != '/' + expected_name or not expected_name.startswith(self.namespace + '-'):
            raise ValueError('Cleanup container identity changed')
        self.command([self.docker, 'rm', '-f', container_id])

    def cleanup_containers(self):
        errors = []
        # A failed auxiliary inventory/log read must not prevent independent
        # exact-ID service cleanup. Preserve all failures after every attempt.
        for name, action in [('helper', self.containers.cleanup), ('logs', self.capture_service_logs),
                             ('services', self.services.cleanup), ('legacy-records', self.cleanup_recorded_services)]:
            try:
                action()
            except BaseException as error:
                errors.append(name + ': ' + type(error).__name__ + ': ' + str(error))
        if errors:
            raise RuntimeError('Rehearsal cleanup remains unresolved: ' + '; '.join(errors))

    def cleanup_recorded_services(self):
        # Only IDs recorded when this run created a container are eligible.
        # A prefix search alone could select a container created by someone else.
        ledger = self.root / 'owned-containers.jsonl'
        if not ledger.exists():
            return
        seen, errors = set(), []
        for line in ledger.read_text().splitlines():
            owned = json.loads(line)
            if owned['id'] in seen:
                continue
            seen.add(owned['id'])
            if not owned['name'].startswith(self.namespace + '-'):
                raise ValueError('Owned-container ledger escaped its namespace')
            for name, action in [('logs', lambda: self.command([self.docker, 'logs', '--tail', '200', owned['id']], check=False)),
                                 ('remove', lambda: self.remove_container(owned['id'], owned['name']))]:
                try: action()
                except BaseException as error: errors.append(name + ': ' + type(error).__name__ + ': ' + str(error))
        if errors: raise RuntimeError('Recorded service cleanup remains unresolved: ' + '; '.join(errors))

    def capture_service_logs(self):
        # Capture before exact-ID removal; retain the original ledger even
        # when an earlier case's container is already gone.
        for path in self.services.state.glob('*.json'):
            plan = json.loads(path.read_text())
            if plan.get('id') and not plan.get('removed'):
                self.services.inspect_owned(path, plan)
                self.command([self.docker, 'logs', '--tail', '200', plan['id']], check=False)

    def data(self, mode, release=None):
        result = self.containers.start(self.namespace + ':' + (release or self.candidate),
            ['/check/data.py', mode, '/data/jobs.sqlite', *(['--schema', '/check/legacy.sql'] if mode == 'seed' else [])],
            mounts=[str(self.live / 'data') + ':/data', str(self.root / 'rehearsal_data.py') + ':/check/data.py:ro',
                    str(self.root / 'legacy-schema.sql') + ':/check/legacy.sql:ro'],
            image_id=self.image_ids[release or self.candidate])
        return json.loads(result.stdout)

    def http(self, mode, label='during-recovery'):
        from rehearsal_recovery import RehearsalRecoveryHost
        container = RehearsalRecoveryHost(self).running()
        return json.loads(self.command([self.docker, 'exec', container, 'python', '-c',
            (self.root / 'rehearsal_data.py').read_text(), mode, '/data/jobs.sqlite', '--label', label], capture=True, timeout=60))

    def verify_data_permissions(self):
        code = '''import os,stat
from pathlib import Path
p=Path('/data'); info=p.stat()
assert (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(10001,10001,0o700)
probe=p/'.permission-proof'
with probe.open('x') as f: f.write('synthetic permission proof')
assert probe.read_text()=='synthetic permission proof'
probe.unlink()
'''
        self.containers.start(self.namespace + ':' + self.candidate, ['-c', code],
            image_id=self.image_ids[self.candidate], mounts=[str(self.live / 'data') + ':/data'])
        # A real non-owner read must fail. Drop root to the host's unprivileged
        # uid inside this short helper; do not relax the data mount permissions.
        code = '''import os
os.setgroups([]); os.setgid(1000); os.setuid(1000)
try: os.listdir('/data')
except PermissionError: pass
else: raise AssertionError('Non-owner can read private data')
'''
        self.containers.start(self.namespace + ':' + self.candidate, ['-c', code], user='0:0',
            image_id=self.image_ids[self.candidate], mounts=[str(self.live / 'data') + ':/data'])

    def wait_healthy(self):
        name = self.namespace + '-mcp-1'
        for _ in range(40):
            result = self.command([self.docker, 'inspect', '-f', '{{.State.Health.Status}}', name], capture=True, check=False)
            if result == 'healthy':
                return
            time.sleep(1)
        raise RuntimeError('Isolated baseline did not become healthy')

    def baseline(self, case):
        self.cleanup_containers()
        if any(self.live.iterdir()):
            destination = self.archive / (self.case + '-live')
            if destination.exists():
                raise ValueError('Refusing to overwrite rehearsal evidence')
            self.live.rename(destination)
            self.live.mkdir()
        self.case = case
        (self.root / 'fault.json').write_text('{}')
        self.command([self.rsync, '-a', str(self.stages / self.old) + '/', str(self.live) + '/'])
        (self.live / 'data').mkdir()
        # Ownership changes are constrained to a fresh empty synthetic mount.
        self.containers.start(self.namespace + ':' + self.candidate,
            ['-c', 'import os; os.chown("/data",10001,10001); os.chmod("/data",0o700)'],
            mounts=[str(self.live / 'data') + ':/data'], user='0:0', image_id=self.image_ids[self.candidate])
        self.verify_data_permissions()
        self.data('seed')
        self.command([self.docker, 'tag', self.namespace + ':' + self.old, self.namespace + ':0.1.0'])
        name = self.namespace + '-mcp-1'
        plan = self.services.track_name(name, self.namespace)
        self.command([self.docker, 'compose', '--project-directory', self.live, 'up', '-d', '--no-build', 'mcp'])
        self.services.inspect_owned(plan, json.loads(plan.read_text()))
        info = json.loads(self.command([self.docker, 'inspect', name], capture=True))[0]
        from rehearsal_command import verify_resources
        verify_resources(info)
        if info['Name'] != '/' + name or info['Image'] != self.image_ids[self.old]:
            raise ValueError('Initial container identity changed')
        with (self.root / 'owned-containers.jsonl').open('a') as ledger:
            ledger.write(json.dumps({'id': info['Id'], 'name': name}) + '\n')
        self.wait_healthy()
        return self.data('fingerprint')

    def driver(self, target, failure=None):
        (self.root / 'fault.json').write_text(json.dumps({'point': failure, 'fired': False}))
        result = self.command(['bash', HERE / 'switch_release.sh', target, self.live,
            self.stages / (self.candidate if target == '--rollback' else target), self.archive,
            *([] if target == '--rollback' else [self.inspect(self.namespace + ':' + target)['Id']])], check=False, timeout=360)
        if failure and not json.loads((self.root / 'fault.json').read_text()).get('fired'):
            raise RuntimeError('Requested failure point was not exercised: ' + failure)
        return result

    def assert_image(self, expected):
        name = self.namespace + '-mcp-1'
        value = json.loads(self.command([self.docker, 'inspect', name], capture=True))[0]
        from rehearsal_command import verify_resources
        verify_resources(value)
        assert value['Config']['Labels']['release'] == expected
        assert value['Image'] == self.image_ids[expected]
        assert value['HostConfig']['NetworkMode'] == 'none' and not value['HostConfig'].get('PortBindings')
        assert (self.live / 'RELEASE').read_text().strip() == expected
        # Compare actual live code to the extracted paired image website.
        assert (self.live / 'jobs_radar/static/board.js').read_bytes() == (self.stages / expected / 'jobs_radar/static/board.js').read_bytes()

    def assert_resumed(self):
        # data is mode 0700, owned by UID 10001. Check from the same container
        # identity as the service, never by traversing the mount on the host.
        assert self.data('maintenance') == {'active': False}

    def run(self):
        try:
            for point in ('backup', 'dry_run', 'apply', 'code_copy', 'probe'):
                before = self.baseline('failure-' + point)
                result = self.driver(self.candidate, point)
                assert result.returncode != 0
                self.assert_image(self.old)
                assert self.data('fingerprint') == before
                self.assert_resumed()
                self.results.append(dict(case=self.case, result='passed', realDocker=True, databaseRestored=True))
                self.save_report()
            self.baseline('migration-and-rollback')
            assert self.driver(self.candidate).returncode == 0
            self.assert_image(self.candidate)
            before_refusal = self.data('fingerprint')
            assert self.driver('--rollback').returncode != 0
            assert self.data('fingerprint') == before_refusal
            self.assert_image(self.candidate)
            self.assert_resumed()
            self.results.append(dict(case='incompatible-rollback', result='refused-before-change', realDocker=True))
            self.data('write')
            postwrite = self.data('fingerprint')
            assert self.driver(self.newer).returncode == 0
            self.assert_image(self.newer)
            assert self.data('fingerprint') == postwrite
            assert self.driver('--rollback').returncode == 0
            self.assert_image(self.candidate)
            assert self.data('fingerprint') == postwrite
            self.results.append(dict(case='compatible-rollback', result='passed', realDocker=True, postMigrationWritesPreserved=True))
            self.save_report()
            from rehearsal_recovery import run_recovery
            self.case = 'restricted-recovery'
            run_recovery(self)
        except BaseException as error:
            self.results.append(dict(case=self.case, result='failed', error=str(error)))
            raise
        finally:
            self.finalize()
        return dict(root=str(self.root), namespace=self.namespace, scenarios=self.results,
                    productionChanged=False, syntheticDataOnly=True, publicNetwork=False)

    def finalize(self):
        if self.finalized: return
        self.deadline = min(self.total_deadline - 240, time.monotonic() + 90)
        try:
            self.cleanup_containers()
        finally:
            self.save_report()
        self.finalized = True

    def save_report(self):
        (self.archive / 'report.json').write_text(json.dumps(dict(namespace=self.namespace, results=self.results,
            old=self.old, candidate=self.candidate, compatibleVariant=self.newer,
            mode='isolated-real-docker', syntheticDataOnly=True, productionChanged=False,
            helperMemoryMiB=512, productionMigrationHelperMemoryMiB=768,
            budgetDifference='Only the known 768m request is tightened locally; actual HostConfig is checked',
            publicIngressVerified=False), indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage-root', type=Path, required=True)
    parser.add_argument('--old-image', required=True)
    parser.add_argument('--candidate-image', required=True)
    args = parser.parse_args()
    parser.error('No independent rehearsal environment is configured. Production rehearsals are disabled; use release.sh as the release entrypoint.')
