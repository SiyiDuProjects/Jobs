"""The provider error must remain diagnosable without storing applicant data."""
import asyncio
import json
import httpx
import pytest
from jobs_radar.answer_transport import request_json, record_failure, AnswerProviderError
from jobs_radar.answers import Answers
from test_answers import setup, field

SECRET = 'PRIVATE_APPLICANT_TEXT_DO_NOT_LOG'

class Client:
    def __init__(self, response): self.response = response
    async def post(self, url, json):
        if isinstance(self.response, Exception): raise self.response
        return self.response

@pytest.mark.parametrize('response,category,status', [
    (httpx.ReadTimeout(SECRET), 'read_timeout', None),
    (httpx.ConnectTimeout(SECRET), 'connect_timeout', None),
    (httpx.ConnectError(SECRET), 'transport_error', None),
    (httpx.Response(429, text=SECRET, headers={'x-request-id':'req_test'}), 'http_error', 429),
    (httpx.Response(200, text=SECRET), 'invalid_json', 200),
    (httpx.Response(200, json={'status':'incomplete','incomplete_details':{'reason':'max_output_tokens'},'output':SECRET}), 'incomplete_response', 200),
    (httpx.Response(200, json={'status':'completed','output':[{'content':[{'type':'output_text','text':SECRET}]}]}), 'invalid_json', 200),
])
def test_failure_metadata_is_safe_and_specific(response, category, status, caplog):
    with pytest.raises(AnswerProviderError) as caught:
        asyncio.run(request_json(Client(response), {'input':SECRET}))
    record = record_failure(caught.value, 'synthetic-request', 'legacy')
    assert record['category'] == category
    assert record.get('httpStatus') == status
    assert record['elapsedMs'] >= 0
    if status == 429: assert record['providerRequestId'] == 'req_test'
    assert SECRET not in caplog.text + json.dumps(record) + str(caught.value)

@pytest.mark.parametrize('flow', ['legacy', 'simple'])
def test_both_engines_preserve_diagnostics_and_unknown_result(tmp_path, caplog, flow):
    a,p = setup(tmp_path)
    reply = asyncio.run(Answers(a.store, flow=flow).generate({**p, 'answerProtocol':3,'fields':[field()]}, Client(httpx.ReadTimeout(SECRET))))
    assert reply['answers'][0]['interruptionReason'] == 'ai_unavailable'
    diagnostic = reply['answerDiagnostics'][0]
    assert diagnostic['category'] == 'read_timeout'
    assert diagnostic['engine'] == flow and diagnostic['requestId'] == reply['responseId']
    assert SECRET not in caplog.text + json.dumps(reply)
