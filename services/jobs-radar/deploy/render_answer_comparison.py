"""Render a completed private comparison for owner review; never print answers."""
import argparse
import json
import os
from pathlib import Path


def label(field, row):
    value=row.get('value')
    if value is None: return '留空'
    labels={o['value']:o['label'] for o in field['options']}
    if isinstance(value,list): return '；'.join(labels.get(v,v) for v in value)
    if isinstance(value,bool): return '是' if value else '否'
    return labels.get(value,value)


def render(report):
    summary=report['summary']; old=summary['metrics']['legacy']; new=summary['metrics']['simple']
    snapshot = report.get('evaluationScope') == 'snapshot_pipeline'
    scope = '快照重演结果' if snapshot else '服务端补答'
    detail = ('本报告从去值快照开始，用当前资料重演本地规则、剩余题请求和快照写入；不是还原历史请求，也未验证真实 ATS。动态选项只使用已录制结果，平台专属经历绑定和附件上传不在此工具中。' if snapshot else
              '本报告单独比较服务端，不包含扩展先行的本地资料填写；联系方式等留空不能据此判定真实页面退步。')
    count = len(report.get('profileNames', ['Intern', 'Newgrad']))
    lines=['# 答题流程验收：待本人审核','',
        f"已处理 {report['pages']} 个题库页面、{count} 份资料，共 {summary['questions']} 条{scope}。",'',
        detail,'',
        '| 检查 | 旧流程 | 新流程 |','| --- | ---: | ---: |']
    for key,title in [('local','本地规则已填'),('unknown','留空'),('snapshotWriteFailures','快照写入未成功'),('wrongGold','有标准答案的已填错答'),('unansweredGold','有标准答案但留空'),('invalidOptions','无效选项'),('internalValues','内部枚举值'),('chineseMissing','缺中文题意或理由')]:
        lines.append(f'| {title} | {old.get(key,0)} | {new.get(key,0)} |')
    lines += ['',f"标准答案覆盖 {summary['goldCount']} 条；其他答案还未判定对错。已排除 {summary.get('excludedPages',0)} 页损坏的题库输入。",
        f"{summary['contextIncomplete']} 条缺少完整岗位上下文；{summary['captureGaps']} 次控件捕获不完整或不支持；{summary['failures']} 次调用失败。",
        '这些是模型与题库回放结果，尚未证明真实 ATS 写入和继续操作成功。','']
    for title,key in [('发生变化的答案','changed'),('未变化答案的随机 30 条抽查','unchangedSample')]:
        lines += ['## '+title,'']
        for i in report[key]:
            r=report['results'][i];field=r['field'];after=r['simple']
            lines += [f"### {i+1}. {r['profileName']} · {after.get('questionZh') or field['question']}",'',
                f"- 原题：{field['question']}",f"- 页面：{r['page']}",
                f"- 旧答案：{label(field,r['legacy'])}",f"- 新答案：{label(field,after)}",
                f"- 中文：{after.get('answerZh') or '—'}",f"- 理由：{after.get('reasonZh') or '—'}"]
            if r['gold'] is not None: lines.append(f"- 已有标准答案：{r['gold']}（{r['goldSource']}）")
            lines += ['- 本人审核：待核对','']
    return '\n'.join(lines)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',required=True);parser.add_argument('--output',required=True)
    args=parser.parse_args();report=json.loads(Path(args.input).read_text())
    fd=os.open(args.output,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as output: output.write(render(report))
    print(json.dumps({'rendered':True,'changed':len(report['changed']),'unchangedSample':len(report['unchangedSample'])}))
