"""Local-only environment adapter for the unchanged production recovery machine.

No production paths, published ports, system timers or alternate state machine.
All data operations and HTTP checks execute in the verified candidate image.
"""
import json
from pathlib import Path
import re
import time
import uuid

import recover_profiles as production
from release_helpers import LABEL


def require(condition, message):
    if not condition: raise ValueError(message)


class RehearsalRecoveryHost(production.Host):
    def __init__(self, subject, *, failure=None):
        self.subject = subject
        self.live, self.release = subject.live, subject.candidate
        self.image_id = subject.image_ids[self.release]
        self.namespace = subject.namespace
        self.deadline = subject.deadline
        require(re.fullmatch(r'rehearsal-[a-f0-9]{16}', subject.root.name) and
                subject.root.parent.name == 'jobs-radar-stage' and
                self.namespace == 'jobs-radar-' + subject.root.name and
                self.live == subject.root / 'live', 'Invalid isolated recovery root')
        require(re.fullmatch('sha256:[a-f0-9]{64}', self.image_id), 'Full image ID required')
        self.state = self.live / '.release'
        require(not self.state.is_symlink(), 'Release state is a link')
        self.state.mkdir(mode=0o700, exist_ok=True)
        self.journal_path = self.state / 'restricted-active.json'
        # Auxiliary cleanup is shared with production. Compose is owned by a
        # separate local-only ledger so driver EXIT cannot delete the service.
        self.containers = subject.containers
        self.failure, self.fired = failure, False
        self.activation_write = None

    def invoke(self, args, *, timeout=30):
        # Absolute run deadline and bounded output/entire Linux process group.
        return self.subject.invoke(args, timeout=timeout)

    def compose(self, *args):
        result = self.docker('compose', '--project-name', self.namespace,
            '--file', str(self.subject.root / 'compose.yaml'), '--project-directory', str(self.live),
            *args, timeout=180)
        if args == ('stop', 'mcp'):
            value = json.loads(self.docker('inspect', self.service_id))[0]
            require(value['Id'] == self.service_id and not value['State']['Running'], 'Service stop is not confirmed')
        return result

    def running(self):
        ids = self.compose('ps', '-q', 'mcp').splitlines()
        require(len(ids) == 1 and re.fullmatch('[a-f0-9]{64}', ids[0]), 'One full isolated service ID required')
        value = json.loads(self.docker('inspect', ids[0]))[0]
        from rehearsal_command import verify_resources
        verify_resources(value)
        require(value['Id'] == ids[0] and value['Image'] == self.image_id and
                value['Name'] == '/' + self.namespace + '-mcp-1' and value['State']['Running'] and
                value['Config']['Labels'].get('release') == self.release and
                value['Config']['Labels'].get('com.docker.compose.project') == self.namespace and
                value['Config']['Labels'].get('com.docker.compose.service') == 'mcp' and
                value['Config']['Labels'].get(LABEL) == self.namespace and
                value['HostConfig']['NetworkMode'] == 'none' and not value['HostConfig'].get('PortBindings'),
                'Isolated service ownership/image/network differs')
        return ids[0]

    def preflight(self):
        # Do not clean the shared ledger here: it also owns the active service.
        config = json.loads((self.subject.root / 'compose.yaml').read_text())
        service = config['services']['mcp']
        require(set(config['services']) == {'mcp'} and config['name'] == self.namespace and
                service['image'] == self.namespace + ':0.1.0' and service['network_mode'] == 'none' and
                not any(service.get(key) for key in ('ports', 'secrets', 'configs', 'devices', 'pid', 'ipc')) and
                service['volumes'] == [dict(type='bind', source=str(self.live / 'data'), target='/data')],
                'Isolated compose binding differs')
        require((self.live / 'RELEASE').read_text().strip() == self.release, 'Live release differs')
        paired = self.subject.stages / self.release / 'deploy/recover_profiles.py'
        require(paired.read_bytes() == Path(production.__file__).read_bytes(), 'Recovery machine differs from candidate source')
        for image in (self.namespace + ':0.1.0', self.namespace + ':' + self.release, self.image_id):
            value = json.loads(self.docker('image', 'inspect', image))[0]
            require(value['Id'] == self.image_id and value['Config']['Labels'].get('release') == self.release,
                    'Isolated published image differs')
        self.helper(['-c', production.DATA_CHECK])
        self.service_id = self.running()

    def timer_states(self):
        # No unit names are ever dispatched to systemctl in local rehearsal.
        return {name: 'inactive' for name in production.TIMERS}

    def stop_timers(self):
        require(self.subject.env['JOBS_RELEASE_MANAGE_TIMERS'] == '0', 'Local rehearsal must not manage host timers')

    def wait_writers(self):
        # Own namespace contains exactly the service; no collector/backup job.
        names = self.docker('ps', '--filter', 'label=com.docker.compose.project=' + self.namespace,
                            '--format', '{{.Names}}').splitlines()
        require(names == [self.namespace + '-mcp-1'], 'Unexpected isolated writer inventory')

    def restore_timers(self, states):
        require(states == self.timer_states(), 'Local timer state differs')

    def helper(self, args, timeout=production.STEP_SECONDS, detached=False, name=None):
        return self.containers.start(self.namespace + ':' + self.release, args, image_id=self.image_id,
            memory=512, timeout=timeout, detached=detached, name=name,
            mounts=[str(self.live / 'data') + ':/data'], environment=['JOBS_DB=/data/jobs.sqlite',
                'JOBS_HOST=127.0.0.1', 'JOBS_PORT=8796', 'JOBS_ORIGIN=https://jobs.siyidu.com'])

    def probe(self, mode, public=False):
        if public:
            container = self.running()
            result = json.loads(self.docker('exec', container, 'python', '-c', production.PROBE,
                                           mode, self.release, timeout=60))
            if self.failure == 'after-resumed-write' and mode == 'applications' and not self.fired:
                self.activation_write = self.subject.http('http-edit', 'after-activation')
                self.fired = True
                raise RuntimeError('Injected failure after a real accepted HTTP write')
            return dict(result, scope='isolated-compose-service-no-public-ingress')
        name = self.namespace + '-recovery-probe-' + uuid.uuid4().hex
        try:
            self.helper(['-m', 'jobs_radar.cli', 'serve'], detached=True, name=name)
            value = json.loads(self.docker('inspect', name))[0]
            require(value['Image'] == self.image_id and value['HostConfig']['NetworkMode'] == 'none', 'Private probe identity differs')
            return json.loads(self.docker('exec', value['Id'], 'python', '-c', production.PROBE,
                                          mode, self.release, timeout=60))
        finally:
            self.containers.cleanup(name)

    def fail(self, journal):
        # A fixed cleanup reserve remains inside the complete run deadline.
        self.subject.deadline = min(self.subject.total_deadline - 240, time.monotonic() + 90)
        # Production failure sequencing holds/stops, cleans helpers and never
        # restores a database. Finish the separate local Compose ledger too.
        parent_error = None
        try:
            production.Host.fail(self, journal)
        except BaseException as error:
            # Even a failed failure-journal write cannot skip owned cleanup.
            parent_error = error
            journal.setdefault('stopUncertain', []).append('recovery-failure-handler')
        for name, action in [('isolated-service-logs', self.subject.capture_service_logs),
                             ('isolated-service-cleanup', self.subject.services.cleanup)]:
            try:
                action()
            except BaseException:
                journal['stopUncertain'].append(name)
        self.save(journal)
        if parent_error is not None:
            raise RuntimeError('Recovery failure handling remains unresolved') from parent_error


