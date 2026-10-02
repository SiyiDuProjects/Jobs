"""Stream an SSH transfer with a bounded POSIX process group, including on Mac."""
import argparse
import os
import signal
import subprocess
import sys


def stop(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    # Also stop descendants whose parent already exited after TERM.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


def run(args, timeout):
    if os.name != 'posix':
        raise ValueError('Use macOS or WSL for full service releases')
    # Inherit streams: image archives and remote scripts are never buffered in
    # host memory, and SSH exit codes pass back to release.sh unchanged.
    process = subprocess.Popen(args, start_new_session=True)
    try:
        return process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        stop(process)
        return 124
    except BaseException:
        stop(process)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--timeout', type=float, default=3600)
    parser.add_argument('args', nargs=argparse.REMAINDER)
    options = parser.parse_args()
    args = options.args[1:] if options.args[:1] == ['--'] else options.args
    if not args or not 0 < options.timeout <= 3600:
        parser.error('Provide a command and a deadline up to 3600 seconds')
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    result = run(args, options.timeout)
    raise SystemExit(result if result >= 0 else 128 - result)


if __name__ == '__main__':
    main()
