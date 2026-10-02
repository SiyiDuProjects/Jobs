import base64
import importlib.util
import json
from pathlib import Path
import sqlite3

import pytest

spec = importlib.util.spec_from_file_location(
    "verify_restore", Path(__file__).parents[1] / "deploy" / "verify_restore.py"
)
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


def fixture_db(path):
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE owner_profiles(profile TEXT, deleted INTEGER)")
        db.execute("INSERT INTO owner_profiles VALUES(?,0)", (json.dumps({
            "resumeData": {"resumeBase64": base64.b64encode(b"fixture-pdf").decode(), "fileSize": 11 / 1024}
        }),))
        db.execute("CREATE TABLE events(id TEXT PRIMARY KEY, body BLOB)")
        db.execute("INSERT INTO events VALUES('a', ?)", (b"private-value",))


def test_restore_preserves_rows_and_embedded_attachments_without_printing_values(tmp_path):
    source = tmp_path / "live.sqlite"
    fixture_db(source)
    before = source.read_bytes()
    result = restore.rehearse(source, tmp_path / "backups" / "recovery.sqlite")
    assert result["restore"] == "passed"
    assert result["embedded_resumes_verified"] == 1
    assert result["table_counts"] == {"events": 1, "owner_profiles": 1}
    assert "private-value" not in json.dumps(result)
    assert source.read_bytes() == before


def test_existing_destination_is_never_overwritten(tmp_path):
    source = tmp_path / "live.sqlite"
    fixture_db(source)
    target = tmp_path / "existing.sqlite"
    target.write_bytes(b"keep-me")
    with pytest.raises(ValueError, match="new, separate"):
        restore.rehearse(source, target)
    assert target.read_bytes() == b"keep-me"


def test_invalid_embedded_attachment_prevents_success(tmp_path):
    source = tmp_path / "live.sqlite"
    fixture_db(source)
    with sqlite3.connect(source) as db:
        db.execute("UPDATE owner_profiles SET profile=?", (json.dumps({
            "resumeData": {"resumeBase64": "!!!", "fileSize": 11}
        }),))
    with pytest.raises(ValueError):
        restore.rehearse(source, tmp_path / "recovery.sqlite")
