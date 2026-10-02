import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest

from test_release_migration import implementation


def module(name):
    file = Path(__file__).parents[1] / 'deploy' / (name + '.py')
    if str(file.parent) not in sys.path:
        sys.path.insert(0, str(file.parent))
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def test_synthetic_real_container_data_helper_creates_post_migration_writes(tmp_path):
    helper = module('rehearsal_data')
    path = tmp_path / 'fixture.sqlite'
    helper.seed(path, Path(__file__).parent / 'fixtures/legacy-release-schema.sql')
    before = helper.fingerprint(path)
    assert before['oauth_tokens']['count'] == 1
    implementation().migrate(path, dry_run=False)
    writes = helper.write(path)
    assert all(writes.values())
    after = helper.fingerprint(path)
    assert after['owner_profiles']['count'] == 1
    assert after['applications']['count'] == 2
    assert after['application_events']['count'] >= 4
    assert after['oauth_tokens']['hash'] != before['oauth_tokens']['hash']
    with pytest.raises(AssertionError, match='must not overwrite'):
        helper.seed(path, Path(__file__).parent / 'fixtures/legacy-release-schema.sql')


@pytest.fixture
def wrapper(tmp_path, monkeypatch):
    root = tmp_path / 'jobs-radar-stage/rehearsal-a1b2c3d4e5f67890'
    root.mkdir(parents=True)
    env = dict(JOBS_RELEASE_REHEARSAL_ROOT=str(root), JOBS_RELEASE_IMAGE_PREFIX='jobs-radar-rehearsal-a1b2c3d4e5f67890',
               REHEARSAL_REAL_DOCKER='real-docker', REHEARSAL_REAL_RSYNC='real-rsync')
    calls = []
    monkeypatch.setattr(subprocess, 'run', lambda args, **kwargs: (calls.append(args), subprocess.CompletedProcess(args, 0))[1])
    return module('rehearsal_command'), root, env, calls


@pytest.mark.parametrize('args', [
    ['tag', 'sha256:fixture', 'jobs-radar:0.1.0'],
    ['tag', 'sha256:fixture', 'jobs-radar:previous'],
    ['exec', 'jobs-radar-mcp-1', 'python', '-c', 'pass'],
    ['rm', '-f', 'jobs-radar-mcp-1', 'jobs-radar-rehearsal-a1b2c3d4e5f67890-mcp-1'],
    ['system', 'prune', '-f'],
    ['image', 'prune', '-f'],
    ['run', '--entrypoint', 'python', 'jobs-radar:0.1.0', '-c', 'pass'],
])
def test_failure_wrapper_never_dispatches_production_mutation(wrapper, args):
    tool, _, env, calls = wrapper
    with pytest.raises(ValueError):
        tool.execute('docker', args, env)
    assert calls == []


def test_fault_after_real_copy_occurs_once_and_recovery_can_copy(wrapper):
    tool, root, env, calls = wrapper
    (root / 'fault.json').write_text(json.dumps(dict(point='code_copy', fired=False)))
    args = ['-a', str(root / 'stages/code') + '/', str(root / 'live') + '/']
    assert tool.execute('rsync', args, env) == 77
    assert len(calls) == 1
    assert tool.execute('rsync', args, env) == 0
    assert len(calls) == 2
    with pytest.raises(ValueError, match='escaped'):
        tool.execute('rsync', ['-a', '/production/', str(root / 'live')], env)
    assert len(calls) == 2


def test_rehearsal_root_must_be_the_designated_staging_directory(tmp_path):
    orchestrator = module('rehearse_docker')
    with pytest.raises(ValueError, match='jobs-radar-stage'):
        orchestrator.validate_stage_root(tmp_path)
    staging = tmp_path / 'jobs-radar-stage'
    staging.mkdir()
    assert orchestrator.validate_stage_root(staging) == staging


def test_cleanup_requires_the_recorded_full_container_id_and_exact_name():
    tool = module('rehearse_docker')
    subject = object.__new__(tool.Rehearsal)
    subject.docker = 'docker'
    subject.namespace = 'jobs-radar-rehearsal-a1b2c3d4e5f67890'
    calls = []
    def mismatched(args, **options):
        calls.append(args)
        return json.dumps([dict(Id='different-id', Name='/' + subject.namespace + '-mcp-1')])
    subject.command = mismatched
    with pytest.raises(ValueError, match='identity changed'):
        subject.remove_container('recorded-id', subject.namespace + '-mcp-1')
    assert not any('rm' in call for call in calls)


