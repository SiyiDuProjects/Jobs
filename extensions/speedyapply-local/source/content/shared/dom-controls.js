import { JobsDOMWait } from "../../../src/custom/dom-wait.js";
import { JobsControlFields } from "../../../src/custom/control-fields.js";
import { JobsDiagnostics } from "../../../src/custom/diagnostics.js";
import { JobsPageActions } from "../../../src/custom/page-actions.js";
import { JobsProfileAnswers } from "../../../src/custom/profile-answers.js";
import { JobsPlatformConfig } from "../../../src/custom/platform-config.js";

// A hidden success template is not an ATS receipt. Keep waiting for the
// platform's explicit success marker to become visible.
export function jobsWaitForConfirmation(platform, options = {}) {
  return JobsDOMWait.until(
    () => JobsPlatformConfig.confirmation(document, platform),
    options,
  );
}

function jobsWaitForCssNodes(selector, root = document) {
  return JobsDOMWait.until(
    () => {
      const nodes = Array.from(root.querySelectorAll(selector));
      return nodes.length ? nodes : null;
    },
    { root: root },
  );
}
// Sign-in and registration pages take the saved account settings. They are
// not application answers: no run, rules or AI, and nothing is pressed.
// Each field is a CSS selector, an XPath (starting with / or () or a
// function, with a text value, a check, or a spec chosen from its options.
async function jobsFillAccount(fields) {
  for (const { find, value, checked, spec, topic } of fields) {
    const node =
      typeof find === `function`
        ? find()
        : /^\(*\.?\//.test(find)
          ? jobsFindXPath(find)
          : document.querySelector(find);
    if (!node) continue;
    if (topic === "consent") {
      node.dataset.jobsTopic = topic;
      const row = JobsControlFields.create(
        node.ownerDocument,
        () => node.closest("form") || node.ownerDocument,
      )
        .scan()
        .find((item) => item.node === node);
      if (!row) continue;
      const answer = JobsProfileAnswers.resolve(
        row.public.question,
        {},
        { ...row.public, topicHint: topic },
      );
      if (answer?.reason !== "authorized_consent") continue;
      await JobsControlFields.chooseSpec(
        node,
        JobsProfileAnswers.answerSpec(answer),
        { source: "rule" },
      );
    } else if (checked !== undefined)
      await JobsControlFields.writeChecked(node, checked);
    else if (spec)
      await JobsControlFields.chooseSpec(node, spec, { source: `account` });
    else if (value)
      await JobsControlFields.writeText(node, value, {
        keyboard: true,
        click: true,
      });
  }
}
// A step's navigation for its run: its Next button when the step has one,
// otherwise the final submit; each only when the person's settings allow it.
function jobsStepNavigation(settings, next, submit) {
  return document.querySelector(next)
    ? { action: settings?.autoClickNextPage ? `next` : `fill`, selector: next }
    : { action: settings?.autoSubmit ? `submit` : `fill`, selector: submit };
}
function jobsWatchCssPresence(selector, onPresent, excludedIds, onAbsent) {
  let present = !1,
    checkPresence = () => {
      let a = document.querySelectorAll(selector),
        o = Array.from(a).filter(
          (e) => !excludedIds || !excludedIds.includes(e.id),
        );
      o.length > 0 && !present
        ? ((present = !0), onPresent(o))
        : o.length === 0 && present && ((present = !1), onAbsent?.());
    };
  (checkPresence(),
    new MutationObserver((e) => {
      checkPresence();
    }).observe(document.body, { childList: !0, subtree: !0 }));
}
async function jobsWaitForXPathRemoval(xpath) {
  await JobsDOMWait.until(() => !jobsFindXPath(xpath));
}
function jobsWaitForXPathNodes(xpath) {
  return JobsDOMWait.until(() => {
    const nodes = jobsFindAllXPath(xpath);
    return nodes.length ? nodes : null;
  });
}
async function jobsWaitForXPathNodesWithRetry(
  xpath,
  timeout = 5e3,
  maxAttempts = 1,
  onRetry,
) {
  for (let attempt = 1; ; attempt++) {
    const nodes = await JobsDOMWait.until(
      () => {
        const found = jobsFindAllXPath(xpath);
        return found.length ? found : null;
      },
      { timeout: timeout },
    );
    if (nodes) return nodes;
    if (attempt >= maxAttempts) return [];
    if (onRetry) onRetry(attempt);
  }
}
function jobsFindXPath(xpath, root) {
  let snapshot = document.evaluate(
    xpath,
    root ?? document,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  return snapshot.snapshotLength > 0 ? snapshot.snapshotItem(0) : null;
}
function jobsFindAllXPath(xpath, root) {
  let nodes = [],
    snapshot = document.evaluate(
      xpath,
      root || document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
  for (let e = 0; e < snapshot.snapshotLength; e++) {
    let t = snapshot.snapshotItem(e);
    t && nodes.push(t);
  }
  return nodes;
}
function jobsWatchXPathPresence(xpath, onPresent, onAbsent) {
  let present = !1,
    checkPresence = () => {
      let i = jobsFindXPath(xpath);
      i && !present
        ? ((present = !0), onPresent(i))
        : !i && present && ((present = !1), onAbsent && onAbsent());
    };
  (checkPresence(),
    new MutationObserver(checkPresence).observe(document.documentElement, {
      childList: !0,
      subtree: !0,
    }));
}
function jobsClick(selector, useXPath = false, root = document) {
  const run = () => jobsClickValue(selector, useXPath, root);
  return JobsDiagnostics
    ? JobsDiagnostics.perform(
        "click",
        () =>
          useXPath
            ? jobsFindXPath(selector, jobsIsDocumentNode(root) ? root : void 0)
            : root.querySelector(selector),
        run,
      )
    : run();
}
function jobsClickValue(selector, useXPath = !1, root = document) {
  let element = useXPath
    ? jobsFindXPath(selector, jobsIsDocumentNode(root) ? root : void 0)
    : root.querySelector(selector);
  return element && JobsPageActions.click(element) ? element : null;
}
async function jobsClickAllXPath(xpath) {
  let t = document.evaluate(
    xpath,
    document,
    null,
    XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  for (let e = 0; e < t.snapshotLength; e++) {
    let n = t.snapshotItem(e);
    if (n && !JobsPageActions.click(n)) return null;
  }
}
function jobsWaitAndClick(selector, useXPath = false) {
  const run = () => jobsWaitAndClickValue(selector, useXPath);
  return JobsDiagnostics
    ? JobsDiagnostics.perform(
        "wait_click",
        () =>
          useXPath ? jobsFindXPath(selector) : document.querySelector(selector),
        run,
      )
    : run();
}
async function jobsWaitAndClickValue(selector, useXPath = !1) {
  return useXPath
    ? jobsWaitForXPathNodes(selector).then((e) =>
        e.length > 0 && JobsPageActions.click(e[0]) ? e[0] : null,
      )
    : jobsWaitForCssNodes(selector).then((e) =>
        e.length > 0 && JobsPageActions.click(e[0]) ? e[0] : null,
      );
}
function jobsPdfFileFromBase64(base64, fileName) {
  let decoded = atob(base64),
    bytes = Array(decoded.length);
  for (let e = 0; e < decoded.length; e++) bytes[e] = decoded.charCodeAt(e);
  let blob = new Blob([new Uint8Array(bytes)], { type: `application/pdf` });
  return new File([blob], fileName, { type: `application/pdf` });
}
/** @param {Document|Element|ShadowRoot} [root] */
function jobsUploadResume(resume, selector, useXPath = false, root = document) {
  const run = () => jobsUploadResumeValue(resume, selector, useXPath, root);
  return JobsDiagnostics
    ? JobsDiagnostics.perform(
        "upload",
        () =>
          useXPath
            ? jobsFindXPath(selector, jobsIsDocumentNode(root) ? root : void 0)
            : root.querySelector(selector),
        run,
      )
    : run();
}
/** @param {Document|Element|ShadowRoot} [root] */
function jobsUploadResumeValue(
  resume,
  selector,
  useXPath = !1,
  root = document,
) {
  if (!JobsPageActions.allowed()) return null;
  let input = useXPath
    ? jobsFindXPath(selector, jobsIsDocumentNode(root) ? root : void 0)
    : root.querySelector(selector);
  if (input) {
    let t = jobsPdfFileFromBase64(resume.resumeBase64, resume.fileName),
      n = new DataTransfer();
    (n.items.add(t),
      (input.files = n.files),
      JobsPageActions.dispatch(input, new Event(`input`, { bubbles: !0 })),
      JobsPageActions.dispatch(input, new Event(`change`, { bubbles: !0 })));
  }
}
function jobsDelay(milliseconds) {
  return new Promise((t) => setTimeout(t, milliseconds));
}
function jobsWatchAttribute(selector, attributeName, onChange, useXPath = !1) {
  let previousValue = null,
    checkAttribute = () => {
      let a =
        (useXPath
          ? jobsFindXPath(selector)
          : document.querySelector(selector)
        )?.getAttribute(attributeName) ?? null;
      a !== previousValue && ((previousValue = a), onChange(a));
    };
  (checkAttribute(),
    new MutationObserver(checkAttribute).observe(document.documentElement, {
      childList: !0,
      subtree: !0,
      attributes: !0,
      attributeFilter: [attributeName],
    }));
}
function jobsIsDocumentNode(value) {
  return (
    typeof value == `object` &&
    !!value &&
    `nodeType` in value &&
    value.nodeType === Node.DOCUMENT_NODE
  );
}

export {
  jobsWaitForCssNodes,
  jobsFillAccount,
  jobsStepNavigation,
  jobsWatchCssPresence,
  jobsWaitForXPathRemoval,
  jobsWaitForXPathNodes,
  jobsWaitForXPathNodesWithRetry,
  jobsFindXPath,
  jobsFindAllXPath,
  jobsWatchXPathPresence,
  jobsClick,
  jobsClickValue,
  jobsClickAllXPath,
  jobsWaitAndClick,
  jobsWaitAndClickValue,
  jobsPdfFileFromBase64,
  jobsUploadResume,
  jobsUploadResumeValue,
  jobsDelay,
  jobsWatchAttribute,
  jobsIsDocumentNode,
};
