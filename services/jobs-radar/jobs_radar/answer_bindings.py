"""Closed, independently verified question predicates; never cached answers.

A binding describes every offered option by position. It cannot supply a path,
value, quotation, code, or a new predicate. Evaluation always uses the current
bound server Profile. Unsupported qualifiers stay on the semantic verifier path.
"""
import json
from .answer_evidence import decide, facts
from .answer_semantics import cache_key, classification

BINDING_CACHE_VERSION = 2
BOOLEAN = ('true', 'false')
DISCLOSURE = (*BOOLEAN, 'undisclosed')
GENDERS = ('male', 'female', 'nonbinary', 'undisclosed')
RACES = ('asian', 'white', 'black', 'native_american', 'pacific_islander', 'multiracial', 'undisclosed')
# The tuple fixes the evidence topic and complete result domain, not prose rules.
PREDICATES = {
    'us_work_eligible': ('work_eligibility', BOOLEAN),
    'sponsorship_now': ('sponsorship', BOOLEAN),
    'sponsorship_future': ('sponsorship', BOOLEAN),
    'sponsorship_either': ('sponsorship', BOOLEAN),
    'age_at_least_18': ('age', BOOLEAN),
    'currently_enrolled': ('education', BOOLEAN),
    'voluntary_gender': ('demographics', GENDERS),
    'voluntary_race': ('demographics', RACES),
    'voluntary_hispanic': ('hispanic_latino', DISCLOSURE),
    'voluntary_current_disability': ('demographics', DISCLOSURE),
}
INSTRUCTIONS = """
Also return binding=null unless the ENTIRE public field and EVERY option are
exactly a supported closed predicate, independently of this person's answer.
A binding is public question meaning, reusable for any Profile; never encode an
answer or use the supplied personal evidence to guess the question's meaning.
Allowed predicates: us_work_eligible (ordinary current US eligibility only),
sponsorship_now, sponsorship_future, sponsorship_either (now OR future),
age_at_least_18 (>=18 now, not >18 or at a future date), currently_enrolled
(currently attending any education, without institution/degree/full-time limits),
voluntary_gender, voluntary_race, voluntary_hispanic, voluntary_current_disability.
Disclosure predicates require a voluntary self-identification question, not an
employment qualification or a separate consent to processing these answers.
Return null for ITAR/US-person/citizenship, unrestricted/permanent work rights,
veteran/protected veteran, medical or criminal history, statements, certifications,
agreements, mixed predicates, future dates, or any additional qualifier. Disability
including 'ever' or 'previously' is history and is NOT current disability.
Race options conditioned on non-Hispanic status are compound: return null.
Set options to one closed concept per option in the original order; true/false
mean the underlying POSITIVE predicate, including for a negated question. Use
unused only for a placeholder/unrelated option; never discard a qualification.
Only radio/select-one/custom-dropdown controls with complete supplied options
are executable. A binding must be fully determined by the field's question,
description, type, required flag, complete options and context.jobContext.country.
It will be reused across companies, job postings and form filling progress.
Return null if interpreting the field needs a company, job title/description,
additionalContext, formContext or another answer. Do not resolve references such
as 'the conditions above' or 'the degree required for this role' into a binding.
Those fields may still receive a verified answer for this request, without a
reusable binding. Unrelated changes elsewhere in the form do not affect a
self-contained field's binding.
"""


def binding_key(field, context, model):
    # Only independently verified, self-contained predicates use this scope.
    # The namespace excludes old context-bound plans rather than upgrading them.
    return cache_key(field, {
        'bindingVersion': BINDING_CACHE_VERSION,
        'country': context.get('jobContext', {}).get('country', ''),
    }, model)


def schema():
    return {'anyOf': [{'type': 'null'}, {'type': 'object', 'properties': {
        'predicate': {'type': 'string', 'enum': list(PREDICATES)},
        'options': {'type': 'array', 'items': {'type': 'string', 'enum': sorted(
            {'unused', *(value for _, domain in PREDICATES.values() for value in domain)})}},
    }, 'required': ['predicate', 'options'], 'additionalProperties': False}]}


def checked(binding, meaning, field):
    if (not isinstance(binding, dict) or set(binding) != {'predicate', 'options'}
            or not isinstance(binding['predicate'], str) or binding['predicate'] not in PREDICATES
            or not classification(meaning) or field['type'] not in {'radio', 'select-one', 'custom-dropdown'}):
        return None
    topic, domain = PREDICATES[binding['predicate']]
    values = binding['options']
    if (meaning['topic'] != topic or meaning['company'] not in {'', 'any'}
            or meaning['timeframe'] not in {'', 'current', 'future'}
            or not isinstance(values, list) or len(values) != len(field['options'])
            or any(not isinstance(value, str) or value not in (*domain, 'unused') for value in values)
            or any(values.count(value) > 1 for value in domain)):
        return None
    if binding['predicate'] == 'us_work_eligible' and meaning['country'] != 'US':
        return None
    if binding['predicate'].startswith('sponsorship_') and meaning['country'] != 'US':
        return None
    if binding['predicate'] not in {'sponsorship_future', 'sponsorship_either'} and meaning['timeframe'] == 'future':
        return None
    # A partially mapped yes/no question cannot be applied to a different fact.
    if domain in (BOOLEAN, DISCLOSURE) and any(value not in values for value in BOOLEAN):
        return None
    return {'predicate': binding['predicate'], 'options': list(values)}


