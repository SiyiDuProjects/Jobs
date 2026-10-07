"""Explicit source restrictions only; absent/Other never means a refusal."""
import re

LABELS = {'Does Not Offer Sponsorship':'no_sponsorship', 'U.S. Citizenship is Required':'citizenship'}


def restriction(sources):
    # A missing SpeedyApply field does not contradict an explicit Simplify label.
    # Positive and negative explicit labels do conflict and require clarification.
    if any(s.get('sponsorship')=='Offers Sponsorship' for s in sources):
        return None
    for label, reason in reversed(tuple(LABELS.items())):
        for source in sources:
            if source.get('sponsorship')==label:
                return source,label,reason
    return None


def title_citizenship(title):
    return bool(re.search(r'\bU\.?S\.?\s+Citizen(?:ship|s)?\s*(?:is\s+)?(?:[-–—:]\s*)?(?:Required|Only)\b',title,re.I))
