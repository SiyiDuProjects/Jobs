"""Optional board filters using explicit source locations, never eligibility claims."""
import re

CA_ALIASES = {'sf', 'san francisco', 'san francisco bay area', 'bay area',
              'silicon valley', 'los angeles', 'san diego', 'san jose',
              'santa clara', 'mountain view', 'palo alto', 'sunnyvale',
              'oakland', 'berkeley', 'sacramento', 'irvine'}


def in_california(location):
    value=re.sub(r'\s+',' ',location).strip()
    if re.search(r'\bcanad(?:a|ian)\b',value,re.I): return False
    if re.search(r'\bCalifornia,\s*MD\b',value,re.I): return False
    if re.search(r'\bCalifornia\b|(?:^|[,;/])\s*CA(?=$|[\s,;/)])',value,re.I): return True
    return re.sub(r'\s*\+\d+$','',value).casefold() in CA_ALIASES


def us_remote(location):
    # A national remote label is a candidate, not proof every state is eligible.
    value=re.sub(r'[^a-z0-9]+',' ',location.casefold()).strip()
    return value in {'remote usa','remote us','remote united states',
                     'remote in usa','remote in us','remote in united states',
                     'usa remote','us remote','united states remote'}


def matches_region(locations, region):
    if region=='': return True
    if any(in_california(x) for x in locations): return True
    if region in {'ca_remote','focus_remote'} and any(us_remote(x) for x in locations): return True
    if region=='focus_remote':
        # A broad US or missing label is unresolved, not evidence of exclusion.
        unresolved = {'', 'usa', 'us', 'u s', 'united states', 'united states of america',
                      'remote', 'tbd', 'multiple locations', 'various locations'}
        if not locations or any(re.sub(r'[^a-z0-9]+',' ',x.casefold()).strip() in unresolved for x in locations):
            return True
        for location in locations:
            if re.search(r'\b(?:Canada|Canadian)\b',location,re.I): continue
            value=re.sub(r'\s*\+\d+$','',location).strip()
            if re.search(r'(?:^|[,;/])\s*(?:WA|NY|MA|TX)(?=$|[\s,;/)])',value,re.I): return True
            if value.casefold() in {'nyc','new york city','new york','seattle','boston','washington state','massachusetts','texas','austin','dallas','houston'}: return True
    return False
