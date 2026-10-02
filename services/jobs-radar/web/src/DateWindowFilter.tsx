import {useState} from 'react';
import {Button, Popover, RangeCalendar} from '@heroui/react';
import {getLocalTimeZone, today} from '@internationalized/date';
import {I18nProvider} from 'react-aria-components';
import {readDateWindow} from './date-window';

export function DateWindowFilter({value,onChange}:{value:string;onChange:(value:string)=>void}) {
 const [open,setOpen]=useState(false);
 const maximum=today(getLocalTimeZone());
 const selected=readDateWindow(value);
 const label=selected?`${selected.start.toString().replaceAll('-','/')} – ${selected.end.toString().replaceAll('-','/')}`:'全部时间';
 return <I18nProvider locale="zh-CN"><Popover isOpen={open} onOpenChange={setOpen}>
  <Button variant="secondary" size="sm" aria-label={`收录时间：${label}`}><span>{label}</span><span aria-hidden="true">▾</span></Button>
  <Popover.Content placement="bottom start"><Popover.Dialog>
   <RangeCalendar aria-label="选择开始和结束日期" value={selected} maxValue={maximum} onChange={range=>{
    if(range&&range.start.compare(range.end)<=0&&range.end.compare(maximum)<=0){onChange(`${range.start}/${range.end}`);setOpen(false);}
   }}>
    <RangeCalendar.Header>
     <RangeCalendar.YearPickerTrigger><RangeCalendar.YearPickerTriggerHeading/><RangeCalendar.YearPickerTriggerIndicator/></RangeCalendar.YearPickerTrigger>
     <RangeCalendar.NavButton slot="previous"/><RangeCalendar.NavButton slot="next"/>
    </RangeCalendar.Header>
    <RangeCalendar.Grid>
     <RangeCalendar.GridHeader>{day=><RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>}</RangeCalendar.GridHeader>
     <RangeCalendar.GridBody>{date=><RangeCalendar.Cell date={date}/>}</RangeCalendar.GridBody>
    </RangeCalendar.Grid>
    <RangeCalendar.YearPickerGrid><RangeCalendar.YearPickerGridBody>{({year})=><RangeCalendar.YearPickerCell year={year}/>}</RangeCalendar.YearPickerGridBody></RangeCalendar.YearPickerGrid>
   </RangeCalendar>
   <div className="date-window-footer"><Button slot={null} size="sm" variant="ghost" onPress={()=>{onChange('');setOpen(false);}}>全部时间</Button></div>
  </Popover.Dialog></Popover.Content>
 </Popover></I18nProvider>;
}
