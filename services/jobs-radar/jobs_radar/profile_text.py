"""Readable Profile facts, with enabled defaults rendered as declarations."""
import re
from .profile_contract import project_answer_profile

DECLARATIONS = {
    'government': 'I have never been employed by a government entity and have no relationship with government officials.',
    'clearance': 'I do not hold and have not held a security clearance.',
    'obligations': 'I am not bound by any non-compete, non-solicitation or other restrictive obligation.',
    'criminal': 'I have no criminal convictions, sanctions or debarments.',
    'termination': 'I have never been involuntarily terminated or suspended from employment.',
    'conflicts': 'I have no relatives at the company, conflicts of interest, or outside employment.',
    'screening': 'I am willing to undergo background checks and drug screening.',
    'referral': 'I was not referred by an employee.',
    'terms': 'I accept application terms and certify that my application information is true, accurate and complete.',
    'requirements': 'I meet the basic requirements and can perform the essential functions of the role.',
    'location': 'I am willing to relocate, commute or work on-site as required for this role.',
}
ENUM_TEXT = {
    'posted_range': 'Within the posted salary range', 'negotiable': 'Negotiable',
    'custom': 'Use the specified amount and currency', 'hourly': 'Per hour',
    'annual_base': 'Annual base salary', 'annual_total': 'Annual total compensation',
    'cis_heterosexual': 'Cisgender and heterosexual', 'undisclosed': 'Prefer not to disclose',
    'Green card': 'US lawful permanent resident (green card)',
}


def render_profile(profile):
    data = project_answer_profile(profile, partial=False)
    categories = data.get('applicationData', {}).pop('defaultAnswers', [])
    lines = []
    def visit(value, path):
        if value is None or value == '' or value == [] or value == {}: return
        if isinstance(value, dict):
            for key, child in value.items(): visit(child, [*path, re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', key)])
        elif isinstance(value, list):
            for index, child in enumerate(value): visit(child, [*path, str(index + 1)])
        else:
            text = 'Yes' if value is True else 'No' if value is False else ENUM_TEXT.get(str(value), str(value))
            lines.append(' / '.join(path) + ': ' + text)
    visit(data, [])
    if categories: lines.extend(['', 'Standard declarations:', *[DECLARATIONS[k] for k in categories if k in DECLARATIONS]])
    return '\n'.join(lines)
