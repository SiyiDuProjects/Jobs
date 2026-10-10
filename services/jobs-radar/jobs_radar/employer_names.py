"""Company-name equivalence and explicit, positive-only group relationships."""
import re
import unicodedata


def company_name(value):
    text = unicodedata.normalize('NFKC', str(value)).casefold()
    text = re.sub(r'[^\w\s]', ' ', text)
    text = ' '.join(text.split())
    suffix = r'\s+(?:inc|incorporated|corp|corporation|llc|ltd|limited|plc)$'
    while re.search(suffix, text):
        text = re.sub(suffix, '', text).strip()
    key = re.sub(r'[\s_]', '', text)
    return {'字节跳动': 'bytedance', '字節跳動': 'bytedance'}.get(key, key)


# https://www.bytedance.com/en/products -- this supports a positive relationship,
# not an exhaustive inventory that could prove an arbitrary employer unrelated.
GROUPS = ({'bytedance', 'tiktok'},)


def employed_by(records, argument, *, affiliates=False):
    target = company_name(argument)
    if not target or not isinstance(records, list):
        return None
    names = [company_name(row.get('company', '')) for row in records]
    if target in names:
        return 'true'
    if affiliates:
        if any(target in group and any(name in group for name in names) for group in GROUPS):
            return 'true'
        # The owner treats their recorded employment history as complete.
        # Keep incomplete records unknown, just as for a single employer.
        return None if any(not name for name in names) else 'false'
    return None if any(not name for name in names) else 'false'
