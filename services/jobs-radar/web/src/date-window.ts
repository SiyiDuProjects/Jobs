import {getLocalTimeZone, parseDate, today, type CalendarDate} from '@internationalized/date';

export type DateWindow = {start:CalendarDate;end:CalendarDate};

export function readDateWindow(value:unknown):DateWindow|null {
 if(typeof value!=='string'||!value)return null;
 try {
  const dates=value==='today'?[today(getLocalTimeZone()).toString()]:value.split('/');
  if(dates.length>2)return null;
  const start=parseDate(dates[0]),end=parseDate(dates[1]??dates[0]);
  return start.compare(end)<=0?{start,end}:null;
 }catch{return null;}
}

export function normalizeDateWindow(value:unknown):string {
 const range=readDateWindow(value);
 return range?`${range.start}/${range.end}`:'';
}

export function rangeLabel(value:string):string {
 const range=readDateWindow(value);
 if(!range)return '全部时间';
 return range.start.compare(range.end)===0?`${range.start} 收录`:`${range.start} 至 ${range.end} 收录`;
}

export function addedRange(value:string):Record<string,string> {
 const range=readDateWindow(value);
 if(!range)return {};
 const zone=getLocalTimeZone();
 // The chosen end day is inclusive; use the next local midnight across DST changes.
 return {added_since:String(range.start.toDate(zone).getTime()/1000),
  added_before:String(range.end.add({days:1}).toDate(zone).getTime()/1000)};
}
