"""Capture exact cumulative token telemetry or compare it to a saved baseline."""
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output')
    parser.add_argument('--compare')
    parser.add_argument('--session', default='01a0859f-4b42-7653-8c52-91ebb7b4733b')
    parser.add_argument('--sessions-dir', type=Path,
                        default=Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex') / 'sessions')
    args = parser.parse_args()
    snapshots = {}
    for path in args.sessions_dir.expanduser().rglob('*' + args.session + '*.jsonl'):
        for line in path.open(encoding='utf-8'):
            event = json.loads(line)
            payload = event.get('payload', {})
            if event.get('type') == 'event_msg' and payload.get('type') == 'token_count' and payload.get('info'):
                snapshots[path.name] = {'timestamp': event['timestamp'], **payload['info']['total_token_usage']}
    report = {'captured_at': datetime.now(timezone.utc).isoformat(), 'session': args.session, 'files': snapshots}
    if args.compare:
        old = json.loads(Path(args.compare).read_text(encoding='utf-8'))['files']
        keys = ('input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens')
        delta = {key: sum(row[key] - old.get(name, {}).get(key, 0) for name, row in snapshots.items()) for key in keys}
        if any(value < 0 for value in delta.values()):
            raise ValueError('Counter reset; reconcile telemetry before reporting')
        delta['uncached_input_tokens'] = delta['input_tokens'] - delta['cached_input_tokens']
        report['delta'] = delta
        report['note'] = 'Input includes cached input; reasoning is a subset of output. Counts may lag the current tool call. No cost estimate.'
    Path(args.output).write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
