"""Transactional release migration; detailed reports stay with the private database."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile

from jobs_radar.application_schema import _migrate as applications, table_exists
from jobs_radar.diagnostic_migration import migrate as diagnostics
from jobs_radar.profile_contract import assert_profile
from jobs_radar.submission_reporting_migration import migrate as submission_reporting


def migrate(database, *, dry_run=True):
    database = Path(database).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='release-rehearsal-', dir=database.parent) as folder:
        target = Path(folder) / 'isolated.sqlite' if dry_run else database
        if dry_run:
            with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as source:
                with closing(sqlite3.connect(target)) as copy:
                    source.backup(copy)
        with closing(sqlite3.connect(target)) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute('PRAGMA foreign_keys=ON')
            connection.execute('BEGIN IMMEDIATE')
            try:
                profiles = 0
                if table_exists(connection, 'owner_profiles'):
                    for row in connection.execute('SELECT profile FROM owner_profiles WHERE deleted=0'):
                        assert_profile(json.loads(row['profile']))
                        profiles += 1
                report = {'applications': applications(connection), 'submissionReporting': submission_reporting(connection), 'diagnostics': diagnostics(connection),
                          'profilesValidated': profiles, 'dryRun': dry_run}
                if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or connection.execute('PRAGMA foreign_key_check').fetchone():
                    raise ValueError('Migrated database integrity failed')
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        return report


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.apply and not (args.database.parent / '.release-maintenance').is_file():
        raise ValueError('Writes must be paused before an applied release migration')
    report = migrate(args.database, dry_run=not args.apply)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'dryRun': report['dryRun'], 'profilesValidated': report['profilesValidated'],
                      'applications': report['applications'].get('applications'),
                      'events': report['applications'].get('events'),
                      'nativeSubmissionsRestored': report['submissionReporting']['changed'],
                      'diagnosticRuns': report['diagnostics']['runsRedacted'], 'integrity': 'ok'}))


if __name__ == '__main__':
    main()