def evaluate(predicate, profile):
    available = facts(profile)
    def boolean(path, disclosure=False):
        value = available.get(path)
        if type(value) is bool:
            return ('true' if value else 'false'), [path]
        if disclosure and value == 'undisclosed':
            return 'undisclosed', [path]
        return None
    if predicate == 'us_work_eligible':
        return boolean('employmentData.eligibilityUS')
    if predicate.startswith('sponsorship_'):
        now, future, legacy = [available.get(path) for path in (
            'applicationData.sponsorshipNow', 'applicationData.sponsorshipFuture', 'employmentData.sponsorship')]
        # Legacy sponsorship describes either time, never a specific time.
        explicit = True if now is True or future is True else False if now is False and future is False else None
        if type(legacy) is bool and explicit is not None and legacy != explicit:
            return None
        if legacy is False and (now is True or future is True):
            return None
        if predicate != 'sponsorship_either':
            return boolean('applicationData.sponsorship' + ('Now' if predicate.endswith('now') else 'Future'))
        if explicit is not None:
            paths = [path for path in ('applicationData.sponsorshipNow', 'applicationData.sponsorshipFuture')
                     if type(available.get(path)) is bool and (not explicit or available[path])]
            return ('true' if explicit else 'false'), paths
        if now is None and future is None:
            return boolean('employmentData.sponsorship')
        return None
    if predicate == 'age_at_least_18':
        value = available.get('employmentData.age')
        if isinstance(value, str) and value.isascii() and value.isdigit():
            value = int(value)
        if type(value) is int and 0 <= value <= 130:
            return ('true' if value >= 18 else 'false'), ['employmentData.age']
        return None
    if predicate == 'currently_enrolled':
        records = profile.get('educationData', [])
        paths = [f'educationData.{index}.currentlyAttending' for index in range(len(records))]
        positive = [path for path in paths if available.get(path) is True]
        if positive:
            return 'true', positive[:1]
        if paths and len(paths) <= 12 and all(available.get(path) is False for path in paths):
            return 'false', paths
        return None
    if predicate in {'voluntary_hispanic', 'voluntary_current_disability'}:
        return boolean('employmentData.' + ('hispanicOrLatino' if predicate == 'voluntary_hispanic' else 'disability'), True)
    path = 'employmentData.' + ('gender' if predicate == 'voluntary_gender' else 'ethnicity')
    value = available.get(path)
    if not isinstance(value, str):
        return None
    normalized = ' '.join(value.casefold().split())
    aliases = {'male': 'male', 'man': 'male', 'female': 'female', 'woman': 'female',
               'nonbinary': 'nonbinary', 'non-binary': 'nonbinary', 'undisclosed': 'undisclosed',
               'prefer not to disclose': 'undisclosed', 'asian': 'asian', 'white': 'white',
               'black': 'black', 'black or african american': 'black',
               'american indian or alaska native': 'native_american',
               'native hawaiian or other pacific islander': 'pacific_islander',
               'two or more races': 'multiracial'}
    concept = aliases.get(normalized)
    if concept in PREDICATES[predicate][1]:
        return concept, [path]
    return None


def answer(binding, meaning, field, profile, profile_id, version):
    binding = checked(binding, meaning, field)
    if not binding:
        return None
    result = evaluate(binding['predicate'], profile)
    if result is None or result[0] not in binding['options']:
        return None
    concept, paths = result
    option = field['options'][binding['options'].index(concept)]
    row = {'fieldId': field['fieldId'], 'state': 'answer', 'source': 'profile',
           'value': option['value'], 'reason': 'Verified question evaluated against current structured facts.',
           'evidence': [{'profilePath': path} for path in paths], 'meaning': meaning}
    result = decide(row, field, profile, profile_id, version, {'verdict': 'write', 'meaning': meaning})
    return result if result['decision'] == 'write' else None


class BindingCache:
    def __init__(self, store):
        self.store = store
        with store.connect(True) as c:
            c.execute('CREATE TABLE IF NOT EXISTS answer_bindings(key TEXT PRIMARY KEY,binding TEXT NOT NULL)')

    def read(self, fields, context, model, profile, profile_id, version, saved):
        result = {}
        with self.store.connect() as c:
            for field in fields:
                # A saved person statement can conflict with the structured fact;
                # only the existing independent verifier may resolve its scope.
                if field['fieldId'] not in saved or saved.get(field['fieldId']):
                    continue
                row = c.execute('SELECT binding FROM answer_bindings WHERE key=?', (binding_key(field, context, model),)).fetchone()
                if not row:
                    continue
                try:
                    plan = json.loads(row[0])
                    value = answer(plan['binding'], plan['meaning'], field, profile, profile_id, version)
                except (ValueError, KeyError, TypeError):
                    continue
                if value:
                    result[field['fieldId']] = value
        return result

    def save(self, fields, rows, checks, context, model, profile, profile_id, version, saved):
        rows = {row['fieldId']: row for row in rows}
        with self.store.connect(True) as c:
            for field in fields:
                fid = field['fieldId']; row = rows[fid]; check = checks.get(fid, {})
                if fid not in saved or saved.get(fid) or row.get('decision') != 'write' or check.get('verdict') != 'write':
                    continue
                binding = checked(check.get('binding'), check.get('meaning'), field)
                value = answer(binding, check['meaning'], field, profile, profile_id, version) if binding else None
                if not value or value['value'] != row['value']:
                    continue
                # No quoted fact or extra condition is promoted into a generic plan.
                if row.get('evidence') != value['evidence']:
                    continue
                c.execute('INSERT OR REPLACE INTO answer_bindings VALUES(?,?)',
                          (binding_key(field, context, model), json.dumps({'meaning': check['meaning'], 'binding': binding})))
            c.execute('DELETE FROM answer_bindings WHERE rowid NOT IN (SELECT rowid FROM answer_bindings ORDER BY rowid DESC LIMIT 4000)')
