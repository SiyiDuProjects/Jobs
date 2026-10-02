"""Rehearse an online backup without loading migrations or exposing private rows."""
import argparse
import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile


@contextmanager
def readonly(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        yield connection
    finally:
        connection.close()


def fingerprint(path):
    with readonly(path) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("Database integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError("Database has broken foreign key references")
        tables = [row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )]
        counts, hashes = {}, {}
        for name in tables:
            quoted = '"' + name.replace('"', '""') + '"'
            digest = hashlib.sha256()
            row_hashes = []
            for row in db.execute("SELECT * FROM " + quoted):
                values = [
                    {"blob": base64.b64encode(value).decode("ascii")}
                    if isinstance(value, bytes) else value for value in row
                ]
                row_hashes.append(hashlib.sha256(json.dumps(
                    values, ensure_ascii=False, separators=(",", ":")
                ).encode()).digest())
            for value in sorted(row_hashes):
                digest.update(value)
            counts[name] = len(row_hashes)
            hashes[name] = digest.hexdigest()
        resumes = 0
        if "owner_profiles" in tables:
            for (raw,) in db.execute("SELECT profile FROM owner_profiles WHERE deleted=0"):
                resume = json.loads(raw).get("resumeData", {})
                encoded = resume.get("resumeBase64", "")
                if not encoded:
                    continue
                data = base64.b64decode(encoded.split(",", 1)[-1], validate=True)
                # Profile's existing fileSize contract is KiB, not bytes.
                if not data or (resume.get("fileSize") and len(data) != resume["fileSize"] * 1024):
                    raise ValueError("Stored resume failed attachment verification")
                resumes += 1
        return {"counts": counts, "hashes": hashes, "embedded_resumes": resumes}


def rehearse(source, destination):
    source = Path(source).resolve(strict=True)
    destination = Path(destination).absolute()
    if destination == source or destination.exists() or destination.is_symlink():
        raise ValueError("Backup must be a new, separate file")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    with readonly(source) as live:
        backup = sqlite3.connect(destination)
        try:
            live.backup(backup)
        finally:
            backup.close()
    return verify_backup(destination)


def verify_backup(destination):
    destination = Path(destination).resolve(strict=True)
    expected = fingerprint(destination)
    # Compare against the immutable backup, not a changing live database.
    with tempfile.TemporaryDirectory(prefix="restore-check-", dir=destination.parent) as folder:
        restored = Path(folder) / "restored.sqlite"
        shutil.copyfile(destination, restored)
        if fingerprint(restored) != expected:
            raise ValueError("Restored data differs from the backup")
    return {
        "backup": str(destination), "integrity": "ok", "restore": "passed",
        "table_counts": expected["counts"],
        "embedded_resumes_verified": expected["embedded_resumes"],
        "bytes": destination.stat().st_size,
    }


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--source", type=Path, default=os.environ.get("JOBS_DB", "/data/jobs.sqlite"))
    parser.add_argument("--verify-existing", action="store_true")
    arguments = parser.parse_args()
    result = verify_backup(arguments.destination) if arguments.verify_existing else rehearse(arguments.source, arguments.destination)
    print(json.dumps(result, sort_keys=True))
