"""Structured field answers. This contract contains no navigation commands."""
from datetime import date
import re
TYPES = {'text','textarea','email','tel','url','number','date','month','search','search-choice',
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
               'description':_string(item.get('description',''),20000,'description',True)}
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
        if item['type'] == 'search-choice' and options: raise ValueError('Search query cannot include offered choices')
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

def _exact_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        return None
