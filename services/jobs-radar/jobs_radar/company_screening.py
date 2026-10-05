"""One persisted employer decision, tied to the exact model input and policy."""
import hashlib
import json

from .geography import screening_locations
from .screening_policy import POLICY

SOURCE_FIELDS = ('company', 'title', 'locations', 'repository', 'category', 'source_category', 'section', 'sponsorship')


def source_input(source):
    # Preserve each source's value independently. Absent sponsorship is unknown,
    # not a refusal, and must not inherit a conflicting source's label.
    return {key: source.get(key, None if key == 'sponsorship' else '') for key in SOURCE_FIELDS}


def public_input(row, reference):
    return {'id': reference, 'kind': row['kind'], 'company': row['company'], 'title': row['title'],
            'locations': screening_locations(row['all_sources']),
            'sources': [source_input(s) for s in row['all_sources']]}


def input_fingerprint(sources, kind, title):
    # Ignore source ordering/collection timestamps, but include every classification
    # field and the effective display title actually sent to the model.
    material = sorted({json.dumps(source_input(s), sort_keys=True)
                       for s in sources})
    return hashlib.sha256(json.dumps([POLICY, kind, title, material]).encode()).hexdigest()
