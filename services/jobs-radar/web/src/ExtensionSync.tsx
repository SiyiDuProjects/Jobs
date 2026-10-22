import {useEffect,useRef,useState} from 'react';

type Status={installed:boolean;connected:boolean;disabled?:boolean;queued:number;error?:string;lastSynced:number|null};
// The extension's answer console lists every open application's questions.
export const openAnswerConsole=()=>window.postMessage({type:'jobs:open-console'},location.origin);
export function ExtensionSync({onSynced,onInstalled}:{onSynced:()=>Promise<void>;onInstalled?:(installed:boolean)=>void}){
 const [launchError,setLaunchError]=useState('');
 const reload=useRef(onSynced),installed=useRef(onInstalled),last=useRef<number|null>(null);reload.current=onSynced;installed.current=onInstalled;
 const send=(type:string)=>window.postMessage({type},location.origin);
 useEffect(()=>{
  const receive=(event:MessageEvent)=>{
   if(event.source===window&&event.origin===location.origin&&event.data?.type==='jobs:launch-error'){setLaunchError(String(event.data.error));return;}
   if(event.source!==window||event.origin!==location.origin||event.data?.type!=='jobs:extension-status')return;
   const value=event.data as Status;
   installed.current?.(value.installed===true);
   if(value.lastSynced&&value.lastSynced!==last.current){last.current=value.lastSynced;void reload.current();}
  };
  window.addEventListener('message',receive);
  send('jobs:website-ready');
  const timer=setInterval(()=>send('jobs:website-ready'),30000);
  return()=>{clearInterval(timer);window.removeEventListener('message',receive);};
 },[]);
 return launchError?<p role="alert" className="text-danger">{launchError}</p>:null;
}
