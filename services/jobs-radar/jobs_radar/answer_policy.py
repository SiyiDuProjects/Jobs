"""Published answer boundaries shared by the deterministic rules and AI prompt."""
import json
from pathlib import Path

POLICY = json.loads(Path(__file__).with_name("answer-policy.json").read_text(encoding="utf-8"))
COMMON_INSTRUCTIONS = POLICY["instructions"]["common"]
FIELD_INSTRUCTIONS = POLICY["instructions"]["fields"]


def needs_confirmation(state, source, requested=False):
    rules = POLICY["rules"]
    return (state != "answer" or requested is not False
            or source == "suggestion" and rules["suggestionsRequireConfirmation"]
            or source == "unknown" and rules["unknownFactsRequireConfirmation"])
