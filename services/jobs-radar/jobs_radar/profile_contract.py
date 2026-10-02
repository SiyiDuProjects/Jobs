"""Profile validation and answer projection from the server-owned JSON Schema."""
from datetime import date
from decimal import Decimal
import copy
import json
from pathlib import Path
import re

from jsonschema import Draft202012Validator, FormatChecker, ValidationError, validators

SCHEMA = json.loads(Path(__file__).with_name("profile.schema.json").read_text(encoding="utf-8"))
VERSION = SCHEMA["x-version"]
ANSWER_PROJECTION = {"version": VERSION, "fields": SCHEMA["x-answerProjection"]}
FORMATS = FormatChecker()


@FORMATS.checks("optional-date")
def optional_date(value):
    if not isinstance(value, str) or not value:
        return True  # Type validation is performed by the schema.
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def invariants(validator, rules, instance, schema):
    if not isinstance(instance, dict):
        return
    for rule in rules:
        if rule["kind"] == "dateMonth":
            exact = instance.get(rule["date"])
            if isinstance(exact, str) and exact and instance.get(rule["month"]) != exact[:7]:
                yield ValidationError(rule["message"])
        elif rule["kind"] == "salary" and instance.get(rule["when"]) == rule["equals"]:
            currency = instance.get(rule["currency"], "")
            minimum = instance.get(rule["minimum"], "")
            maximum = instance.get(rule["maximum"], "")
            valid_amount = lambda value: isinstance(value, str) and bool(re.fullmatch(r"[0-9]+(?:\.[0-9]{1,2})?", value)) and Decimal(value) > 0
            if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency) or not instance.get(rule["period"]) or not valid_amount(minimum) or maximum and not valid_amount(maximum):
                yield ValidationError(rule["message"])
            elif maximum and Decimal(maximum) < Decimal(minimum):
                yield ValidationError("薪资上限不能低于下限。")


Validator = validators.extend(Draft202012Validator, {"x-invariants": invariants})
VALIDATOR = Validator(SCHEMA, format_checker=FORMATS)


def _credentials(value):
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("Invalid Profile field name")
        if any(key.lower() in SCHEMA["x-forbiddenKeys"] for key in value):
            raise ValueError("Credentials are not Profile data")
        for item in value.values():
            _credentials(item)
    elif isinstance(value, list):
        for item in value:
            _credentials(item)


def assert_profile(value):
    """Validate without coercion, defaults, truncation, or removal of fields."""
    _credentials(value)
    error = next(VALIDATOR.iter_errors(value), None)
    if error:
        path = ".".join(str(item) for item in error.absolute_path) or "Profile"
        # Do not echo offending personal values in errors/logs.
        message = error.message if error.validator == "x-invariants" else "Invalid Profile field"
        raise ValueError(f"{path}: {message}")
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    except (ValueError, TypeError):
        raise ValueError("Profile must contain valid JSON values") from None
    if len(encoded) > SCHEMA["x-maxBytes"]:
        raise ValueError("Profile exceeds 8 MB")
    return value


def project_answer_profile(value, *, partial=True):
    """Validate selected snapshot and omit binary/contact/exact-address values."""
    if not isinstance(value, dict):
        raise ValueError("Invalid answer Profile")
    policies = SCHEMA["x-answerProjection"]
    if partial and any(key not in policies or policies[key]["mode"] == "exclude" for key in value):
        raise ValueError("Invalid answer Profile")
    if partial:
        defaults = {key: [] if SCHEMA["properties"][key]["type"] == "array" else {}
                    for key in SCHEMA["required"] if key != "profileName"}
        assert_profile({**defaults, **value})
    else:
        assert_profile(value)
    result = {}
    for key, policy in policies.items():
        if key not in value or policy["mode"] == "exclude":
            continue
        result[key] = ({child: value[key][child] for child in policy["include"] if child in value[key]}
                       if policy["mode"] == "project" else value[key])
    return copy.deepcopy(result)