def run_recovery(subject):
    invariant = subject.data('recovery-invariants')
    host = RehearsalRecoveryHost(subject)
    journal = production.transaction(host, '--recover-profiles')
    require(journal['status'] == 'restricted-active', 'Recovery did not activate')
    expected = subject.http('http-edit', 'during-recovery')
    require(subject.http('http-verify') == expected, 'Recovery HTTP readback differs')
    require(subject.data('recovery-invariants') == invariant, 'Recovery altered protected application/auth data')
    production.transaction(host, '--resume-applications')
    require(subject.http('http-verify') == expected, 'Resumed latest Profile/settings/session differs')
    require(subject.data('recovery-invariants') == invariant, 'Resume altered protected application/auth data')
    subject.assert_resumed()
    subject.results.append(dict(case='restricted-recovery-roundtrip', result='passed', realDocker=True,
        realHTTP=True, latestEditsPreserved=True, authRevocationPreserved=True, publicIngressVerified=False))
    subject.save_report()
    # Preserve the completed journal before a distinct failure experiment.
    host.journal_path.rename(host.state / 'restricted-completed.json')
    host = RehearsalRecoveryHost(subject, failure='after-resumed-write')
    production.transaction(host, '--recover-profiles')
    subject.http('http-edit', 'second-recovery')
    try:
        production.transaction(host, '--resume-applications')
    except RuntimeError:
        if not host.fired: raise
    else:
        raise AssertionError('Requested post-activation failure was not exercised')
    require(host.load()['status'] == 'failed-needs-review', 'Failure was not held')
    require(not host.load()['stopUncertain'], 'Failure cleanup remains uncertain')
    require(subject.data('maintenance') == {'active': True}, 'Failure lost maintenance')
    require(subject.data('recovery-invariants') == invariant, 'Failure restored protected data')
    require(subject.data('recovery-state') == host.activation_write, 'Accepted latest write was lost after failure')
    names = subject.command([subject.docker, 'ps', '--filter', 'label=com.docker.compose.project=' + subject.namespace,
                             '--format', '{{.Names}}'], capture=True)
    require(not names, 'Service is still running after failure')
    subject.results.append(dict(case='recovery-post-activation-failure', result='held', realDocker=True,
        acceptedHTTPWritePreserved=True, databaseRestored=False, publicIngressVerified=False))
    subject.save_report()
