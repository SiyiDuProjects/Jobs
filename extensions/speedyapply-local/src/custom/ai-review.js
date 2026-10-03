import { JobsDiagnostics } from "./diagnostics.js";
import { JobsReviewPresenter } from "./review-presenter.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsFormPipeline } from "./form-pipeline.js";
import { JobsAnswerMemory } from "./answer-memory.js";
export var JobsAIReview;
let initialized = false;
export function initializeAiReview() {
  if (initialized) return;
  initialized = true;
  (() => {
    let active;
    const note = (type, detail) => JobsDiagnostics?.note(type, null, detail);
    const present = (own, data) => {
      if (window === window.top)
        JobsReviewPresenter.show(data, (action, id, payload) =>
          action === "confirm"
            ? confirm()
            : action === "answer"
              ? answer(id, payload)
              : own.locate(id),
        );
      else
        own.transport = own.transport
          .catch(() => {})
          .then(() =>
            chrome.runtime.sendMessage({
              type: "jobs:review-present",
              id: own.id,
              data,
            }),
          )
          .then((reply) => {
            if (reply?.error) throw Error(reply.error);
          })
          .catch((error) => note("auto_review_display_failed", error.message));
    };
    function create(root, reader) {
      const own = {
        id: crypto.randomUUID(),
        root,
        reader,
        url: location.href,
        items: new Map(),
        onConfirm: null,
        validate: null,
        busy: false,
        hidden: false,
        status: "正在补填，完成后可确认。",
        transport: Promise.resolve(),
      };
      own.signature = (row) =>
        JSON.stringify([
          row.public.question,
          row.public.type,
          row.public.options,
          row.raw,
        ]);
      own.refresh = (expand = false, render = true) => {
        const rows = reader.scan(),
          items = [];
        let unresolved = 0,
          omitted = 0,
          filled = 0;
        for (const [node, item] of own.items) {
          const row = rows.find((row) => row.node === node),
            record = row && reader.response(row);
          item.members = row ? [node, ...(row.group || [])] : [node];
          if ((!record && !item.omitted) || row?.public.invalid) unresolved++;
          if (!record && item.omitted) omitted++;
          if (record) filled++;
          const basis = item.needsConfirmation
            ? "待你确认"
            : item.source === "profile"
              ? "依据档案"
              : item.source === "suggestion"
                ? "AI 建议"
                : "待核对";
          const response = record?.response,
            unchanged = response === item.originalResponse;
          const signature = row && own.signature(row);
          const schema =
            row &&
            JSON.stringify([
              row.public.question,
              row.public.type,
              row.public.options,
            ]);
          if (schema !== item.schema) {
            item.schema = schema;
            item.schemaVersion = (item.schemaVersion || 0) + 1;
          }
          if (signature !== item.signature) {
            item.signature = signature;
            item.version = (item.version || 0) + 1;
          }
          let editor;
          if (
            row &&
            reader.apply &&
            row.public.supported &&
            row.public.question === item.question
          ) {
            const kind = row.public.type,
              options = row.public.options?.filter(
                (option) => option.value && option.label,
              );
            if (JobsControlFields.choiceTypes.includes(kind) && options?.length)
              editor = {
                kind:
                  kind === "select-multiple"
                    ? "multiple"
                    : options.length <= 4
                      ? "buttons"
                      : "select",
                options,
                value: kind === "search-choice" ? row.raw[0] || "" : row.raw,
              };
            else if (["checkbox", "custom-checkbox"].includes(kind))
              editor = {
                kind: "buttons",
                options: [
                  { value: true, label: "是" },
                  { value: false, label: "否" },
                ],
                value:
                  item.needsInput && !item.userAnswered
                    ? null
                    : row.raw === true,
              };
            else if (
              [
                "text",
                "textarea",
                "email",
                "tel",
                "url",
                "number",
                "date",
                "month",
                "search",
              ].includes(kind)
            )
              editor = {
                kind: kind === "textarea" ? "textarea" : "text",
                inputType: kind,
                value: row.raw,
              };
            if (editor)
              Object.assign(editor, {
                version: item.version,
                schemaVersion: item.schemaVersion,
                valid: !!record && !row.public.invalid,
                disabled: own.busy || !own.onConfirm,
              });
          }
          items.push({
            id: item.id,
            question: item.questionZh || item.question,
            originalQuestion: item.question,
            answer: response
              ? (unchanged && item.answerZh) ||
                { Yes: "是", No: "否" }[response] ||
                response
              : node.isConnected
                ? item.omitted
                  ? "无需填写"
                  : "待补充"
                : "控件已变化，请检查",
            source: item.userAnswered
              ? "你的回答"
              : response && !unchanged
                ? "已手动修改"
                : basis,
            editor,
            error: item.error || "",
          });
        }
        // Acknowledging AI answers is not whole-form validation. Missing or
        // replaced controls must never lock both Confirm and native Continue.
        own.canConfirm = !own.busy && !!own.onConfirm;
        if (own.hidden || !render) return;
        present(own, {
          id: own.id,
          title:
            filled || omitted
              ? `AI 补填 · ${filled} 项${omitted ? ` · 留空 ${omitted} 项` : ""}${unresolved ? ` · 待补 ${unresolved} 项` : ""}`
              : `需要你补充 · ${own.items.size} 项`,
          status:
            unresolved && own.onConfirm
              ? `还有 ${unresolved} 项待补或需检查，可直接在这里作答。`
              : own.status,
          canConfirm: own.canConfirm,
          items,
          expand,
        });
      };
      own.add = (
        row,
        {
          needsInput = false,
          omitted = false,
          source = "unknown",
          questionZh = "",
          answerZh = "",
          needsConfirmation = true,
        } = {},
      ) => {
        if (own.items.has(row.node)) return;
        own.items.set(row.node, {
          id: String(own.items.size),
          question: row.public.question,
          questionZh,
          answerZh,
          originalResponse: reader.response(row)?.response,
          needsInput,
          omitted,
          source,
          needsConfirmation:
            source === "suggestion" || needsConfirmation !== false,
        });
        row.node.setAttribute(
          "data-jobs-ai-review",
          needsInput ? "needs-input" : "",
        );
        own.refresh();
      };
      own.locate = (id) => {
        const node = [...own.items].find(([, item]) => item.id === id)?.[0];
        const row = reader.scan().find((row) => row.node === node);
        const target =
          row?.group.find(
            (node) =>
              node.checked || node.getAttribute("aria-checked") === "true",
          ) ||
          row?.group[0] ||
          node;
        target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
        target?.focus?.({ preventScroll: true });
      };
      let queued = false;
      const affected = (target) => {
        const box = target?.closest?.(
          '[data-automation-id="multiSelectContainer"]',
        );
        return [...own.items.values()].some((item) =>
          (item.members || []).some(
            (node) =>
              node === target ||
              node.contains(target) ||
              target?.contains?.(node) ||
              box?.contains(node),
          ),
        );
      };
      const refresh = (event) => {
        if (
          (event && !affected(event.composedPath?.()[0] || event.target)) ||
          queued
        )
          return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (active === own) own.refresh();
        });
      };
      document.addEventListener("input", refresh, true);
      document.addEventListener("change", refresh, true);
      // Workday can commit/remove a pill without an input/change event.
      const observer = new MutationObserver((records) => {
        if (
          records.some((record) => {
            const target =
              record.target.nodeType === 1
                ? record.target
                : record.target.parentElement;
            return (
              affected(target) ||
              [...record.removedNodes].some((node) => affected(node))
            );
          })
        )
          refresh();
      });
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-invalid", "aria-checked", "aria-expanded"],
      });
      own.dispose = () => {
        observer.disconnect();
        document.removeEventListener("input", refresh, true);
        document.removeEventListener("change", refresh, true);
        for (const node of own.items.keys())
          node.removeAttribute("data-jobs-ai-review");
        if (active === own) active = null;
        if (!own.hidden) present(own, null);
      };
      if (!document.querySelector("style[data-jobs-ai-review-style]")) {
        const style = document.createElement("style");
        style.dataset.jobsAiReviewStyle = "";
        style.textContent =
          '[data-jobs-ai-review]{outline:2px solid #7567ed!important;outline-offset:2px!important}[data-jobs-ai-review="needs-input"]{outline-color:#c2913a!important}';
        document.head.append(style);
      }
      return own;
    }
    async function answer(
      id,
      payload,
      { canProceed = () => true, source = "user" } = {},
    ) {
      const own = active,
        entry = own && [...own.items].find(([, item]) => item.id === id);
      if (!own || !entry || own.busy || !own.onConfirm)
        return { error: "当前不能修改，请稍候。" };
      const [node, item] = entry;
      let row = own.reader.scan().find((row) => row.node === node);
      const current = () =>
        canProceed() &&
        active === own &&
        own.root.isConnected &&
        node.isConnected &&
        location.href === own.url;
      if (
        !current() ||
        !row ||
        payload?.version !== item.version ||
        own.signature(row) !== item.signature
      ) {
        item.error = "页面选项已变化，请按更新后的选项重新选择。";
        own.refresh();
        return { error: item.error };
      }
      const expected = item.signature;
      own.busy = true;
      item.error = "";
      own.refresh();
      try {
        await own.validate?.();
        row = own.reader.scan().find((row) => row.node === node);
        if (!current() || !row || own.signature(row) !== expected)
          throw Error("页面已变化，请重新选择。");
        // The card may acknowledge a manual correction without writing its old
        // draft. Keep freshness/context validation and ordinary confirmation.
        if (payload.acceptCurrent === true) {
          if (row.public.invalid || !own.reader.response(row))
            throw Error("网页当前答案仍需检查，请先完成该题。");
          return { ok: true };
        }
        // The person's answer goes through the run's one write, as decider "user".
        const written = await JobsFormPipeline.write(
          row.node,
          { value: payload.value },
          {
            ledger: JobsFormPipeline.ledgerFor(own.root),
            root: own.root,
            decider: "user",
            source: "review-card",
            replace: true,
            canProceed: current,
          },
        );
        if (!written.ok) throw Error(written.reason);
        await own.validate?.();
        const after = own.reader.scan().find((row) => row.node === node);
        if (!current() || !after || after.public.invalid)
          throw Error("网页未接受这个答案，请检查该题。");
        item.userAnswered = true;
        item.needsInput = false;
        item.omitted = false;
        JobsAnswerMemory?.remember(item.question, node, {
          requireReview: true,
          learn: true,
        });
        note(
          source === "remote"
            ? "auto_review_remote_answer"
            : "auto_review_user_answer",
          item.id,
        );
        return { ok: true };
      } catch (error) {
        note("auto_review_answer_failed", error.message || "Write failed");
        item.error = /[\u4e00-\u9fff]/.test(error.message || "")
          ? error.message
          : "网页未接受这个答案，请重试或点题目查看原字段提示。";
        return { error: item.error };
      } finally {
        own.busy = false;
        if (active === own) own.refresh();
      }
    }
    async function confirm({ canProceed = () => true } = {}) {
      const own = active;
      if (!own || own.busy || !own.onConfirm) return false;
      own.refresh();
      if (!own.canConfirm) return false;
      own.busy = true;
      own.refresh();
      try {
        if (!canProceed()) throw Error("补答命令已过期或页面已变化");
        await own.onConfirm([...own.items.keys()], () => own.dispose(), {
          canProceed,
        });
        return true;
      } catch (error) {
        own.status = error.message || "无法确认，请检查页面。";
        note("auto_review_blocked", own.status);
        return false;
      } finally {
        own.busy = false;
        if (active === own) own.refresh();
      }
    }
    function block(event) {
      if (
        !active ||
        (event.type === "click" &&
          !JobsControlFields.continuation(event.target))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      active.status = "先检查卡片中的答案、补齐缺项，再点“确认这些答案”。";
      active.refresh(true);
      note("auto_navigation_blocked", "AI answers await user review");
    }
    document.addEventListener("click", block, true);
    document.addEventListener("submit", block, true);
    chrome.runtime.onMessage?.addListener((message, sender, reply) => {
      if (message?.type !== "jobs:review-command") return;
      if (
        sender.id !== chrome.runtime.id ||
        sender.tab ||
        message.id !== active?.id
      ) {
        reply({ error: "这份补答已过期，请检查当前页面。" });
        return;
      }
      if (message.action === "locate") {
        active.locate(message.itemId);
        reply({ ok: true });
        return;
      }
      if (message.action === "confirm") {
        confirm().then((ok) => reply({ ok }));
        return true;
      }
      if (message.action === "answer") {
        answer(message.itemId, message.payload).then(reply);
        return true;
      }
      reply({ error: "Unknown review action" });
    });
    // Remote commands name the page's application root; a run may own a step
    // inside it (a Workday step, a form inside the page's container).
    const onPage = (root) =>
      !!active &&
      !!root &&
      (active.root === root || root.contains(active.root));
    JobsAIReview = Object.freeze({
      pending: () => !!active,
      remoteState(root) {
        const own = active;
        if (!onPage(root) || !root.isConnected || location.href !== own.url)
          return null;
        own.refresh(false, false);
        const rows = own.reader.scan();
        return {
          id: own.id,
          ready: !own.busy && !!own.onConfirm,
          action: own.action || "fill",
          items: [...own.items].map(([node, item]) => ({
            itemId: item.id,
            fieldId: rows.find((row) => row.node === node)?.public.id || "",
            version: item.version || 0,
          })),
        };
      },
      matches: (root, id) => onPage(root) && active.id === id,
      async remoteAnswer(root, reviewId, itemId, payload, canProceed) {
        if (!onPage(root) || active.id !== reviewId)
          return { error: "这份补答已过期" };
        return answer(itemId, payload, { canProceed, source: "remote" });
      },
      async remoteConfirm(root, reviewId, canProceed) {
        if (!onPage(root) || active.id !== reviewId) return false;
        return confirm({ canProceed });
      },
      add(root, reader, row, options) {
        if (active && active.root !== root)
          throw Error("上一页的 AI 答案仍待确认");
        if (!active) {
          active = create(root, reader);
          active.hidden = options?.defer === true;
        }
        active.add(row, options);
      },
      canAutoConfirm(root) {
        if (!active || active.root !== root) return false;
        const rows = active.reader.scan();
        return [...active.items].every(([node, item]) => {
          const row = rows.find((row) => row.node === node);
          return (
            row &&
            !row.public.invalid &&
            !item.needsInput &&
            !item.needsConfirmation &&
            (!!active.reader.response(row) ||
              (item.omitted && !row.public.required))
          );
        });
      },
      release(root) {
        if (active?.root === root) active.dispose();
      },
      ready(onConfirm, action, { validate = undefined } = {}) {
        if (!active) return;
        active.hidden = false;
        active.onConfirm = onConfirm;
        active.action = action;
        active.validate = validate;
        active.status =
          "可在这里直接作答，点题目可查看原字段。" +
          (action === "fill"
            ? "确认后由你继续。"
            : `确认后${action === "next" ? "进入下一步" : "提交"}，有缺项会停下。`);
        active.refresh();
      },
      confirm,
    });
  })();
}
