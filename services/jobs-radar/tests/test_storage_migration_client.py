"""The real extension worker and real authenticated service complete one migration."""
import json
from pathlib import Path
import subprocess
import sys
import pytest


@pytest.mark.parametrize('scenario', ['normal', 'interrupt-saga'])
def test_current_extension_worker_crosses_real_service_without_network(tmp_path, scenario):
    script = Path(__file__).with_name('storage-migration-client.mjs')
    result = subprocess.run(['node', str(script), sys.executable, str(tmp_path), scenario], text=True, encoding='utf-8', capture_output=True, timeout=90)
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report['phase'] == 'complete'
    assert report['previewRequests'] >= 4
    assert report['protectedOperationalKeys'] is True
