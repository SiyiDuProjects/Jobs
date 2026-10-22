// Shared button recognition; independent of form scanners and widget writers.
export function continuation(target) {
  const button = target?.closest?.(
    'button,input[type="submit"],[role="button"]',
  );
  if (
    !button ||
    button.disabled ||
    button.matches('[role="radio"],[role="checkbox"]')
  )
    return null;
  const label = String(
    button.getAttribute("aria-label") ||
      button.value ||
      button.textContent ||
      "",
  )
    .replace(/\s+/g, " ")
    .trim();
  if (/back|previous|cancel|delete|remove|withdraw|later/i.test(label))
    return null;
  return /^(?:next|continue|submit|apply|save (?:and|&) continue|下一步|继续|提交)(?:\b|\s|$)/i.test(
    label,
  )
    ? button
    : null;
}
