"""Typed diagnostic causes and write evidence; arbitrary exception text is forbidden."""

ENUMS = {
    'stage': ['guard', 'write', 'item', 'navigation', 'lifecycle'],
    'reason': ['manual', 'cancelled', 'form_hidden', 'url_changed', 'owner_changed', 'caller_invalid', 'queue_changed', 'queue_paused', 'page_left', 'removed', 'user_input', 'expired', 'detached', 'root_changed', 'profile_changed', 'not_committed', 'value_lost', 'exception', 'unknown', 'buffer_overflow'],
    'result': ['started', 'committed', 'failed', 'kept', 'blocked', 'completed'],
    'action': ['fill', 'next', 'submit', 'review'],
}


def evidence(value):
    from .validation import shape, integer, boolean
    counters = ('operation', 'item', 'total', 'committed', 'dropped')
    flags = ('focused', 'hidden')
    shape(value, (), (*ENUMS, *counters, *flags))
    out = {}
    for key, item in value.items():
        if key in ENUMS:
            if item not in ENUMS[key]:
                raise ValueError('Unknown diagnostic evidence category')
            out[key] = item
        elif key in counters:
            out[key] = integer(item, 1_000_000)
        else:
            out[key] = boolean(item)
    return out


def decision(value, now):
    from .validation import shape, text, integer
    d = shape(value, (), ('status', 'source', 'reason', 'field', 'ruleId', 'at'))
    return {k: integer(v, now + 60_000) if k == 'at' else text(v, 80) for k, v in d.items()}


def trace(value, now):
    from .validation import shape, text, integer, sequence
    t = shape(value, (), ('source', 'topic', 'result', 'method', 'reason', 'answer', 'chosen',
                          'alias', 'readback', 'optionCount', 'options', 'at'))
    result = {k: text(t[k], 40) for k in ('source', 'topic', 'result', 'method', 'reason') if k in t}
    result.update({k: text(t[k], 120, empty=True) for k in ('answer', 'chosen', 'alias', 'readback') if k in t})
    if 'at' in t:
        result['at'] = integer(t['at'], now + 60_000)
    if 'optionCount' in t:
        result['optionCount'] = integer(t['optionCount'], 100_000)
    if 'options' in t:
        result['options'] = [text(o, 60, empty=True) for o in sequence(t['options'], 12)]
    return result


def explain(data):
    """Report observed failures and evidence gaps, not an inferred ATS root cause."""
    events = data['events']
    streams = {}
    for event in events:
        if 'sequence' in event:
            streams.setdefault(event['document'], set()).add(event['sequence'])
    findings = []
    for event in events:
        cause = event.get('evidence', {})
        if cause.get('result') in ('failed', 'blocked'):
            findings.append({k: event[k] for k in ('at', 'document', 'sequence', 'fieldId', 'evidence') if k in event})
    return {
        'findings': findings[:50],
        'evidenceCoverage': {
            'truncated': data['truncated'],
            'sequencedEvents': sum(len(v) for v in streams.values()),
            'legacyEvents': sum('sequence' not in e for e in events),
            'missingSequences': sum(max(v) - min(v) + 1 - len(v) for v in streams.values()),
            'hasEarlierEventsMissing': any(min(v) > 1 for v in streams.values()),
            'findingsLimited': len(findings) > 50,
            'interpretation': 'Observed plugin decisions and outcomes; no proof of website acceptance or submission.',
        },
    }


def evict_event(events):
    def important(event):
        return event.get('evidence', {}).get('result') in ('failed', 'blocked') or (
            event.get('trace', {}).get('result') and event['trace']['result'] not in ('committed', 'decided', 'matched', 'kept'))
    index = next((i for i, e in enumerate(events) if i > 0 and not important(e)), 0)
    events.pop(index)
