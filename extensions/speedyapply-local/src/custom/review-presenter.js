import { JobsControlFields } from "./control-fields.js";
export var JobsReviewPresenter;
let initialized = false;
export function initializeReviewPresenter() {
  if (initialized) return;
  initialized = true;
  (() => {
    let slot, view, last;
    function removeView() {
      if (!view) return;
      for (const [node, display] of view.hidden) node.style.display = display;
      view.host.remove();
      view = null;
    }
    function editorFor(item, row) {
      let box = item.querySelector(".editor");
      if (!box) {
        box = document.createElement("div");
        box.className = "editor";
        item.append(box);
      }
      const editor = row.editor,
        key = JSON.stringify([
          editor?.kind,
          editor?.inputType,
          editor?.options,
        ]);
      item.reviewRow = row;
      // One write path and one button: an edit is written to the page when it
      // is committed (a choice, Enter, leaving the field) and at the latest by
      // Confirm, which never discards an answer typed in the card.
      const submit = (value, version) =>
        (item.writing = (async () => {
          if (!view || item.reviewRow.editor?.disabled)
            return { error: "当前不能修改，请稍候。" };
          const owner = view;
          box
            .querySelectorAll("button,input,select,textarea")
            .forEach((node) => (node.disabled = true));
          try {
            const result = await owner.act("answer", row.id, {
              value,
              version,
            });
            if (result?.ok)
              box.querySelectorAll("input,textarea,select").forEach((node) => {
                node.draftVersion = null;
              });
            if (result?.error)
              item.querySelector(".error").textContent = result.error;
            return result || { error: "填入失败，请重试。" };
          } catch (error) {
            item.querySelector(".error").textContent =
              error.message || "填入失败，请重试。";
            return { error: error.message };
          } finally {
            if (view === owner) editorFor(item, item.reviewRow);
          }
        })());
      const draft = (control) =>
        control.multiple
          ? [...control.selectedOptions].map((option) => option.value)
          : control.value;
      item.flush = async () => {
        await item.writing;
        const control = box.querySelector("input,textarea,select");
        return control && control.draftVersion != null
          ? submit(draft(control), control.draftVersion)
          : { ok: true };
      };
      if (item.editorKey !== key) {
        item.editorKey = key;
        box.replaceChildren();
        if (editor) {
          if (editor.kind === "buttons") {
            for (const option of editor.options) {
              const button =
                /** @type {HTMLButtonElement & {valueKey?:string|boolean}} */ (
                  document.createElement("button")
                );
              button.type = "button";
              button.className = "choice";
              button.textContent =
                { Yes: "是", No: "否" }[option.label] || option.label;
              button.title = option.label;
              button.valueKey = option.value;
              button.onclick = (event) => {
                if (event.isTrusted)
                  void submit(option.value, item.reviewRow.editor.version);
              };
              box.append(button);
            }
          } else {
            const choice = ["select", "multiple"].includes(editor.kind),
              control =
                /** @type {(HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement)&{draftVersion?:number|null}} */ (
                  document.createElement(
                    choice
                      ? "select"
                      : editor.kind === "textarea"
                        ? "textarea"
                        : "input",
                  )
                );
            control.setAttribute("aria-label", row.question);
            control.className = "answer-input";
            if (control instanceof HTMLSelectElement) {
              control.multiple = editor.kind === "multiple";
              if (!control.multiple) {
                const placeholder = document.createElement("option");
                placeholder.value = "";
                placeholder.textContent = "请选择";
                placeholder.disabled = true;
                control.append(placeholder);
              }
              for (const option of editor.options) {
                const node = document.createElement("option");
                node.value = String(option.value);
                node.textContent = option.label;
                control.append(node);
              }
            } else if (control instanceof HTMLInputElement)
              control.type =
                editor.inputType === "search"
                  ? "text"
                  : editor.inputType || "text";
            else if (control instanceof HTMLTextAreaElement) control.rows = 3;
            control.oninput = () => {
              control.draftVersion = item.reviewRow.editor.version;
            };
            box.append(control);
            control.onchange = (event) => {
              if (!event.isTrusted) return;
              if (editor.kind === "select")
                void submit(
                  control.value,
                  control.draftVersion ?? item.reviewRow.editor.version,
                );
              else void item.flush();
            };
            if (control.tagName === "INPUT")
              control.onkeydown = (event) => {
                if (event.isTrusted && event.key === "Enter") {
                  event.preventDefault();
                  void item.flush();
                }
              };
          }
        }
      }
      if (!editor) return;
      for (const button of box.querySelectorAll(".choice"))
        button.setAttribute(
          "aria-pressed",
          String(button.valueKey === editor.value),
        );
      const control = box.querySelector("input,textarea,select");
      if (control && control.draftVersion == null) {
        if (control.multiple)
          for (const option of control.options)
            option.selected =
              Array.isArray(editor.value) &&
              editor.value.includes(option.value);
        // Segmented dates expose partial masks while the user types. Native date
        // inputs accept only complete ISO dates; leave the original page untouched.
        else
          control.value =
            control.type === "date"
              ? JobsControlFields.calendarDate(editor.value)?.iso || ""
              : (editor.value ?? "");
      }
      box
        .querySelectorAll("button,input,select,textarea")
        .forEach((node) => (node.disabled = editor.disabled));
    }
    function render(data, act) {
      if (window !== window.top) return;
      if (!data) {
        removeView();
        last = null;
        return;
      }
      last = { data, act };
      if (view?.id !== data.id) {
        removeView();
        const host = document.createElement("div");
        host.id = "jobs-ai-review";
        host.style.cssText =
          "all:initial;position:fixed;right:16px;top:96px;width:min(360px,calc(100vw - 32px));z-index:2147483647";
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `<style>
      :host{color-scheme:light}*{box-sizing:border-box}section{font:14px/1.45 system-ui,sans-serif;color:#242334;background:#fff;border:1px solid #dfdbfa;border-radius:14px;box-shadow:0 8px 32px #25204430;overflow:hidden}
      header{display:flex;align-items:center;gap:10px;padding:14px;background:linear-gradient(110deg,#685cf2,#8b82fa);color:white}h2{flex:1;margin:0;font-size:15px}button{font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #bcb4ff;outline-offset:-3px}
      #toggle{border:0;background:transparent;color:inherit;padding:4px 6px}#list{max-height:min(300px,40vh);overflow:auto;padding:0 14px}.item{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid #efedf7;background:#fff;padding:10px 0;color:inherit}.item:hover{background:#faf9ff}
      .question{display:block;font-size:12px;color:#686579;overflow-wrap:anywhere}.answer{display:block;margin-top:4px;font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere;color:#5442bd}.source{display:block;margin-top:4px;font-size:11px;color:#8d899c}
      .review-row{border-bottom:1px solid #efedf7;padding-bottom:10px}.review-row .item{border-bottom:0;padding-bottom:6px}.editor{display:flex;flex-wrap:wrap;gap:6px}.choice{border:1px solid #d8d3ee;border-radius:7px;padding:7px 10px;background:#fff;color:#514477;max-width:100%;overflow-wrap:anywhere;text-align:left}.choice[aria-pressed="true"]{background:#eeeaff;border-color:#7567ed;color:#4d3bb5}.answer-input{width:100%;font:inherit;border:1px solid #d8d3ee;border-radius:7px;padding:8px;color:#242334;background:white;resize:vertical}.error{display:block;color:#af3444;font-size:12px;margin-top:4px}.error:empty{display:none}.editor :disabled{opacity:.55;cursor:default}
      footer{padding:10px 14px 14px}p{margin:0 0 10px;font-size:12px;color:#706c80}#confirm{width:100%;padding:9px 12px;border:0;border-radius:8px;background:#685cf2;color:#fff;font-weight:600}#confirm:disabled{opacity:.55;cursor:default}[hidden]{display:none!important}
      </style><section aria-label="AI 补填确认"><header><strong aria-hidden="true">jobs</strong><h2>AI 补填</h2><button id="toggle" type="button" aria-expanded="true">收起</button></header><div id="body"><div id="list"></div><footer><p id="status" role="status"></p><button id="confirm" type="button" disabled>确认这些答案</button></footer></div></section>`;
        view = { id: data.id, host, shadow, hidden: [], items: new Map(), act };
        if (slot)
          for (const node of slot.container.children) {
            view.hidden.push([node, node.style.display]);
            node.style.display = "none";
          }
        (slot?.container || document.body).append(host);
        /** @type {HTMLButtonElement} */ (
          shadow.querySelector("#toggle")
        ).onclick = () => {
          const body = /** @type {HTMLDivElement} */ (
              shadow.querySelector("#body")
            ),
            toggle = /** @type {HTMLButtonElement} */ (
              shadow.querySelector("#toggle")
            );
          body.hidden = !body.hidden;
          toggle.textContent = body.hidden ? "展开" : "收起";
          toggle.setAttribute("aria-expanded", String(!body.hidden));
        };
        /** @type {HTMLButtonElement} */ (
          shadow.querySelector("#confirm")
        ).onclick = (event) => {
          const button = /** @type {HTMLButtonElement} */ (
            shadow.querySelector("#confirm")
          );
          if (!event.isTrusted || button.disabled) return;
          button.disabled = true;
          const owner = view;
          void (async () => {
            for (const item of owner.items.values())
              if (!(await item.flush?.())?.ok) {
                if (view === owner) button.disabled = false;
                return;
              }
            if (view === owner) await owner.act("confirm");
          })();
        };
      }
      view.act = act;
      const { shadow, items } = view;
      shadow.querySelector("h2").textContent = data.title;
      shadow.querySelector("#status").textContent = data.status;
      /** @type {HTMLButtonElement} */ (
        shadow.querySelector("#confirm")
      ).disabled = !data.canConfirm;
      if (data.expand) {
        /** @type {HTMLDivElement} */ (shadow.querySelector("#body")).hidden =
          false;
        /** @type {HTMLButtonElement} */ (
          shadow.querySelector("#toggle")
        ).textContent = "收起";
        /** @type {HTMLButtonElement} */ (
          shadow.querySelector("#toggle")
        ).setAttribute("aria-expanded", "true");
      }
      for (const row of data.items) {
        let item = items.get(row.id);
        if (!item) {
          const wrapper = document.createElement("div");
          wrapper.className = "review-row";
          const button = document.createElement("button");
          button.type = "button";
          button.className = "item";
          button.innerHTML =
            '<span class="question"></span><span class="answer"></span><span class="source"></span>';
          button.onclick = () => void view.act("locate", row.id);
          wrapper.append(button);
          const error = document.createElement("span");
          error.className = "error";
          error.setAttribute("role", "alert");
          wrapper.append(error);
          shadow.querySelector("#list").append(wrapper);
          items.set(row.id, (item = wrapper));
        }
        item.querySelector(".question").textContent = row.question;
        item.querySelector(".answer").textContent = row.answer;
        item.title = row.originalQuestion || row.question;
        item.querySelector(".source").textContent = row.source;
        item.querySelector(".error").textContent = row.error || "";
        editorFor(item, row);
      }
    }
    JobsReviewPresenter = Object.freeze({
      show: render,
      pending: () => !!last,
      expand() {
        if (last) render({ ...last.data, expand: true }, last.act);
      },
      attach(host, container, remove) {
        if (slot?.host === host) return;
        host.dataset.jobsOwner = chrome.runtime.id;
        const previous = slot,
          saved = last;
        removeView();
        slot = { host, container, remove };
        previous?.remove();
        if (saved) render(saved.data, saved.act);
      },
      detach(host) {
        if (slot?.host === host) {
          removeView();
          slot = null;
        }
      },
    });
    chrome.runtime.onMessage?.addListener((message, sender, reply) => {
      if (message?.type !== "jobs:review-view" || window !== window.top) return;
      if (sender.id !== chrome.runtime.id || sender.tab) {
        reply({ error: "Background only" });
        return;
      }
      if (!message.data) {
        if (last?.data.id === message.id) render(null);
        reply({ ok: true });
        return;
      }
      const route = { id: message.id, documentId: message.sourceDocumentId };
      render(message.data, async (action, itemId, payload) => {
        try {
          const result = await chrome.runtime.sendMessage({
            type: "jobs:review-action",
            ...route,
            action,
            itemId,
            payload,
          });
          if (result?.error) throw Error(result.error);
          return result;
        } catch (error) {
          if (last?.data.id === route.id)
            render(
              {
                ...last.data,
                canConfirm: false,
                status: error.message || "申请页面已变化，请检查。",
              },
              last.act,
            );
        }
      });
      reply({ ok: true });
    });
    const block = (event) => {
      if (
        !last ||
        (event.type === "click" &&
          !JobsControlFields?.continuation(event.target))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      JobsReviewPresenter.expand();
    };
    document.addEventListener("click", block, true);
    document.addEventListener("submit", block, true);
  })();
}
