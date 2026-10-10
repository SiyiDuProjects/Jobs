// Static instructions belong to the question, never to the whole page or to
// another field's answer. Keep this read-only context identical in both passes.
export const FIELD_DESCRIPTION_LIMIT = 20000;
export function fieldDescription(node, group, scope, platform, visible) {
  const boxes = [
    "fieldset",
    '[role="group"]',
    '[role="radiogroup"]',
    platform.descriptionBox,
    platform.questionBox,
  ]
    .filter(Boolean)
    .join(",");
  const controls =
    'input:not([type="hidden"]),textarea,select,[contenteditable],' +
    '[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="listbox"]';
  const omitted = [
    "input,textarea,select,[contenteditable],script,style,template," +
      'button,[role="button"],[role="option"],[role="textbox"],[role="combobox"],[role="listbox"],' +
      '[role="alert"],[data-jobs-diagnostics],[data-jobs-review]',
    platform.errorSelector,
  ]
    .filter(Boolean)
    .join(",");
  const members = [node, ...(group || [])];
  const errors = new Set(
    members.flatMap((member) =>
      (member.getAttribute("aria-errormessage") || "")
        .split(/\s+/)
        .map((id) => member.getRootNode().getElementById?.(id))
        .filter(Boolean),
    ),
  );
  const owns = (element) =>
    members.some((member) => member === element || member.contains(element));
  const parts = [];
  const references = new Set();
  function read(element, explicit = false) {
    if (
      !element ||
      errors.has(element) ||
      element.matches(omitted) ||
      (!explicit && !visible(element))
    )
      return "";
    return [...element.childNodes]
      .map((child) => {
        if (child.nodeType === 3) return child.textContent;
        if (child.nodeType !== 1) return "";
        if (!explicit && child.matches("label,legend")) return "";
        return read(child, explicit);
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function describedBy(element) {
    const tree = element.getRootNode();
    for (const id of (element.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter(Boolean)) {
      const target = tree.getElementById?.(id);
      if (target && !references.has(target)) {
        references.add(target);
        parts.push(read(target, true));
      }
    }
    parts.push(element.getAttribute("aria-description") || "");
  }
  members.forEach(describedBy);
  let owner = null;
  for (
    let box = node.closest(boxes);
    box && scope.contains(box);
    box = box.parentElement?.closest(boxes)
  ) {
    if (
      box.matches('form,[role="form"]') ||
      [...box.querySelectorAll(controls)].some((control) => !owns(control))
    )
      break;
    owner = box;
    describedBy(box);
  }
  if (owner) parts.push(read(owner));
  // A referenced help node may also be inside the owning fieldset.
  const unique = [...new Set(parts.filter(Boolean))];
  const description = unique
    .filter(
      (part) => !unique.some((other) => other !== part && other.includes(part)),
    )
    .join("\n");
  return description.length > FIELD_DESCRIPTION_LIMIT
    ? { description: "", descriptionIncomplete: true }
    : { description };
}
