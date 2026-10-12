import gzip
import os
import sqlite3
import subprocess

import pytest

from deploy_module import module

prune = module('prune_releases')
NOW = 2_000_000_000
OLD = NOW - 2 * prune.IN_FLIGHT_SECONDS
CURRENT, PREVIOUS, OLDER, OLDEST, INFLIGHT = 'c' * 12, 'b' * 12, 'a' * 12, '9' * 12, 'e' * 12


def database(path):
    with sqlite3.connect(path) as connection:
        connection.execute('create table marker(value)')
    connection.close()


class Docker:
    def __init__(self, tags, in_use=()):
        self.tags, self.in_use, self.calls = tags, set(in_use), []

    def __call__(self, args):
        self.calls.append(args)
        if args[:3] == ['docker', 'image', 'ls']:
            return '\n'.join(self.tags) + '\n'
        if args[:3] == ['docker', 'image', 'rm'] and args[3] in self.in_use:
            raise subprocess.CalledProcessError(1, args, stderr='conflict: image is being used by stopped container')
        return ''


def layout(tmp_path):
    live, stage, archive = tmp_path / 'live', tmp_path / 'stage', tmp_path / 'archive'
    migrations = live / 'data/migrations'
    for path in (migrations, stage, archive):
        path.mkdir(parents=True)
    (live / 'RELEASE').write_text(CURRENT + '\n')
    rollback_code = archive / f'code-{OLDEST}-{OLDER}-20261001T000000Z-1.tgz'
    (live / '.rollback-target').write_text(f'{PREVIOUS}\n{rollback_code}\nsha256:{"1" * 64}\n{"2" * 64}\n')
    runs = {}
    for commit, stamp, kind in [(CURRENT, '20261012T060000Z', 'sqlite'), (PREVIOUS, '20261011T060000Z', 'sqlite'),
                                (OLDER, '20261001T000000Z', 'sqlite'), (OLDEST, '20260927T000000Z', 'gz')]:
        run = migrations / f'{commit}-{stamp}-1'
        run.mkdir()
        (run / 'applied.json').write_text('{}')
        if kind == 'sqlite':
            database(run / 'pre-change.sqlite')
            (run / 'pre-change.sqlite-shm').write_bytes(b'x')
        else:
            (run / 'pre-change.sqlite.gz').write_bytes(b'compressed')
        runs[commit] = run
    (migrations / 'dod-20260926').mkdir()
    (migrations / 'dod-20260926/pre-change.sqlite').write_bytes(b'one-off')
    for name in [CURRENT, PREVIOUS, OLDER, INFLIGHT, 'import-' + OLDER + 'f' * 28 + '-' + '1' * 12,
                 'import-' + INFLIGHT + 'f' * 28 + '-' + '2' * 12, 'rehearsal-3eafb8dececb64f0']:
        (stage / name).mkdir()
        (stage / name / 'RELEASE').write_text(name)
    rollback_code.write_bytes(b'rollback code')
    for name in [f'code-{PREVIOUS}-{CURRENT}-20261012T060000Z-1.tgz', f'code-{OLDER}-{PREVIOUS}-20261011T060000Z-1.tgz',
                 f'code-{OLDEST}-{OLDEST}-20260927T000000Z-1.tgz', f'rollback-target-{CURRENT}-20261012T060000Z-1',
                 f'rollback-target-{PREVIOUS}-20261011T060000Z-1', f'rollback-target-{OLDER}-20261001T000000Z-1',
                 'before-rebuild-20260923.sqlite', 'code-221b69cd9ce6-20260924T054843Z.tgz']:
        (archive / name).write_bytes(b'archive')
    for path in [*stage.iterdir(), *archive.iterdir()]:
        os.utime(path, (OLD, OLD))
    for name in [INFLIGHT, 'import-' + INFLIGHT + 'f' * 28 + '-' + '2' * 12]:
        os.utime(stage / name, (NOW, NOW))
    return live, stage, archive, runs


def planned(tmp_path, docker):
    live, stage, archive, runs = layout(tmp_path)
    return prune.plan(live, stage, archive, now=NOW, docker=docker), live, stage, archive, runs


