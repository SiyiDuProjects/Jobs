"""Switchable answer engines with a common extension wire contract."""
import os
from .answer_timing import database
from .legacy_answers import Answers as LegacyAnswers, INSTRUCTIONS, unique_rows
from .simple_answers import SimpleAnswers
from .answer_result import from_legacy
from .field_answers import fields_input


class Answers:
    def __init__(self, store, flow=None):
        self.store, self.flow = store, flow

    async def generate(self, payload, client=None):
        flow = self.flow or os.environ.get('JOBS_ANSWER_FLOW', 'legacy')
        if flow not in {'simple','legacy'}: raise ValueError('Invalid answer flow')
        modern = isinstance(payload,dict) and payload.get('answerProtocol') == 3
        batch = isinstance(payload,dict) and 'fields' in payload
        # Old installed clients retain their contract during staged deployment.
        if not modern and self.flow is None: flow = 'legacy'
        if flow == 'legacy':
            engine = await database(LegacyAnswers, self.store)
            response = await engine.generate(payload,client)
            if modern and batch:
                fields = {f['fieldId']:f for f in fields_input(payload)['fields']}
                response['answers'] = [from_legacy(row,fields[row['fieldId']],payload['profileId'],payload['profileVersion']) for row in response['answers']]
                response['flow'] = 'legacy'
            return response
        engine = await database(SimpleAnswers, self.store)
        if batch: return await engine.generate(payload,client)
        prompt = payload.get('prompt')
        if not isinstance(prompt,str) or not 1 <= len(prompt) <= 8000: raise ValueError('题目为空或过长')
        response = await engine.generate({**payload,'fields':[{
            'fieldId':'text','question':prompt[:2000],'description':prompt[2000:],
            'type':'textarea','required':True,'options':[]}]},client)
        row = response['answers'][0]
        if row['kind'] == 'unknown': raise ValueError(row['reasonZh'])
        return {'text':row['value'],'source':row['source'],'responseId':response['responseId'],'remaining':None,'model':response['model']}