@pytest.mark.parametrize('fault_state', [None, {'point': None, 'fired': False}])
def test_no_fault_invokes_the_real_subprocess_without_interception(tmp_path, monkeypatch, fault_state):
    tool = module('rehearsal_command')
    root = tmp_path / 'jobs-radar-stage/rehearsal-a1b2c3d4e5f67890'
    root.mkdir(parents=True)
    monkeypatch.chdir(root)
    # Python acts as a harmless executable accepting the forwarded `image
    # inspect` argv. No mocked subprocess: its real child writes this marker.
    (root / 'image').write_text('from pathlib import Path\nimport sys\nassert sys.argv[1:]==["inspect"]\nPath("executed").write_text("real child ran")\n')
    if fault_state is not None:
        (root / 'fault.json').write_text(json.dumps(fault_state))
    env = dict(JOBS_RELEASE_REHEARSAL_ROOT=str(root), JOBS_RELEASE_IMAGE_PREFIX='jobs-radar-rehearsal-a1b2c3d4e5f67890',
               REHEARSAL_REAL_DOCKER=sys.executable)
    assert tool.execute('docker', ['image', 'inspect'], env) == 0
    assert (root / 'executed').read_text() == 'real child ran'
    if fault_state is not None:
        assert json.loads((root / 'fault.json').read_text()) == fault_state


def test_maintenance_helper_distinguishes_absence_from_permission_failure(tmp_path, monkeypatch):
    tool = module('rehearsal_data')
    database = tmp_path / 'jobs.sqlite'
    assert tool.maintenance(database) == {'active': False}
    (tmp_path / '.release-maintenance').write_text('paused')
    assert tool.maintenance(database) == {'active': True}
    def inaccessible(*args, **kwargs):
        raise PermissionError('container cannot read mount')
    monkeypatch.setattr(Path, 'stat', inaccessible)
    with pytest.raises(PermissionError):
        tool.maintenance(database)


@pytest.mark.parametrize('active', [False, True])
def test_rehearsal_marker_check_uses_container_identity_without_host_traversal(tmp_path, monkeypatch, active):
    tool = module('rehearse_docker')
    subject = object.__new__(tool.Rehearsal)
    subject.root, subject.live = tmp_path, tmp_path / 'live'
    subject.docker, subject.namespace, subject.candidate = 'docker', 'isolated', 'candidate'
    subject.image_ids = {'candidate': 'sha256:' + 'c' * 64}
    calls = []
    class Containers:
        def start(self, image, args, **kwargs):
            calls.append((image, args, kwargs))
            return subprocess.CompletedProcess(args, 0, json.dumps({'active': active}), '')
    subject.containers = Containers()
    def host_cannot_traverse(*args, **kwargs):
        raise PermissionError('host cannot traverse UID 10001 private data')
    monkeypatch.setattr(Path, 'stat', host_cannot_traverse)
    if active:
        with pytest.raises(AssertionError):
            subject.assert_resumed()
    else:
        subject.assert_resumed()
    assert len(calls) == 1
    image, args, options = calls[0]
    assert image == 'isolated:candidate'
    assert str(subject.live / 'data') + ':/data' in options['mounts']
    assert args[-2:] == ['maintenance', '/data/jobs.sqlite']


def test_apply_fault_fires_after_real_start_command_using_only_phase_metadata(tmp_path, monkeypatch):
    tool = module('rehearsal_command')
    root = tmp_path / 'jobs-radar-stage/rehearsal-a1b2c3d4e5f67890'
    (root / 'containers').mkdir(parents=True)
    namespace = 'jobs-radar-rehearsal-a1b2c3d4e5f67890'
    container_id = 'a' * 64
    (root / 'containers/plan.json').write_text(json.dumps(dict(namespace=namespace, id=container_id, phase='apply')))
    (root / 'fault.json').write_text(json.dumps(dict(point='apply', fired=False)))
    (root / 'start').write_text('from pathlib import Path\nPath("committed").write_text("mutation completed")\n')
    (root / 'inspect').write_text('import json,sys\nprint(json.dumps([dict(Id=sys.argv[1],HostConfig=dict(Memory=536870912,MemorySwap=536870912,NanoCpus=500000000,PidsLimit=128,NetworkMode="none",PortBindings={}))]))\n')
    monkeypatch.chdir(root)
    env = dict(JOBS_RELEASE_REHEARSAL_ROOT=str(root), JOBS_RELEASE_IMAGE_PREFIX=namespace, REHEARSAL_REAL_DOCKER=sys.executable)
    assert tool.execute('docker', ['start', '-a', container_id], env) == 77
    assert (root / 'committed').read_text() == 'mutation completed'
    assert tool.execute('docker', ['start', '-a', container_id], env) == 0


def create_arguments(namespace, memory='768m', swap='768m', cpus='0.5', pids='128'):
    return ['create', '--name', namespace+'-helper', '--network','none','--memory',memory,
        '--memory-swap',swap,'--cpus',cpus,'--pids-limit',pids,'--entrypoint','python',namespace+':candidate','-c','pass']


