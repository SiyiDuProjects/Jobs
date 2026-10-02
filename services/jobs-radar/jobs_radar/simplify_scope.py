"""Structured Simplify scope, independent of its generated README files.

Matches the source's published scope as audited on 2026-09-28: three tracks,
summer internships in the configured cohort, and new-grad full-time roles.
Age limits are source availability rules, not the board's optional date filter.
"""
import math
from datetime import datetime, timezone


CATEGORIES = {
    **dict.fromkeys(('software', 'software engineering', 'software engineer', 'engineering',
                    'swe', 'dev', 'developer', 'backend', 'frontend', 'fullstack', 'full-stack',
                    'mobile', 'web', 'infrastructure', 'devops', 'sre'), 'Software'),
    **dict.fromkeys(('ai/ml/data', 'data & analytics', 'ai & machine learning', 'data science',
                    'data science, ai & machine learning', 'ai', 'ml', 'machine learning',
                    'data', 'analytics', 'research', 'ai/ml', 'data science & analytics'), 'AI/ML/Data'),
    **dict.fromkeys(('quant', 'quantitative finance', 'quantitative', 'finance', 'trading',
                    'investment', 'financial'), 'Quant'),
}

# Preserve the full-time source's entry-level gate. Its JSON also contains
# experienced roles that never appear in the public new-grad collection.
NEWGRAD_TERMS = ('new grad', 'early career', 'college grad', 'entry level', 'founding',
                 'early in career', 'university grad', 'fresh grad', '2024 grad', '2025 grad',
                 'engineer 0', 'engineer 1', 'engineer i ', 'junior', 'sde 1', 'sde i')
ROLE_TERMS = ('software eng', 'software dev', 'product engineer', 'fullstack engineer',
              'frontend', 'front end', 'front-end', 'backend', 'back end', 'full-stack',
              'full stack', 'founding engineer', 'mobile dev', 'mobile engineer',
              'data scientist', 'data engineer', 'research eng', 'product manag', 'apm',
              'product', 'devops', 'android', 'ios', 'sre', 'site reliability eng',
              'quantitative trad', 'quantitative research', 'quantitative dev', 'security eng',
              'compiler eng', 'machine learning eng', 'hardware eng', 'firmware eng',
              'infrastructure eng', 'embedded', 'fpga', 'circuit', 'chip', 'silicon', 'asic',
              'quant', 'quantitative', 'trading', 'finance', 'investment', 'ai &',
              'machine learning', 'ml', 'analytics', 'analyst', 'research sci')


def category_in_scope(row, kind, cohort, now):
    """Return the normalized track, or None for a well-formed excluded row."""
    if not isinstance(row, dict) or any(type(row.get(key)) is not bool for key in ('active', 'is_visible')):
        raise ValueError('Simplify invalid visibility/status; old snapshot retained')
    if not row['active'] or not row['is_visible']:
        return None
    category = row.get('category')
    if not isinstance(category, str):
        raise ValueError('Simplify category missing; old snapshot retained')
    category = CATEGORIES.get(category.strip().casefold())
    if category is None:
        return None
    posted = row.get('date_posted')
    if type(posted) not in (int, float) or not math.isfinite(posted):
        raise ValueError('Simplify posting date invalid; old snapshot retained')
    if posted > now:
        return None
    # The source excludes this company from its published scope.
    if 'https://simplify.jobs/c/jerry' in str(row.get('company_url', '')).casefold():
        return None
    age_days = int((now - posted) // 86400)
    if kind == 'internship':
        terms = row.get('terms')
        if not isinstance(terms, list) or any(not isinstance(term, str) for term in terms):
            raise ValueError('Simplify internship terms invalid; old snapshot retained')
        # The upstream summer season starts May 1 of the preceding year (07:00 UTC).
        earliest = datetime(cohort - 1, 5, 1, 7, tzinfo=timezone.utc).timestamp()
        if f'Summer {cohort}' not in terms or posted <= earliest or age_days >= 60:
            return None
    elif kind == 'newgrad':
        # The full-time repository is not cohort-named; its current source cutoff
        # is June 1, 2025. Only community submissions expire after 120 whole days.
        if posted <= 1748761200 or (row.get('source') != 'Simplify' and age_days > 120):
            return None
        if row.get('source') == 'Simplify':
            title = row.get('title')
            if not isinstance(title, str):
                raise ValueError('Simplify title invalid; old snapshot retained')
            title = title.casefold()
            if not any(term in title for term in ROLE_TERMS):
                return None
            if not any(term in title for term in NEWGRAD_TERMS) and not title.endswith('engineer i'):
                return None
    else:
        raise ValueError('Unsupported Simplify kind')
    return category
