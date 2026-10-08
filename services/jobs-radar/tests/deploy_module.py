import importlib.util
from pathlib import Path
import sys


def module(name):
    file = Path(__file__).parents[1] / 'deploy' / (name + '.py')
    if str(file.parent) not in sys.path:
        sys.path.insert(0, str(file.parent))
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
