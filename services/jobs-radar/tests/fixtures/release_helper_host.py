"""Run the real helper against the same private fake-Docker process fixture."""
import importlib.util
import json
import os
from pathlib import Path
import sys

source = Path(sys.argv[1])
sys.argv = sys.argv[1:]
spec = importlib.util.spec_from_file_location('helper_under_test', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
original = helper.bounded
fixture = Path(__file__).with_name('release_commands.py')
def invoke(args, **kwargs):
    state = json.loads((Path(os.environ['RELEASE_TEST_ROOT']) / 'state.json').read_text())
    if state.get('fail') == 'daemon_public_start' and args[:3] == ['docker', 'compose', 'up']:
        kwargs['timeout'] = 1
    return original([sys.executable, str(fixture), *args], **kwargs)
helper.bounded = invoke
helper.main()