def test_actual_child_receives_only_the_two_known_budget_reductions(tmp_path, monkeypatch):
    tool=module('rehearsal_command')
    root=tmp_path/'jobs-radar-stage/rehearsal-a1b2c3d4e5f67890'; root.mkdir(parents=True)
    namespace='jobs-radar-rehearsal-a1b2c3d4e5f67890'
    (root/'create').write_text('import json,sys\nfrom pathlib import Path\nPath("forwarded.json").write_text(json.dumps(sys.argv[1:]))\n')
    monkeypatch.chdir(root)
    env=dict(JOBS_RELEASE_REHEARSAL_ROOT=str(root), JOBS_RELEASE_IMAGE_PREFIX=namespace, REHEARSAL_REAL_DOCKER=sys.executable)
    arguments=create_arguments(namespace)
    assert tool.execute('docker',arguments,env)==0
    forwarded=json.loads((root/'forwarded.json').read_text())
    expected=arguments[1:]
    expected[expected.index('--memory')+1]='512m'; expected[expected.index('--memory-swap')+1]='512m'
    assert forwarded==expected
    assert arguments[arguments.index('--memory')+1]=='768m'


@pytest.mark.parametrize('options', [dict(memory='1g'),dict(swap='512m'),dict(cpus='2'),dict(pids='1024')])
def test_unexpected_budget_is_refused_without_dispatch(wrapper,options):
    tool,_,env,calls=wrapper
    with pytest.raises(ValueError,match='resource'):
        tool.execute('docker',create_arguments(env['JOBS_RELEASE_IMAGE_PREFIX'],**options),env)
    assert not calls


@pytest.mark.parametrize('field,value',[('Memory',805306368),('MemorySwap',805306368),('NanoCpus',2000000000),('PidsLimit',1024),('NetworkMode','bridge'),('PortBindings',{'8796/tcp':[{'HostPort':'8796'}]})])
def test_actual_container_budget_is_verified_not_just_requested(field,value):
    tool=module('rehearsal_command')
    host=dict(Memory=536870912,MemorySwap=536870912,NanoCpus=500000000,PidsLimit=128,NetworkMode='none',PortBindings={})
    tool.verify_resources({'HostConfig':host})
    host[field]=value
    with pytest.raises(ValueError,match='Actual'): tool.verify_resources({'HostConfig':host})


def test_release_helper_cleanup_never_removes_the_restored_compose_service(tmp_path, monkeypatch):
    from test_release_helpers import Engine
    helpers=module('release_helpers'); tool=module('rehearsal_command'); engine=Engine()
    root=tmp_path/'jobs-radar-stage/rehearsal-a1b2c3d4e5f67890'; root.mkdir(parents=True)
    namespace='jobs-radar-rehearsal-a1b2c3d4e5f67890'; service_id='b'*64
    monkeypatch.setattr(tool,'Containers',lambda state, ns, docker:helpers.Containers(state,ns,docker,invoke=engine))
    def run(args,**kwargs):
        if args[1]=='compose':
            engine.containers[service_id]=dict(Id=service_id,Name='/'+namespace+'-mcp-1',Config={'Labels':{helpers.LABEL:namespace}})
            return subprocess.CompletedProcess(args,0,'','')
        return engine(args,**kwargs)
    monkeypatch.setattr(tool.subprocess,'run',run)
    env=dict(JOBS_RELEASE_REHEARSAL_ROOT=str(root),JOBS_RELEASE_IMAGE_PREFIX=namespace,REHEARSAL_REAL_DOCKER='docker')
    assert tool.execute('docker',['compose','up','-d','--no-build','mcp'],env)==0
    # This is the unchanged production driver's EXIT helper cleanup, exercised
    # against the actual rehearsal-created ledger and real Containers code.
    helpers.Containers(root/'containers',namespace,invoke=engine).cleanup()
    assert service_id in engine.containers
    assert not any(args[1:3]==['rm','-f'] for args,_ in engine.calls)
    services=helpers.Containers(root/'service-containers',namespace,invoke=engine)
    services.cleanup()
    assert engine.containers=={}
    assert [args[-1] for args,_ in engine.calls if args[1:3]==['rm','-f']]==[service_id]


@pytest.mark.parametrize('failure', ['helper', 'logs'])
def test_cleanup_attempts_owned_service_even_if_other_cleanup_or_logs_fail(tmp_path, failure):
    from types import SimpleNamespace
    tool=module('rehearse_docker'); subject=object.__new__(tool.Rehearsal)
    subject.root=tmp_path; events=[]
    def action(name):
        events.append(name)
        if name==failure: raise RuntimeError('synthetic '+name+' failure')
    subject.containers=SimpleNamespace(cleanup=lambda:action('helper'))
    subject.capture_service_logs=lambda:action('logs')
    subject.services=SimpleNamespace(cleanup=lambda:action('services'))
    with pytest.raises(RuntimeError,match=failure): subject.cleanup_containers()
    assert events==['helper','logs','services']
