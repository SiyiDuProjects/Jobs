"""Public question mappings and deterministic answers, shared with corpus replay."""
import hashlib
import json
import re
from .answer_values import PREDICATES, PATHS, DEFAULTS, BOOLEAN, DISCLOSURE, evaluate, normalized
from .answer_semantics import field_key
from .field_answers import CHOICES, _exact_date

BINDING_CACHE_VERSION = 6
INSTRUCTIONS = '''Map each public question to exactly one supported Profile path, computed predicate,
default category, draft intent, or unknown. You never answer a personal fact.
Do not infer an answer from the job, other questions, option IDs or typical applicants.
A route must cover the ENTIRE question including every qualifier and description.
Mixed predicates, unsupported countries, conditions, histories, timeframes and
ambiguous references are unknown. Map ordinary US eligibility to us_work_eligible;
unrestricted/permanent rights to us_permanent_work_right; ITAR US-person to us_person;
citizenship to us_citizen/citizen_of. Current disability is not disability history;
protected veteran is not generic veteran. Do not discard these distinctions.
Use direct Profile paths for personal facts including relocation, onsite and sponsorship.
Use default categories for government employment/official relations, clearance,
restrictive obligations, criminal/sanctions/debarment, termination, conflicts,
screening, referral, application terms/accuracy, minimum qualifications/core duties,
and willingness to commute/relocate/onsite only. Do not generalize to other commitments.
previous_employer means EVER employed by a named company, including current employment.
Use previous_employer_group only when the question explicitly includes that company's
affiliates, subsidiaries or parent companies. Do not silently broaden a single company.
Its argument must be the company name verbatim from the public question/context;
citizen_of argument must be the country name verbatim. Other arguments are empty.
Use jobData.current.company/jobTitle for CURRENT employment only; jobData.latest
is for the most recent employment, which may have ended. Current or most recent
explicitly permits latest. Missing current employment is not the latest past job.
For choices, map EVERY option in its original order to the underlying positive
predicate concept (true/false), including negated questions. unused is only for
an actual placeholder or unrelated choice. For direct paths map options to the
canonical value of that field. Never invent an option or use its opaque value.
For boolean checkbox or free text, options=[]; polarity=true means positive,
false means the boolean statement is negated. Do not negate non-boolean facts.
No binding if option labels are ambiguous or the question cannot be expressed exactly.
Only use draft.motivation, draft.preference or draft.experience for open prose
requests for motivation, preferences or an experience narrative. Text boxes asking
for facts (date, citizenship, visa, pay, employer, a count, contact, etc.) MUST use
an existing field/predicate or unknown; never draft. No AI notes as a factual source.
Return a row for each field. unknown is an explicit result, never a guessed default.
'''


def recognition_context(context):
    context = dict(context)
    raw = context.get('additionalContext', '')
    try: parsed = json.loads(raw)
    except (ValueError, TypeError): return context
    if isinstance(parsed, dict):
        for key in ('currentLocalDate', 'timeZone'): parsed.pop(key, None)
        context['additionalContext'] = json.dumps(parsed, sort_keys=True, ensure_ascii=False) if parsed else ''
    return context


