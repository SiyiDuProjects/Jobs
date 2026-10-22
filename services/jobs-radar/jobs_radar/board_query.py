"""One SQL predicate for paginated jobs and filter counts."""
import json
import time

from .application_progress import job_progress_value
from .recruiting import authorized_mailbox, email_url, STAGES
from .scope import discovery_scope


BASE = '''WITH board AS (
    SELECT b.*,a.status,a.version AS application_version,a.detail AS application_detail,
        a.progress,p.keep AS company_recommended,
        (a.status IN ('submitted','submitted_unconfirmed') AND u.version=a.version AND u.expires>?) AS can_undo_submission,
        CASE WHEN f.fingerprint=b.fingerprint AND f.family!='unknown' THEN f.family ELSE b.family END AS role_family,
        CASE WHEN f.fingerprint=b.fingerprint AND f.family!='unknown' THEN 'duties' ELSE b.basis END AS role_basis,
        CASE WHEN b.company_fold IN ('google','alphabet','meta','facebook','apple','amazon','netflix')
            OR EXISTS (SELECT 1 FROM board_faang_sources bf WHERE bf.company_fold=b.company_fold)
            THEN 'faang' ELSE 'other' END AS board_group,
        CASE WHEN q.job_id IS NULL OR (q.fingerprint IS NOT b.fingerprint AND q.state!='trash' AND coalesce(q.manual_keep,0)=0)
            THEN 'pending' ELSE q.state END AS screening,
        q.state AS review_state,q.expires_at,q.manual_keep,q.version AS review_version,
        CASE WHEN q.job_id IS NOT NULL THEN json_object('job_id',q.job_id,'kind',q.kind,'state',q.state,
            'reason',q.reason,'detail',q.detail,'evidence',q.evidence,'fingerprint',q.fingerprint,
            'reviewed_at',q.reviewed_at,'expires_at',q.expires_at,'version',q.version,'manual_keep',q.manual_keep) END AS review,
        CASE WHEN json_extract(a.progress,'$.stage')='applied' AND json_extract(a.progress,'$.receipt_confirmed')
            THEN 'received' ELSE json_extract(a.progress,'$.stage') END AS progress_stage
    FROM board_jobs b JOIN applications a ON a.job_id=b.job_id
    LEFT JOIN job_screening q ON q.job_id=b.job_id AND q.kind=b.kind
    LEFT JOIN job_role_family f ON f.job_id=b.job_id AND f.kind=b.kind
    LEFT JOIN company_preferences p ON p.company_key=b.company_key
    LEFT JOIN owner_submission_undo u ON u.job_id=b.job_id
) '''


def scope(kind, include_history=False, trash=False):
    return ('kind=? AND (active=1' + (' OR application_version>0' if include_history else '')
            + (" OR (review_state='trash' AND expires_at>?)" if trash else '') + ')',
            [kind,*([time.time()] if trash else [])])


def hydrate(rows, c, *, public=False):
    mailbox = authorized_mailbox(c,required=False)
    result = []
    for row in rows:
        item = json.loads(row['payload'])
        item.update({name:row[name] for name in ('status','application_version','application_detail',
                    'role_family','role_basis','screening')})
        item.update(group=row['board_group'],can_undo_submission=bool(row['can_undo_submission']),
                    review_version=row['review_version'] or 0,
                    company_recommended=bool(row['company_recommended']) if row['company_recommended'] is not None else None,
                    review=json.loads(row['review']) if row['review'] else None,
                    progress=job_progress_value(row['job_id'],row['progress']))
        if item['progress']:
            p=item['progress'];p['email_url']=email_url(p['message_id'],mailbox) if p['message_id'] else None
        if public:
            item.pop('all_sources',None)
            if item['review']:
                item['review']['evidence']=json.loads(item['review']['evidence'])
        result.append(item)
    return result


def source_evidence(c, result, kind):
    by_id={r['id']:r for r in result}
    for row in result: row['all_sources']=[]
    if not result: return result
    discovery, discovery_values=discovery_scope()
    for source in c.execute('''SELECT o.job_id,o.payload FROM observations o
            JOIN board_jobs b ON b.job_id=o.job_id AND b.kind=?
            LEFT JOIN search_index s USING(stream,source_id)
            WHERE b.job_id IN (SELECT value FROM json_each(?)) AND (
                (b.active=1 AND s.kind=? AND o.present=1 AND s.active=1 AND s.visible=1 AND '''+discovery+''')
                OR (b.active=0 AND json_extract(o.payload,'$.kind')=?))''',
            [kind,json.dumps(list(by_id)),kind,*discovery_values,kind]):
        by_id[source['job_id']]['all_sources'].append(json.loads(source['payload']))
    for row in result:
        row['all_sources'].sort(key=lambda s:({'simplify':0,'speedyapply':1}.get(s['source'],9),s.get('source_id','')))
    return result


