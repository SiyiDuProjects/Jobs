import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Card,
  Chip,
  Input,
  Kbd,
  Spinner,
  TextArea,
} from "@heroui/react";
import { createConsoleController } from "./console-controller.js";
import { calendarDate } from "./calendar-date.js";
import {
  answerable,
  choosePage,
  consoleSummary,
  filterOptions,
  groupLabels,
  keyIndex,
  nextQuestion,
  optionKey,
  orderPages,
  pageGroup,
  pageHost,
  pageTitle,
  pendingItems,
  reviewItems,
} from "./console-model.js";

const groupColors = {
  review: "accent",
  attention: "warning",
  ready: "success",
  busy: "default",
  idle: "default",
  done: "success",
};
const sourceColors = {
  依据档案: "success",
  已保存回答: "success",
  你的回答: "success",
  默认设置: "default",
  "AI 建议": "accent",
  "AI 补答": "accent",
  待你确认: "warning",
  已手动修改: "warning",
  提交前核对的草稿: "warning",
};
const optionLabel = (label) => ({ Yes: "是", No: "否" })[label] || label;
const same = (a, b) => a === b || (a != null && String(a) === String(b));
const itemKey = (row, item) => `${row.tabId}:${row.review?.id}:${item.id}`;
const editable = (target) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

function ChoiceEditor({ item, state, onAnswer, inputRef }) {
  const editor = item.editor;
  const [query, setQuery] = useState("");
  const many = editor.options.length > 12;
  const shown = many ? filterOptions(editor.options, query) : editor.options;
  const chosen = state.pending ? state.choice : editor.value;
  const disabled = editor.disabled || state.pending;
  return (
    <div className="console-editor">
      {many && (
        <Input
          ref={inputRef}
          variant="secondary"
          fullWidth
          aria-label="筛选选项"
          placeholder={`共 ${editor.options.length} 个选项，输入关键词筛选，Enter 选第一项`}
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!disabled && shown[0]) onAnswer(shown[0].value);
            }
          }}
        />
      )}
      <div className="console-options" role="group" aria-label="选项">
        {shown.slice(0, many ? 40 : undefined).map((option, index) => {
          const selected = same(chosen, option.value);
          return (
            <Button
              key={String(option.value)}
              className="console-option"
              size="sm"
              variant={selected ? "primary" : "secondary"}
              isDisabled={disabled}
              aria-label={
                optionLabel(option.label) + (selected ? "（当前）" : "")
              }
              onPress={() => onAnswer(option.value)}
            >
              {!many && optionKey(index) && (
                <Kbd className="console-kbd">{optionKey(index)}</Kbd>
              )}
              <span className="console-option-label">
                {optionLabel(option.label)}
              </span>
            </Button>
          );
        })}
      </div>
      {many && !shown.length && (
        <p className="console-hint">没有匹配的选项，请换个关键词。</p>
      )}
      {many && shown.length > 40 && (
        <p className="console-hint">
          还有 {shown.length - 40} 项，请继续输入筛选。
        </p>
      )}
    </div>
  );
}

