import pytest
from jobs_radar.intern_companies import normalize_company
from test_compact_screening import seed, mark


def test_company_normalization_is_not_a_company_whitelist():
    assert normalize_company('  ＧＯＯＧＬＥ  ') == 'google'
    assert normalize_company('Google Contractor') != normalize_company('Google')


def test_legacy_intern_flag_and_new_both_kind_company_filter(tmp_path):
    store,board=seed(tmp_path)
    for kind in ('newgrad','internship'):
        for row in board._rows(kind): mark(board,row,row['company'] in {'xAI','Duolingo'})
    assert board.list(kind='newgrad',intern_companies='1')['total']==4
    assert board.list(kind='internship',intern_companies='1')['total']==2
    assert board.list(kind='newgrad',company_filter='1')['total']==2
    counts=board.filter_counts(company_newgrad='',company_internship='1')
    assert counts['newgrad']['total']==4 and counts['internship']['total']==2
    with pytest.raises(ValueError): board.list(company_filter='invalid')


def test_company_filter_never_mutates_or_hides_trash_history(tmp_path):
    store,board=seed(tmp_path)
    row=board._rows('internship')[0]
    board.review(row['id'],'internship','trash','manual','Owner removal',[
        {'url':row['apply_url'],'quote':row['title'],'observed_at':'2026-10-05T00:00:00Z'}],
        row['fingerprint'],0,'owner-remove',actor='web-owner')
    assert board.list(kind='internship',view='trash',company_filter='1')['total']==1
    row=board._rows('newgrad')[0]
    board.mark_submitted(row['id'],0,key='submit-test')
    assert board.list(kind='newgrad',status='submitted')['total']==1
    before=store.progress()
    board.list(kind='newgrad',company_filter='1',status='submitted')
    assert store.progress()==before
