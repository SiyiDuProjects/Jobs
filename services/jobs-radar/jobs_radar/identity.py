"""Conservative URL identity. Titles never authorize an automatic merge."""
import hashlib


def identity(url: str) -> str:
    from .job_match import job_key
    key=job_key(url)
    if not key: raise ValueError('Expected an identifiable public application URL')
    return key


def stable_id(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:24]