function MultipleEditor({ item, state, draft, onDraft, onAnswer }) {
  const editor = item.editor;
  const [query, setQuery] = useState("");
  const picked = (
    draft?.values || (Array.isArray(editor.value) ? editor.value : [])
  ).map(String);
  const shown = filterOptions(editor.options, query);
  const disabled = editor.disabled || state.pending;
  const toggle = (value) => {
    if (disabled) return;
    onDraft({
      values: picked.includes(String(value))
        ? picked.filter((entry) => entry !== String(value))
        : [...picked, String(value)],
      version: editor.version,
    });
  };
  const submit = () => {
    if (!disabled)
      onAnswer(
        editor.options
          .map((option) => option.value)
          .filter((value) => picked.includes(String(value))),
        draft?.version ?? editor.version,
      );
  };
  useEffect(() => {
    const keydown = (event) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        editable(event.target)
      )
        return;
      const index = keyIndex(event.key);
      if (index >= 0 && editor.options.length <= 12 && shown[index]) {
        event.preventDefault();
        toggle(shown[index].value);
      } else if (
        event.key === "Enter" &&
        !(event.target instanceof Element && event.target.closest("button,a"))
      ) {
        event.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  return (
    <div className="console-editor">
      {editor.options.length > 12 && (
        <Input
          aria-label="筛选选项"
          placeholder="输入关键词筛选"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className="console-options" role="group" aria-label="可多选">
        {shown.map((option, index) => {
          const selected = picked.includes(String(option.value));
          return (
            <Button
              key={String(option.value)}
              className="console-option"
              size="sm"
              variant={selected ? "primary" : "secondary"}
              isDisabled={disabled}
              aria-pressed={selected}
              aria-label={
                optionLabel(option.label) + (selected ? "（已选）" : "")
              }
              onPress={() => toggle(option.value)}
            >
              {editor.options.length <= 12 && optionKey(index) && (
                <Kbd className="console-kbd">{optionKey(index)}</Kbd>
              )}
              <span className="console-option-label">
                {optionLabel(option.label)}
              </span>
            </Button>
          );
        })}
      </div>
      <div className="console-row-actions">
        <Button size="sm" isDisabled={disabled} onPress={submit}>
          填入所选 {picked.length ? `（${picked.length}）` : ""}
        </Button>
      </div>
    </div>
  );
}

function TextEditor({ item, state, draft, onDraft, onAnswer, inputRef }) {
  const editor = item.editor;
  const current =
    editor.inputType === "date"
      ? calendarDate(editor.value)?.iso || ""
      : (editor.value ?? "");
  const value = draft ? draft.text : String(current);
  const disabled = editor.disabled || state.pending;
  const submit = () => {
    if (!disabled) onAnswer(value, draft?.version ?? editor.version);
  };
  const common = {
    ref: inputRef,
    variant: "secondary",
    fullWidth: true,
    "aria-label": item.originalQuestion || item.question,
    value,
    disabled,
    onChange: (event) =>
      onDraft({
        text: event.target.value,
        version: editor.version,
      }),
  };
  return (
    <div className="console-editor">
      {editor.kind === "textarea" ? (
        <TextArea
          {...common}
          rows={4}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              !event.repeat &&
              (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
      ) : (
        <Input
          {...common}
          type={
            ["email", "tel", "url", "number", "date", "month"].includes(
              editor.inputType,
            )
              ? editor.inputType
              : "text"
          }
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              !event.repeat
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
      )}
      <div className="console-row-actions">
        <Button
          size="sm"
          isDisabled={disabled || !String(value).trim()}
          onPress={submit}
        >
          填入{" "}
          <Kbd className="console-kbd">
            {editor.kind === "textarea" ? "⌘↵" : "↵"}
          </Kbd>
        </Button>
      </div>
    </div>
  );
}

function OptionsEditor({ item, state, onOptions, inputRef }) {
  const [query, setQuery] = useState("");
  const disabled = item.editor.disabled || state.pending;
  return (
    <div className="console-editor">
      <Input
        ref={inputRef}
        aria-label={`${item.question} 搜索选项`}
        placeholder="可输入关键词搜索网页选项"
        value={query}
        maxLength={500}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.nativeEvent.isComposing &&
            !disabled
          ) {
            event.preventDefault();
            onOptions(query);
          }
        }}
      />
      <Button
        size="sm"
        variant="secondary"
        isDisabled={disabled}
        isPending={state.pending}
        onPress={() => onOptions(query)}
      >
        加载选项
      </Button>
      <p className="console-hint">读取这道题的网页选项后，由你选择答案。</p>
    </div>
  );
}

function Question({
  row,
  item,
  active,
  state,
  draft,
  onSelect,
  onDraft,
  onAnswer,
  onOptions,
  onAccept,
  onLocate,
  inputRef,
}) {
  const error = state.error || item.error;
  const editorProps = { item, state, onAnswer, inputRef };
  // An answer already on the page (AI, Profile or the person's own edit) can
  // be accepted as is; Enter does the same from the keyboard.
  const canAccept =
    item.editor?.valid &&
    item.reviewState === "pending" &&
    !draft &&
    !item.editor.disabled &&
    !state.pending;
  return (
    <li
      className="console-question"
      data-active={active || undefined}
      data-state={item.reviewState}
    >
      <button
        type="button"
        className="console-question-head"
        aria-expanded={active}
        onClick={() => onSelect(item.id)}
      >
        <span className="console-question-text">{item.question}</span>
        {item.originalQuestion && item.originalQuestion !== item.question && (
          <span className="console-question-original">
            {item.originalQuestion}
          </span>
        )}
      </button>
      <div className="console-answer-line">
        <span className="console-answer">{item.answer}</span>
        {state.pending ? (
          <Spinner
            size="sm"
            aria-label={state.loadingOptions ? "正在加载选项" : "正在填入"}
          />
        ) : (
          <Chip
            size="sm"
            variant="soft"
            color={sourceColors[item.source] || "default"}
          >
            {item.source}
          </Chip>
        )}
      </div>
      {item.reason && <p className="console-reason">{item.reason}</p>}
      {active &&
        item.editor &&
        (item.editor.kind === "options" ? (
          <OptionsEditor
            item={item}
            state={state}
            onOptions={onOptions}
            inputRef={inputRef}
          />
        ) : ["buttons", "select"].includes(item.editor.kind) ? (
          <ChoiceEditor key={item.editor.version} {...editorProps} />
        ) : item.editor.kind === "multiple" ? (
          <MultipleEditor {...editorProps} draft={draft} onDraft={onDraft} />
        ) : (
          <TextEditor {...editorProps} draft={draft} onDraft={onDraft} />
        ))}
      {active && !item.editor && (
        <p className="console-hint">
          {item.id.startsWith("summary-")
            ? "这是提交前核对的草稿，确认前请通读；需要修改时到网页中改。"
            : "这一题不能在答题台作答，请到网页中处理。"}
        </p>
      )}
      {error && (
        <p className="console-error" role="alert">
          {error}
        </p>
      )}
      {active && (
        <div className="console-row-actions">
          {canAccept && (
            <Button size="sm" variant="secondary" onPress={onAccept}>
              保留网页当前答案 <Kbd className="console-kbd">↵</Kbd>
            </Button>
          )}
          <Button size="sm" variant="ghost" onPress={() => onLocate(item.id)}>
            在网页中查看这一题
          </Button>
        </div>
      )}
    </li>
  );
}

// Typed drafts live in the console, keyed by tab, review and item, so moving
// between pages never discards an unfilled answer.
function PageCard({
  row,
  controller,
  autoAdvance,
  notify,
  drafts,
  setDrafts,
  onConfirmed,
}) {
  const [active, setActive] = useState(null);
  const [states, setStates] = useState({});
  const [busy, setBusy] = useState("");
  const inputRef = useRef(null);
  const confirmRef = useRef(null);
  const answering = useRef(new Set());
  const confirming = useRef(false);
  const cardRef = useRef(null);
  const items = reviewItems(row);
  const pending = pendingItems(row);
  const settled = items.filter((item) => item.reviewState !== "pending");
  const editablePending = pending.filter(answerable);
  const group = pageGroup(row);
  const data = row.review?.data;
  // Keep the active question while it is pending; otherwise take the next.
  useEffect(() => {
    if (
      !items.some(
        (item) => item.id === active && item.reviewState === "pending",
      )
    )
      setActive(nextQuestion(row, null)?.id ?? null);
  }, [
    row.tabId,
    row.review?.id,
    items.map((item) => item.id + item.reviewState).join(),
  ]);
  useEffect(() => {
    setStates({});
  }, [row.review?.id]);
  useEffect(() => {
    cardRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
    inputRef.current?.focus?.();
  }, [active]);
  const patch = (key, value) =>
    setStates((current) => ({
      ...current,
      [key]: { ...current[key], ...value },
    }));
  async function answer(
    item,
    value,
    { version = item.editor.version, accept = false } = {},
  ) {
    const key = itemKey(row, item);
    if (answering.current.has(key) || item.editor.disabled) return false;
    answering.current.add(key);
    patch(key, { pending: true, error: "", choice: value });
    const result = await controller.act(row, "answer", item.id, {
      value,
      version,
      ...(accept ? { acceptCurrent: true } : {}),
    });
    answering.current.delete(key);
    if (result?.ok) {
      patch(key, { pending: false, error: "" });
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (autoAdvance) {
        const next = nextQuestion(row, item.id);
        setActive(next?.id ?? null);
        if (!next) confirmRef.current?.focus?.();
      }
      return true;
    }
    patch(key, {
      pending: false,
      error: result?.error || "填入失败，请重试。",
    });
    // Keep the version the draft was written against. Only a new edit after
    // reading the updated page may adopt the new version.
    return false;
  }
  async function loadOptions(item, query) {
    const key = itemKey(row, item);
    if (answering.current.has(key) || item.editor.disabled) return;
    answering.current.add(key);
    patch(key, { pending: true, loadingOptions: true, error: "" });
    try {
      const result = await controller.act(row, "options", item.id, {
        query,
        version: item.editor.version,
      });
      patch(key, { error: result?.error || "" });
    } finally {
      answering.current.delete(key);
      patch(key, { pending: false, loadingOptions: false });
    }
  }
  async function confirm() {
    if (confirming.current || answering.current.size) return;
    confirming.current = true;
    setBusy("confirm");
    try {
      // Typed answers that were not yet filled land before confirmation.
      for (const item of items) {
        const draft = drafts[itemKey(row, item)];
        if (
          draft &&
          item.editor &&
          !(await answer(item, draft.values ?? draft.text, {
            version: draft.version,
          }))
        )
          return;
      }
      const result = await controller.act(row, "confirm");
      if (result?.ok) {
        notify(`已确认「${pageTitle(row)}」，网页继续处理。`);
        onConfirmed(row.tabId);
      } else
        notify(
          result?.error ||
            data?.status ||
            "未能确认，请查看提示或跳到网页检查。",
          true,
        );
    } finally {
      confirming.current = false;
      setBusy("");
    }
  }
  async function prepare() {
    setBusy("prepare");
    try {
      const result = await controller.prepare(row);
      if (result?.error) notify(result.error, true);
    } finally {
      setBusy("");
    }
  }
  const locate = (itemId) =>
    void controller.focus(row, itemId).then((result) => {
      if (result?.error || result?.data?.error)
        notify(result.error || result.data.error, true);
    });
  // Keyboard: digits choose, Enter keeps the current answer or confirms the
  // page, J/K move between questions, G opens the question on its page.
  useEffect(() => {
    const keydown = (event) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (editable(event.target)) {
        if (event.key === "Escape") event.target.blur();
        return;
      }
      const item = items.find((entry) => entry.id === active);
      if (busy || (item && answering.current.has(itemKey(row, item)))) return;
      const index = keyIndex(event.key);
      const shortcuts =
        ["buttons", "select"].includes(item?.editor?.kind) &&
        item.editor.options.length <= 12;
      if (index >= 0 && shortcuts && answerable(item)) {
        const option = item.editor.options[index];
        if (!option) return;
        event.preventDefault();
        void answer(item, option.value);
      } else if (event.key === "Enter") {
        // A focused button answers Enter itself.
        if (event.target instanceof Element && event.target.closest("button,a"))
          return;
        if (
          answerable(item) &&
          item.editor.valid &&
          item.editor.kind !== "multiple" &&
          item.reviewState === "pending" &&
          !drafts[itemKey(row, item)]
        ) {
          event.preventDefault();
          void answer(item, item.editor.value, { accept: true });
        } else if (!editablePending.length && data?.canConfirm && !busy) {
          event.preventDefault();
          void confirm();
        }
      } else if (["j", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        setActive(nextQuestion(row, active)?.id ?? active);
      } else if (["k", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const list = pending;
        const at = list.findIndex((entry) => entry.id === active);
        if (list.length)
          setActive(list[(at - 1 + list.length) % list.length].id);
      } else if (event.key === "g") {
        event.preventDefault();
        locate(active);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  const renderQuestion = (item) => {
    const key = itemKey(row, item);
    return (
      <Question
        key={item.id}
        row={row}
        item={item}
        active={item.id === active}
        state={states[key] || {}}
        draft={drafts[key]}
        inputRef={item.id === active ? inputRef : undefined}
        onSelect={(id) => setActive(id === active ? null : id)}
        onDraft={(draft) =>
          setDrafts((current) => ({ ...current, [key]: draft }))
        }
        onAnswer={(value, version) =>
          void answer(item, value, version === undefined ? {} : { version })
        }
        onOptions={(query) => void loadOptions(item, query)}
        onAccept={() => void answer(item, item.editor.value, { accept: true })}
        onLocate={locate}
      />
    );
  };
  return (
    <Card ref={cardRef} className="console-card">
      <Card.Header className="console-card-header">
        <div className="console-card-title">
          <Card.Title>{pageTitle(row)}</Card.Title>
          <Card.Description>
            {pageHost(row.url)}
            {row.profileName ? ` · 档案：${row.profileName}` : ""}
            {row.operator && row.operator !== "person" ? " · AI 操作中" : ""}
          </Card.Description>
        </div>
        <div className="console-card-tools">
          <Chip size="sm" variant="soft" color={groupColors[group]}>
            {groupLabels[group]}
          </Chip>
          <Button size="sm" variant="secondary" onPress={() => locate(active)}>
            跳到网页 <Kbd className="console-kbd">G</Kbd>
          </Button>
        </div>
      </Card.Header>
      <Card.Content className="console-card-body">
        <p className="console-status" role="status">
          {data?.status || row.status?.text || "正在读取页面状态…"}
        </p>
        {group === "review" && !data && (
          <p className="console-hint">
            这一页有待确认的答案，但暂时读不到内容。页面可能正在重新加载，稍后会自动刷新，或跳到网页查看。
          </p>
        )}
        {group !== "review" &&
          row.status?.canFill &&
          !["busy", "done"].includes(group) && (
            <div className="console-row-actions">
              <Button
                size="sm"
                variant="secondary"
                isPending={busy === "prepare"}
                onPress={() => void prepare()}
              >
                准备本页回答
              </Button>
            </div>
          )}
        {pending.length > 0 && (
          <section aria-label="需要你处理">
            <h3 className="console-group-title">
              需要你处理 · {pending.length} 项
            </h3>
            <ol className="console-questions">{pending.map(renderQuestion)}</ol>
          </section>
        )}
        {settled.length > 0 && (
          <details className="console-settled">
            <summary>已确定 · {settled.length} 项</summary>
            <ol className="console-questions">{settled.map(renderQuestion)}</ol>
          </details>
        )}
      </Card.Content>
      {data && (
        <Card.Footer className="console-card-footer">
          <Button
            ref={confirmRef}
            fullWidth
            isDisabled={
              !data.canConfirm ||
              !!busy ||
              Object.values(states).some((state) => state.pending)
            }
            isPending={busy === "confirm"}
            onPress={() => void confirm()}
          >
            确认这些答案
            {editablePending.length
              ? `（还有 ${editablePending.length} 项待答）`
              : ""}
          </Button>
          <p className="console-hint">
            {editablePending.length
              ? "可以先确认已答部分；仍有缺项时网页会停下。"
              : "全部答完。按 Enter 确认，网页随后按你的设置继续。"}
          </p>
        </Card.Footer>
      )}
    </Card>
  );
}

function PageList({ rows, selected, onSelect }) {
  const ordered = orderPages(rows);
  let lastGroup = "";
  return (
    <nav className="console-list" aria-label="投递页面">
      {ordered.map((row) => {
        const group = pageGroup(row);
        const heading = group !== lastGroup ? groupLabels[group] : "";
        lastGroup = group;
        const count = pendingItems(row).length;
        return (
          <React.Fragment key={row.tabId}>
            {heading && <p className="console-list-heading">{heading}</p>}
            <button
              type="button"
              className="console-list-item"
              aria-current={row.tabId === selected ? "true" : undefined}
              onClick={() => onSelect(row.tabId)}
            >
              <span className="console-list-title">{pageTitle(row)}</span>
              <span className="console-list-meta">
                {pageHost(row.url)}
                {group === "review" && count ? ` · ${count} 题` : ""}
              </span>
              {group !== "review" && row.status?.text && (
                <span className="console-list-status">{row.status.text}</span>
              )}
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

function readPreference() {
  try {
    return localStorage.getItem("jobsConsoleAutoAdvance") !== "false";
  } catch {
    return true;
  }
}

export function ConsoleApp() {
  const [state, setState] = useState({ rows: [], loaded: false, error: "" });
  const [selected, setSelected] = useState(null);
  const [pinned, setPinned] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(readPreference);
  const [notice, setNotice] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [drafts, setDrafts] = useState({});
  const controller = useMemo(
    () => createConsoleController(chrome, (next) => setState(next)),
    [],
  );
  useEffect(() => {
    void controller.start();
    return () => controller.dispose();
  }, [controller]);
  const { rows } = state;
  useEffect(() => {
    if (pinned && rows.some((row) => row.tabId === selected)) return;
    setSelected(choosePage(rows, selected));
    if (pinned) setPinned(false);
  }, [rows]);
  useEffect(() => {
    if (!state.loaded) return;
    setDrafts((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([key]) =>
          rows.some(
            (row) =>
              key.startsWith(`${row.tabId}:`) &&
              (row.review
                ? key.startsWith(`${row.tabId}:${row.review.id}:`)
                : row.reviewPending),
          ),
        ),
      );
      return Object.keys(next).length === Object.keys(current).length
        ? current
        : next;
    });
  }, [rows, state.loaded]);
  useEffect(() => {
    const summary = consoleSummary(rows);
    document.title = summary.questions
      ? `(${summary.questions}) 答题台 · jobs`
      : "答题台 · jobs";
  }, [rows]);
  const noticeTimer = useRef(null);
  const notify = (text, error = false) => {
    setNotice({ text, error });
    clearTimeout(noticeTimer.current);
    // Confirmations fade; errors stay until the next notice.
    if (!error) {
      setPinned(false);
      noticeTimer.current = setTimeout(() => setNotice(null), 6000);
    }
  };
  const ordered = orderPages(rows);
  const row = rows.find((entry) => entry.tabId === selected) || null;
  const summary = consoleSummary(rows);
  const candidates = rows.filter(
    (entry) =>
      entry.status?.canFill &&
      pageGroup(entry) === "attention" &&
      /^(complete-required|stopped-)/.test(entry.status.phase || ""),
  );
  async function prepareAll() {
    setPreparing(true);
    try {
      const results = await Promise.all(
        candidates.map((entry) => controller.prepare(entry)),
      );
      const failed = results.filter((result) => result?.error).length;
      notify(
        failed
          ? `已为 ${candidates.length - failed} 页准备回答，${failed} 页未能开始。`
          : `已为 ${candidates.length} 页准备回答。`,
        failed > 0,
      );
    } finally {
      setPreparing(false);
    }
  }
  // [ and ] move between pages that still need the person.
  useEffect(() => {
    const keydown = (event) => {
      if (
        event.isComposing ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        editable(event.target)
      )
        return;
      if (!["[", "]"].includes(event.key) || !ordered.length) return;
      event.preventDefault();
      const at = ordered.findIndex((entry) => entry.tabId === selected);
      const step = event.key === "]" ? 1 : -1;
      const next = ordered[(at + step + ordered.length) % ordered.length];
      setSelected(next.tabId);
      setPinned(true);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  return (
    <main className="console">
      <header className="console-header">
        <div className="console-brand">
          <strong>jobs</strong>
          <span>答题台</span>
        </div>
        <div className="console-summary" aria-live="polite">
          <Chip color="accent" variant="soft">
            待答 {summary.questions} 题 · {summary.pages} 页
          </Chip>
          {summary.attention > 0 && (
            <Chip color="warning" variant="soft">
              需处理 {summary.attention} 页
            </Chip>
          )}
          {summary.done > 0 && (
            <Chip color="success" variant="soft">
              有提交记录 {summary.done} 页
            </Chip>
          )}
        </div>
        <div className="console-header-actions">
          {candidates.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              isPending={preparing}
              onPress={() => void prepareAll()}
            >
              为 {candidates.length} 页准备回答
            </Button>
          )}
          <Button
            size="sm"
            variant={autoAdvance ? "secondary" : "ghost"}
            onPress={() => {
              setAutoAdvance((value) => {
                try {
                  localStorage.setItem(
                    "jobsConsoleAutoAdvance",
                    String(!value),
                  );
                } catch {}
                return !value;
              });
            }}
          >
            {autoAdvance ? "答完自动下一题：开" : "答完自动下一题：关"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => void controller.refresh()}
          >
            刷新
          </Button>
        </div>
      </header>
      {notice && (
        <p
          className="console-notice"
          role={notice.error ? "alert" : "status"}
          data-error={notice.error || undefined}
        >
          {notice.text}
        </p>
      )}
      {state.error && (
        <p className="console-notice" role="alert" data-error="true">
          {state.error}
        </p>
      )}
      {!state.loaded ? (
        <div className="console-empty">
          <Spinner aria-label="正在读取" />
        </div>
      ) : !rows.length ? (
        <div className="console-empty">
          <p>还没有打开的投递页面。</p>
          <p className="console-hint">
            打开岗位申请页后，这里会按页面列出需要你回答的问题；答完一页会自动进入下一页。
          </p>
        </div>
      ) : (
        <div className="console-layout">
          <PageList
            rows={rows}
            selected={selected}
            onSelect={(tabId) => {
              setSelected(tabId);
              setPinned(true);
            }}
          />
          <section className="console-main" aria-label="当前页面">
            {row ? (
              <PageCard
                key={row.tabId}
                row={row}
                controller={controller}
                autoAdvance={autoAdvance}
                notify={notify}
                drafts={drafts}
                setDrafts={setDrafts}
                onConfirmed={(tabId) => {
                  const next = orderPages(rows).find(
                    (entry) =>
                      entry.tabId !== tabId && pageGroup(entry) === "review",
                  );
                  if (next) {
                    setSelected(next.tabId);
                    setPinned(true);
                  }
                }}
              />
            ) : (
              <p className="console-hint">选择左侧的页面。</p>
            )}
            <p className="console-keys">
              <Kbd>1</Kbd>–<Kbd>9</Kbd> 选择 · <Kbd>↵</Kbd>{" "}
              保留当前答案或确认本页 · <Kbd>J</Kbd>/<Kbd>K</Kbd> 上下题 ·{" "}
              <Kbd>[</Kbd>/<Kbd>]</Kbd> 上下页 · <Kbd>G</Kbd> 跳到网页 ·{" "}
              <Kbd>⌥⇧J</Kbd> 从任意页面回到答题台
            </p>
          </section>
        </div>
      )}
    </main>
  );
}

if (typeof document !== "undefined" && document.getElementById("root"))
  createRoot(document.getElementById("root")).render(<ConsoleApp />);
