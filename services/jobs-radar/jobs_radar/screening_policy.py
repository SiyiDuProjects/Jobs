"""Board, MCP and model instructions share the same screening policy."""
import json
from pathlib import Path

RULES = json.loads(Path(__file__).with_name('screening-policy.json').read_text(encoding='utf-8'))
POLICY = RULES['version']
PROMPT = '\n'.join(f'{key}: {json.dumps(value, ensure_ascii=False)}' for key, value in RULES.items())


def tool_description():
    return ('Apply the shared initial screening policy below. Company membership is maintained separately; do not pass company decisions to screen_job. Preserve processed and manually kept jobs.\n' + PROMPT)
