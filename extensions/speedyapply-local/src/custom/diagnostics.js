import { publicJobUrl } from "./public-job-url.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsBuildInfo } from "./build-info.js";
import { JobsReproCase } from "./repro-case.js";
import { JobsControlConfig } from "./control-config.js";
import { JobsPlatformConfig } from "./platform-config.js";
export var JobsDiagnostics;
let initialized = false;
export function initializeDiagnostics() {
  if (initialized) return;
  initialized = true;
  (() => {
    const doc = document,
      view = window;
    const MAX_FIELDS = 300,
      MAX_EVENTS = 300;
    const secret =
      /password|passcode|one.?time|verification code|social security|\bssn\b|credit card|验证码|密码/i;
    const normalized = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const quiet = (fn) => {
      try {
        return fn();
      } catch {}
    };
    const clean = (value) =>
      normalized(value)
        .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
        .replace(/(?:\+?\d[\s().-]*){7,}/g, "[number]")
        .replace(/[A-Za-z0-9_+/=-]{40,}/g, "[token]")
        .slice(0, 300);
    let session = null,
      stopped = false,
      timer,
      observer,
      truncatedEvents = 0,
      lastSignature = "",
      lastUrl = "";
    let reader,
      fallbackReader,
      history = new WeakMap(),
      questionStates = new Map(),
      events = [],
      disposers = [];
    let owners = new WeakMap(),
      rowByNode = new WeakMap(),
      observed = new Map(),
      priorFields = new Map(),
      probes = new Map(),
      lastFields = [],
      scanRoots = [];
    let lastRows = [],
      lastUnrecognized = [],
      lastCaseSignature = "",
      profileEvent = null;
    // Job paths are public identifiers (Greenhouse job numbers, Ashby/Lever UUIDs).
    // Mask only an email or a long opaque segment, one segment at a time, so the
    // URL stays valid and two postings never share one history.
    function safeUrl() {
      try {
        return publicJobUrl(location.href);
      } catch {
        return "";
      }
    }
    // Values in fill records keep dates, numbers and names; contact data is masked.
    const maskContact = (value) =>
      normalized(value)
        .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
        .replace(
          /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
          "[phone]",
        );
    function visible(node) {
      fallbackReader ||= JobsControlFields.create(doc);
      return !!node && fallbackReader.visible(node);
    }
    function textOnly(node) {
      if (!node) return "";
      const clone = node.cloneNode(true);
      clone
        .querySelectorAll?.(
          "input,textarea,select,[contenteditable],script,style",
        )
        .forEach((item) => item.remove());
      return normalized(clone.textContent);
    }
    function sensitive(node) {
      return (
        node.matches('input[type="password"]') ||
        secret.test(
          (rowByNode.get(node)?.row.public.question || "") +
            " " +
            node.getAttribute("name") +
            " " +
            node.getAttribute("autocomplete"),
        )
      );
    }
    function fieldId(node) {
      return (
        rowByNode.get(node)?.row.public.id ||
        (reader || (fallbackReader ||= JobsControlFields.create(doc))).identify(
          node,
        )
      );
    }
    function canonical(node) {
      if (!node?.matches) return null;
      const known = () => {
        for (
          let current = node;
          current;
          current = current.parentElement || current.getRootNode()?.host
        ) {
          if (owners.has(current)) return owners.get(current);
        }
        return null;
      };
      const found = known();
      if (found || !scanRoots.some((root) => root.contains(node))) return found;
      // A newly mounted field can emit input before the DOM observer fires.
      // Existing fields use their cached ownership; only a new node refreshes it.
      readRows();
      return known();
    }
    function state(node) {
      if (!history.has(node))
        history.set(node, {
          attempts: 0,
          observedEvents: [],
          resolution: "unknown",
        });
      return history.get(node);
    }
    function controlState(node) {
      const row = rowByNode.get(node)?.row;
      const choice =
        row &&
        [
          "checkbox",
          "custom-checkbox",
          "radio",
          "custom-radio",
          "yesno",
          "select-multiple",
        ].includes(row.public.type);
      return {
        connected: node.isConnected,
        hasValue: row?.public.filled === true,
        ...(choice
          ? {
              checked: Array.isArray(row.raw)
                ? row.raw.length
                : row.public.filled
                  ? 1
                  : 0,
            }
          : {}),
        invalid: row?.public.invalid === true,
        disabled:
          node.hasAttribute("disabled") ||
          node.getAttribute("aria-disabled") === "true",
      };
    }
    function observeState(node, cause) {
      if (!session || stopped || !node || sensitive(node)) return;
      const after = controlState(node),
        before = observed.get(node);
      if (!before && observed.size >= MAX_FIELDS) return;
      observed.set(node, after);
      if (before && JSON.stringify(before) !== JSON.stringify(after)) {
        const type = !after.connected
          ? "field_detached"
          : before.hasValue && !after.hasValue
            ? "field_value_lost"
            : "field_state_changed";
        add(type, node, JSON.stringify({ cause, before, after }));
      }
    }
    function probe(node, cause) {
      if (!node || !observed.has(node)) return;
      // Bounded reads also catch property-only resets that emit no DOM mutation.
      // A batch shares one scan, but every late field keeps its full window.
      for (const delay of [0, 250, 1000]) {
        let pending = probes.get(delay);
        if (!pending) {
          pending = {
            nodes: new Map(),
            timer: null,
          };
          probes.set(delay, pending);
        }
        pending.nodes.set(node, cause);
        view.clearTimeout(pending.timer);
        pending.timer = view.setTimeout(() => {
          probes.delete(delay);
          quiet(() => {
            readRows();
            for (const [target, source] of pending.nodes)
              observeState(target, source + "+" + delay);
          });
        }, delay);
      }
    }
    function add(type, node, detail = "") {
      if (!session || stopped) return;
      node = canonical(node);
      if (node && sensitive(node)) return;
      if (node && type === "auto_control_write") {
        state(node).writeDecisionEvent = state(node).decisionEvent;
        state(node).writeDecision = state(node).decision;
      }
      events.push({
        at: Date.now(),
        type,
        ...(node ? { fieldId: fieldId(node) } : {}),
        ...(detail ? { detail: clean(detail) } : {}),
      });
      if (events.length > MAX_EVENTS) {
        events.shift();
        truncatedEvents++;
      }
      schedule();
    }
    // Fill decisions: what each write was asked for, what the page offered and
    // what was chosen and how. Values stay (secrets excluded): they are the
    // evidence for "why was this filled wrong". Only the owner's own server
    // receives reports; the event stream keeps its general redaction.
    function trace(node, entry) {
      if (!session || stopped || !entry) return;
      const target = canonical(node);
      if (!target?.matches || sensitive(target)) return;
      const safe = (value) =>
        typeof value === "string" ? maskContact(value).slice(0, 200) : value;
      const record = { at: Date.now() };
      for (const [key, value] of Object.entries(entry))
        if (value !== undefined && value !== null)
          record[key] = Array.isArray(value)
            ? value.slice(0, 60).map(safe)
            : safe(value);
      const item = state(target);
      item.traces = [...(item.traces || []), record].slice(-6);
      add(
        "fill_trace",
        target,
        JSON.stringify({
          result: record.result,
          source: record.source,
          method: record.method || "",
        }),
      );
    }
    function profile(value) {
      if (!session || stopped) return;
      // Typed metadata preserves UUIDs and revision dates without relaxing the
      // general event redactor or recording the Profile's personal contents.
      const profileId = /^[a-f0-9-]{36}$/i.test(value?.id || "")
        ? value.id
        : "unknown";
      const revision =
        typeof value?.revision === "string" &&
        /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(
          value.revision,
        ) &&
        !Number.isNaN(Date.parse(value.revision))
          ? value.revision
          : "unknown";
      profileEvent = {
        at: Date.now(),
        type: "profile_version",
        detail: JSON.stringify({
          profileId,
          profileName: clean(value?.profileName || ""),
          revision,
          hasAdditional: !!value?.profile?.applicationData,
          hasAiNotes: !!value?.profile?.applicationData?.aiNotes,
        }),
      };
      schedule();
    }
    function scope() {
      const matches = JobsPlatformConfig.roots(doc, session?.ats);
      if (matches.length === 1) return { nodes: matches, kind: "adapter_form" };
      const forms = [...doc.querySelectorAll("form")].filter(visible);
      return forms.length
        ? { nodes: forms, kind: "visible_forms" }
        : {
            nodes: [doc.body || doc.documentElement],
            kind: "document_fallback",
          };
    }
    function readRows() {
      const selected = scope();
      scanRoots = selected.nodes;
      const readers = reader
        ? [reader]
        : selected.nodes.map((root) =>
            JobsControlFields.create(doc, () => root),
          );
      const rows = readers.flatMap((item) =>
        item.scan().map((row) => {
          rowByNode.set(row.node, { row, reader: item });
          owners.set(row.node, row.node);
          for (const child of row.group || []) owners.set(child, row.node);
          return row;
        }),
      );
      const unique = [...new Map(rows.map((row) => [row.node, row])).values()];
      lastRows = unique;
      return { selected, readers, unique };
    }
    function inventory() {
      const { selected, readers, unique } = readRows();
      const nextFields = new Map();
      for (const row of unique.slice(0, MAX_FIELDS)) {
        const identity =
          row.node.id || row.node.getAttribute("data-automation-id");
        if (identity) {
          const key = row.public.type + ":" + identity,
            previous = priorFields.get(key);
          if (previous && previous !== row.node && !previous.isConnected) {
            observeState(previous, "inventory");
            add(
              "field_replaced",
              row.node,
              JSON.stringify({
                previousId: fieldId(previous),
                hasValue: row.public.filled,
              }),
            );
          }
          nextFields.set(key, row.node);
        }
        observeState(row.node, "inventory");
      }
      for (const node of observed.keys())
        if (!node.isConnected) {
          observeState(node, "inventory");
          observed.delete(node);
        }
      priorFields = nextFields;
      const fields = unique.slice(0, MAX_FIELDS).map((row) => {
        const node = row.node,
          item = row.public,
          record = state(node);
        const answer =
          questionStates.get(item.id) ||
          questionStates.get(normalized(item.question).toLowerCase()) ||
          record.resolution;
        const status = item.invalid
          ? "validation_error"
          : item.commitState === "unconfirmed"
            ? "selection_unconfirmed"
            : item.filled
              ? "value_observed"
              : record.attempts
                ? "attempted_still_empty"
                : answer === "missing"
                  ? "answer_missing"
                  : !item.supported
                    ? "unhandled_control"
                    : "not_attempted";
        return {
          id: fieldId(node),
          question: clean(item.question),
          kind: item.type,
          required: item.required,
          component: item.component,
          capabilities: item.capabilities,
          completion: JobsControlFields.completion(item),
          hasValue: item.filled,
          invalid: item.invalid,
          status,
          attempts: record.attempts,
          answer,
          ...(record.decision ? { decision: record.decision } : {}),
          ...(record.writeDecision
            ? { writeDecision: record.writeDecision }
            : {}),
          ...(record.traces ? { traces: record.traces } : {}),
          // What the field holds now (contact data masked). With the adapter/
          // supplement timeline this shows which step wrote which value.
          ...(item.filled && !sensitive(node)
            ? {
                value: maskContact(
                  quiet(
                    () => rowByNode.get(node).reader.response(row)?.response,
                  ) || "",
                ).slice(0, 160),
              }
            : {}),
          observedEvents: [...record.observedEvents],
          locator: {
            tag: node.tagName.toLowerCase(),
            ...(node.id ? { id: clean(node.id) } : {}),
            ...(node.getAttribute("data-automation-id")
              ? { automation: clean(node.getAttribute("data-automation-id")) }
              : {}),
            inputTypes: [
              ...new Set(
                (row.group || [node]).map(
                  (child) =>
                    child.getAttribute("type") ||
                    child.getAttribute("role") ||
                    child.tagName.toLowerCase(),
                ),
              ),
            ],
            labelled: !!item.question && item.question !== "Unlabelled control",
            groupSize: (row.group || [node]).length,
          },
        };
      });
      lastFields = fields;
      lastRows = unique;
      // Questions no reader turned into a field: structure only, never values.
      lastUnrecognized = readers
        .flatMap((item) => quiet(() => item.unrecognized?.(unique)) || [])
        .slice(0, 20);
      const unansweredContainers = lastUnrecognized.map((item) => ({
        question: clean(item.question),
        reason: item.reason,
        structure: item.structure,
      }));
      const alerts = [
        ...doc.querySelectorAll('[role="alert"],[aria-live="assertive"]'),
      ]
        .filter(visible)
        .filter((node) => normalized(node.textContent)).length;
      return {
        fields,
        unansweredContainers,
        alerts,
        coverage: {
          scope: selected.kind,
          complete: false,
          scanLimited: unique.length > MAX_FIELDS,
          excludedSensitive: null,
          iframeCount: selected.nodes.reduce(
            (n, root) => n + root.querySelectorAll("iframe").length,
            0,
          ),
          openShadowRoots: null,
          note: "Reuses the existing partial control reader. No claim that every field, shadow root or frame is covered. Unobserved actions are unknown; visible values do not prove site acceptance.",
        },
      };
    }
    const eventHistory = () =>
      profileEvent
        ? [profileEvent, ...events.slice(-(MAX_EVENTS - 1))]
        : [...events];
    function snapshot() {
      if (!session) throw Error("No matched ATS adapter has started");
      const data = inventory();
      return {
        schemaVersion: 2,
        ...session,
        pageUrl: safeUrl(),
        observedAt: Date.now(),
        visibility: doc.visibilityState,
        step: [...doc.querySelectorAll("[data-automation-id]")]
          .filter(
            (node) =>
              /Page$/.test(node.getAttribute("data-automation-id")) &&
              visible(node),
          )
          .map((node) => node.getAttribute("data-automation-id"))
          .join(",")
          .slice(0, 300),
        ...data,
        counts: {
          controls: data.fields.length,
          empty: data.fields.filter((row) => !row.hasValue).length,
          invalid: data.fields.filter((row) => row.invalid).length,
          unattempted: data.fields.filter(
            (row) => row.status === "not_attempted",
          ).length,
        },
        events: eventHistory(),
        droppedEvents: truncatedEvents,
        valuePolicy: "fill_trace_values_only",
        verdict: "observation_only",
      };
    }
    function publish() {
      view.clearTimeout(timer);
      timer = null;
      if (!session || stopped) return;
      try {
        if (lastUrl !== location.href) {
          lastUrl = location.href;
          events.push({ at: Date.now(), type: "navigation_observed" });
        }
        while (events.length > MAX_EVENTS) {
          events.shift();
          truncatedEvents++;
        }
        const report = snapshot();
        const signature = JSON.stringify([
          report.fields,
          report.unansweredContainers,
          report.alerts,
        ]);
        if (lastSignature && signature !== lastSignature) {
          // Only metadata is compared/stored; field values never enter reports.
          events.push({ at: Date.now(), type: "inventory_changed" });
          while (events.length > MAX_EVENTS) {
            events.shift();
            truncatedEvents++;
          }
          report.events = eventHistory();
          report.droppedEvents = truncatedEvents;
        }
        lastSignature = signature;
        void chrome.runtime
          .sendMessage({ type: "jobs:diagnostics-push", report })
          .catch(() => {});
        if (
          /^(complete-required|complete-manually|site-error|ai-review)$/.test(
            report.phase,
          ) ||
          report.unansweredContainers.length
        )
          void saveCase(report).catch(() => {});
      } catch {
        /* Diagnostics must not break the original form. */
      }
    }
    function schedule() {
      if (session && !stopped && !timer) timer = view.setTimeout(publish, 200);
    }
    function stop() {
      stopped = true;
      observer?.disconnect();
      view.clearTimeout(timer);
      timer = null;
      for (const pending of probes.values()) view.clearTimeout(pending.timer);
      probes.clear();
      for (const dispose of disposers) dispose();
      disposers = [];
    }
    function clear() {
      stop();
      session = null;
      reader = fallbackReader = null;
      history = owners = rowByNode = new WeakMap();
      questionStates = new Map();
      observed = new Map();
      priorFields = new Map();
      events = [];
      lastFields = [];
      lastRows = [];
      lastUnrecognized = [];
      scanRoots = [];
      profileEvent = null;
      lastSignature = lastCaseSignature = lastUrl = "";
    }
    function start(ats, options) {
      stop();
      stopped = false;
      history = new WeakMap();
      questionStates = new Map();
      events = [];
      profileEvent = null;
      truncatedEvents = 0;
      lastSignature = "";
      lastUrl = location.href;
      owners = new WeakMap();
      rowByNode = new WeakMap();
      observed = new Map();
      priorFields = new Map();
      lastFields = [];
      lastRows = [];
      lastUnrecognized = [];
      lastCaseSignature = "";
      scanRoots = [];
      const page = options.pageSession || {
        documentId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        startedAt: Date.now(),
        phase: "adapter_started",
        profileName: "",
      };
      session = {
        sessionId: page.documentId,
        get runId() {
          return page.runId;
        },
        ats: clean(ats),
        get startedAt() {
          return page.startedAt;
        },
        get phase() {
          return page.phase;
        },
        get profileName() {
          return page.profileName;
        },
        build: JobsBuildInfo?.id || "unbuilt",
        version:
          chrome.runtime.getManifest().version_name ||
          chrome.runtime.getManifest().version,
      };
      const on = (target, type, fn) => {
        const safe = (...args) => quiet(() => fn(...args));
        target.addEventListener(type, safe, true);
        disposers.push(() => target.removeEventListener(type, safe, true));
      };
      for (const type of ["input", "change", "focus", "blur", "invalid"])
        on(doc, type, (event) => {
          const node = canonical(event.composedPath?.()[0] || event.target);
          if (!node || sensitive(node)) return;
          const record = state(node);
          if (!record.observedEvents.includes(type))
            record.observedEvents.push(type);
          add("field_event", node, type);
          if (type === "invalid") add("site_rejected_field", node);
          probe(node, type);
        });
      on(doc, "click", (event) => {
        const target = event.composedPath?.()[0] || event.target;
        const button = target.closest?.(
          'button,input[type="submit"],[role="button"]',
        );
        if (button && visible(button))
          add(
            "button_click",
            canonical(button),
            clean(
              textOnly(button) ||
                button.getAttribute("aria-label") ||
                button.type,
            ),
          );
        const control = canonical(target);
        if (control && !sensitive(control)) probe(control, "click");
      });
      on(doc, "submit", () => add("submit_event", null, "attempt_only"));
      on(view, "pagehide", publish);
      on(view, "pageshow", schedule);
      on(doc, "visibilitychange", () =>
        add("visibility_changed", null, doc.visibilityState),
      );
      observer = new view.MutationObserver((records) => {
        // Scope work to form/control changes; unrelated page animation is not a
        // reason to rescan all answers. Child insertion still discovers new fields.
        const roots = scanRoots;
        const intersects = (node) =>
          roots.some(
            (root) =>
              root === node || root.contains(node) || node.contains(root),
          );
        const changed = records.filter(
          (record) =>
            roots.some(
              (root) => root === record.target || root.contains(record.target),
            ) ||
            (record.type === "attributes" && intersects(record.target)) ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                intersects(node) ||
                JobsPlatformConfig.containsRoot(node, session?.ats),
            ),
        );
        if (!changed.length) return;
        // Mutation delivery runs before the browser can paint. Keep it cheap:
        // the scheduled inventory reads changed/new fields once for the burst.
        // Detachment is readable without a scan; write/input reset probes retain
        // their independent windows for property-only losses.
        for (const node of observed.keys())
          if (!node.isConnected) quiet(() => observeState(node, "mutation"));
        schedule();
      });
      observer.observe(doc.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
        attributeFilter: [
          "aria-invalid",
          "aria-checked",
          "aria-disabled",
          "aria-hidden",
          "aria-expanded",
          "disabled",
          "hidden",
          "value",
          "checked",
          "selected",
          "required",
          "style",
          "class",
        ],
      });
      options?.ctx?.onInvalidated?.(stop);
      add("adapter_started", null, ats);
      const build = JobsBuildInfo?.id;
      if (/^[a-f0-9]{16}$/.test(build || ""))
        events.push({
          at: Date.now(),
          type: "build_info",
          detail: JSON.stringify({ build }),
        });
      publish();
    }
    function beginRun() {
      history = new WeakMap();
      questionStates = new Map();
      events = [];
      profileEvent = null;
      truncatedEvents = 0;
      lastSignature = "";
      lastCaseSignature = "";
    }
    function perform(operation, target, run) {
      if (!session || stopped) return run();
      const owner = session;
      let node;
      try {
        node = canonical(target());
      } catch {
        /* Original selector still determines behavior. */
      }
      try {
        if (node && !sensitive(node)) {
          observeState(node, "before_action");
          state(node).attempts++;
          add("action_started", node, operation);
        } else add("action_started", null, operation + ":target_not_observed");
      } catch {
        /* Observation never prevents the original operation. */
      }
      const finish = (failed) => {
        if (session !== owner) return;
        let current = node;
        try {
          current = canonical(target()) || node;
        } catch {}
        try {
          add(failed ? "action_failed" : "action_returned", current, operation);
        } catch {}
        quiet(() => probe(current, "action_returned"));
        // A successful helper return does not establish browser/framework acceptance.
        schedule();
      };
      try {
        const result = run();
        if (result?.then)
          void result.then(
            () => finish(false),
            () => finish(true),
          );
        else finish(false);
        return result;
      } catch (error) {
        finish(true);
        throw error;
      }
    }
    function answers(questions, results, decisions) {
      if (!session || stopped) return;
      const answered = new Set((results || []).map((result) => result.index));
      const rows = readRows().unique;
      const byId = new Map(rows.map((row) => [row.public.id, row.node]));
      (questions || []).forEach((item, index) => {
        const raw = normalized(item.question);
        if (!raw || secret.test(raw)) return;
        const matches = rows.filter(
          (row) =>
            normalized(row.public.question).toLowerCase() === raw.toLowerCase(),
        );
        const node =
          byId.get(item.fieldId) ||
          (matches.length === 1 ? matches[0].node : null);
        const resolution = answered.has(index) ? "found" : "missing";
        if (item.fieldId) questionStates.set(item.fieldId, resolution);
        else if (matches.length <= 1)
          questionStates.set(raw.toLowerCase(), resolution);
        const decision = decisions?.find(
          (decision) => decision.index === index,
        );
        add("answer_resolution", node, clean(raw) + " → " + resolution);
        if (decision) {
          const evidence = {
            status: decision.status,
            source: decision.source,
            field: decision.field,
            reason: decision.reason,
            inputType: item.inputType || item.type || "unknown",
            country: item.country || "unknown",
            ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
          };
          add("answer_decision", node, JSON.stringify(evidence));
          // Keep the current field's origin independently of the rolling activity
          // log. Later clicks/fills must not erase why this field was answered.
          // Its time orders it against later writes of the same field.
          if (node) {
            state(node).decision = { ...evidence, at: Date.now() };
            state(node).decisionEvent = events.at(-1);
          }
        }
      });
    }
    async function saveCase(report, force = false) {
      if (!JobsReproCase) return null;
      const signature = JSON.stringify([
        report.step,
        report.fields.map((f) => [f.id, f.completion, f.attempts]),
        report.unansweredContainers.map((u) => u.question),
        report.events
          .filter((e) => e.type === "answer_decision")
          .map((e) => e.detail),
      ]);
      if (!force && signature === lastCaseSignature) return null;
      // An unrecognized question is saved like a failing field: its region's
      // sanitized structure becomes a fixture for the reader that missed it.
      const extra = lastUnrecognized.map((item, index) => ({
        row: { node: item.node, public: { id: "unrecognized-" + (index + 1) } },
        field: {
          id: "unrecognized-" + (index + 1),
          kind: "unknown",
          component: "unrecognized",
          required: item.reason === "required-title-without-field",
          hasValue: false,
          invalid: false,
          completion: "unrecognized",
        },
      }));
      const value = JobsReproCase.capture({
        report: {
          ...report,
          fields: [...report.fields, ...extra.map((item) => item.field)],
        },
        rows: [...lastRows, ...extra.map((item) => item.row)],
        document: doc,
      });
      if (!value) return null;
      const result = await chrome.runtime.sendMessage({
        type: "jobs:repro-push",
        value,
        runId: report.runId,
      });
      if (result?.error) throw Error(result.error);
      lastCaseSignature = signature;
      return {
        captured: true,
        fields: value.fields.length,
        truncated: value.coverage.truncated,
      };
    }
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (
        !["jobs:diagnostics-inspect", "jobs:repro-capture"].includes(
          message?.type,
        )
      )
        return;
      if (sender.id !== chrome.runtime.id || sender.tab) {
        reply({ error: "Background only" });
        return;
      }
      if (message.type === "jobs:repro-capture") {
        if (message.sessionId !== session?.sessionId) {
          reply({ error: "页面已切换，请重新选择申请页面" });
          return;
        }
        try {
          saveCase(snapshot(), true).then(
            (data) => reply({ data }),
            (error) => reply({ error: error.message }),
          );
        } catch (error) {
          reply({ error: error.message });
        }
        return true;
      }
      try {
        reply({ data: snapshot() });
      } catch (error) {
        reply({ error: error.message });
      }
    });
    function recentEvents() {
      const build = /^[a-f0-9]{16}$/.test(JobsBuildInfo?.id || "")
        ? JobsBuildInfo.id
        : "unbuilt";
      const context = [
        {
          at: session?.startedAt || Date.now(),
          type: "build_info",
          detail: JSON.stringify({
            build,
            remote: JobsControlConfig?.enabled === true,
          }),
        },
        ...(profileEvent ? [profileEvent] : []),
        ...lastFields
          .filter(
            (field) => field.invalid || (field.required && !field.hasValue),
          )
          .slice(0, 5)
          .map((field) => ({
            at: Date.now(),
            type: "field_structure",
            fieldId: field.id,
            detail: clean(
              JSON.stringify({ kind: field.kind, ...field.locator }),
            ),
          })),
      ];
      const important = (event) =>
        /^(answer_decision$|auto_|field_(?:state_changed|value_lost|detached|replaced)$|phase$|adapter_|action_failed$|navigation_observed$|visibility_changed$)/.test(
          event.type,
        );
      const rows = lastRows;
      const provenance = [
        ...new Set(
          rows
            .map(
              (row) =>
                history.get(row.node)?.writeDecisionEvent ||
                history.get(row.node)?.decisionEvent,
            )
            .filter(Boolean),
        ),
      ];
      const budget = 50 - context.length;
      const selected = new Set(
        provenance.slice(
          0,
          Math.max(0, budget - (provenance.length > budget ? 1 : 0)),
        ),
      );
      for (const event of events.filter(important).slice(-30).reverse()) {
        if (selected.size >= budget) break;
        selected.add(event);
      }
      for (const event of events.slice().reverse()) {
        if (selected.size >= budget) break;
        selected.add(event);
      }
      if (provenance.length > budget) {
        const last = [...selected].at(-1);
        selected.delete(last);
        selected.add({
          at: Date.now(),
          type: "answer_trace_truncated",
          detail: String(provenance.length - budget + 1),
        });
      }
      return [...context, ...[...selected].sort((a, b) => a.at - b.at)];
    }
    JobsDiagnostics = Object.freeze({
      start,
      beginRun,
      finishRun: publish,
      phase: (value) => quiet(() => add("phase", null, value)),
      perform,
      profile: (value) => quiet(() => profile(value)),
      answers: (...args) => quiet(() => answers(...args)),
      snapshot,
      stop,
      clear,
      note: (type, node, detail) => quiet(() => add(type, node, detail)),
      trace: (node, entry) => quiet(() => trace(node, entry)),
      useReader: (value) => {
        reader = value;
      },
      recentEvents,
    });
  })();
}
