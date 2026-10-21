import {
  createReviewControl,
  releaseReviewControls,
} from "./review-components.js";
import { stableStringify } from "./stable-value.js";
import { calendarDate } from "./calendar-date.js";
// Shared by the side panel and the in-page AI surface. The editor keeps the existing
// versioned write/confirm contract around the shared HeroUI React controls.
export function createReviewView({
  stylesheetHref = "custom/popup.css",
  showReasons = false,
} = {}) {
  let slot, view, last;
  function removeView() {
    if (!view) return;
    for (const [node, display] of view.hidden) node.style.display = display;
    releaseReviewControls(view.shadow);
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
      key = stableStringify([editor?.kind, editor?.inputType, editor?.options]);
    item.reviewRow = row;
    // One write path and one button: an edit is written to the page when it
    // is committed (a choice, Enter, leaving the field) and at the latest by
    // Confirm, which never discards an answer typed in the card.
    const submit = (value, version, acceptCurrent = false) =>
      (item.writing = (async () => {
        if (!view || item.reviewRow.editor?.disabled)
          return { error: "当前不能修改，请稍候。" };
        const owner = view,
          control = box.querySelector("input,textarea,select"),
          revision = control?.draftRevision;
        // Other rows stay usable; the page writes queued answers in order.
        // A choice shows as selected at once while its write is pending.
        item.pending = (item.pending || 0) + 1;
        item.choice = value;
        for (const button of box.querySelectorAll(
          ".choice:not(.use-page-value)",
        ))
          button.setAttribute(
            "aria-pressed",
            String(button.valueKey === value),
          );
        box
          .querySelectorAll("button,input,select,textarea")
          .forEach((node) => (node.disabled = true));
        try {
          const result = await owner.act("answer", row.id, {
            value,
            version,
            ...(acceptCurrent ? { acceptCurrent: true } : {}),
          });
          if (
            control &&
            control.draftRevision === revision &&
            box.contains(control)
          ) {
            if (result?.ok) control.draftVersion = null;
            control.failedDraft = !result?.ok;
          } else if (control && result?.ok)
            return { error: "卡片中的答案已更改，请重新确认。" };
          if (result?.error)
            item.querySelector(".error").textContent = result.error;
          return result || { error: "填入失败，请重试。" };
        } catch (error) {
          item.querySelector(".error").textContent =
            error.message || "填入失败，请重试。";
          return { error: error.message };
        } finally {
          item.pending--;
          if (view === owner && last) render(last.data, last.act);
        }
      })());
    const draft = (control) =>
      control.multiple
        ? [...control.selectedOptions].map((option) => option.value)
        : control.value;
    item.flush = async () => {
      await item.writing;
      const control = box.querySelector("input,textarea,select"),
        current = item.reviewRow.editor,
        value =
          control?.type === "date"
            ? calendarDate(current?.value)?.iso
            : current?.value;
      if (
        control?.draftVersion != null &&
        control.failedDraft &&
        Number.isInteger(control.draftSchemaVersion) &&
        control.draftSchemaVersion === current?.schemaVersion &&
        current.valid === true &&
        stableStringify(draft(control)) === stableStringify(value)
      )
        return submit(value, current.version, true);
      return control && control.draftVersion != null
        ? submit(draft(control), control.draftVersion)
        : { ok: true };
    };
    if (item.editorKey !== key) {
      item.editorKey = key;
      releaseReviewControls(box);
      box.replaceChildren();
      if (editor) {
        if (editor.kind === "buttons") {
          for (const option of editor.options) {
            const button =
              /** @type {HTMLButtonElement & {valueKey?:string|boolean}} */ (
                createReviewControl(box, "button")
              );
            button.type = "button";
            button.classList.add("choice");
            button.textContent =
              { Yes: "是", No: "否" }[option.label] || option.label;
            button.title = option.label;
            button.valueKey = option.value;
            button.onclick = (event) => {
              if (event.isTrusted)
                void submit(option.value, item.reviewRow.editor.version);
            };
          }
        } else {
          const choice = ["select", "multiple"].includes(editor.kind),
            control =
              /** @type {(HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement)&{draftVersion?:number|null,draftRevision?:number,draftSchemaVersion?:number,failedDraft?:boolean}} */ (
                createReviewControl(
                  box,
                  choice
                    ? "select"
                    : editor.kind === "textarea"
                      ? "textarea"
                      : "input",
                )
              );
          control.setAttribute("aria-label", row.question);
          control.classList.add("answer-input");
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
            control.draftSchemaVersion = item.reviewRow.editor.schemaVersion;
            control.draftRevision = (control.draftRevision || 0) + 1;
            control.failedDraft = false;
          };

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
              if (
                event.isTrusted &&
                !event.isComposing &&
                event.key === "Enter"
              ) {
                event.preventDefault();
                void item.flush();
              }
            };
        }
      }
    }
    if (!editor) return;
    const chosen = item.pending ? item.choice : editor.value;
    for (const button of box.querySelectorAll(".choice"))
      button.setAttribute("aria-pressed", String(button.valueKey === chosen));
    const control = box.querySelector("input,textarea,select");
    const previousChoice = box
      .querySelector(".use-page-value")
      ?.closest("[data-review-control]");
    if (previousChoice) {
      releaseReviewControls(previousChoice.parentElement, previousChoice);
      previousChoice.remove();
    }
    if (
      control?.draftVersion != null &&
      control.draftVersion !== editor.version &&
      editor.valid === true
    ) {
      const button = createReviewControl(box, "button");
      button.type = "button";
      button.classList.add("choice", "use-page-value");
      button.textContent = "使用网页当前值";
      button.onclick = (event) => {
        if (event.isTrusted)
          void submit(
            item.reviewRow.editor.value,
            item.reviewRow.editor.version,
            true,
          );
      };
    }
    if (control && control.draftVersion == null) {
      if (control.multiple)
        for (const option of control.options)
          option.selected =
            Array.isArray(editor.value) && editor.value.includes(option.value);
      // Segmented dates expose partial masks while the user types. Native date
      // inputs accept only complete ISO dates; leave the original page untouched.
      else
        control.value =
          control.type === "date"
            ? calendarDate(editor.value)?.iso || ""
            : (editor.value ?? "");
    }
    box
      .querySelectorAll("button,input,select,textarea")
      .forEach((node) => (node.disabled = editor.disabled));
  }
  function render(data, act) {
    if (!slot) return;
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
      host.style.cssText = "display:block;width:100%;min-width:0";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<link rel="stylesheet"><section class="card card--default review-card" aria-label="AI 补填确认"><header class="review-heading"><h2>AI 补填</h2><button id="toggle" class="button button--secondary button--sm" type="button" aria-expanded="true" aria-controls="body">收起</button></header><div id="body"><div id="list"><section class="review-group" data-group="pending" aria-labelledby="pending-heading"><h3 id="pending-heading"></h3><div class="group-items"></div></section><details class="review-group" data-group="ready"><summary></summary><div class="group-items"></div></details></div><footer><p id="status" role="status"></p><button id="confirm" class="button button--primary button--full-width" type="button" disabled>确认这些答案</button></footer></div></section>`;
      for (const id of ["toggle", "confirm"]) {
        const old = shadow.querySelector("#" + id);
        const control = createReviewControl(old.parentElement, "button", {
          id,
          variant: id === "confirm" ? "primary" : "secondary",
          fullWidth: id === "confirm",
          children: old.textContent,
        });
        for (const attribute of old.attributes)
          if (attribute.name.startsWith("aria-"))
            control.setAttribute(attribute.name, attribute.value);
        old.replaceWith(control.closest("[data-review-control]"));
      }
      shadow.querySelector("link").href = stylesheetHref;
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
    for (const [id, item] of items) {
      if (!data.items.some((row) => row.id === id)) {
        releaseReviewControls(item);
        item.remove();
        items.delete(id);
      }
    }
    for (const row of data.items) {
      let item = items.get(row.id);
      if (!item) {
        const wrapper = document.createElement("div");
        wrapper.className = "review-row";
        const button = createReviewControl(wrapper, "button");
        button.type = "button";
        button.classList.add("item");
        button.innerHTML =
          '<span class="question"></span><span class="answer"></span><span class="source"></span>' +
          (showReasons ? '<span class="evidence"></span>' : "");
        button.onclick = () => void view.act("locate", row.id);

        const error = document.createElement("span");
        error.className = "error";
        error.setAttribute("role", "alert");
        wrapper.append(error);
        items.set(row.id, (item = wrapper));
      }
      item.querySelector(".question").textContent = row.question;
      item.querySelector(".answer").textContent = row.answer;
      item.title = row.originalQuestion || row.question;
      item.querySelector(".source").textContent = row.source;
      const evidence = item.querySelector(".evidence");
      if (evidence) {
        evidence.textContent =
          row.reason ||
          (row.evidence || [])
            .map(
              (item) =>
                item.profilePath ||
                item.noteQuote ||
                (item.savedResponse ? "本人已存回答（原题与范围匹配）" : ""),
            )
            .join(" · ");
        evidence.hidden = !evidence.textContent;
      }
      item.querySelector(".error").textContent = row.error || "";
      editorFor(item, row);
    }
    for (const row of data.items) {
      const item = items.get(row.id),
        control = item.querySelector("input,textarea,select"),
        editing =
          item.contains(shadow.activeElement) || control?.draftVersion != null,
        // Older page scripts do not send reviewState: keep their rows visible.
        state = ["pending", "ready"].includes(row.reviewState)
          ? row.reviewState
          : "pending",
        group = shadow.querySelector(`[data-group="${state}"] .group-items`);
      if (item.parentElement !== group && !(editing && item.isConnected))
        group.append(item);
      // A failed edit must be visible even inside the completed section.
      if ((row.error || control?.failedDraft) && item.closest("details"))
        item.closest("details").open = true;
    }
    for (const [state, label] of Object.entries({
      pending: "需要你处理",
      ready: "已确定",
    })) {
      const group = shadow.querySelector(`[data-group="${state}"]`),
        count = group.querySelector(".group-items").children.length;
      group.hidden = count === 0;
      group.querySelector("h3,summary").textContent = `${label} · ${count} 项`;
    }
  }
  return Object.freeze({
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
}
