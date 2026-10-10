"""Public questions from the reported pages, with synthetic personal facts."""
from test_answers import setup, save, run, Client, mapping, field
from jobs_radar.flexible_answers import checked
from jobs_radar.answer_bindings import answer


def proposed(**patch):
    return dict(fieldId='eligible',state='answer',value='n',basis='profile',intent='fact',
                evidencePaths=['jobData'],noteQuote='',savedResponse='',defaultCategory='',
                questionZh='是否曾为该公司工作？',answerZh='从未',reason='完整工作经历中没有该公司。',optionLabelsZh=['否','是']) | patch


def test_lucid_contractor_question_without_closed_predicate(tmp_path):
    a,p=setup(tmp_path);p=save(a,p,jobData=[{'company':'Example Labs','jobTitle':'Engineer','startDate':'2024-01','endDate':'2025-01','currentlyWorkHere':False}])
    f=field(question='Have you previously worked for Lucid, or any of its entities, as a contractor?',
            options=[{'value':'current','label':'Currently a contractor'},{'value':'past','label':'Previously a contractor'},
                     {'value':'employee','label':'Previously an employee'},{'value':'never','label':'Never been a contractor or an employee'}])
    client=Client([mapping(route='unknown',options=[])],answers=[proposed(value='never',optionLabelsZh=['目前是承包商','曾是承包商','曾是员工','从未'])])
    row=run(a,p,client,[f])['answers'][0]
    assert row['value']=='never' and row['decision']=='write'
    assert row['questionZh'] and row['reason']=='完整工作经历中没有该公司。'
    assert len(client.calls)==1


def test_known_fact_overrides_generated_conflict_and_cache_translates_current_answer(tmp_path):
    a,p=setup(tmp_path);p=save(a,p,employmentData={'eligibilityUS':False})
    raw=proposed(value='y',evidencePaths=['employmentData.eligibilityUS'],questionZh='是否获准在美国工作？')
    row=run(a,p,Client(answers=[raw]))['answers'][0]
    assert row['value']=='n' and row['answerZh']=='否'
    newer=save(a,p,employmentData={'eligibilityUS':True})
    row=run(a,newer)['answers'][0]
    assert row['value']=='y' and row['answerZh']=='是' and row['questionZh']=='是否获准在美国工作？'


def test_enabled_clearance_default_can_select_unique_no_among_several_yes():
    f=field(question='Have you ever held a security clearance?',options=[
        {'value':'old','label':'Previously cleared (debriefed less than two years)'},
        {'value':'older','label':'Previously cleared (debriefed two or more years ago)'},
        {'value':'active','label':'Yes, current active clearance'},
        {'value':'never','label':'No, never held a clearance'}])
    plan=mapping(route='default.clearance',options=['true','true','true','false'])['binding']
    assert answer(plan,None,f,{'applicationData':{'defaultAnswers':['clearance']}},'p','v')['value']=='never'
    plan['predicate']='us_work_eligible'
    assert answer(plan,None,f,{'employmentData':{'eligibilityUS':True}},'p','v') is None


def test_internal_salary_enum_is_never_written_and_completed_education_matches():
    f=field(question='What is your expected compensation range?',type='text',options=[])
    plan=mapping(route='applicationData.salaryPreference',options=[])['binding']
    assert answer(plan,None,f,{'applicationData':{'salaryPreference':'posted_range'}},'p','v')['value']=='Within the posted salary range'
    f=field(question='What is your highest level of education completed?',options=[{'value':'hs','label':'High School Diploma/GED'}])
    plan=mapping(route='applicationData.highestCompletedEducation',options=['High School Diploma/GED'])['binding']
    assert answer(plan,None,f,{'applicationData':{'highestCompletedEducation':'High School'}},'p','v')['value']=='hs'


def test_notes_require_real_quote_and_unknown_facts_stay_unanswered():
    f=field();p={'applicationData':{'aiNotes':'I can work through August 19.'}}
    assert checked(proposed(evidencePaths=[],noteQuote='Invented personal statement'),f,p,'p','v',{}) is None
    assert checked(proposed(evidencePaths=['missing']),f,p,'p','v',{}) is None
    assert checked(proposed(basis='default',defaultCategory='clearance',evidencePaths=[]),f,p,'p','v',{}) is None
    assert checked(proposed(basis='suggestion',intent='preference',evidencePaths=[]),f,p,'p','v',{}) is None
    row=checked(proposed(state='needs_input',value=None,basis='unknown',evidencePaths=[],reason='缺少第二国籍信息。'),f,p,'p','v',{})
    assert row['value'] is None and row['reason']=='缺少第二国籍信息。'


def test_proofpoint_history_options_do_not_become_a_current_disability_rule():
    f=field(question='Please check one of the boxes below:',options=[
        {'value':'y','label':'Yes, I have a disability, or have had one in the past'},
        {'value':'n','label':'No, I do not have a disability and have not had one in the past'},
        {'value':'u','label':'I do not want to answer'}])
    plan=mapping(route='voluntary_current_disability',options=['true','false','undisclosed'])['binding']
    assert answer(plan,None,f,{'employmentData':{'disability':False}},'p','v') is None
