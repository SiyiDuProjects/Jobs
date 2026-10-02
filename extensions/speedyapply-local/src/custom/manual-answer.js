import { JobsAnswerMemory } from "./answer-memory.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsControlFields } from "./control-fields.js";
export var JobsManualAnswer;
let initialized = false;
export function initializeManualAnswer() {
  if (initialized) return;
  initialized = true;
  (() => {
    const active = new WeakMap();
    function start(
      node,
      { prompt, additionalContext, onState, onError, onComplete },
    ) {
      active.get(node)?.disconnect();
      const original = node.value,
        url = location.href,
        style = node.style.boxShadow,
        placeholder = node.placeholder;
      const port = chrome.runtime.connect({ name: "generate-response" });
      const disconnect = port.disconnect.bind(port);
      let expected = original,
        stopped = false,
        writing = false;
      const events = ["input", "beforeinput", "keydown", "paste"];
      function stop() {
        if (stopped) return;
        stopped = true;
        events.forEach((type) => node.removeEventListener(type, edit));
        if (active.get(node) === port) active.delete(node);
        node.style.boxShadow = style;
        node.placeholder = placeholder;
        disconnect();
      }
      function valid() {
        if (stopped) return false;
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
        )
          write(original, true);
      };
      port.disconnect = () => {
        restore();
        stop();
        onState("idle");
      };
      active.set(node, port);
      JobsAnswerMemory?.cancel(node);
      JobsDiagnostics?.note("luna_started", node);
      events.forEach((type) => node.addEventListener(type, edit));
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
          const accepted = await JobsControlFields.writeText(node, expected, {
            canProceed: valid,
          });
          if (!valid()) return;
          if (!accepted) {
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
          JobsAnswerMemory?.remember(prompt, node, {
            learn: message.source === "suggestion",
          });
          stop();
          onComplete(message.responseId);
          onState("finished");
        }
      });
      port.onDisconnect?.addListener(() => {
        if (!stopped) {
          restore();
          stop();
          onError("连接中断，原答案已保留，请重试");
          onState("error");
        }
      });
      port.postMessage({
        type: "GENERATE_RESPONSE",
        prompt,
        additionalContext,
      });
      return port;
    }
    JobsManualAnswer = { start };
  })();
}
