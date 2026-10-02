import React, {useCallback, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SiteApp} from './SiteApp';
import {CLIENT_PROTOCOL_HEADERS} from './client-protocol';
import {Button, Checkbox, Chip, Input, Label, ListBox, Select as HeroSelect, Modal, Switch, Table, TextArea, TextField} from '@heroui/react';
import {Segment} from '@heroui-pro/react';
import './style.css';
import {ExtensionSync} from './ExtensionSync';
import {createBoardLoader} from './board-loader';
import {DateWindowFilter} from './DateWindowFilter';
import {addedRange, normalizeDateWindow, rangeLabel} from './date-window';

type Evidence={url:string;quote:string;observed_at:string};
type Job={progress?:{stage:string;received_at:number;summary:string;email_url:string}|null;role_family:string;role_basis:string;id:string;group:string;company:string;title:string;locations:string[];sources:string[];apply_url:string|null;source_url:string|null;posted_at:number|null;added_at:number;status:string;opened_at:number|null;can_undo_submission:boolean;active:boolean;application_version:number;review_version:number;fingerprint:string;screening:string;review:null|{detail:string;manual_keep:number;expires_at:number;evidence:Evidence[]}};
type Recent=Pick<Job,'id'|'company'|'title'|'application_version'>;
type UndoTarget={id:string;version:number};
type Listing={groups:Record<string,number>;jobs:Job[];recent_opened:Recent[];application_counts:Record<string,number>;total:number;source_health:{last_success:number;stale:boolean}[]};
type Counts={newgrad:{total:number;submitted:number};internship:{total:number;submitted:number};total:number};
type Filters={exclude_companies:string;compact:boolean;intern_companies:string;roles:string;exclude_data_engineering:string;exclude_titles:string;region:string;text:string;location:string;category:string;status:string;group:string;screening:string;added_date:string;page:number};
const statusOptions={recent:'全部岗位',unsubmitted:'未投递',submitted:'已投递'};
const displayFilterStatus=(status:string)=>status==='submitted'||['received','assessment','interview','offer','rejected','withdrawn'].includes(status)?'submitted':['unsubmitted','not_started','needs_input','skipped','retryable_failure','in_progress','submitted_unconfirmed'].includes(status)?'unsubmitted':'recent';
const names:Record<string,string>={simplify:'Simplify',speedyapply:'SpeedyApply',jobright:'Jobright'};
const screenings:Record<string,string>={pending:'待初筛',keep:'已保留',review:'待核实',trash:'已删除'};
const trash=location.pathname==='/trash';
type Kind='newgrad'|'internship';
function readKind():Kind{
 const query=new URLSearchParams(location.search).get('kind');
 if(query==='newgrad'||query==='internship')return query;
 if(location.pathname==='/internships')return 'internship';
 if(location.pathname==='/full-time')return 'newgrad';
 try{return localStorage.getItem('radar-kind')==='internship'?'internship':'newgrad';}catch{return 'newgrad';}
}
const splitCompanies=(value:string)=>Array.from(new Map(value.split(/[,，;；\n]/).map(v=>v.trim()).filter(Boolean).map(v=>[v.normalize('NFKC').toLowerCase(),v])).values());
const defaults:Filters={exclude_companies:trash?'':'TikTok',compact:false,intern_companies:'',roles:'',exclude_data_engineering:'',exclude_titles:'',region:'',text:'',location:'',category:'',status:trash?'':'recent',group:'',screening:'',added_date:'',page:1};
const filterKey='radar-filters-shared-v5';
const statusColor=(job:Job)=>job.status==='submitted'?'success':'default';
const safe=(url:string|null)=>{try{const u=new URL(url||'');return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:undefined;}catch{return undefined;}};
const date=(ts:number|null)=>ts?new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit'}).format(ts*1000):'—';
async function api(path:string,options:RequestInit={}){const headers=new Headers(options.headers);for(const [name,value]of Object.entries(CLIENT_PROTOCOL_HEADERS))headers.set(name,value);const r=await fetch(path,{credentials:'same-origin',...options,headers});let v;try{v=await r.json();}catch{throw new Error('暂时无法连接，请刷新重试');}if(!r.ok)throw new Error(r.status===401?'登录已过期，请刷新页面重新连接':v.error||'操作失败');return v;}
function Select({label,value,options,onChange}:{label:string;value:string;options:Record<string,string>;onChange:(v:string)=>void}){
 const [keyboard,setKeyboard]=useState(false);
 const keyboardInput=(e:React.KeyboardEvent)=>{if(['ArrowDown','ArrowUp','Home','End','Tab','Enter',' '].includes(e.key))setKeyboard(true);};
 return <div className="filter-select" onPointerDownCapture={()=>setKeyboard(false)} onPointerMoveCapture={()=>setKeyboard(false)} onKeyDownCapture={keyboardInput}><HeroSelect aria-label={label} variant="secondary" value={value||'__all__'} onChange={key=>{if(key!==null)onChange(key==='__all__'?'':String(key));}}>
  <HeroSelect.Trigger><HeroSelect.Value/><HeroSelect.Indicator/></HeroSelect.Trigger>
  <HeroSelect.Popover className="filter-popover" data-keyboard={keyboard?'true':'false'} placement="bottom start" offset={6}><ListBox aria-label={label}>{Object.entries(options).map(([v,n])=><ListBox.Item key={v||'__all__'} id={v||'__all__'} textValue={n}>{n}<ListBox.ItemIndicator/></ListBox.Item>)}</ListBox></HeroSelect.Popover>
 </HeroSelect></div>;
}
export function JobsBoard(){
 const [kind,setKind]=useState<Kind>(readKind);
 const kindRef=useRef(kind);kindRef.current=kind;
 const auth=true;
 const [data,setData]=useState<Listing|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[advanced,setAdvanced]=useState(false),[notice,setNotice]=useState('');
 const [filters,setFilters]=useState<Filters>(()=>{if(trash)return defaults;try{
  const saved=localStorage.getItem(filterKey);
  if(saved){const prior=JSON.parse(saved),f={...defaults,...prior,page:1};return {...f,added_date:normalizeDateWindow(f.added_date),roles:'',exclude_data_engineering:'',exclude_titles:'',status:displayFilterStatus(f.status),compact:prior.compact??false};}
  const old=JSON.parse(localStorage.getItem('radar-filters-shared-v4')||localStorage.getItem('radar-filters-shared-v3')||'{}');
  // Retire the former automatic shortlist; keep explicitly customized filters.
  return {...defaults,...old,...(old.compact!==false?{region:'',intern_companies:''}:{}),added_date:normalizeDateWindow(old.added_date),roles:'',exclude_data_engineering:'',exclude_titles:'',compact:false,status:displayFilterStatus(old.status),page:1};
 }catch{return defaults;}});
 const [draft,setDraft]=useState<Filters|null>(null),[draftEdited,setDraftEdited]=useState(false);
 const [countsUnavailable,setCountsUnavailable]=useState(false);
 const [counts,setCounts]=useState<Counts|null>(null),[preview,setPreview]=useState<Counts|null>(null),[previewError,setPreviewError]=useState('');
 const [query,setQuery]=useState(filters.text),[action,setAction]=useState<{type:'trash';job:Job}|null>(null),[detail,setDetail]=useState(''),[actionError,setActionError]=useState(''),[saving,setSaving]=useState(false);
 const [undo,setUndo]=useState<UndoTarget[]|null>(null),[showRecent,setShowRecent]=useState(false),[batchProgress,setBatchProgress]=useState('');
 const mutation=useRef(false),keys=useRef(new Map<string,string>());
 const serial=useRef(0),actionRef=useRef(action);actionRef.current=action;
 const loader=useRef(createBoardLoader(api)).current;
 const load=useCallback(async()=>{
  if(kindRef.current!==kind)return;
  const seq=++serial.current,current=()=>seq===serial.current;
  setBusy(true);setError('');setCounts(null);setCountsUnavailable(false);
  const {added_date,compact,...rest}=filters;
  const params=new URLSearchParams({...rest,compact:!trash&&compact?'1':'',...addedRange(trash?'':added_date),page:String(filters.page),kind,view:trash?'trash':'jobs',page_size:'50',...(trash?{status:'',screening:''}:{})});
  // A slow statistics service must not hold the usable job list hostage.
  if(!trash){
   void loader.counts(params).then(v=>{if(current())setCounts(v);},()=>{if(current()){setCounts(null);setCountsUnavailable(true);}});
  }
  try{
   const v=await loader.jobs(params);
   if(current()){if(filters.page>1&&!v.jobs.length)setFilters(f=>({...f,page:1}));else setData(v);}
  }catch(e){if(current())setError((e as Error).message);}
  finally{if(current())setBusy(false);}
 },[filters,kind,loader]);
 useEffect(()=>()=>{++serial.current;loader.cancel();},[loader]);
 useEffect(()=>{
  // Honor old bookmarks once, then keep the selected kind in browser storage.
  const url=new URL(location.href);url.pathname=trash?'/trash':'/';url.searchParams.delete('kind');
  history.replaceState(null,'',url.pathname+url.search+url.hash);
 },[]);
 useEffect(()=>{try{localStorage.setItem('radar-kind',kind);}catch{}},[kind]);
 useEffect(()=>{if(auth)void load();},[auth,load]);
 useEffect(()=>{if(!trash)localStorage.setItem(filterKey,JSON.stringify(filters));},[filters]);
 useEffect(()=>{const timer=setTimeout(()=>setFilters(f=>f.text===query?f:{...f,text:query,page:1}),300);return()=>clearTimeout(timer);},[query]);
 useEffect(()=>{if(!auth)return;const refresh=()=>{if(!actionRef.current&&document.visibilityState==='visible')void load();};const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',refresh);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[auth,load]);
 useEffect(()=>{if(notice){const timer=setTimeout(()=>{setNotice('');setUndo(null);},undo?30000:4000);return()=>clearTimeout(timer);}},[notice,undo]);
 useEffect(()=>{
  if(!auth||!advanced||!draft||trash)return;
  let active=true;setPreview(null);setPreviewError('');
  const timer=setTimeout(()=>{const {added_date,page,compact,...rest}=draft;void api('/api/filter-counts?'+new URLSearchParams({...rest,...addedRange(added_date)})).then(v=>{if(active)setPreview(v);}).catch(e=>{if(active)setPreviewError(e.message);});},200);
  return()=>{active=false;clearTimeout(timer);};
 },[auth,advanced,draft]);
 function changeKind(next:Kind){
  if(next===kindRef.current)return;
  ++serial.current;kindRef.current=next;
  setKind(next);setData(null);setBusy(true);setError('');setShowRecent(false);
  setAction(null);setAdvanced(false);setFilters(f=>({...f,page:1}));
 }
 function draftFilter(key:keyof Filters,value:string){setDraftEdited(true);setDraft(f=>f?{...f,[key]:value}:f);}
 function toggleCompact(selected:boolean){setFilters(f=>({...f,compact:selected,roles:'',region:selected?'focus_remote':'',intern_companies:selected?'1':'',page:1}));}
 function filter(key:keyof Filters,value:string){setFilters(f=>({...f,[key]:value,page:1}));}
 function open(type:'trash',job:Job){setDetail('');setActionError('');setAction({type,job});}
 function review(job:Job,decision:'trash'|'restore',text:string){return {action:'review',job_id:job.id,kind,decision,reason:decision==='trash'?'manual':'owner_restore',detail:text,evidence:decision==='trash'?[{url:job.apply_url||job.source_url,quote:job.title,observed_at:new Date().toISOString()}]:[],expected_fingerprint:job.fingerprint,expected_version:job.review_version,key:crypto.randomUUID()};}
 async function send(payload:unknown){try{return await api('/api/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});}finally{loader.invalidate();}}
 async function restore(job:Job){if(saving)return;setSaving(true);try{await send(review(job,'restore','用户恢复并人工保留'));setNotice('已恢复，自动初筛不会再次删除');await load();}catch(e){setError((e as Error).message);}finally{setSaving(false);}}
 async function trackOpened(job:Recent,dismiss=false){try{await send({action:'opened',job_id:job.id,kind,dismiss});await load();}catch(e){setError('打开记录未保存：'+(e as Error).message);}}
 async function submission(input:Recent|Recent[]){
  if(mutation.current)return;mutation.current=true;setSaving(true);
  const jobs=Array.isArray(input)?[...input]:[input],completed:UndoTarget[]=[],failures:string[]=[];
  setError('');
  try{
   for(const [index,job] of jobs.entries()){
    if(jobs.length>1)setBatchProgress(`${index+1} / ${jobs.length}`);
    const token='submitted:'+job.id+':'+job.application_version;
    if(!keys.current.has(token))keys.current.set(token,crypto.randomUUID());
    try{const v=await send({action:'submitted',job_id:job.id,version:job.application_version,key:keys.current.get(token)});completed.push({id:job.id,version:v.version});}
    catch(e){failures.push(`${job.company}：${(e as Error).message}`);}
   }
   if(completed.length){setUndo(completed);setNotice(`已标记 ${completed.length} 个岗位为已投递${failures.length?`，${failures.length} 个未确认成功`:''}`);}
   await load();
   if(failures.length)setError(`${failures.length} 个岗位未确认标记成功，请查看刷新后的状态。${failures[0]}`);
  }finally{mutation.current=false;setSaving(false);setBatchProgress('');}
 }
 async function undoSubmission(input:UndoTarget|UndoTarget[]){
  if(mutation.current)return;mutation.current=true;setSaving(true);
  const targets=Array.isArray(input)?input:[input],remaining:UndoTarget[]=[];let failure='';setError('');
  try{
   for(const target of targets){
    const token='undo:'+target.id+':'+target.version;
    if(!keys.current.has(token))keys.current.set(token,crypto.randomUUID());
    try{await send({action:'undo_submitted',job_id:target.id,version:target.version,key:keys.current.get(token)});}
    catch(e){remaining.push(target);failure=(e as Error).message;}
   }
   setUndo(remaining.length?remaining:null);setNotice(`已撤销 ${targets.length-remaining.length} 个岗位的标记${remaining.length?`，${remaining.length} 个未确认成功`:''}`);
   await load();
   if(remaining.length)setError(failure);
  }finally{mutation.current=false;setSaving(false);}
 }
 async function confirm(){if(!action||!detail.trim())return;setSaving(true);try{await send(review(action.job,'trash',detail.trim()));setAction(null);setNotice('已标记删除，可在回收站恢复');await load();}catch(e){setActionError((e as Error).message);}finally{setSaving(false);}}
 const stale=data?.source_health.some(s=>s.stale),synced=data?.source_health.length?Math.min(...data.source_health.map(s=>s.last_success||0)):0;
 const isRefined=!!(filters.region||(kind==='internship'&&filters.intern_companies==='1'));
 const countText=(c:Counts)=>`全职 ${c.newgrad.total} + 实习 ${c.internship.total} = ${c.total} 个`;
 const unstarted=(c:Counts)=>(c.newgrad.total-c.newgrad.submitted)+(c.internship.total-c.internship.submitted);
 return <section aria-label={trash?'回收站':'岗位列表'}>
  {<>
  {!trash&&<ExtensionSync onSynced={load}/>}
  {!trash&&!!data?.recent_opened.length&&<section className="recent-opened" aria-label="刚打开的岗位"><div className="recent-heading"><h2>刚打开 · {data.recent_opened.length}</h2><span className="text-muted">自动同步未覆盖的岗位，可在此手动确认</span><Button className="recent-bulk" size="sm" variant="secondary" isDisabled={saving||busy} isPending={!!batchProgress} onPress={()=>submission(data.recent_opened)}>{batchProgress?`正在标记 ${batchProgress}`:`全部标记已投递（${data.recent_opened.length}）`}</Button></div>{(showRecent?data.recent_opened:data.recent_opened.slice(0,3)).map(job=><div className="recent-row" key={job.id}><div><strong>{job.company}</strong><span className="text-muted">{job.title}</span></div><div className="actions"><Button size="sm" variant="secondary" isDisabled={saving} onPress={()=>submission(job)}>标记已投递</Button><Button size="sm" variant="ghost" isDisabled={saving} onPress={()=>trackOpened(job,true)}>暂不处理</Button></div></div>)}{data.recent_opened.length>3&&<Button size="sm" variant="ghost" onPress={()=>setShowRecent(v=>!v)}>{showRecent?'收起':'展开其余 '+(data.recent_opened.length-3)+' 个'}</Button>}</section>}
  <div className="browse-controls">{!trash&&<section className="date-filter" aria-label="收录日期筛选"><DateWindowFilter value={filters.added_date} onChange={v=>filter('added_date',v)}/></section>}
  <section className="toolbar" aria-label="岗位筛选"><TextField aria-label="搜索公司或岗位" value={query} onChange={setQuery} className="search"><Input placeholder="搜索公司或岗位" variant="secondary"/></TextField>
   {!trash&&<Select label="公司分组" value={filters.group} options={{'':'全部公司',faang:'仅 FAANG+',other:'其他公司'}} onChange={v=>filter('group',v)}/>}
   {!trash&&<Select label="投递状态" value={filters.status} options={statusOptions} onChange={v=>filter('status',v)}/>}
   {!trash&&<div className="refinement-controls"><Switch size="sm" isSelected={filters.compact} onChange={toggleCompact}><Switch.Content><Switch.Control><Switch.Thumb/></Switch.Control>精简筛选</Switch.Content></Switch><Button variant="secondary" onPress={()=>{setDraft({...filters});setDraftEdited(false);setAdvanced(true);}} aria-haspopup="dialog">筛选{!filters.compact&&isRefined?' · 自定义':''}</Button></div>}
  </section></div>
  {!trash&&filters.compact&&<p className="filter-help mt-2">已按地区精简{kind==='internship'?'，仅排除已评估为不优先的公司':''}；🔥 FAANG+ 岗位不受精简条件限制，未评估公司或地点待定的岗位仍保留。<Button size="sm" variant="ghost" onPress={()=>toggleCompact(false)}>恢复完整列表</Button></p>}
  {!trash&&!!filters.exclude_companies&&<div className="excluded-companies flex gap-2 flex-wrap mt-2" aria-label="已排除公司">{splitCompanies(filters.exclude_companies).map(company=><Button key={company} size="sm" variant="secondary" aria-label={'取消排除 '+company} onPress={()=>filter('exclude_companies',splitCompanies(filters.exclude_companies).filter(v=>v!==company).join(', '))}>已排除 {company} ×</Button>)}</div>}
  <div className="kind-switch"><Segment aria-label="岗位类型" selectedKey={kind} isDisabled={saving} onSelectionChange={k=>{if(k==='newgrad'||k==='internship')changeKind(k);}}><Segment.Item id="newgrad">全职</Segment.Item><Segment.Item id="internship">实习</Segment.Item></Segment>{!trash&&<span className="combined-count text-muted" aria-live="polite">{busy?'正在更新数量…':counts?countText(counts):countsUnavailable?'数量暂时不可用':'正在读取数量…'}{!busy&&counts&&<small>其中未投递 {unstarted(counts)} 个</small>}</span>}</div>
  <div className="list-meta"><h1>{trash?'回收站':kind==='newgrad'?'全职':'实习'} <span className="text-muted">{data?.total.toLocaleString()??'—'}</span></h1>{!trash&&data&&<div className="progress-counts" aria-label="当前筛选投递进度"><span className="count-submitted">已投递 {data.application_counts.submitted}</span><span className="count-unstarted">未投递 {data.total-data.application_counts.submitted}</span></div>}<div className="sync">{!trash&&<span className="text-muted">{rangeLabel(filters.added_date)+' · 每分钟更新'}</span>}<span className={stale?'text-warning':'text-muted'}>{busy?'正在更新…':stale?'部分来源待更新':synced?'已同步 '+date(synced):''}</span><Button size="sm" variant="ghost" isDisabled={busy} onPress={()=>{loader.invalidate();void load();}}>刷新</Button></div></div>
  {trash&&<p className="trash-note text-muted">保留 24 小时供恢复；到期后“已删除”标签仍有效，同步不会带回。恢复后人工保留。</p>}
  {!data&&!error&&<p className="text-muted">正在读取岗位…</p>}
  {data?.jobs.length===0&&<div className="empty">{trash?'回收站暂无岗位':'当前筛选下没有岗位'}</div>}
  {!!data?.jobs.length&&<section className="job-section" aria-label="岗位列表"><Table><Table.ScrollContainer><Table.Content aria-label={trash?'回收站岗位列表':kind==='newgrad'?'全职岗位列表':'实习岗位列表'} className="job-table"><Table.Header><Table.Column id="company" isRowHeader>公司</Table.Column><Table.Column id="role">岗位</Table.Column><Table.Column id="location">地点</Table.Column><Table.Column id="date">{filters.added_date?'收录':'发布'}</Table.Column><Table.Column id="state">{trash?'删除原因':'状态'}</Table.Column><Table.Column id="actions">操作</Table.Column></Table.Header><Table.Body items={data.jobs}>{job=><Table.Row id={job.id} className={job.status==='submitted'?'job-submitted':undefined}><Table.Cell><strong>{job.group==='faang'&&<span className="company-fire" role="img" aria-label="FAANG+" title="FAANG+">🔥</span>}{job.company}</strong></Table.Cell><Table.Cell><div className="role">{job.title}</div><div className="source text-muted">{job.sources.map(s=>names[s]||s).join(' · ')}</div></Table.Cell><Table.Cell><div className="locations" title={job.locations.join(' · ')}>{job.locations.slice(0,2).join(' · ')||'地点待核实'}{job.locations.length>2?' +'+(job.locations.length-2):''}</div></Table.Cell><Table.Cell><span className="date">{date(filters.added_date?job.added_at:job.posted_at)}</span></Table.Cell><Table.Cell>{trash?<><div>{job.review?.detail}</div><small className="text-muted">剩余 {Math.max(0,Math.ceil(((job.review?.expires_at||0)-Date.now()/1000)/3600))} 小时</small>{job.review?.evidence?.map((e,i)=><a className="evidence" key={i} title={e.quote} href={safe(e.url)} target="_blank" rel="noreferrer">依据 ↗</a>)}</>:<><Chip size="sm" variant="soft" className="application-status" color={statusColor(job)}><span aria-hidden="true">{job.status==='submitted'?'✓':''}</span><Chip.Label>{job.status==='submitted'?'已投递':'未投递'}</Chip.Label></Chip><div className="screening text-muted" title={job.review?.detail}>{job.review?.manual_keep?'人工保留':screenings[job.screening]}</div></>}</Table.Cell><Table.Cell><div className="actions">{trash?<Button size="sm" variant="secondary" isDisabled={saving} onPress={()=>restore(job)}>恢复</Button>:<>{safe(job.apply_url||job.source_url)&&<a data-jobs-id={job.id} data-jobs-kind={kind==='internship'?'intern':'newgrad'} className={'apply '+(job.status==='submitted'?'apply-completed':'')} href={safe(job.apply_url||job.source_url)} target="_blank" rel="noreferrer" onClick={()=>{if(job.status!=='submitted')void trackOpened(job);}} onAuxClick={e=>{if(e.button===1&&job.status!=='submitted')void trackOpened(job);}}>{job.status==='submitted'?'查看岗位':'申请'} ↗</a>}{job.status!=='submitted'&&<Button size="sm" variant="secondary" isDisabled={saving} onPress={()=>submission(job)}>标记已投递</Button>}{job.can_undo_submission&&<Button size="sm" variant="ghost" isDisabled={saving} onPress={()=>undoSubmission({id:job.id,version:job.application_version})}>撤销</Button>}{job.status==='not_started'&&<Button size="sm" variant="ghost" className="delete-job" onPress={()=>open('trash',job)}>删除</Button>}</>}</div></Table.Cell></Table.Row>}</Table.Body></Table.Content></Table.ScrollContainer></Table></section>}
  <footer className="footer"><span className="text-muted">第 {filters.page} / {Math.max(1,Math.ceil((data?.total||0)/50))} 页</span><Button size="sm" variant="ghost" isDisabled={filters.page===1||busy} onPress={()=>setFilters(f=>({...f,page:f.page-1}))}>上一页</Button><Button size="sm" variant="ghost" isDisabled={filters.page*50>=(data?.total||0)||busy} onPress={()=>setFilters(f=>({...f,page:f.page+1}))}>下一页</Button><Button size="sm" className="logout" variant="ghost" onPress={async()=>{await api('/api/session',{method:'DELETE'});location.reload();}}>退出</Button></footer>
  </>}
  {error&&<p role="alert" className="error text-danger">{error}</p>}{notice&&<div className="notice" role="status">{notice}{undo&&<Button size="sm" variant="ghost" isDisabled={saving} onPress={()=>undoSubmission(undo)}>{undo.length>1?'全部撤销':'撤销'}</Button>}</div>}
  <Modal.Backdrop isOpen={advanced} onOpenChange={setAdvanced}><Modal.Container><Modal.Dialog className="filter-dialog"><Modal.CloseTrigger/><Modal.Header><Modal.Heading>筛选</Modal.Heading></Modal.Header><Modal.Body>{draft&&<>
   <section aria-label="排除公司"><TextField value={draft.exclude_companies} onChange={v=>draftFilter('exclude_companies',v)}><Label>排除公司</Label><Input placeholder="例如 TikTok, Amazon" variant="secondary"/></TextField><p className="filter-help mt-2">按完整公司名称匹配，不区分大小写；多家公司用逗号分隔。仅隐藏列表，不删除岗位。</p></section>
   <section aria-label="地区范围"><p className="filter-label">地区范围</p><Select label="地域范围" value={draft.region} options={{'':'全部地区',focus_remote:'重点地区 + 美国远程',ca_remote:'加州 + 美国远程',ca:'仅加州'}} onChange={v=>draftFilter('region',v)}/>{draft.region==='focus_remote'&&<p className="filter-help mt-2">CA、WA、NY、MA、TX、美国远程，以及仅标注 USA 或地点待定的岗位。</p>}</section>
   <section aria-label="实习公司"><Checkbox isSelected={kind==='internship'&&draft.intern_companies==='1'} isDisabled={kind!=='internship'} onChange={selected=>{if(kind==='internship')draftFilter('intern_companies',selected?'1':'');}}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>排除已评估为不优先的公司（实习）</Checkbox.Content></Checkbox><p className="filter-help mt-2">{kind==='internship'?'保留推荐公司与尚未评估的公司；不会因为未进入旧名单就隐藏历史岗位。':'此条件仅用于实习，全职不按公司名单筛选。'}</p></section>
   {!trash&&<div className="filter-count" role="status" aria-live="polite">{previewError?<span className="text-danger">数量读取失败，请重新选择或稍后重试</span>:preview?<><strong>{countText(preview)}</strong><span className="text-muted">其中未投递 {unstarted(preview)} 个 · {rangeLabel(draft.added_date)}</span></>:<span className="text-muted">正在计算…</span>}</div>}
   <p className="filter-help">只调整显示，不删除岗位。</p>
  </>}</Modal.Body><Modal.Footer><Button variant="ghost" onPress={()=>{setDraftEdited(true);setDraft(f=>f?{...f,exclude_companies:'',roles:'',region:'',...(kind==='internship'?{intern_companies:''}:{})}:f);}}>全部显示</Button><Button variant="secondary" onPress={()=>setAdvanced(false)}>取消</Button><Button onPress={()=>{if(draft)setFilters({...draft,compact:draftEdited?false:filters.compact,page:1});setAdvanced(false);}}>保存并应用</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>
  <Modal.Backdrop isOpen={!!action} onOpenChange={open=>{if(!open&&!saving)setAction(null);}}><Modal.Container><Modal.Dialog className="sm:max-w-md"><Modal.CloseTrigger/><Modal.Header><Modal.Heading>删除岗位</Modal.Heading></Modal.Header><Modal.Body><p className="mb-4">{action?.job.company} · {action?.job.title}</p><TextField isRequired value={detail} onChange={setDetail}><Label>删除原因</Label><TextArea variant="secondary" autoFocus/></TextField><p className="mt-3 text-sm text-muted">添加“已删除”标签并隐藏，可在回收站恢复。以后同步不会带回。</p>{actionError&&<p className="mt-3 text-danger" role="alert">{actionError}</p>}</Modal.Body><Modal.Footer><Button variant="ghost" isDisabled={saving} onPress={()=>setAction(null)}>取消</Button><Button variant={action?.type==='trash'?'danger-soft':'primary'} isDisabled={!detail.trim()||saving} isPending={saving} onPress={confirm}>确认</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop>
 </section>;
}
createRoot(document.getElementById('root')!).render(<SiteApp Board={JobsBoard}/>);

