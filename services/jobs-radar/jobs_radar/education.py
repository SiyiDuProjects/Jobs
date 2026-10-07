"""Explicit doctoral-only evidence, shared by sync, model and review validation."""
import re

PHD = re.compile(r'\bph\.?\s*d\b', re.I)
POSTDOC = re.compile(r'\bpost[ -]?doc(?:toral|torate)?\b', re.I)
LOWER_DEGREE = re.compile(r"\b(?:bachelor(?:'?s)?|master(?:'?s)?|undergraduate|BSc|MSc|B\.?S\.?|M\.?S\.?)(?!\w)", re.I)


def doctoral_label(value):
    return isinstance(value, str) and re.sub(r'[^a-z]', '', value.casefold()) in {
        'phd', 'doctorate', 'doctoral', 'doctorofphilosophy'}


def restriction(sources):
    """Return (source, exact quote), or None for missing/mixed/conflicting facts.

    Postdoctoral titles are explicit occupations. For doctoral eligibility, any
    stated non-doctoral option wins over a PhD-only source. Missing degrees in
    another source are unknown, not a conflicting eligibility statement.
    """
    for source in sources:
        title = source.get('title') or ''
        if POSTDOC.search(title):
            return source, title
    for source in sources:
        title = source.get('title') or ''
        degrees = source.get('degrees') or []
        if (LOWER_DEGREE.search(title)
                or (PHD.search(title) and re.search(r'\b(?:preferred|optional)\b', title, re.I))
                or (isinstance(degrees, list) and any(not doctoral_label(d) for d in degrees))
                or (degrees and not isinstance(degrees, list))):
            return None
    for source in sources:
        title = source.get('title') or ''
        if PHD.search(title):
            return source, title
        degrees = source.get('degrees') or []
        if isinstance(degrees, list) and degrees and all(doctoral_label(d) for d in degrees):
            return source, degrees[0]
    return None
