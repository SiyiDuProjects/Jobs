import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('ats_index',Path(__file__).parents[3]/'scripts/generate-ats-index.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


def test_index_preserves_human_acceptance_and_ignores_all_answer_content():
    original='# Index\n\nScope.\n\n## Workday\n| 级别 | 问题与状态 | 证据 |\n| --- | --- | --- |\n| P1 | Example: fixed pending live verification | [case](ats-bugs/case.md) |\n'
    data=module.import_annotations(original)
    runs=[{'id':'one','ats':'workday','truncated':True,'profile':'SECRET', 'events':[{'answer':'SECRET'}]},
          {'id':'one','ats':'workday','truncated':True}]
    result=module.render(data,runs)
    assert 'fixed pending live verification' in result
    assert '[case](ats-bugs/case.md)' in result
    assert '1 次运行；1 份截断' in result
    assert 'SECRET' not in result
    assert data['sections'][0]['rows'][0]['priority']=='P1'
