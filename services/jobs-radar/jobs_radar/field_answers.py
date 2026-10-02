from .answer_policy import FIELD_INSTRUCTIONS as INSTRUCTIONS, POLICY, needs_confirmation
"""Structured field answers. This contract contains no navigation commands."""
from datetime import date
import re
TYPES = {'text','textarea','email','tel','url','number','date','month','search',
         'radio','yesno','custom-radio','select-one','select-multiple','checkbox','custom-checkbox','combobox'}
CHOICES = {'radio','yesno','custom-radio','select-one','select-multiple','combobox'}

def _string(value, limit, name, empty=False):
    if not isinstance(value,str) or len(value)>limit or (not empty and not value.strip()):
        raise ValueError('Invalid '+name)
    return value

def fields_input(payload):
    source=payload.get('fields')
    if not isinstance(source,list) or not 1<=len(source)<=30: raise ValueError('字段数量须为 1–30')
    fields=[]
    for item in source:
        if not isinstance(item,dict) or item.get('type') not in TYPES or type(item.get('required')) is not bool:
            raise ValueError('Invalid field')
        field={'fieldId':_string(item.get('fieldId'),80,'fieldId'),
               'question':_string(item.get('question'),2000,'question'),
               'type':item['type'],'required':item['required'],
               'description':_string(item.get('description',''),2000,'description',True)}
        options=item.get('options',[])
        if not isinstance(options,list) or len(options)>1000: raise ValueError('Invalid options: '+field['fieldId'])
        field['options']=[{'value':_string(option.get('value'),2000,'option value'),
                           'label':_string(option.get('label'),500,'option label')} for option in options if isinstance(option,dict)]
        if len(field['options'])!=len(options): raise ValueError('Invalid options: '+field['fieldId'])
        unique={}
        for option in field['options']:
            if option['value'] in unique and unique[option['value']]['label']!=option['label']:
                raise ValueError('Ambiguous option value: '+field['fieldId'])
            unique[option['value']]=option
        field['options']=list(unique.values())
        if item['type'] in CHOICES and not options: raise ValueError('选择题缺少可用选项')
        fields.append(field)
    if len({f['fieldId'] for f in fields})!=len(fields): raise ValueError('Duplicate fields')
    context=payload.get('formContext',[])
    if not isinstance(context,list) or len(context)>150: raise ValueError('Invalid form context')
    clean=[]
    for item in context:
        if not isinstance(item,dict): raise ValueError('Invalid form context')
        clean.append({'question':_string(item.get('question'),2000,'context question'),
                      'answer':_string(item.get('answer',''),4000,'context answer',True)})
    return {'fields':fields,'formContext':clean}

def schema(fields):
    return {'type':'object','properties':{'answers':{'type':'array','items':{
        'type':'object','properties':{'fieldId':{'type':'string','enum':[f['fieldId'] for f in fields]},
            'state':{'type':'string','enum':['answer','needs_input']},
            'source':{'type':'string','enum':['profile','suggestion','unknown']},
            'needsConfirmation':{'type':'boolean'},
            'value':{'anyOf':[{'type':'string'},{'type':'boolean'},
                {'type':'array','items':{'type':'string'}},{'type':'null'}]},
            'reason':{'type':'string'},'questionZh':{'type':'string'},'answerZh':{'type':'string'}},
        'required':['fieldId','state','value','reason','source','needsConfirmation','questionZh','answerZh'],'additionalProperties':False}}},
        'required':['answers'],'additionalProperties':False}

def _exact_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        return None


def _date_fact_error(field, value, profile):
    """A provider's provenance claim cannot manufacture missing date precision."""
    if field['type'] != 'date':
        return None
    exact = _exact_date(value)
    if not exact:
        return '此题需要有效的完整日期；AI 未返回可用日期，请补充。'
    if profile is None or not POLICY['rules']['exactDatesRequireExactFacts']:
        return None
    question = field['question'] + ' ' + field.get('description', '')
    for rule in POLICY['rules']['exactDateFacts']:
        if not re.search(rule['question'], question, re.I):
            continue
        section, key = rule['profilePath'].split('.')
        records = profile.get(section, [])
        values = [_exact_date(row.get(key)) for row in records]
        # Missing and ambiguous facts both abstain. A day borrowed from another
        # education record cannot repair the incomplete record requested here.
        if not values or any(v is None for v in values) or set(values) != {exact}:
            return 'Profile 没有能支持此答案的唯一明确毕业日期；不能从月份猜测日期，请补充。'
    return None


def checked_answers(body,fields,profile=None):
    results=body.get('answers') if isinstance(body,dict) else None
    if not isinstance(results,list) or len(results)!=len(fields): raise ValueError('Luna 未完整返回每个字段')
    expected={f['fieldId']:f for f in fields};seen=set();checked=[]
    for row in results:
        if not isinstance(row,dict) or row.get('fieldId') not in expected or row['fieldId'] in seen:
            raise ValueError('Luna 返回了未知或重复字段')
        field=expected[row['fieldId']];seen.add(row['fieldId']);value=row.get('value')
        state=row.get('state');source=row.get('source','unknown')
        if source not in {'profile','suggestion','unknown'}:source='unknown'
        try:
            reason=_string(row.get('reason'),600,'reason',True)
            if state=='needs_input':
                if value is not None or not reason.strip(): raise ValueError('Invalid needs_input answer')
            elif state=='answer':
                options={o['value'] for o in field['options']};kind=field['type']
                if kind=='select-multiple':
                    valid=isinstance(value,list) and all(isinstance(v,str) and v in options for v in value) and len(set(value))==len(value) and (bool(value) or not field['required'])
                elif kind in CHOICES: valid=isinstance(value,str) and value in options
                elif kind in {'checkbox','custom-checkbox'}: valid=type(value) is bool
                else:
                    valid=isinstance(value,str) and len(value)<=4000 and (bool(value.strip()) or not field['required'] and bool(reason.strip()))
                    if valid and not value.strip(): value=''
                if not valid: raise ValueError('Invalid field value')
            else: raise ValueError('Invalid answer state')
        except ValueError:
            # Keep correctly identified, valid answers usable. Invalid values
            # stay unfilled and visible in the existing review card.
            state,value,reason='needs_input',None,'这题的 AI 答案格式或选项不符，未填入；请检查此题。其他有效答案可正常填入。'
        if state == 'answer':
            date_error = _date_fact_error(field, value, profile)
            if date_error:
                state, value, reason = 'needs_input', None, date_error
        if state=='needs_input':source='unknown'
        result={'fieldId':row['fieldId'],'state':state,'value':value,'reason':reason,'source':source,
                'needsConfirmation':needs_confirmation(state, source, row.get('needsConfirmation'))}
        # Display metadata must never invalidate a usable form answer. Older
        # clients/providers can omit it; the card then shows the actual text.
        for key,limit in [('questionZh',200),('answerZh',1000)]:
            display=row.get(key)
            if isinstance(display,str) and display.strip() and len(display)<=limit:
                result[key]=display.strip()
        if state=='needs_input':result.pop('answerZh',None)
        checked.append(result)
    return checked
