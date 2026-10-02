import pytest

from jobs_radar.profile_migration import prepare_fact_migration, apply_fact_migration
from jobs_radar.profiles import Profiles, ProfileConflict
from jobs_radar.store import Store
from test_profile_contract import fixture


def test_migration_preserves_profile_differences_and_requires_explicit_replacement(tmp_path):
    profiles = Profiles(Store(tmp_path / "migration.sqlite"))
    first = profiles.save({**fixture(), "profileName": "Full time", "applicationData": {"sponsorshipFuture": True}})
    second = profiles.save({**fixture(), "profileName": "Intern", "applicationData": {"sponsorshipFuture": False}})
    manifest = [{"profile_id": item["id"], "expected_sync": item["last_sync"], "changes": [
        {"path": "/applicationData/willingToTravel", "value": True}]} for item in [first, second]]
    prepared = prepare_fact_migration(profiles, manifest)
    assert "willingToTravel" not in profiles.get(first["id"])["profile"]["applicationData"]
    receipt = apply_fact_migration(profiles, prepared)
    assert profiles.get(first["id"])["profile"]["applicationData"]["sponsorshipFuture"] is True
    assert profiles.get(second["id"])["profile"]["applicationData"]["sponsorshipFuture"] is False
    assert apply_fact_migration(profiles, prepared) == receipt
    current = profiles.get(second["id"])
    correction = [{"profile_id": second["id"], "expected_sync": current["last_sync"], "changes": [
        {"path": "/applicationData/sponsorshipFuture", "value": True}]}]
    with pytest.raises(ProfileConflict):
        prepare_fact_migration(profiles, correction)
    correction[0]["changes"][0]["expected"] = False
    apply_fact_migration(profiles, prepare_fact_migration(profiles, correction))
    assert profiles.get(second["id"])["profile"]["applicationData"]["sponsorshipFuture"] is True
