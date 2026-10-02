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
    assert 'Missing sponsorship information is not a No' in RULES['never_infer']
    assert 'No graduation-date filter' in RULES['never_infer']
    assert 'Front-end engineering roles' in RULES['remove_fulltime_only']
