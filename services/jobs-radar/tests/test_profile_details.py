import copy
import pytest

from jobs_radar.profiles import Profiles, ProfileConflict
from jobs_radar.store import Store


@pytest.mark.parametrize('field', ['willingToRelocate','willingToWorkOnsite','willingToTravel','hasRelatedPeopleAtWork'])
def test_explicit_work_preferences_preserve_boolean_and_reject_strings(field):
    from jobs_radar.profiles import Profiles
    for value in [True, False]:
        p=enriched();p['applicationData'][field]=value
        assert Profiles.profile(p)['applicationData'][field] is value
    p=enriched();p['applicationData'][field]='false'
    with pytest.raises(ValueError): Profiles.profile(p)


def profile():
    return dict(profileName='Fixture', nameData={}, addressData={}, contactData={},
                jobData=[], educationData=[dict(school='Example University', degree='Bachelor',
                fieldOfStudy='Physics', startDate='2024-08', endDate='2027-05', currentlyAttending=True)],
                languageData=[], resumeData={'fileName':'existing.pdf'}, websiteData={}, employmentData={})


def enriched():
    p=profile()
    p['educationData'][0]['graduationDate']='2027-05-17'
    p['applicationData']=dict(earliestStartDate='2027-06-01', weeklyHours='40', highestCompletedEducation='High School',
        visaStatus='User-supplied status', sponsorshipNow=False, sponsorshipFuture=True,
        salaryPreference='custom', salaryCurrency='USD', salaryPeriod='annual_base', salaryMin='90000',
        salaryMax='120000', pronouns='They/them', interviewLanguage='Python', aiNotes='Confirmed preferences.')
    return p


def test_roundtrip_complete_save_and_explicit_clear(tmp_path):
    api=Profiles(Store(tmp_path/'profiles.sqlite'))
    original=enriched()
    first=api.save(original)
    get=lambda:api.get(first['id'])
    assert get()['profile']==original
    renamed=copy.deepcopy(original);renamed['profileName']='Renamed'
    second=api.save(renamed,profile_id=first['id'],expected_sync=first['last_sync'])
    assert get()['profile']['applicationData']==original['applicationData']
    assert get()['profile']['educationData'][0]['graduationDate']=='2027-05-17'
    assert original['profileName']=='Fixture'  # Caller input remains unchanged.
    with pytest.raises(ProfileConflict):
        api.save(original,profile_id=first['id'],expected_sync=first['last_sync'])
    cleared=get()['profile'];cleared['applicationData']={};cleared['educationData'][0]['graduationDate']=''
    api.save(cleared,profile_id=first['id'],expected_sync=second['last_sync'])
    assert get()['profile']['applicationData']=={}
    assert get()['profile']['educationData'][0]['graduationDate']==''
    assert get()['profile']['educationData'][0]['endDate']=='2027-05'


def test_changed_month_does_not_resurrect_stale_day(tmp_path):
    api=Profiles(Store(tmp_path/'profiles.sqlite'))
    first=api.save(enriched())
    changed=enriched();changed['educationData'][0]['endDate']='2027-12';changed['educationData'][0].pop('graduationDate')
    api.save(changed,profile_id=first['id'],expected_sync=first['last_sync'])
    result=api.get(first['id'])['profile']
    assert 'graduationDate' not in result['educationData'][0]
    assert result['applicationData']['sponsorshipNow'] is False


@pytest.mark.parametrize('change',[
    {'sponsorshipNow':'false'}, {'sponsorshipFuture':0}, {'sponsorshipNow':None},
    {'earliestStartDate':'2027-02-30'}, {'earliestStartDate':'2027-05'},
    {'weeklyHours':40}, {'weeklyHours':False}, {'weeklyHours':'0'}, {'weeklyHours':'25 hours'}, {'weeklyHours':'41'},
    {'salaryPeriod':'monthly'}, {'salaryMin':'-1'}, {'salaryMax':'5'},
    {'salaryCurrency':'usd'}, {'salaryPreference':'other'}, {'aiNotes':'x'*8001}, {'unexpected':'x'},
])
def test_invalid_details_rejected(change):
    p=enriched();p['applicationData'].update(change)
    with pytest.raises(ValueError):Profiles.profile(p)


@pytest.mark.parametrize('value',[None,0,False,'2027-02-30','2027-06-01','2027-05'])
def test_invalid_or_mismatched_graduation_date_rejected(value):
    p=enriched();p['educationData'][0]['graduationDate']=value
    with pytest.raises(ValueError):Profiles.profile(p)


def test_old_profile_and_unknown_boolean_remain_distinct():
    p=profile();assert Profiles.profile(copy.deepcopy(p))==p
    p['applicationData']={'sponsorshipNow':False}
    assert Profiles.profile(p)['applicationData']=={'sponsorshipNow':False}


@pytest.mark.parametrize('hours',['','10','15','20','25','30','35','40'])
def test_weekly_hours_supported_choices(hours):
    p=profile();p['applicationData']={'weeklyHours':hours}
    assert Profiles.profile(p)['applicationData']['weeklyHours']==hours
