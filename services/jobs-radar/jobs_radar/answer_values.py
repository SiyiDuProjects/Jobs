"""Closed Profile computations. No model-generated personal fact enters here."""
import re
from .profile_contract import SCHEMA
from .employer_names import employed_by

BOOLEAN = ('true', 'false')
DISCLOSURE = (*BOOLEAN, 'undisclosed')
DEFAULTS = SCHEMA['x-defaultAnswers']
PATHS = {}
for group in ('nameData', 'addressData', 'contactData', 'employmentData', 'applicationData', 'websiteData'):
    for key, spec in SCHEMA['properties'][group]['properties'].items():
        if spec.get('type') in {'string', 'number', 'boolean'} or 'anyOf' in spec:
            if key not in {'aiNotes', 'identityDefaults', 'defaultAnswers'}:
                PATHS[f'{group}.{key}'] = spec
for group in ('jobData', 'educationData', 'projectData'):
    for key in SCHEMA['properties'][group]['items']['properties']:
        PATHS[f'{group}.latest.{key}'] = SCHEMA['properties'][group]['items']['properties'][key]
PATHS.update({'employmentData.citizenships': {}, 'skillsData': {}, 'websiteData.websites': {}})
for key in ('company', 'jobTitle'):
    PATHS[f'jobData.current.{key}'] = SCHEMA['properties']['jobData']['items']['properties'][key]
PREDICATES = {
    'us_work_eligible': BOOLEAN, 'sponsorship_now': BOOLEAN, 'sponsorship_future': BOOLEAN,
    'sponsorship_either': BOOLEAN, 'age_at_least_18': BOOLEAN, 'currently_enrolled': BOOLEAN,
    'voluntary_gender': ('male','female','nonbinary','undisclosed'),
    'voluntary_race': ('asian','white','black','native_american','pacific_islander','multiracial','undisclosed'),
    'voluntary_hispanic': DISCLOSURE, 'voluntary_current_disability': DISCLOSURE,
    'voluntary_veteran': DISCLOSURE, 'us_citizen': BOOLEAN, 'us_person': BOOLEAN,
    'us_permanent_work_right': BOOLEAN, 'citizen_of': BOOLEAN, 'previous_employer': BOOLEAN,
    'previous_employer_group': BOOLEAN,
    'gender_identity': ('male','female','nonbinary','undisclosed'),
    'transgender': DISCLOSURE, 'lgbtq': DISCLOSURE,
    'sexual_orientation': ('heterosexual','undisclosed'),
    **{'default.'+key: BOOLEAN for key in DEFAULTS},
    **{path: BOOLEAN if spec.get('type') == 'boolean' or any(s.get('type') == 'boolean' for s in spec.get('anyOf', [])) else () for path, spec in PATHS.items()},
    'unknown': (), 'draft.motivation': (), 'draft.preference': (), 'draft.experience': (),
}
ALIASES = {'yes':'true','no':'false','man':'male','woman':'female','non-binary':'nonbinary',
           'high school diploma/ged':'high school','high school diploma':'high school',
           "bachelor's degree":'bachelors degree',"master's degree":'masters degree',
           'i choose not to disclose':'undisclosed','prefer not to disclose':'undisclosed','prefer not to answer':'undisclosed',
           'black or african american':'black','american indian or alaska native':'native_american',
           'native hawaiian or other pacific islander':'pacific_islander','two or more races':'multiracial',
           'united states of america':'united states','usa':'united states','us':'united states',
           '美国':'united states','美國':'united states','中国':'china','中國':'china','cn':'china','can':'canada','ca':'canada','u.s.':'united states','united states citizen':'us citizen','permanent resident':'green card'}

def normalized(value):
    raw = ' '.join(str(value).casefold().split())
    return ALIASES.get(raw, raw)


COUNTRIES={normalized(v) for v in SCHEMA['x-uiOptions']['countries']} | {'united states','china','canada'}

def get(profile, path):
    value = profile
    real = []
    for part in path.split('.'):
        if part == 'current' and isinstance(value, list):
            indices = [i for i, row in enumerate(value) if row.get('currentlyWorkHere') is True]
            if len(indices) != 1: return None
            index = indices[0]
            value = value[index]; real.append(str(index))
        elif part == 'latest' and isinstance(value, list):
            if not value: return None
            def date_key(row):
                if row.get('currentlyWorkHere') or row.get('currentlyAttending'): return '9999'
                return row.get('endDate') or row.get('graduationDate') or row.get('startDate') or ''
            if len(value) > 1 and any(not date_key(row) for row in value): return None
            index = max(range(len(value)), key=lambda i: date_key(value[i]))
            value = value[index]; real.append(str(index))
        elif isinstance(value, dict):
            value = value.get(part); real.append(part)
        else: return None
    if value is None or value == '' or value == []: return None
    if isinstance(value, bool): value = 'true' if value else 'false'
    return value, ['.'.join(real)]


