import { readModule } from "./module-source.mjs";
import fs from "node:fs/promises";
import vm from "node:vm";
export const resolverSource = await readModule(
  new URL("../../src/custom/answer-resolver.js", import.meta.url),
  "utf8",
);
// The maintained resolver with only its storage boundary replaced: the saved
// responses are the value of `saved` (an expression evaluated on each read).
export const resolverWith = (saved) =>
  resolverSource +
  `
;(()=>{const resolver=globalThis.JobsAnswerResolver,read=async()=>(${saved});
globalThis.JobsAnswerResolver=Object.freeze({...resolver,readSaved:read,resolve:async(questions,profile,options={})=>resolver.resolve(questions,profile,{saved:await read(),...options})});})();`;
// Install it in a window or vm context with fixture saved responses.
export function installAnswerResolver(target, saved = []) {
  target.fixtureSavedResponses = saved;
  const code = resolverWith("globalThis.fixtureSavedResponses");
  if (vm.isContext(target)) vm.runInContext(code, target);
  else target.eval(code);
  return target.JobsAnswerResolver.resolve;
}
