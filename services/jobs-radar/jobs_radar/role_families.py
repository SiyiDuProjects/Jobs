"""Browsing preferences, never removal or eligibility rules."""
import re

FAMILIES = {'software', 'ai_ml', 'quant', 'data_engineering', 'qa_ops_support', 'hardware', 'unknown'}


def title_family(title):
    """A provisional hint only. Verified duties override this via screen_job."""
    def has(pattern):
        return bool(re.search(pattern, title, re.I))
    if has(r'\b(?:sales|marketing|merchandise|business analyst|data analyst|data scien(?:ce|tist))\b'):
        return 'unknown'
    if has(r'\b(?:support|help\s?desk|devops|sre|site reliability|quality assurance|qa|test(?:ing)?|field service)\b'):
        return 'qa_ops_support'
    if has(r'\b(?:hardware|firmware|embedded|electrical|electronics|fpga|asic|rtl|vlsi)\b'):
        return 'hardware'
    if has(r'\bdata[\s-]+engineer(?:ing|s)?\b'):
        return 'data_engineering'
    if has(r'\b(?:quantitative|quant|trader|trading)\b'):
        return 'quant'
    if has(r'\b(?:machine learning|deep learning)\b|\b(?:AI|ML|artificial intelligence)\b.*\b(?:engineer|engineering|research|scientist|developer|development|frameworks|applications)\b|\b(?:engineer|research|scientist)\b.*\b(?:AI|ML|artificial intelligence)\b'):
        return 'ai_ml'
    if has(r'\b(?:software|developer|backend|back[ -]end|frontend|front[ -]end|full[ -]?stack|web development|mobile development|ios|android)\b'):
        return 'software'
    return 'unknown'


def classify(sources, saved, fingerprint):
    # An empty unknown classification from an earlier failed deep review must
    # not suppress the normal, explicitly provisional title hint.
    if saved and saved['fingerprint'] == fingerprint and saved['family'] != 'unknown':
        return saved['family'], 'duties' if saved['family'] != 'unknown' else 'unknown'
    hints = {title_family(s.get('title', '')) for s in sources}
    # Conflicting aliases must not silently put a role in the core selection.
    if len(hints) == 1 and 'unknown' not in hints:
        return hints.pop(), 'title'
    return 'unknown', 'unknown'