def rows(store, kind, include_history=False):
    clause, values = scope(kind,include_history)
    with store.connect() as c:
        return source_evidence(c,hydrate(c.execute(BASE+'SELECT * FROM board WHERE '+clause,[time.time(),*values]),c),kind)


def queue(store, kind, limit, cursor):
    clause, values = scope(kind)
    clause += " AND status='not_started' AND application_version=0 AND screening='pending' AND coalesce(manual_keep,0)=0"
    if cursor:
        clause += ' AND job_id>?'
        values.append(cursor)
    with store.connect() as c:
        c.execute('BEGIN')
        selected = c.execute(BASE+'SELECT * FROM board WHERE '+clause+' ORDER BY job_id LIMIT ?', [time.time(),*values,limit]).fetchall()
        return source_evidence(c,hydrate(selected,c),kind)


def listing(store, *, kind, view, status, text, location, category, group, screening,
            page, page_size, added_since, added_before, region, company_filter,
            excluded_companies, selected_roles, exclude_data_engineering, title_patterns, summary_only):
    now = time.time()
    base, values = scope(kind,view=='jobs' and status not in {'not_started','recent','unsubmitted'},view=='trash')
    conditions = [base]
    if view=='trash':
        conditions.append("review_state='trash' AND expires_at>?");values.append(now)
    else:
        conditions += ["coalesce(review_state,'')!='trash'",
                       "NOT (foreign_only=1 AND status='not_started' AND application_version=0 AND coalesce(manual_keep,0)=0)"]
        if excluded_companies:
            conditions.append('NOT EXISTS (SELECT 1 FROM board_source_companies sc WHERE sc.job_id=board.job_id AND sc.kind=board.kind AND sc.company_key IN ('+','.join('?' for _ in excluded_companies)+'))')
            values.extend(sorted(excluded_companies))
        if company_filter=='1': conditions.append('company_recommended=1')
        if added_since is not None: conditions.append('added_at>=?');values.append(added_since)
        if added_before is not None: conditions.append('added_at<?');values.append(added_before)
        if status in STAGES: conditions.append('progress_stage=?');values.append(status)
        elif status=='unsubmitted': conditions.append("status NOT IN ('submitted','submitted_unconfirmed')")
        elif status not in {'','recent'}: conditions.append('status=?');values.append(status)
        conditions.append('role_family IN ('+','.join('?' for _ in selected_roles)+')');values.extend(sorted(selected_roles))
        if exclude_data_engineering=='1': conditions.append('data_engineering=0')
        if title_patterns: conditions.append('board_title_allowed(title)')
    if text: conditions.append('instr(text_search,?)>0');values.append(text.casefold())
    if location: conditions.append('instr(location_search,?)>0');values.append(location.casefold())
    if region:
        match = region+'=1'
        if region=='focus_remote': match="("+match+" OR (foreign_only=0 AND (board_group='faang' OR company_recommended=1)))"
        conditions.append(match)
    if category=='engineering': conditions.append('engineering=1')
    elif category:
        conditions.append("EXISTS (SELECT 1 FROM json_each(board.payload,'$.categories') WHERE value=?)");values.append(category)
    if group: conditions.append('board_group=?');values.append(group)
    if screening: conditions.append('screening=?');values.append(screening)
    where = ' AND '.join(conditions)
    params = [now,*values]
    with store.connect() as c:
        c.create_function('board_title_allowed',1,lambda title:not any(p.search(title) for p in title_patterns),deterministic=True)
        # Counts and page rows see the same committed data, even during a scrape.
        c.execute('BEGIN')
        totals = c.execute(BASE+'SELECT status,board_group,count(*) AS n FROM board WHERE '+where+' GROUP BY status,board_group',params).fetchall()
        application_counts = {'submitted':0,'not_started':0}
        groups = {'faang':0,'other':0}
        for row in totals:
            application_counts[row['status']]=application_counts.get(row['status'],0)+row['n']
            groups[row['board_group']]+=row['n']
        result = {'total':sum(groups.values()),'application_counts':application_counts}
        if summary_only: return result
        selected = c.execute(BASE+'SELECT * FROM board WHERE '+where+' ORDER BY added_at DESC,job_id LIMIT ? OFFSET ?',
                             [*params,page_size,(page-1)*page_size]).fetchall()
        result.update(jobs=hydrate(selected,c,public=True),groups=groups,page=page,page_size=page_size)
    return result
