import { JobsManualAnswer } from "../../../src/custom/manual-answer.js";
import { jobsFindAllXPath, jobsFindXPath } from "./dom-controls.js";
// One explicit request control per textarea; the answer service owns cancellation.
export async function jobsMountManualAnswerControls(context, pairs) {
  for (const [fields, label] of pairs)
    for (const node of jobsFindAllXPath(fields)) {
      if (node.dataset.jobsAnswerControl === "true") continue;
      const prompt = jobsFindXPath(label, node)?.textContent?.trim();
      if (!prompt) continue;
      node.dataset.jobsAnswerControl = "true";
      const box = document.createElement("span"),
        button = document.createElement("button"),
        status = document.createElement("span");
      box.dataset.jobsUi = "manual-answer";
      button.type = "button";
      button.textContent = "生成回答";
      status.setAttribute("role", "status");
      box.append(button, status);
      node.after(box);
      let request;
      button.addEventListener("click", () => {
        if (request) {
          request.disconnect();
          request = null;
          return;
        }
        request = JobsManualAnswer.start(node, {
          prompt,
          additionalContext: "",
          onState: (phase) => {
            button.textContent = phase === "progress" ? "取消生成" : "生成回答";
            if (phase !== "progress") request = null;
          },
          onError: (message) => {
            status.textContent = message;
          },
          onComplete: () => {
            status.textContent = "已生成，请检查答案";
            request = null;
          },
        });
      });
      context?.onInvalidated?.(() => {
        request?.disconnect();
        box.remove();
        delete node.dataset.jobsAnswerControl;
      });
    }
}
