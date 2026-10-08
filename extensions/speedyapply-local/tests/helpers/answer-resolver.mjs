import { readModule } from "./module-source.mjs";
import vm from "node:vm";
export const resolverSource = await readModule(
  new URL("../../src/custom/answer-resolver.js", import.meta.url),
  "utf8",
);
// The runtime no longer reads Saved Responses in the local resolver.
// The argument remains only for older fixture call signatures.
export const resolverWith = (_saved) => resolverSource;
// Install it in a window or vm context with fixture saved responses.
export function installAnswerResolver(target, saved = []) {
  target.fixtureSavedResponses = saved;
  const code = resolverWith("globalThis.fixtureSavedResponses");
  if (vm.isContext(target)) vm.runInContext(code, target);
  else target.eval(code);
  return target.JobsAnswerResolver.resolve;
}
