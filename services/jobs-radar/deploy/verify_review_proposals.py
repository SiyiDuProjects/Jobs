"""Explicit one-batch rehearsal with synthetic facts and no live application data."""
import argparse
import asyncio
import json
from pathlib import Path
import tempfile
import httpx
from jobs_radar.answers import Answers
from jobs_radar.profiles import Profiles
from jobs_radar.store import Store
from jobs_radar.luna_screening import api_key


async def run():
    profile = dict(profileName='Synthetic review proposals', nameData={}, addressData={},
                   contactData={}, jobData=[], educationData=[], languageData=[], resumeData={},
                   websiteData={}, skillsData=[], employmentData={'eligibilityUS':True,'sponsorship':True},
                   applicationData={'sponsorshipNow':True,'sponsorshipFuture':True,'visaStatus':'F-1',
                                    'aiNotes':'No complete government employment history or current security clearance fact is recorded.'})
    fields = [dict(fieldId='authorization', question='Work Authorization:*', type='combobox', required=True,
                   description='', options=[
                       {'value':'any','label':'I am authorized to work in this country for any employer'},
                       {'value':'present','label':'I am authorized to work in this country for my present employer only'},
                       {'value':'sponsor','label':'I require sponsorship to work in this country'}])]
    for ident, question in [
        ('export','This role requires U.S.-person status under ITAR/EAR or an approved export license. Can you provide documentation for this requirement?'),
        ('government','Were you ever previously employed by, or are you currently employed by the U.S. Government?'),
        ('clearance','Do you currently hold a Security Clearance?')]:
        fields.append(dict(fieldId=ident, question=question, type='combobox', required=True,
                           description='', options=[{'value':'yes','label':'Yes'},{'value':'no','label':'No'}]))
    with tempfile.TemporaryDirectory(prefix='synthetic-review-') as directory:
        store = Store(Path(directory)/'fixture.sqlite')
        record = Profiles(store).save(profile)
        async with httpx.AsyncClient(headers={'Authorization':'Bearer '+api_key()},timeout=60) as client:
            result = await Answers(store).generate(dict(profileId=record['id'], profileVersion=record['last_sync'],
                fields=fields, jobCountry='US', jobTitle='Software Engineer, San Diego, California',
                jobDescription='This full-time software role is located in San Diego, California, United States.',
                reviewSuggestions=True),client)
    checks = []
    for row in result['answers']:
        automatic = row['fieldId']=='authorization'
        ok = (row['decision']=='write' and row['value']=='sponsor' and not row['needsConfirmation']) if automatic else (
            row['value'] in {'yes','no'} and row.get('reviewOnly') is True and row['needsConfirmation'] is True
            and row['proof']['status']=='proposed')
        checks.append(dict(fieldId=row['fieldId'], passed=ok, decision=row['decision'],
                           reviewOnly=row.get('reviewOnly',False), proofStatus=row['proof']['status']))
    print(json.dumps(dict(syntheticOnly=True, model=result['model'], answerUsage=result['answerUsage'],
                         cases=checks, passed=all(r['passed'] for r in checks)),ensure_ascii=False))
    return all(r['passed'] for r in checks)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live',action='store_true',required=True,help='Explicitly permit one synthetic provider batch')
    parser.parse_args()
    raise SystemExit(0 if asyncio.run(run()) else 1)
