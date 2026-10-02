"""Exercise the real POSIX streaming/deadline wrapper used for SSH uploads."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest


SCRIPT = Path(__file__).parents[1] / 'deploy/host_command.py'
pytestmark = pytest.mark.skipif(os.name != 'posix', reason='Release transport requires macOS or WSL')


def test_binary_streams_and_ssh_failure_exit_code_are_preserved():
    payload = bytes(range(256)) * 8192
    child = 'import sys; sys.stdout.buffer.write(sys.stdin.buffer.read()); sys.stderr.write("ssh failed"); sys.exit(17)'
    result = subprocess.run([sys.executable, str(SCRIPT), '--', sys.executable, '-c', child],
                            input=payload, capture_output=True, timeout=15)
    assert result.stdout == payload and result.stderr == b'ssh failed' and result.returncode == 17


@pytest.mark.parametrize('interrupt', [False, True])
def test_deadline_and_interrupt_stop_descendants_after_the_parent_exits(tmp_path, interrupt):
    marker = tmp_path / 'escaped'
    # The descendant ignores TERM; killing only SSH's parent would leave it running.
    descendant = ('import signal,time,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); '
                  f'time.sleep(1.5); pathlib.Path({str(marker)!r}).write_text("escaped"); time.sleep(30)')
    child = ('import subprocess,sys,time; '
             f'subprocess.Popen([sys.executable,"-c",{descendant!r}]); '
             'print("ready",flush=True); time.sleep(30)')
    process = subprocess.Popen([sys.executable, str(SCRIPT), '--timeout', '0.8', '--', sys.executable, '-c', child],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert process.stdout.readline().strip() == 'ready'
        if interrupt:
            process.send_signal(signal.SIGTERM)
        process.communicate(timeout=10)
        assert process.returncode == (143 if interrupt else 124)
        time.sleep(1.6)
        assert not marker.exists()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