def evaluate(predicate, profile, argument='', *, defaults=True):
    def at(path): return get(profile, path)
    def boolean(path):
        v = at(path)
        return v if v and v[0] in DISCLOSURE else None
    app = profile.get('applicationData', {})
    emp = profile.get('employmentData', {})
    visa = normalized(app.get('visaStatus',''))
    citizenships = [normalized(v) for v in emp.get('citizenships',[])]
    if predicate in PATHS:
        fact = at(predicate)
        category = {'applicationData.willingToRelocate':'location','applicationData.willingToWorkOnsite':'location','applicationData.hasRelatedPeopleAtWork':'conflicts'}.get(predicate)
        if not fact and defaults and category:
            return evaluate('default.'+category, profile)
        return fact
    if predicate == 'us_work_eligible': return boolean('employmentData.eligibilityUS')
    if predicate.startswith('sponsorship_'):
        if predicate != 'sponsorship_either': return boolean('applicationData.sponsorship'+('Now' if predicate.endswith('now') else 'Future'))
        now, future = app.get('sponsorshipNow'), app.get('sponsorshipFuture')
        if now is True or future is True: return 'true', ['applicationData.sponsorship'+('Now' if now else 'Future')]
        if now is False and future is False: return 'false', ['applicationData.sponsorshipNow','applicationData.sponsorshipFuture']
        return boolean('employmentData.sponsorship') if now is None and future is None else None
    if predicate == 'age_at_least_18':
        value = emp.get('age')
        if type(value) in (int,str) and str(value).isascii() and str(value).isdigit() and 0 <= int(value) <= 130:
            return ('true' if int(value) >= 18 else 'false'), ['employmentData.age']
    if predicate == 'currently_enrolled':
        records = profile.get('educationData',[])
        if any(v.get('currentlyAttending') is True for v in records):
            i = next(i for i,v in enumerate(records) if v.get('currentlyAttending') is True)
            return 'true', [f'educationData.{i}.currentlyAttending']
        if records and all(v.get('currentlyAttending') is False for v in records):
            return 'false', [f'educationData.{i}.currentlyAttending' for i in range(len(records))]
    if predicate in {'us_citizen','citizen_of'}:
        country = 'united states' if predicate == 'us_citizen' else normalized(argument)
        if country in COUNTRIES and citizenships:
            if country in citizenships: return 'true', ['employmentData.citizenships']
            if all(v in COUNTRIES for v in citizenships): return 'false', ['employmentData.citizenships']
        if predicate == 'us_citizen' and visa == 'us citizen': return 'true', ['applicationData.visaStatus']
    if predicate in {'us_person','us_permanent_work_right'}:
        if 'united states' in citizenships or visa in {'us citizen','green card'}:
            return 'true', ['employmentData.citizenships'] if 'united states' in citizenships else ['applicationData.visaStatus']
        if visa in {'f-1','f-1 opt','f-1 stem opt','f-1 cpt','h-1b','j-1'} and citizenships and all(v in COUNTRIES for v in citizenships):
            return 'false', ['applicationData.visaStatus','employmentData.citizenships']
    if predicate in {'previous_employer', 'previous_employer_group'}:
        match = employed_by(profile.get('jobData'), argument, affiliates=predicate.endswith('_group'))
        return (match, ['jobData']) if match is not None else None
    disclosure_paths = {'voluntary_gender':'gender','voluntary_race':'ethnicity','voluntary_hispanic':'hispanicOrLatino','voluntary_current_disability':'disability','voluntary_veteran':'veteran'}
    if predicate in disclosure_paths:
        v = at('employmentData.'+disclosure_paths[predicate])
        if v and normalized(v[0]) in PREDICATES[predicate]: return normalized(v[0]), v[1]
    if predicate in {'gender_identity','transgender','lgbtq','sexual_orientation'}:
        preset = emp.get('identityDefaults')
        if preset == 'undisclosed': return 'undisclosed', ['employmentData.identityDefaults']
        if preset == 'cis_heterosexual':
            if predicate == 'gender_identity':
                v = evaluate('voluntary_gender',profile)
                return (v[0], [*v[1], 'employmentData.identityDefaults']) if v else None
            return ('heterosexual' if predicate == 'sexual_orientation' else 'false'), ['employmentData.identityDefaults']
    if predicate.startswith('default.'):
        category = predicate.split('.')[1]
        if defaults and category in app.get('defaultAnswers',[]):
            return ('true' if category in {'screening','terms','requirements','location'} else 'false'), ['applicationData.defaultAnswers']
    return None
