"""Public entry for bounded, read-only application migration accounting.

The retired eager implementation is intentionally not retained here. Both this
historical command name and the explicit stream command use the same auditor.
"""
import importlib.util
from pathlib import Path

_source = Path(__file__).with_name('reconcile_application_migration_stream.py')
_spec = importlib.util.spec_from_file_location('jobs_stream_migration_accounting', _source)
_stream = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_stream)
reconcile = _stream.reconcile
main = _stream.main

if __name__ == '__main__':
    raise SystemExit(main())
