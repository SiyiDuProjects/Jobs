// Exercise the maintained common entrance, including literal normalization,
// option matching, component transaction and answer trace.
export function chooseAnswer(node, value, options = {}) {
  const fields = node.ownerDocument.defaultView.JobsControlFields;
  return fields.chooseSpec(node, fields.literalSpec(node, value), options);
}
