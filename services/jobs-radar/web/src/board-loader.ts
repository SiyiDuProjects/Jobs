type API = (path:string, options?:RequestInit)=>Promise<any>;
// List requests follow navigation; shared totals depend on filters, not pages.
// This cache is private to the open page and invalidated after every mutation.
export function createBoardLoader(api:API, now=Date.now) {
 let controller:AbortController|undefined, epoch=0;
 const cache=new Map<string,{expires:number;task:Promise<any>}>();
 function cached(path:string) {
  const previous=cache.get(path);
  if(previous&&previous.expires>now())return previous.task;
  const generation=epoch;
  const entry={expires:now()+60000,task:Promise.resolve() as Promise<any>};
  entry.task=api(path).catch(error=>{if(generation===epoch&&cache.get(path)===entry)cache.delete(path);throw error;});
  cache.set(path,entry);
  // Keep rapid filter exploration bounded; pending callers still own their promises.
  while(cache.size>8)cache.delete(cache.keys().next().value!);
  return entry.task;
 }
 return {
  jobs(params:URLSearchParams) {
   controller?.abort();controller=new AbortController();
   return api('/api/jobs?'+params,{signal:controller.signal});
  },
  counts(params:URLSearchParams) {
   const filters=new URLSearchParams(params);
   for(const key of ['page','page_size','kind','view'])filters.delete(key);
   filters.sort();return cached('/api/filter-counts?'+filters);
  },
  invalidate(){epoch++;cache.clear();},
  cancel(){controller?.abort();},
 };
}
