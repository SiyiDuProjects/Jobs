"""Deterministic draft checks; prose quality remains a sampled human review."""
import json
import re


def basic_issues(text, question):
    if not isinstance(text,str) or not text.strip(): return ['empty_draft']
    issues=[]
    if re.search(r'\[(?:insert|your|company|name)|\{\{|<placeholder>|your name',text,re.I):
        issues.append('placeholder')
    chinese=lambda value: len(re.findall(r'[\u3400-\u9fff]',value))
    if chinese(question) >= 4 and not chinese(text): issues.append('wrong_language')
    if not chinese(question) and re.search('[a-zA-Z]',question) and chinese(text) > len(text)/5:
        issues.append('wrong_language')
    return issues


def sample_issues(text, field, profile):
    issues=basic_issues(text,field['question'])
    if issues: return issues
    # Synthetic samples expose unfamiliar proper names/acronyms for inspection.
    # This is deliberately conservative and does not claim full NER/entailment.
    allowed=json.dumps(profile,ensure_ascii=False).casefold()+' '+field['question'].casefold()
    ordinary={'i','my','we','our','the','this','that','these','those','a','an','as','at','by','for','from','in','it','its','on','to','with','building','working','developing','learning','using','during','through','one','first','second','yes','no'}
    tokens=re.findall(r'\b(?:[A-Z][a-z]+|[A-Z]{2,})(?:[+#]{1,2})?\b',text)
    unsupported=sorted({v for v in tokens if v.casefold() not in ordinary and v.casefold() not in allowed})
    if unsupported: issues.append('unrecognized_names_or_skills:'+','.join(unsupported))
    return issues
