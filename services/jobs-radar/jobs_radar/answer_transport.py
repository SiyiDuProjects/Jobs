"""Provider failures with bounded metadata, never request/response bodies."""
import json
import logging
import re
import time
import httpx
from .answer_timing import add

logger = logging.getLogger(__name__)


class AnswerProviderError(ValueError):
    def __init__(self, details):
        super().__init__('AI 服务暂时不可用，当前填写已保留')
        self.details = details


async def request_json(client, payload):
    started = time.monotonic()
    details = {}
    try:
        response = await client.post('https://api.openai.com/v1/responses', json=payload)
        details['httpStatus'] = response.status_code
        request_id = response.headers.get('x-request-id', '')
        if re.fullmatch(r'[A-Za-z0-9_-]{1,160}', request_id):
            details['providerRequestId'] = request_id
        if response.status_code != 200:
            details['category'] = 'http_error'
            raise ValueError()
        body = response.json()
        if not isinstance(body, dict):
            details['category'] = 'invalid_response'
            raise ValueError()
        if body.get('status') != 'completed':
            details['category'] = 'incomplete_response'
            reason = (body.get('incomplete_details') or {}).get('reason')
            if reason in {'max_output_tokens', 'content_filter'}:
                details['reason'] = reason
            raise ValueError()
        text = ''.join(p.get('text', '') for o in body.get('output', [])
                       for p in o.get('content', []) if p.get('type') == 'output_text')
        parsed = json.loads(text)
        if not isinstance(parsed, dict):
            details['category'] = 'invalid_response'
            raise ValueError()
        return parsed
    except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError) as error:
        category = ('read_timeout' if isinstance(error, httpx.ReadTimeout) else
                    'connect_timeout' if isinstance(error, httpx.ConnectTimeout) else
                    'timeout' if isinstance(error, httpx.TimeoutException) else
                    'transport_error' if isinstance(error, httpx.HTTPError) else
                    'invalid_json' if isinstance(error, json.JSONDecodeError) else 'invalid_response')
        details.setdefault('category', category)
        details['elapsedMs'] = round((time.monotonic() - started) * 1000)
        raise AnswerProviderError(details) from None
    finally:
        add("modelMs", time.monotonic()-started)


def record_failure(error, request_id, engine):
    details = dict(error.details) if isinstance(error, AnswerProviderError) else {'category': 'processing_error'}
    record = {'requestId': request_id, 'engine': engine, **details}
    logger.warning('answer_provider_failure %s', json.dumps(record, sort_keys=True))
    return record