def test_dry_run_keeps_live_rollback_recent_snapshots_and_unrecognized_files(tmp_path):
    docker = Docker([CURRENT, PREVIOUS, OLDER, OLDEST, INFLIGHT, '0.1.0', 'previous', 'before-rebuild-20260923'])
    result, live, stage, archive, runs = planned(tmp_path, docker)
    removed = {entry['path'] for entry in result['remove']}
    assert removed == {
        str(runs[OLDER] / 'pre-change.sqlite'), str(runs[OLDER] / 'pre-change.sqlite-shm'),
        str(runs[OLDEST] / 'pre-change.sqlite.gz'),
        str(stage / OLDER), str(stage / ('import-' + OLDER + 'f' * 28 + '-' + '1' * 12)),
        str(archive / f'code-{OLDEST}-{OLDEST}-20260927T000000Z-1.tgz'),
        str(archive / f'rollback-target-{OLDER}-20261001T000000Z-1'),
    }
    assert result['retainedSnapshots'] == [str(runs[CURRENT] / 'pre-change.sqlite'), str(runs[PREVIOUS] / 'pre-change.sqlite')]
    assert result['removeImages'] == ['jobs-radar:' + OLDEST, 'jobs-radar:' + OLDER]
    unmanaged = {entry['path'] for entry in result['unmanaged']}
    assert {str(live / 'data/migrations/dod-20260926'), str(stage / 'rehearsal-3eafb8dececb64f0'),
            str(archive / 'before-rebuild-20260923.sqlite'), str(archive / 'code-221b69cd9ce6-20260924T054843Z.tgz')} <= unmanaged
    assert all(os.path.exists(path) for path in removed)
    assert all(call[:3] == ['docker', 'image', 'ls'] for call in docker.calls)


def test_apply_removes_only_planned_payloads_and_never_forces_an_image(tmp_path):
    docker = Docker([CURRENT, PREVIOUS, OLDER, OLDEST], in_use=['jobs-radar:' + OLDEST])
    result, live, stage, archive, runs = planned(tmp_path, docker)
    prune.apply(result, docker=docker)
    assert not any(os.path.exists(entry['path']) for entry in result['remove'])
    assert (runs[OLDER] / 'applied.json').exists() and (runs[OLDEST] / 'applied.json').exists()
    assert (runs[CURRENT] / 'pre-change.sqlite').exists() and (runs[PREVIOUS] / 'pre-change.sqlite').exists()
    assert (archive / f'code-{OLDEST}-{OLDER}-20261001T000000Z-1.tgz').exists()
    assert (stage / CURRENT).exists() and (stage / PREVIOUS).exists() and (stage / INFLIGHT).exists()
    assert (live / 'data/migrations/dod-20260926/pre-change.sqlite').exists()
    assert (archive / 'before-rebuild-20260923.sqlite').exists()
    removes = [call for call in docker.calls if call[:3] == ['docker', 'image', 'rm']]
    assert removes == [['docker', 'image', 'rm', 'jobs-radar:' + OLDEST], ['docker', 'image', 'rm', 'jobs-radar:' + OLDER]]
    assert [entry['image'] for entry in result['retainedImages']] == ['jobs-radar:' + OLDEST]


def test_unreadable_retained_snapshot_stops_before_any_removal(tmp_path):
    docker = Docker([OLDER])
    result, _, _, _, runs = planned(tmp_path, docker)
    (runs[PREVIOUS] / 'pre-change.sqlite').write_bytes(b'not a database' * 100)
    with pytest.raises(sqlite3.DatabaseError):
        prune.apply(result, docker=docker)
    assert all(os.path.exists(entry['path']) for entry in result['remove'])
    assert not any(call[:3] == ['docker', 'image', 'rm'] for call in docker.calls)


def test_compressed_snapshot_must_be_a_complete_database_stream(tmp_path):
    path = tmp_path / 'pre-change.sqlite.gz'
    path.write_bytes(gzip.compress(b'SQLite format 3\x00' + b'\x00' * 4096))
    prune.verify_snapshot(path)
    path.write_bytes(path.read_bytes()[:-6])
    with pytest.raises(EOFError):
        prune.verify_snapshot(path)


def test_symlinked_run_swapped_in_after_planning_is_refused(tmp_path):
    docker = Docker([])
    result, live, _, _, runs = planned(tmp_path, docker)
    outside = tmp_path / 'outside'
    runs[OLDER].rename(outside)
    try:
        runs[OLDER].symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip('Host does not permit fixture symlinks')
    with pytest.raises(ValueError, match='changed during cleanup'):
        prune.apply(result, docker=docker)
    assert (outside / 'pre-change.sqlite').exists()
