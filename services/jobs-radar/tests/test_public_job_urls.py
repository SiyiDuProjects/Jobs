import json
from pathlib import Path

import pytest

from jobs_radar.job_match import job_key
from jobs_radar.public_job_url import public_job_url
from jobs_radar.browser_control import safe_url

EXAMPLES = json.loads((Path(__file__).parent / 'fixtures' / 'public_job_urls.json').read_text())


@pytest.mark.parametrize('example', EXAMPLES)
def test_shared_public_url_examples(example):
    if example['publicUrl'] is None:
        with pytest.raises(ValueError):
            public_job_url(example['url'])
    else:
        value = public_job_url(example['url'])
        assert value == example['publicUrl']
        assert job_key(value) == example['jobKey'] == job_key(example['url'])
        assert safe_url(value) == value


def test_browser_observation_can_read_an_unidentified_page_without_private_parameters():
    assert safe_url('https://example.wd1.myworkdayjobs.com/apply')
    for suffix in ['?session=secret', '?token=secret', '?phone=5555555555', '?credential=x']:
        with pytest.raises(ValueError):
            safe_url('https://example.wd1.myworkdayjobs.com/apply' + suffix)
