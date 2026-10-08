"""Versioned meanings and local, conservative entailment checks.

Classification is a hint, never personal evidence. Cache contains public field
structure only; no Profile, model prose, answers or quotations are persisted.
"""
import hashlib
import json
import re
from pathlib import Path

VOCABULARY = json.loads(Path(__file__).with_name('answer-vocabulary.json').read_text())


def normalize(value):
    return re.sub(r'[^\w]+', ' ', str(value).casefold()).strip()


def topic_for(field):
    text = normalize(field['question'] + ' ' + field.get('description', ''))
    found = [key for key, spec in VOCABULARY['topics'].items()
             if any(' ' + normalize(term) + ' ' in ' ' + text + ' ' for term in spec['terms'])]
    # These qualifiers narrow a more general topic, never the reverse.
    for specific, broad in [('unrestricted_work_right', 'work_eligibility'),
                            ('graduation_date', 'degree'), ('medical_history', 'criminal_history'), ('interview_language','language_proficiency'), ('interview_language','preference')]:
        if specific in found and broad in found:
            found.remove(broad)
    return found[0] if len(found) == 1 else 'unknown'


def classification_schema():
    return {'type': 'object', 'properties': {
        'topic': {'type': 'string', 'enum': list(VOCABULARY['topics'])},
        'country': {'type': 'string', 'enum': ['', 'US', 'CA', 'UK', 'other']},
        'company': {'type': 'string', 'enum': ['', 'current', 'named', 'any']},
        'timeframe': {'type': 'string', 'enum': ['', 'current', 'past', 'future', 'specified']},
    }, 'required': ['topic', 'country', 'company', 'timeframe'], 'additionalProperties': False}


def classification(value):
    if not isinstance(value, dict) or set(value) != {'topic', 'country', 'company', 'timeframe'}:
        return None
    if value['topic'] not in VOCABULARY['topics'] or any(not isinstance(v, str) or len(v) > 300 for v in value.values()):
        return None
    for key in ['country','company','timeframe']:
        if value[key] not in classification_schema()['properties'][key]['enum']:
            return None
    return dict(value)


def field_key(field):
    return {key: field.get(key, '' if key == 'description' else None)
            for key in ('fieldId', 'question', 'type', 'required', 'description', 'options')}


