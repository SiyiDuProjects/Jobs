"""Prepare reviewed facts for server-side Profile migration without guessing facts.

Manifest values must be provided from confirmed source material. This module
does not parse prose, infer immigration answers, or write local Profile copies.
The normal Profile save boundary performs every eventual write.
"""
import copy

from .profiles import ProfileConflict

MISSING = object()


def prepare_fact_migration(profiles, manifest):
    if not isinstance(manifest, list) or not manifest:
        raise ValueError("A nonempty reviewed migration manifest is required")
    prepared = []
    seen = set()
    for item in manifest:
        if not isinstance(item, dict) or set(item) != {"profile_id", "expected_sync", "changes"}:
            raise ValueError("Invalid migration entry")
        record = profiles.get(item["profile_id"])
        if record["id"] in seen:
            raise ValueError("Duplicate Profile in migration manifest")
        seen.add(record["id"])
        if item["expected_sync"] != record["last_sync"]:
            raise ProfileConflict("Migration Profile version changed")
        value = copy.deepcopy(record["profile"])
        changes = item["changes"]
        if not isinstance(changes, list) or not changes:
            raise ValueError("Reviewed field changes are required")
        paths = []
        for change in changes:
            if not isinstance(change, dict) or set(change) - {"path", "value", "expected"} or "value" not in change:
                raise ValueError("Invalid field change")
            path = change.get("path")
            if not isinstance(path, str) or not path.startswith("/") or path in paths:
                raise ValueError("A unique JSON pointer is required")
            keys = [part.replace("~1", "/").replace("~0", "~") for part in path[1:].split("/")]
            if any(key in {"", "__proto__", "prototype", "constructor"} for key in keys):
                raise ValueError("Invalid field path")
            target = value
            for key in keys[:-1]:
                if isinstance(target, list):
                    target = target[int(key)]
                elif isinstance(target, dict):
                    target = target.setdefault(key, {})
                else:
                    raise ValueError("Field parent must be a record")
            key = int(keys[-1]) if isinstance(target, list) else keys[-1]
            old = target[key] if isinstance(target, list) else target.get(key, MISSING)
            if old is not MISSING and old != change["value"] and old not in (None, ""):
                if "expected" not in change or old != change["expected"]:
                    raise ProfileConflict("A populated field requires its exact previous value: " + path)
            target[key] = copy.deepcopy(change["value"])
            paths.append(path)
        profiles.profile(value)
        prepared.append({"profile_id": record["id"], "expected_sync": record["last_sync"], "profile": value, "paths": paths})
    return prepared


def apply_fact_migration(profiles, prepared):
    """Apply prepared versions in order; optimistic checks protect concurrent edits.

    A caller must keep returned receipts if applying multiple Profiles. Re-running
    with identical prepared values is idempotent; no source facts are logged.
    """
    results = []
    for item in prepared:
        receipt = profiles.save(item["profile"], profile_id=item["profile_id"], expected_sync=item["expected_sync"])
        results.append({**receipt, "changed_paths": item["paths"]})
    return results
