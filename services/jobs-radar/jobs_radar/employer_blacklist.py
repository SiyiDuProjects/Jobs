"""Only the owner's named company families; never infer from an industry word."""
import re
import unicodedata


def blocked_employer(name):
    normalized = re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', name or '').casefold()).strip().rstrip('.')
    return (normalized == 'general dynamics' or normalized.startswith('general dynamics ')
            or normalized in {'gdit', 'spacex', 'spacex inc', 'space exploration technologies',
                              'space exploration technologies corp'})
