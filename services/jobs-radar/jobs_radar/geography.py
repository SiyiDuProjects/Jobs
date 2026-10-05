"""Source-location screening and optional board region filters."""
import re
import json
from pathlib import Path

# Reuse the static country vocabulary, never a person's Profile. Ambiguous US
# state names and US territories cannot prove that a location is foreign.
_COUNTRIES = json.loads(Path(__file__).with_name('profile.schema.json').read_text())['x-uiOptions']['countries']
_US_OR_AMBIGUOUS = {'Georgia', 'Jersey', 'United States of America',
                    'United States Minor Outlying Islands', 'U. S. Virgin Islands',
                    'American Samoa', 'Guam', 'Northern Mariana Islands', 'Puerto Rico'}
_FOREIGN = re.compile(r'(?<!\w)(?:' + '|'.join(re.escape(c) for c in
    [c for c in _COUNTRIES if c not in _US_OR_AMBIGUOUS] +
    ['UK', 'U.K.', 'GB', 'GBR', 'Great Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland',
     'South Korea', 'Republic of Korea', 'Czech Republic', 'Turkey', 'UAE']) + r')(?!\w)', re.I)
_US = re.compile(r'\b(?:USA|US|United States|U\.?\s*S\.?(?:\s*A\.?)?)\b|'
    r'(?:^|[,;/])\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)(?=$|[\s,;/)])|'
    r'\b(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|District of Columbia|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington State|West Virginia|Wisconsin|Wyoming|Puerto Rico|Guam|American Samoa|Northern Mariana Islands)\b', re.I)
_UNRESOLVED = re.compile(r'\+\s*\d+|\b(?:unknown|TBD|worldwide|global|international|multiple locations|various locations|other locations)\b', re.I)


def screening_locations(sources):
    # A source without locations is unresolved; do not silently discard it.
    return [loc for source in sources for loc in (source.get('locations') or [''])]


def non_us_only(locations):
    """True only when every listed location explicitly identifies a foreign country."""
    if not locations: return False
    for location in locations:
        if not isinstance(location, str) or _US.search(location) or _UNRESOLVED.search(location): return False
        parts = re.split(r'[/;|\n]|\s+and\s+', location, flags=re.I)
        if any(not _FOREIGN.search(part) for part in parts): return False
    return True

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
