import {useState} from "react";
import {Button,Card} from "@heroui/react";
import {Choice,Field,Upload} from "./components";
import {assertProfile,defaultProfile,type Profile} from "./model";
import {store,useManagement} from "./store";
export function NewProfile(){
 const [id]=useState(()=>crypto.randomUUID()),[p,setP]=useState<Profile>(()=>structuredClone(defaultProfile)),[source,setSource]=useState("");
 const {profiles,pending}=useManagement();
 const create=async()=>{try{if(!p.profileName.trim())throw Error("请填写资料名称");await store.saveProfile({...p,profileName:p.profileName.trim()},null,id);location.hash="/profile";}catch(e){store.report(e);}};
 return <div className="max-w-2xl space-y-5"><h1 className="text-2xl font-semibold">新建资料</h1><Card><Card.Content className="gap-4"><Field label="资料名称" value={p.profileName} onChange={v=>setP({...p,profileName:v})}/><div className="grid sm:grid-cols-2 gap-4"><Field label="名" value={p.nameData.firstName} onChange={v=>setP({...p,nameData:{...p.nameData,firstName:v}})}/><Field label="姓" value={p.nameData.lastName} onChange={v=>setP({...p,nameData:{...p.nameData,lastName:v}})}/></div><details><summary className="text-sm text-muted cursor-pointer">从现有资料开始</summary><div className="space-y-3 mt-3"><Choice label="复制已有资料" value={source} options={Object.fromEntries(profiles.map(v=>[v.id,v.profileName]))} onChange={setSource}/><Button variant="secondary" isDisabled={!source} onPress={async()=>{try{const row=await store.profileAPI("/"+source);setP({...row.profile,profileName:row.profile.profileName+" 副本"});}catch(e){store.report(e);}}}>复制</Button><Upload label="导入资料 JSON" accept=".json" onFile={async file=>{const value=JSON.parse(await file.text());assertProfile(value);setP(value);}}/></div></details></Card.Content><Card.Footer><Button isPending={pending>0} onPress={create}>创建资料</Button></Card.Footer></Card></div>;
}
