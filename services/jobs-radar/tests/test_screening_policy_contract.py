import asyncio

from jobs_radar.board import RULES
from jobs_radar.luna_screening import PROMPT, POLICY
from jobs_radar.screening_policy import tool_description
from jobs_radar.server import create_server
from jobs_radar.store import Store


def test_board_model_and_mcp_use_one_screening_policy(tmp_path):
    assert POLICY == RULES['version']
    assert all(key in PROMPT for key in RULES)
    server = create_server(Store(tmp_path / 'policy.sqlite'))
    tool = next(t for t in asyncio.run(server.list_tools()) if t.name == 'screen_job')
    assert tool.description == tool_description()
    assert PROMPT in tool.description


def test_unknown_facts_and_current_exclusions_do_not_become_broader_filters():
    assert 'remove_fulltime_only' not in RULES
    assert 'Front-end roles are allowed for BOTH kinds' in RULES['judgment']
    assert 'NO employer blacklist' in RULES['judgment']
    assert 'No graduation-date, salary or experience-year filters' in RULES['unknowns']
    assert 'Does Not Offer Sponsorship' in ' '.join(RULES['remove_both'])


def test_mcp_company_preference_is_shared_and_owner_versioned(tmp_path,monkeypatch):
    from test_compact_screening import seed
    monkeypatch.setattr('jobs_radar.server.require',lambda scope:None)
    store,board=seed(tmp_path)
    server=create_server(store)
    asyncio.run(server.call_tool('set_company_preference',dict(company='Duolingo',selected=True,expected_version=0)))
    for kind in ('newgrad','internship'):
        assert next(r for r in board._rows(kind) if r['company']=='Duolingo')['company_recommended'] is True
    with store.connect() as c:
        assert c.execute('SELECT count(*) FROM job_screening').fetchone()[0]==0
