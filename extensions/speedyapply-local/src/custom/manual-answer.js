import { stableStringify } from "./stable-value.js";
import { JobsAnswerMemory } from "./answer-memory.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsPlatformConfig } from "./platform-config.js";
import { JobsFormPipeline } from "./form-pipeline.js";
import { JobsProfileAnswers } from "./profile-answers.js";
export var JobsManualAnswer;
let initialized = false;
export function initializeManualAnswer() {
  if (initialized) return;
  initialized = true;
  (() => {
    const active = new WeakMap();
    function context(node, prompt) {
      const description = JobsControlFields.describeQuestions([
        { node, question: prompt },
      ])[0];
      const conditional = description.conditional;
      const question = conditional?.prompt || description.question || prompt;
      if (!conditional && !JobsProfileAnswers.followup(question)) return null;
      let parentQuestion = conditional?.parentQuestion || null,
        parentAnswer = conditional?.parentAnswer || null,
        applies = conditional?.active ?? null;
      if (!conditional) {
        const doc = node.ownerDocument;
        const parent = JobsPlatformConfig.detect(doc).answerParent?.(node);
        const reader = JobsControlFields.create(
          doc,
          () => node.closest("form") || doc,
        );
        const matches = parent
          ? reader.scan().filter((row) => parent.contains(row.node))
          : [];
        const row = matches.length === 1 ? matches[0] : null;
        if (row && JobsControlFields.choiceTypes.includes(row.public.type)) {
          parentQuestion = row.public.question;
          parentAnswer = reader.response(row)?.response || null;
          const selected = parentAnswer
            ? row.public.type === "select-multiple"
              ? parentAnswer.split("; ")
              : [parentAnswer]
            : [];
          applies =
            JobsProfileAnswers.followup(question, {
              options: row.public.options?.map((option) => option.label),
              selected,
            })?.active ?? null;
        }
      }
      return { question, parentQuestion, parentAnswer, active: applies };
    }
    function start(
      node,
      { prompt, additionalContext, onState, onError, onComplete },
    ) {
      active.get(node)?.disconnect();
      const dependency = context(node, prompt);
      if (dependency && dependency.active !== true) {
        onError(
          dependency.active === false
            ? "根据关联选项，此题无需生成回答。"
            : "请先完成关联问题，再生成回答。",
        );
        onState("idle");
        return null;
      }
      const dependencyKey = stableStringify(dependency);
      const answerPrompt = dependency
        ? dependency.parentQuestion + " — " + dependency.question
        : prompt;
      const answerContext = dependency
        ? stableStringify({
            formDependency: dependency,
            contextKind: "untrusted_form_state",
            additionalContext: additionalContext || "",
          })
        : additionalContext;
      if (dependency && answerContext.length > 4000) {
        onError("关联问题内容过长，请手动检查本题。");
        onState("idle");
        return null;
      }
      const original = node.value,
        originalSource = node.getAttribute("data-jobs-answer-source"),
        url = location.href,
        style = node.style.boxShadow,
        placeholder = node.placeholder;
      const port = chrome.runtime.connect({ name: "generate-response" });
      const disconnect = port.disconnect.bind(port);
      let expected = original,
        stopped = false,
        finished = false,
        invalidating = false,
        writing = false;
      const events = ["input", "beforeinput", "keydown", "paste"];
      const scope = node.closest("form") || node.ownerDocument;
      let observer;
      function stop() {
        if (stopped) return;
        stopped = true;
        events.forEach((type) => node.removeEventListener(type, edit));
        scope.removeEventListener("input", dependencyChanged);
        scope.removeEventListener("change", dependencyChanged);
        observer?.disconnect();
        if (active.get(node) === port) active.delete(node);
        node.style.boxShadow = style;
        node.placeholder = placeholder;
        disconnect();
      }
      function valid() {
        if (stopped || finished) return false;
        if (
          active.get(node) !== port ||
          !node.isConnected ||
          location.href !== url ||
          node.disabled ||
          node.readOnly ||
          node.value !== expected
        ) {
          stop();
          onState("idle");
          return false;
        }
        if (dependencyChanged()) return false;
        return true;
      }
      function dependencyChanged() {
        if (stopped || invalidating || !dependency) return false;
        if (!node.isConnected) {
          stop();
          onState("idle");
          return true;
        }
        if (stableStringify(context(node, prompt)) === dependencyKey)
          return false;
        invalidating = true;
        const book = JobsFormPipeline.ledgerFor(scope);
        if (node.value === expected && book?.peek(node)?.decider === "user")
          book.abstain(node, "user", "manual_generation_context_changed");
        restore();
        stop();
        JobsAnswerMemory?.cancel(node);
        onError("关联答案已变化，请检查本题并重新生成。");
        onState("idle");
        return true;
      }
      function edit(event) {
        if (writing) return;
        if (
          (event.isTrusted && event.type !== "input") ||
          node.value !== expected
        ) {
          stop();
          onState("idle");
        }
      }
      function write(value, change = false) {
        expected = String(value);
        writing = true;
        try {
          Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          ).set.call(node, expected);
          node.dispatchEvent(
            new InputEvent("input", { bubbles: true, cancelable: true }),
          );
          if (change)
            node.dispatchEvent(new Event("change", { bubbles: true }));
        } finally {
          writing = false;
        }
      }
      const restore = () => {
        if (
          !stopped &&
          active.get(node) === port &&
          node.isConnected &&
          location.href === url &&
          node.value === expected &&
          !node.disabled &&
          !node.readOnly
        ) {
          write(original, true);
          if (originalSource == null)
            node.removeAttribute("data-jobs-answer-source");
          else node.setAttribute("data-jobs-answer-source", originalSource);
        }
      };
      port.disconnect = () => {
        if (!finished) restore();
        stop();
        onState("idle");
      };
      active.set(node, port);
      JobsAnswerMemory?.cancel(node);
      JobsDiagnostics?.note("luna_started", node);
      events.forEach((type) => node.addEventListener(type, edit));
      if (dependency) {
        scope.addEventListener("input", dependencyChanged);
        scope.addEventListener("change", dependencyChanged);
        observer = new node.ownerDocument.defaultView.MutationObserver(
          dependencyChanged,
        );
        observer.observe(scope, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }
      onError("");
      onState("progress");
      port.onMessage.addListener(async (message) => {
        if (!valid()) return;
        if (message.type === "STREAM_UPDATE") {
          write(message.text);
          node.scrollTop = node.scrollHeight;
        } else if (message.type === "STREAM_ERROR") {
          write(original, true);
          onError(message.error || "Luna 暂时不可用，请重试");
          stop();
          onState(
            ["QUOTA_EXHAUSTED", "NOT_AUTHENTICATED"].includes(message.code)
              ? "idle"
              : "error",
          );
        } else if (message.type === "STREAM_END") {
          let accepted;
          try {
            accepted = await JobsFormPipeline.write(
              node,
              { value: expected },
              {
                root: scope,
                ledger:
                  JobsFormPipeline.ledgerFor(scope) ||
                  JobsFormPipeline.ledger(scope),
                decider: "user",
                source: message.source || "unknown",
                reason: "manual_generation",
                replace: true,
                canProceed: valid,
              },
            );
          } catch {
            accepted = { ok: false };
          }
          if (!valid()) return;
          if (!accepted.ok) {
            onError("网站未接受答案，请检查字段。");
            stop();
            onState("error");
            return;
          }
          node.setAttribute(
            "data-jobs-answer-source",
            message.source || "unknown",
          );
          JobsDiagnostics?.note(
            "luna_completed",
            node,
            message.source || "unknown",
          );
          JobsAnswerMemory?.remember(answerPrompt, node, {
            learn: message.source === "suggestion",
          });
          finished = true;
          if (dependency) disconnect();
          else stop();
          onComplete(message.responseId);
          onState("finished");
        }
      });
      port.onDisconnect?.addListener(() => {
        if (!stopped && !finished) {
          restore();
          stop();
          onError("连接中断，原答案已保留，请重试");
          onState("error");
        }
      });
      port.postMessage({
        type: "GENERATE_RESPONSE",
        prompt: answerPrompt,
        additionalContext: answerContext,
      });
      return port;
    }
    JobsManualAnswer = {
      start,
      cancel: (node) => active.get(node)?.disconnect(),
    };
  })();
}