def binding_key(field, context, model):
    context = recognition_context(context)
    shape = field_key(field); shape.pop('fieldId')
    shape['options'] = [normalized(option['label']) for option in field.get('options',[])]
    # Posting IDs never affect a question's meaning. Keep public explanatory
    # context because relative company/country references can depend on it.
    scope = {'country':context.get('jobContext',{}).get('country','')}
    raw = [BINDING_CACHE_VERSION, model, shape, scope, context.get('additionalContext','')]
    return hashlib.sha256(json.dumps(raw,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def schema():
    return {'type':'object','properties':{
        'predicate':{'type':'string','enum':list(PREDICATES)},
        'options':{'type':'array','items':{'type':'string'}},
        'argument':{'type':'string'}, 'polarity':{'type':'boolean'},
    },'required':['predicate','options','argument','polarity'],'additionalProperties':False}


def checked(binding, meaning, field, context=None):
    if not isinstance(binding,dict) or set(binding)-{'predicate','options','argument','polarity'}:
        return None
    route=binding.get('predicate'); choices=binding.get('options')
    if not isinstance(route,str) or route not in PREDICATES or not isinstance(choices,list): return None
    if route == 'unknown':
        return {'predicate':'unknown','options':['unused']*len(field.get('options',[])),'argument':'','polarity':True}
    question = (field['question'] + ' ' + field.get('description','')).casefold()
    if route == 'voluntary_current_disability' and re.search(r'\b(ever|had|past|history|previously)\b', question+' '+' '.join(o['label'].casefold() for o in field.get('options',[]))):
        return None  # A current-only fact cannot answer a lifetime-history question.
    if route == 'previous_employer' and re.search(r'\b(affiliates?|subsidiar\w*|parent compan\w*)\b|关联公司|子公司|母公司|旗下', question):
        route = 'previous_employer_group'
    if route.startswith('jobData.latest.') and re.search(r'\bcurrent(?:ly)?\b|当前|目前|现任', question) and not re.search(r'\b(most recent|latest|last)\b|最近|上一', question):
        current_route = route.replace('.latest.', '.current.')
        if current_route not in PATHS: return None
        route = current_route
    if route == 'default.location':
        if re.search(r'\brelocat\w*\b',question): route='applicationData.willingToRelocate'
        elif re.search(r'\b(on.?site|in.?office)\b',question): route='applicationData.willingToWorkOnsite'
    if route == 'default.conflicts' and re.search(r'\b(relatives?|related people|family members?)\b',question):
        route='applicationData.hasRelatedPeopleAtWork'
    if not all(isinstance(v,str) and len(v)<=500 for v in choices) or len(choices)!=len(field.get('options',[])): return None
    labels=[normalized(o['label']) for o in field.get('options',[])]
    if len(set(labels))!=len(labels): return None
    domain=PREDICATES[route]
    if domain and any(v not in (*domain,'unused') for v in choices): return None
    # Several qualified Yes options do not make a unique No ambiguous.
    # field_value checks uniqueness for the person's actual answer.
    if domain in (BOOLEAN,DISCLOSURE) and choices and not all(v in choices for v in BOOLEAN): return None
    arg=binding.get('argument',''); polarity=binding.get('polarity',True)
    if not isinstance(arg,str) or len(arg)>300 or type(polarity) is not bool: return None
    if route in {'previous_employer','previous_employer_group','citizen_of'}:
        if not arg.strip(): return None
        if context is not None:
            public=' '.join([field['question'],field.get('description',''),context.get('additionalContext','')])
            if normalized(arg) not in normalized(public): return None
    elif arg: return None
    if not polarity and domain not in (BOOLEAN,DISCLOSURE): return None
    if route.startswith('draft.') and (field['type'] not in {'text','textarea'} or choices): return None
    return {'predicate':route,'options':choices,'argument':arg,'polarity':polarity}


def result(field, profile_id, version, value=None, paths=(), *, draft=False, reason='', route='unknown', interruption='missing_fact'):
    decision='ask' if value is None else 'draft' if draft else 'write'
    proof={'version':2,'vocabularyVersion':BINDING_CACHE_VERSION,'profileId':profile_id,'profileVersion':version,
           'field':field_key(field),'value':value,'status':'unverified' if value is None else 'verified',
           'paths':list(paths),'id':hashlib.sha256(json.dumps([field,value,list(paths)],sort_keys=True,ensure_ascii=False).encode()).hexdigest()[:24]}
    row={'fieldId':field['fieldId'],'state':'needs_input' if value is None else 'answer','value':value,
         'source':'unknown' if value is None else 'suggestion' if draft else 'profile',
         'decision':decision,'needsConfirmation':value is None or draft,'proof':proof,'reason':reason,
         'route':route,'evidence':[{'profilePath':p} for p in paths]}
    if value is None:
        row['interruptionReason'] = interruption
        if interruption == 'missing_fact': row['missingField'] = route
    return row


def field_value(value, field, binding=None):
    """Transport shape and precision, independent of provider claims."""
    kind=field['type']; options=field.get('options',[])
    if binding and options:
        values=value if isinstance(value,list) else [value]
        selected=[]
        for concept in values:
            matches=[o['value'] for o,c in zip(options,binding['options']) if c!='unused' and normalized(c)==normalized(concept)]
            if len(matches)!=1: return None
            selected.append(matches[0])
        return selected if kind=='select-multiple' else selected[0] if len(selected)==1 else None
    if options:
        values=value if isinstance(value,list) else [value]
        selected=[]
        for v in values:
            matches=[o['value'] for o in options if normalized(o['label'])==normalized(v)]
            if len(matches)!=1: return None
            selected.append(matches[0])
        return selected if kind=='select-multiple' else selected[0] if len(selected)==1 else None
    if kind in CHOICES: return None
    if kind in {'checkbox','custom-checkbox'}:
        if value not in ('true','false',True,False): return None
        return value in ('true',True)
    if isinstance(value,list): value=', '.join(str(v) for v in value)
    if isinstance(value,bool): value='Yes' if value else 'No'
    elif value=='true': value='Yes'
    elif value=='false': value='No'
    if not isinstance(value,(str,int,float)): return None
    value=str(value)
    if not value.strip() or len(value)>4000: return None
    if kind=='date' and not _exact_date(value): return None
    if kind=='month':
        value=value[:7]
        if not re.fullmatch(r'\d{4}-(0[1-9]|1[012])',value): return None
    if kind=='number' and not re.fullmatch(r'-?\d+(?:\.\d+)?',value): return None
    return value


def answer(binding, meaning, field, profile, profile_id, version, *, defaults=True):
    binding=checked(binding,meaning,field)
    if not binding: return None
    route=binding['predicate']
    fact=evaluate(route,profile,binding['argument'],defaults=defaults)
    if fact is None: return None
    value,paths=fact
    if route == 'applicationData.salaryPreference':
        if value == 'custom': return None  # Requires currency, period and bounds.
        value = {'posted_range':'Within the posted salary range', 'negotiable':'Negotiable'}.get(value,value)
    # Option concepts already encode polarity; only bare boolean controls invert.
    if not field.get('options') and not binding['polarity'] and value in BOOLEAN:
        value='false' if value=='true' else 'true'
    value=field_value(value,field,binding)
    return result(field,profile_id,version,value,paths,reason='依据当前资料计算',route=route) if value is not None else None


class BindingCache:
    def __init__(self,store):
        self.store=store
        from .question_corpus import QuestionCorpus
        self.corpus=QuestionCorpus(store)
        with store.connect(True) as c: c.execute('CREATE TABLE IF NOT EXISTS answer_bindings(key TEXT PRIMARY KEY,binding TEXT NOT NULL)')

    def plans(self, fields, context, model):
        found={}
        with self.store.connect(True) as c:
            for field in fields:
                key=binding_key(field,context,model)
                row=c.execute('SELECT binding FROM answer_bindings WHERE key=?',(key,)).fetchone()
                if not row: continue
                try: binding=checked(json.loads(row[0])['binding'],None,field,context)
                except (TypeError,KeyError,ValueError): continue
                if binding:
                    found[field['fieldId']]=binding
                    self.corpus.link_binding(c,field,context,model,key)
        return found

    def displays(self, fields, context, model):
        found={}
        with self.store.connect() as c:
            for field in fields:
                row=c.execute('SELECT binding FROM answer_bindings WHERE key=?',(binding_key(field,context,model),)).fetchone()
                if row:
                    try: found[field['fieldId']]=json.loads(row[0]).get('display',{})
                    except (ValueError,TypeError): pass
        return found

    def save_plans(self, fields, plans, context, model, displays=None):
        with self.store.connect(True) as c:
            for field in fields:
                plan=checked(plans.get(field['fieldId']),None,field,context)
                if not plan or plan['predicate']=='unknown': continue
                key=binding_key(field,context,model)
                display={k:v for k,v in (displays or {}).get(field['fieldId'],{}).items() if k in ('questionZh','optionLabelsZh')}
                c.execute('INSERT OR REPLACE INTO answer_bindings VALUES(?,?)',(key,json.dumps({'binding':plan,'display':display,'meaning':{'topic':'unknown','country':context.get('jobContext',{}).get('country',''),'company':'','timeframe':''}})))
                self.corpus.link_binding(c,field,context,model,key)
            c.execute('DELETE FROM answer_bindings WHERE key NOT IN (SELECT cache_key FROM corpus_bindings) AND rowid NOT IN (SELECT rowid FROM answer_bindings ORDER BY rowid DESC LIMIT 4000)')

    def read(self, fields, context, model, profile, profile_id, version, saved=None):
        plans = self.plans(fields, context, model)
        return {f['fieldId']: value for f in fields if f['fieldId'] in plans
                and (value := answer(plans[f['fieldId']], None, f, profile, profile_id, version))}
