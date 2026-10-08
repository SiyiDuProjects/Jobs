from collections import namedtuple
from pathlib import Path
import importlib.util
import pytest
from jobs_radar import capacity
from jobs_radar.store import Store


def space(monkeypatch, free):
    monkeypatch.setattr(capacity.shutil,'disk_usage',lambda _:namedtuple('Space','total used free')(10**12,0,free))


def test_preflight_counts_two_copies_wal_growth_and_headroom(tmp_path,monkeypatch):
    source=tmp_path/'jobs.sqlite'; source.write_bytes(b'x'*100)
    source.with_name('jobs.sqlite-wal').write_bytes(b'x'*20)
    required=240+capacity.HEADROOM_BYTES
    space(monkeypatch,required-1)
    assert capacity.measure(source,tmp_path/'not-created')['shortfallBytes']==1
    with pytest.raises(ValueError,match='Insufficient free disk'): capacity.require_space(source,tmp_path/'not-created')
    assert not (tmp_path/'not-created').exists()
    space(monkeypatch,required)
    assert capacity.require_space(source,tmp_path)['passed']


def test_backup_refuses_before_creating_recovery_file(tmp_path,monkeypatch):
    store=Store(tmp_path/'jobs.sqlite'); space(monkeypatch,0)
    with pytest.raises(ValueError,match='Insufficient free disk'):store.backup(tmp_path/'backup.sqlite')
    assert not (tmp_path/'backup.sqlite').exists()


def test_release_backup_preflight_preserves_source_and_creates_no_recovery_point(tmp_path,monkeypatch):
    path=Path(__file__).parents[1]/'deploy/verify_restore.py'
    spec=importlib.util.spec_from_file_location('capacity_restore',path); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    source=tmp_path/'source.sqlite'; Store(source); before=source.read_bytes(); space(monkeypatch,0)
    with pytest.raises(ValueError,match='Insufficient free disk'):module.rehearse(source,tmp_path/'backup.sqlite')
    assert source.read_bytes()==before and not (tmp_path/'backup.sqlite').exists()


def test_before_transfer_check_reserves_artifact_bytes_too(tmp_path,monkeypatch):
    source=tmp_path/'jobs.sqlite';source.write_bytes(b'x'*100)
    space(monkeypatch,capacity.HEADROOM_BYTES+1200)
    assert capacity.require_space(source,tmp_path,1000)['passed']
    with pytest.raises(ValueError,match='Insufficient free disk'):
        capacity.require_space(source,tmp_path,1001)