def cache_key(field, context, model):
    shape = field_key(field)
    shape.pop('fieldId')
    raw = [shape, context, VOCABULARY['version'], VOCABULARY['ruleVersion'], model]
    return hashlib.sha256(json.dumps(raw, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class MeaningCache:
    def __init__(self, store):
        self.store = store
        with store.connect(True) as c:
            c.execute('CREATE TABLE IF NOT EXISTS answer_meanings(key TEXT PRIMARY KEY, meaning TEXT NOT NULL)')

    def read(self, fields, context, model):
        with self.store.connect() as c:
            return {field['fieldId']: json.loads(row[0]) for field in fields
                    if (row := c.execute('SELECT meaning FROM answer_meanings WHERE key=?',
                                        (cache_key(field, context, model),)).fetchone())}

    def save(self, fields, rows, context, model):
        source = {row['fieldId']: row for row in rows if isinstance(row, dict) and 'fieldId' in row}
        with self.store.connect(True) as c:
            for field in fields:
                value = classification(source.get(field['fieldId'], {}).get('meaning'))
                if value:
                    c.execute('INSERT OR REPLACE INTO answer_meanings VALUES(?,?)',
                              (cache_key(field, context, model), json.dumps(value, ensure_ascii=False)))
            # Bounded deterministic cache; eviction changes cost, never truth.
            c.execute('DELETE FROM answer_meanings WHERE rowid NOT IN (SELECT rowid FROM answer_meanings ORDER BY rowid DESC LIMIT 4000)')


def canonical_option(topic, label):
    label = normalize(label)
    if topic == 'degree':
        # Descriptive duration is not a second qualification. Other suffixes
        # remain intact, including "in progress" and compound qualifications.
        label = re.sub(r'\s+\d+ years? of education$', '', label)
    groups = VOCABULARY['optionConcepts'].get(topic, {})
    matches = [key for key, aliases in groups.items() if label in map(normalize, aliases)]
    return matches[0] if len(matches) == 1 else None


def answer_label(field, value):
    if type(value) is bool:
        return 'yes' if value else 'no'
    if not isinstance(value, str):
        return None
    options = field.get('options', [])
    labels = [option['label'] for option in options if option['value'] == value]
    return labels[0] if len(labels) == 1 else value if not options else None


def direct_support(field, value, evidence, meaning):
    """Return True only for a locally established field/value relationship.

    Unknown meanings may be resolved by the model but are never auto-approved.
    Unsupported precision, country and qualification qualifiers fail closed.
    """
    topic = topic_for(field)
    if not meaning or meaning['topic'] != topic or topic == 'unknown':
        return False
    spec = VOCABULARY['topics'][topic]
    question = normalize(field['question'] + ' ' + field.get('description', ''))
    label = answer_label(field, value)
    if label is None:
        return False
    paths = [row['profilePath'] for row in evidence if 'profilePath' in row]
    if not paths or len(paths) != len(evidence):
        return False
    def accepts(path):
        normalized = re.sub(r'\.\d+\.', '.*.', path)
        return normalized in spec['paths']
    if not all(accepts(path) for path in paths):
        return False
    # No cross-country or current/future widening, even with real citations.
    if topic == 'work_eligibility':
        country = next((code for code, terms in {'US':['united states','u s','usa'], 'CA':['canada'], 'UK':['united kingdom','u k']}.items()
                        if any(' '+term+' ' in ' '+question+' ' for term in terms)), None)
        if not country or paths != ['employmentData.eligibility' + country]:
            return False
    if topic == 'sponsorship':
        now = any(word in question.split() for word in ['now', 'currently', 'current'])
        future = 'future' in question.split()
        actual = canonical_option('boolean', label)
        if now and future:
            scoped = {'applicationData.sponsorshipNow', 'applicationData.sponsorshipFuture'}
            if not set(paths) <= scoped: return False
            values = [row['value'] for row in evidence]
            return (actual == 'yes' and any(v is True for v in values) or
                    actual == 'no' and set(paths) == scoped and all(v is False for v in values))
        expected = {'applicationData.sponsorshipNow'} if now else {'applicationData.sponsorshipFuture'} if future else set()
        if set(paths) != expected:
            return False
    if topic in {'degree', 'language_proficiency'}:
        if topic == 'degree' and any(word in question.split() for word in ['completed','awarded','earned','highest']):
            if paths != ['applicationData.highestCompletedEducation']:
                return False
        if topic == 'degree':
            types = VOCABULARY['degreeCatalog']['types']
            subtype = next((labels for _level, labels in types if normalize(label) in map(normalize, labels)), None)
            if subtype and any(normalize(row['value']) not in map(normalize, subtype) for row in evidence):
                return False
        actual = canonical_option(topic, label)
        return actual is not None and all(type(row['value']) is not bool and canonical_option(topic, row['value']) == actual for row in evidence)
    if topic == 'graduation_date' and field['type'] == 'date':
        if any(not path.endswith('.graduationDate') for path in paths):
            return False
    # Compound or qualified option text cannot be reduced to its leading Yes/No.
    if all(type(row['value']) is bool for row in evidence):
        actual = canonical_option('boolean', label)
        return actual in {'yes','no'} and all(row['value'] == (actual == 'yes') for row in evidence)
    # A literal identity/status/date must survive the actual offered label.
    return all(normalize(row['value']) == normalize(label) for row in evidence)


def note_support(field, value, evidence, meaning, profile):
    """A narrow explicit-statement path; arbitrary prose still needs review.

    Scope-specific historical/medical declarations never inherit a general No.
    Whole sentences and all same-topic sentences are checked to prevent quoting
    only the favorable clause out of a contradictory or conditional statement.
    """
    topic = topic_for(field)
    if topic != 'noncompete' or not meaning or meaning['topic'] != topic:
        return False
    question = normalize(field['question'] + ' ' + field.get('description', ''))
    if set(question.split()) & {'not','never','past','previously','years','year','ever','other','nondisclosure','confidentiality'}:
        return False
    if any(char.isdigit() for char in question):
        return False
    label = canonical_option('boolean', answer_label(field, value))
    if label not in {'yes','no'} or not evidence or any('noteQuote' not in item for item in evidence):
        return False
    notes = profile.get('applicationData', {}).get('aiNotes', '')
    def statement(text):
        # A heading is structural metadata, not a negation or an extra clause.
        text = re.sub(r'^(?:employment restrictions|non[- ]?compete)\s*:\s*', '', text, flags=re.I)
        words = normalize(text)
        if any(term in words.split() for term in ['if','unless','except','previously','past','formerly','may','might','but','however']):
            return None
        match = re.fullmatch(
            r'i (?:am not subject to|have no) (?:a |any )?'
            r'(?:non compete (?:agreement|agreements|obligation|obligations)|restrictive covenants)'
            r'(?: with (?:another|any) company)?'
            r'(?P<impact> that (?:would|could) (?:affect|restrict) my employment)?', words)
        if match: return (False, bool(match['impact']))
        if words in ['no active non compete obligations','无竞业限制','没有竞业协议']:
            return (False, False)
        if words in ['i am subject to a non compete agreement','i have an active non compete agreement']:
            return (True, False)
        return None
    sentences = [text.strip() for text in re.split(r'[.!?。！？\n]+', notes) if text.strip()]
    # Providers may cite the sentence after a recognized heading, never a
    # substring that drops a condition or a contrary clause.
    without_heading = lambda text: re.sub(r'^(?:employment restrictions|non[- ]?compete)\s*:\s*', '', text, flags=re.I)
    cited = [item['noteQuote'].strip().rstrip('.。!！') for item in evidence]
    if any(not any(text == sentence or text == without_heading(sentence) for sentence in sentences)
           or statement(text) is None for text in cited):
        return False
    relevant = [text for text in sentences if any(term in normalize(text) for term in ['non compete','noncompete','restrictive covenant','竞业'])]
    expected = label == 'yes'
    impact_question = (bool(set(question.split()) & {'employment','work','duties'}) and
                       any(word.startswith(('affect','restrict','breach','violate')) for word in question.split()))
    states = [statement(text) for text in relevant]
    return bool(states) and all(state is not None and state[0] is expected and
                               (not state[1] or impact_question) and
                               (not expected or not impact_question or state[1]) for state in states)


def supported(field, value, evidence, meaning, profile):
    question = normalize(field['question'] + ' ' + field.get('description', ''))
    # Negated or comparative predicates need a separately verified relationship.
    if set(question.split()) & {'not', 'without', 'before', 'after', 'excluding'}:
        return False
    return direct_support(field, value, evidence, meaning) or note_support(field, value, evidence, meaning, profile)
