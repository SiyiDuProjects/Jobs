"""The same fabricated cases exercise Python and both generated JS boundaries."""
import copy
import json
from pathlib import Path
import subprocess

import pytest

from jobs_radar.profile_contract import SCHEMA, assert_profile, project_answer_profile


def fixture():
    return {"profileName": "Fixture", **{key: [] if value["type"] == "array" else {}
            for key, value in SCHEMA["properties"].items() if key in SCHEMA["required"] and key != "profileName"}}


def cases():
    base = fixture()
    values = [("empty facts", base, True)]
    changes = [
        ("false is known", {"applicationData": {"sponsorshipNow": False}}, True),
        ("missing stays unknown", {"applicationData": {}}, True),
        ("null is not false", {"applicationData": {"sponsorshipNow": None}}, False),
        ("string is not boolean", {"applicationData": {"sponsorshipNow": "false"}}, False),
        ("number is not boolean", {"applicationData": {"sponsorshipNow": 0}}, False),
        ("exact leap day", {"applicationData": {"earliestStartDate": "2028-02-29"}}, True),
        ("nonexistent day", {"applicationData": {"earliestStartDate": "2027-02-29"}}, False),
        ("unknown day", {"applicationData": {"earliestStartDate": "2027-05"}}, False),
        ("matching education date", {"educationData": [{"endDate": "2027-05", "graduationDate": "2027-05-17"}]}, True),
        ("contradictory education date", {"educationData": [{"endDate": "2027-05", "graduationDate": "2027-06-17"}]}, False),
        ("new unknown property preserved", {"nameData": {"nativeName": "Synthetic value"}}, True),
        ("credentials nested in extra data", {"nameData": {"extra": {"api_key": "synthetic-secret"}}}, False),
        ("unknown root", {"someOtherRoot": {}}, False),
        ("bad root", {"skillsData": False}, False),
        ("schema version is metadata", {"schema_version": 100}, False),
    ]
    salary = dict(salaryPreference="custom", salaryCurrency="USD", salaryPeriod="annual_base", salaryMin="90000", salaryMax="110000")
    for name, change, valid in changes:
        values.append((name, {**copy.deepcopy(base), **change}, valid))
    for name, change, valid in [
        ("salary valid", {}, True), ("salary equal", {"salaryMax": "90000.00"}, True),
        ("salary inverted", {"salaryMax": "89999.99"}, False),
        ("salary invalid currency", {"salaryCurrency": "usd"}, False),
        ("salary missing period", {"salaryPeriod": ""}, False),
        ("salary zero", {"salaryMin": "000.00"}, False),
        ("salary precision", {"salaryMin": "1.001"}, False),
        ("salary exact high precision", {"salaryMin": "9007199254740992.99", "salaryMax": "9007199254740992.98"}, False),
    ]:
        values.append((name, {**copy.deepcopy(base), "applicationData": {**salary, **change}}, valid))
    return values


@pytest.mark.parametrize("name,value,valid", cases(), ids=[case[0] for case in cases()])
def test_server_schema(name, value, valid):
    original = copy.deepcopy(value)
    if valid:
        assert assert_profile(value) == original
    else:
        with pytest.raises(ValueError) as error:
            assert_profile(value)
        assert "synthetic-secret" not in str(error.value)
    assert value == original


def test_both_generated_runtimes_match_server():
    root = Path(__file__).resolve().parents[1]
    script = """
import fs from 'node:fs';
const {JobsProfileContract}=await import(process.argv[1]);
const values=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(values.map(value=>JobsProfileContract.validate(value).valid)));
"""
    for output in [root / "web/src/manage/profile-contract.js", root.parents[1] / "extensions/speedyapply-local/src/custom/profile-contract.js"]:
        process = subprocess.run(["node", "--input-type=module", "-e", script, output.as_uri()],
                                 input=json.dumps([value for _, value, _ in cases()]), text=True, capture_output=True, check=True)
        assert json.loads(process.stdout) == [valid for _, _, valid in cases()]


def test_projection_omits_binary_and_preserves_false_without_mutation():
    value = fixture()
    value.update(resumeData={"resumeBase64": "synthetic-binary"}, contactData={"email": "fixture@example.test"},
                 addressData={"line1": "Synthetic street", "city": "Example City"},
                 applicationData={"sponsorshipNow": False})
    original = copy.deepcopy(value)
    projected = project_answer_profile(value, partial=False)
    assert "resumeData" not in projected and "contactData" not in projected
    assert projected["addressData"] == {"city": "Example City"}
    assert projected["applicationData"] == {"sponsorshipNow": False}
    assert value == original
