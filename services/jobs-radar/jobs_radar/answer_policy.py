"""Published answer boundaries shared by the deterministic rules and AI prompt."""
import json
import re
from pathlib import Path

POLICY = json.loads(Path(__file__).with_name("answer-policy.json").read_text(encoding="utf-8"))
COMMON_INSTRUCTIONS = POLICY["instructions"]["common"]
FIELD_INSTRUCTIONS = POLICY["instructions"]["fields"]


def needs_confirmation(state, source, requested=False, question=""):
    rules = POLICY["rules"]
    return (any(re.search(pattern, question, re.I) for pattern in rules["reviewQuestions"])
            or state != "answer" or requested is not False
            or source == "suggestion" and rules["suggestionsRequireConfirmation"]
            or source == "unknown" and rules["unknownFactsRequireConfirmation"])
