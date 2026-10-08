import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createPageReview } from "../src/custom/page-review.js";
import { createOperatorState } from "../src/custom/operator-state.js";

test("page and panel share one editor; reads never claim control and writes cannot learn", async () => {
  const dom = new JSDOM("<body><form><input value='existing'></form></body>", {url:"https://jobs.ashbyhq.com/example/role"});
  const names = ["document", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement"];
  const prior = names.map(name => [name, globalThis[name]]);
  const oldChrome = globalThis.chrome;
  for (const name of names) globalThis[name] = dom.window[name];
  globalThis.chrome = {runtime:{id:"fixture",getURL:path=>"chrome-extension://fixture/"+path}};
  const operator = createOperatorState(), claims = [], actions = [];
  operator.update({mode:"person",epoch:"initial"});
  const page = createPageReview({operator, claim:async mode => {claims.push(mode);operator.update({mode,epoch:"agent-"+claims.length});}});
  const data = {id:"review-1",title:"补答",status:"检查后继续",canConfirm:true,
    items:[{id:"field-1",question:"Synthetic preference",answer:"Draft",source:"AI",reviewState:"ready"}]};
  try {
    page.show(data, async action => {actions.push(action);return {ok:true};});
    const host = document.querySelector("[data-jobs-operator]");
    assert.equal(host.shadowRoot.querySelector(".review").hidden,true);
    assert.equal(claims.length,0,"a status read never changes ownership");
    await host.shadowRoot.querySelector("button").onclick({isTrusted:true});
    assert.equal(operator.read().mode,"page-tool");
    assert.equal(operator.canLearn(),false);
    const review = host.shadowRoot.querySelector("#jobs-ai-review").shadowRoot;
    assert.equal(review.querySelector("link").getAttribute("href"),"chrome-extension://fixture/custom/popup.css");
    review.querySelector("#confirm").onclick({isTrusted:true});
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual(actions,["confirm"]);
    assert(claims.every(mode=>mode==="page-tool"));
    operator.update({mode:"person",epoch:"hand-back"});
    assert.equal(host.shadowRoot.querySelector("#jobs-ai-review"),null);
    assert.equal(document.querySelector("form input").value,"existing");
  } finally {
    page.dispose(); dom.window.close();
    for (const [name,value] of prior) if(value===undefined) delete globalThis[name]; else globalThis[name]=value;
    if(oldChrome===undefined) delete globalThis.chrome; else globalThis.chrome=oldChrome;
  }
});
