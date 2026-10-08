"""Shared bounded input validators for diagnostics and compatibility transport."""
import re
from urllib.parse import parse_qsl, urlsplit

class ControlConflict(ValueError):
    pass


def shape(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or set(required) - set(value):
        raise ValueError('Invalid browser control shape')
    return value


def text(value, limit=200, *, empty=False):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()) or '\x00' in value:
        raise ValueError('Invalid browser control text')
    # Never store obvious credential material, even when mislabeled as a title.
    if re.search(r'\b(?:Bearer\s+\S{8,}|sk-(?:proj-)?[\w-]{16,})', value, re.I):
        raise ValueError('Credentials are not browser control data')
    return value


def integer(value, maximum=2**53 - 1, minimum=0):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('Invalid browser control integer')
    return value


def boolean(value):
    if type(value) is not bool:
        raise ValueError('Invalid browser control boolean')
    return value


def sequence(value, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError('Invalid browser control list')
    return value


def safe_url(value):
    from .public_job_url import SENSITIVE, posting_token
    text(value, 3000)
    try:
        parsed = urlsplit(value)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
            raise ValueError('Only credential-free HTTPS page URLs are allowed')
        for key, part in parse_qsl(parsed.query, keep_blank_values=True) + parse_qsl(parsed.fragment, keep_blank_values=True):
            if SENSITIVE.search(key) and not posting_token(parsed.hostname, key, part):
                raise ValueError('Credential-bearing page URL')
    except (TypeError, ValueError) as error:
        raise ValueError('Invalid or credential-bearing page URL') from error
    return value

