"""The repository's single owner-operation policy, included in MCP initialization."""
from pathlib import Path


POLICY_PATH = Path(__file__).resolve().parents[1] / 'config' / 'operation-policy.md'
REFERENCE = 'Follow config/operation-policy.md, supplied in the MCP initialization instructions.'


def instructions():
    return 'Private job discovery and application records.\n\n' + POLICY_PATH.read_text(encoding='utf-8').strip()
