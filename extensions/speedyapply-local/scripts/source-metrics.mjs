import { parse } from "@babel/parser";
export function measure(source, names) {
  const result = {};
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "FunctionDeclaration" && names.includes(node.id?.name)) {
      const helpers = [];
      function children(value) {
        if (!value || typeof value !== "object") return;
        if (
          [
            "FunctionDeclaration",
            "FunctionExpression",
            "ArrowFunctionExpression",
            "ObjectMethod",
          ].includes(value.type)
        ) {
          helpers.push({
            name: value.id?.name || value.key?.name || "callback",
            lines: value.loc.end.line - value.loc.start.line + 1,
          });
          return;
        }
        for (const [key, child] of Object.entries(value))
          if (key !== "loc") {
            if (Array.isArray(child)) child.forEach(children);
            else children(child);
          }
      }
      node.body.body.forEach(children);
      const lines = node.loc.end.line - node.loc.start.line + 1;
      result[node.id.name] = {
        lines,
        ownLines: lines - helpers.reduce((n, h) => n + h.lines, 0),
        helpers,
      };
    }
    for (const [key, value] of Object.entries(node))
      if (key !== "loc") {
        if (Array.isArray(value)) value.forEach(visit);
        else visit(value);
      }
  }
  visit(parse(source, { sourceType: "module" }));
  return result;
}
