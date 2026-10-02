import { JobsPageActions } from "./page-actions.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsAIReview } from "./ai-review.js";
import { JobsPlatformConfig } from "./platform-config.js";
import { JobsPageSession } from "./control-content.js";
import { JobsAnswerResolver } from "./answer-resolver.js";
import { JobsJobMatch } from "./job-match.js";
import { JobsOperationContext } from "./operation-context.js";
import { JobsFormPipeline } from "./form-pipeline.js";
import { JobsProfileAnswers } from "./profile-answers.js";
import { JobsAnswerMemory } from "./answer-memory.js";
import { JobsQueuePage } from "./queue-page.js";
export var JobsAutomatic;
let initialized = false;
export function initializeAutomaticFill() {
  if (initialized) return;
  initialized = true;
  (() => {
    const runs = new WeakMap(),
      ids = new WeakMap(),
      owners = new WeakMap(),
      pendingRuns = new Set();
    let serial = 0,
      latest = null;
    const note = (type, node, detail) =>
      JobsDiagnostics?.note(type, node, detail);
    const shape = (row) =>
      JSON.stringify([
        row.public.question,
        row.public.type,
        row.public.options,
        row.public.conditional,
      ]);
    const isChoice = (row) =>
      JobsControlFields.choiceTypes.includes(row.public.type);
    const stoppedPhases = new Set([
      "complete-required",
      "complete-manually",
      "page-complete",
      "autofill-complete",
    ]);
    const transitionPhases = new Set(["submitting", "awaiting-transition"]);
    const transitions = Object.freeze({
      created: ["verifying"],
      verifying: ["filling", "checking", "review"],
      filling: ["scanning", "review"],
      scanning: ["resolving", "writing", "checking", "review"],
      resolving: ["writing", "scanning", "checking", "review"],
      writing: ["resolving", "scanning", "checking", "review"],
      review: ["verifying", "checking"],
      checking: ["scanning", "review", "complete", "navigation-attempted"],
      complete: [],
      blocked: [],
      cancelled: [],
      "navigation-attempted": [],
    });
    function createFlow(onTransition = (_from, _to) => {}) {
      let state = "created",
        navigation = null;
      const history = [];
      const terminal = () =>
        ["complete", "blocked", "cancelled", "navigation-attempted"].includes(
          state,
        );
      function move(next) {
        if (next === state) return;
        if (!transitions[state]?.includes(next))
          throw Error(`Invalid fill transition: ${state} -> ${next}`);
        const before = state;
        state = next;
        history.push({ from: before, to: next });
        if (history.length > 80) history.shift();
        onTransition(before, next);
      }
      function stop(next) {
        if (terminal()) return false;
        const before = state;
        state = next;
        history.push({ from: before, to: next });
        onTransition(before, next);
        return true;
      }
      return Object.freeze({
        move,
        get state() {
          return state;
        },
        navigate(action) {
          if (
            state !== "checking" ||
            navigation ||
            !["next", "submit"].includes(action)
          )
            throw Error("Navigation cannot be replayed");
          // Journal the attempt before invoking a click. A thrown click or lost
          // acknowledgement is uncertain; it must never reset this latch.
          navigation = action;
          move("navigation-attempted");
        },
        block: () => stop("blocked"),
        cancel: () => stop("cancelled"),
        snapshot: () => ({
          state,
          navigation,
          history: history.map((entry) => ({ ...entry })),
        }),
      });
    }
    const needsReview = () => JobsAIReview.pending();
    const supplement = (row) => JobsControlFields.needsAnswer(row.public);
    const fieldKey = (root) =>
      JobsControlFields.create(document, () => root)
        .scan()
        .map((row) => {
          if (!ids.has(row.node)) ids.set(row.node, ++serial);
          return ids.get(row.node);
        })
        .join(",");
    function failurePhase(root) {
      const state = JobsControlFields.create(document, () => root).state();
      return state.phase === "site-error"
        ? "site-error"
        : state.phase === "complete-required"
          ? "complete-required"
          : "complete-manually";
    }
    function observe(options) {
      let active = true,
        failed = false,
        stopWatching = () => {},
        ownedRun = null,
        lastRun = null;
      const page = options.pageSession || { phase: null };
      const failureReader = JobsControlFields.create(document);
      function checkFailure() {
        if (!active || failed) return failed;
        const failure = failureReader.pageFailure();
        if (!failure) return false;
        failed = true;
        stopWatching();
        if (lastRun) JobsAIReview.release?.(lastRun.root);
        page.phase = "site-error";
        note("auto_site_error", null, failure.code);
        options.setMessage(page.phase);
        return true;
      }
      // A fatal page may replace the entire form while its adapter is waiting.
      const failureObserver = new MutationObserver(checkFailure);
      if (JobsPlatformConfig.detect(document).vpsFailure)
        failureObserver.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      const owner = {
        current: () => active && !checkFailure(),
        owns: (record) => lastRun === record,
        previous(root, key) {
          return lastRun?.key === key &&
            (lastRun.root.contains(root) || root.contains(lastRun.root))
            ? lastRun
            : null;
        },
        begin(record) {
          ownedRun = lastRun = record;
          stopWatching();
        },
        end(record) {
          if (ownedRun === record) {
            ownedRun = null;
            // A step can disappear while AI is pending (including Back at the
            // same URL). Clear only this owner's abandoned busy status. Never
            // overwrite a newer run, a manual navigation, or an invalidated page.
            if (
              active &&
              lastRun === record &&
              !record.current() &&
              !record.manual &&
              ["in-progress", "ai-thinking", "ai-filling", "checking"].includes(
                page.phase,
              )
            ) {
              record.phase = "cancelled";
              publish(null);
              return;
            }
            if (
              record.current() &&
              (stoppedPhases.has(page.phase) ||
                transitionPhases.has(page.phase))
            )
              watch();
          }
        },
      };
      const manualContinue = (event) => {
        const button = JobsControlFields.continuation(
          event.composedPath?.()[0] || event.target,
        );
        if (!event.isTrusted || !button || needsReview()) return;
        if (lastRun) lastRun.manual = true;
        ownedRun = null;
        publish(
          /submit/i.test(button.textContent)
            ? "submitting"
            : "awaiting-transition",
        );
      };
      document.addEventListener("click", manualContinue, true);
      const stop = () => {
        active = false;
        stopWatching();
        failureObserver.disconnect();
        document.removeEventListener("click", manualContinue, true);
        if (lastRun) JobsAIReview.release?.(lastRun.root);
      };
      options.ctx?.onInvalidated?.(stop);
      window.addEventListener("pagehide", stop, { once: true });
      function publish(message) {
        if (!active || checkFailure()) return;
        stopWatching();
        if (page.phase !== message) {
          page.phase = message;
          options.setMessage(message);
        }
        if (
          !ownedRun &&
          (stoppedPhases.has(message) || transitionPhases.has(message))
        )
          watch();
      }
      function watch() {
        stopWatching();
        const root = lastRun?.root.isConnected
          ? lastRun.root
          : JobsPageSession?.root();
        if (!root) return;
        const url = location.href,
          reader = JobsControlFields.create(document, () => root);
        let errorTimer, refreshTimer;
        const refresh = () => {
          if (checkFailure()) return;
          if (!active || !reader.visible(root) || location.href !== url) {
            stopWatching();
            return;
          }
          if (ownedRun || needsReview()) return;
          const state = reader.state({ review: lastRun?.review });
          if (state.busy) {
            clearTimeout(errorTimer);
            errorTimer = null;
            return;
          }
          if (transitionPhases.has(page.phase)) {
            if (state.phase !== "complete-required") {
              clearTimeout(errorTimer);
              errorTimer = null;
              return;
            }
            // Submit temporarily changes validation while the ATS saves. Only
            // an error that survives a quiet interval is an actionable failure.
            if (!errorTimer)
              errorTimer = setTimeout(() => {
                errorTimer = null;
                const currentState = reader.state();
                if (
                  active &&
                  !ownedRun &&
                  reader.visible(root) &&
                  location.href === url &&
                  !currentState.busy &&
                  currentState.phase === "complete-required"
                ) {
                  publish("complete-required");
                }
              }, 350);
            return;
          }
          // A missing review control is not proof that its answer is complete.
          // Reuse the confirmation check until this run's fields are readable.
          if (
            state.phase === "page-complete" &&
            lastRun?.hasIncompleteReview?.()
          ) {
            if (page.phase !== "complete-required") {
              page.phase = "complete-required";
              options.setMessage(page.phase);
            }
            return;
          }
          const next =
            state.phase === "page-complete"
              ? state.rows.length || lastRun?.review
                ? page.phase === "autofill-complete"
                  ? page.phase
                  : "page-complete"
                : "complete-manually"
              : state.phase;
          if (next !== page.phase) {
            page.phase = next;
            options.setMessage(next);
          }
        };
        // This observer only updates the displayed passive state. Merge DOM and
        // input bursts into a task so full-form reads do not run in every
        // mutation microtask or key event. Active fill/readiness stays immediate.
        const scheduleRefresh = () => {
          if (refreshTimer != null) return;
          refreshTimer = setTimeout(() => {
            refreshTimer = null;
            refresh();
          }, 100);
        };
        const observer = new MutationObserver(scheduleRefresh);
        observer.observe(root, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        root.addEventListener("input", scheduleRefresh, true);
        root.addEventListener("change", scheduleRefresh, true);
        stopWatching = () => {
          clearTimeout(errorTimer);
          clearTimeout(refreshTimer);
          observer.disconnect();
          root.removeEventListener("input", scheduleRefresh, true);
          root.removeEventListener("change", scheduleRefresh, true);
          stopWatching = () => {};
        };
        refresh();
      }
      const wrapped = {
        ...options,
        async getProfile(...args) {
          if (checkFailure()) throw Error("Workday 页面出错，停止自动填写");
          if (active && !ownedRun && !needsReview()) publish("in-progress");
          const profile = await options.getProfile(...args);
          if (checkFailure()) throw Error("Workday 页面出错，停止自动填写");
          return profile;
        },
        setMessage(message) {
          if (!active || checkFailure()) return;
          // Adapters report facts; only the active pipeline owns its page.phase.
          // In particular a delayed field-error callback cannot interrupt AI.
          if (ownedRun) {
            // Some adapters close the status surface synchronously from the
            // successful navigation callback. Preserve that terminal signal.
            if (message === null && transitionPhases.has(page.phase))
              publish(null);
            return;
          }
          if (needsReview()) {
            publish("ai-review");
            return;
          }
          if (transitionPhases.has(page.phase) && stoppedPhases.has(message))
            return;
          // Every adapter starts its steps' runs itself; a status report only
          // updates the status.
          publish(message);
        },
      };
      owner.publish = publish;
      owners.set(wrapped.setMessage, owner);
      return wrapped;
    }
    function advance(options) {
      if (JobsPlatformConfig.appliedStatus(document)) {
        note("auto_blocked", null, "already_applied");
        options.setMessage?.("already-applied");
        return Promise.resolve(false);
      }
      const root = options.root || JobsPageSession?.root();
      const owner = owners.get(options.setMessage);
      if (!options.resolveAnswers)
        options = { ...options, resolveAnswers: JobsAnswerResolver?.resolve };
      if (owner && !owner.current()) return Promise.resolve(false);
      if (!root) {
        options.setMessage?.("complete-manually");
        note("auto_blocked", null, "Missing or ambiguous application form");
        return Promise.resolve(false);
      }
      // The adapter may name a Workday step while observation names its parent.
      // They are one operation, not two independently billable supplement runs.
      const adoptNavigation = (record) => {
        if (
          record.action === "fill" &&
          ["next", "submit"].includes(options.action)
        ) {
          record.navigation = {
            action: options.action,
            selector: options.selector,
            target: options.target,
            review: options.review === true,
          };
          record.action = options.action;
          note("auto_navigation_attached", null, options.action);
        }
        return record.task;
      };
      for (const record of pendingRuns)
        if (
          record.current() &&
          (record.root.contains(root) || root.contains(record.root))
        ) {
          // A run without the step's fill (a queue resume, a page-control command)
          // must not swallow the adapter's run that brings it: cancel that run and
          // start the step's complete run once it has ended.
          if (options.fill && !record.fill) {
            record.superseded = true;
            record.flow.cancel();
            JobsAIReview.release?.(record.root);
            note("auto_run_superseded", null, record.action);
            return record.task.then(() => advance(options));
          }
          return adoptNavigation(record);
        }
      // Each form/step owns one attempt. No repeated AI bill or repeated submit.
      const key = fieldKey(root);
      const old = runs.get(root) || owner?.previous(root, key);
      if (old?.current() && old.key === key && needsReview())
        return adoptNavigation(old);
      const retry =
        options.retry === true &&
        old &&
        !needsReview() &&
        ((!old.flow.snapshot().navigation &&
          ["cancelled", "blocked", "complete"].includes(old.flow.state)) ||
          (options.retryAfterValidation === true &&
            old.action === "next" &&
            options.action === "next" &&
            !old.submitted));
      if (
        old &&
        !old.superseded &&
        ((!retry &&
          old.owner === owner &&
          old.key === key &&
          (old.action === (options.action || "submit") ||
            options.action === "fill")) ||
          (old.submitted &&
            (old.url === location.href ||
              JobsJobMatch?.same(old.url, location.href))))
      ) {
        if (old.phase && stoppedPhases.has(old.phase))
          owner?.publish(old.phase);
        return old.task;
      }
      const url = location.href,
        canProceed = options.canProceed || (() => true);
      const visibility = JobsControlFields.create(document, () => root);
      const flow = createFlow((from, to) =>
        note("auto_state_transition", null, JSON.stringify({ from, to })),
      );
      const record = {
        root,
        key,
        url,
        owner,
        flow,
        fill: !!options.fill,
        review: options.review === true,
        action: options.action || "submit",
        submitted: false,
        hasIncompleteReview: /** @type {(() => boolean) | null} */ (null),
        current: () =>
          !record.manual &&
          flow.state !== "cancelled" &&
          visibility.visible(root) &&
          location.href === url &&
          (!owner || (owner.current() && owner.owns(record))) &&
          canProceed(),
      };
      const setMessage = (message) => {
        if (record.current()) {
          record.phase = message;
          (owner ? owner.publish : options.setMessage)?.(message);
        }
      };
      owner?.begin(record);
      pendingRuns.add(record);
      note(
        "auto_step_started",
        null,
        JSON.stringify({
          step: root.getAttribute("data-automation-id") || root.tagName,
          action: record.action,
        }),
      );
      const task = Promise.resolve()
        .then(() =>
          run({
            ...options,
            root,
            flow,
            canProceed: record.current,
            setMessage,
            navigation: () => record.navigation,
            onReviewCheck: (check) => {
              record.hasIncompleteReview = check;
            },
            onNavigate: () => {
              record.key = fieldKey(root);
              record.submitted = record.action === "submit";
            },
          }),
        )
        .catch((error) => {
          if (!record.current()) flow.cancel();
          else if (!needsReview()) flow.block();
          note("auto_blocked", null, error.message || String(error));
          setMessage(
            /Profile|资料/.test(error.message || "")
              ? "profile-unavailable"
              : needsReview()
                ? "ai-review"
                : failurePhase(root),
          );
          return false;
        })
        .finally(() => {
          note("auto_step_finished", null, record.phase || "cancelled");
          pendingRuns.delete(record);
          owner?.end(record);
        });
      record.task = task;
      runs.set(root, record);
      latest = record;
      return task;
    }
    async function run({
      root,
      profile,
      flow,
      selector,
      target,
      action = "submit",
      canProceed = () => true,
      setMessage = (_message) => {},
      review = false,
      resolveAnswers,
      autoConfirm = true,
      onNavigate = () => {},
      fill,
      navigation,
      onReviewCheck = (_check) => {},
    }) {
      const reader = JobsControlFields.create(document, () => root, {
        write: true,
      });
      const operation = JobsOperationContext.create({
        root,
        profile,
        canProceed,
      });
      const { current, assertCurrent, stamp } = operation;
      const started = Date.now(),
        scans = JobsControlFields.scans?.() || 0,
        structuralScans = JobsControlFields.structuralScans?.() || 0;
      // The adapter already fetched the Profile; reuse this step's bound snapshot.
      const binding = () => operation.verify({ fresh: false });
      // Every field's progress lives in this one ledger (JobsFormPipeline.ledger).
      const book = JobsFormPipeline.ledger(root);
      const literal = (answer) =>
        JobsProfileAnswers.literalSpec("known-answer", answer);
      // What a field's one decision offers its option reader later (before AI):
      // the spec (search terms, the rule that picks), the answer, several answers.
      const hint = (result) => {
        const value = result.profileAnswer,
          optionSpec = result.optionSpec || value?.optionSpec,
          answer = result.answer ?? value?.answer,
          answers = value?.answers;
        return {
          ...(optionSpec ? { optionSpec } : {}),
          ...(typeof answer === "string" && answer
            ? { answer: optionSpec?.query ?? answer }
            : {}),
          ...(Array.isArray(answers) ? { answers } : {}),
        };
      };
      const isCheckbox = (row) =>
        ["checkbox", "custom-checkbox"].includes(row.public.type);
      // A fill step can report what it could not complete (an upload never
      // confirmed). Rules, AI and review still run; the step never navigates.
      let hold = null;
      // The review card shows AI answers to confirm and fields left to the person.
      function toCard(row, options = {}) {
        book.entry(row).card = {
          shape: shape(row),
          allowEmpty: !!(options.needsInput || options.omitted),
        };
        JobsAIReview.add(root, reader, row, { ...options, defer: autoConfirm });
      }
      const leave = (row, reason, options = {}) => {
        note("auto_needs_input", row.node, reason);
        toCard(row, { needsInput: true, source: "unknown", ...options });
      };
      function omit(row, answer) {
        note("auto_field_omitted", row.node, answer.reason);
        book.entry(row).state = "omitted";
        toCard(row, {
          omitted: true,
          source: answer.source,
          questionZh: answer.questionZh,
          needsConfirmation: answer.needsConfirmation,
        });
        JobsAnswerMemory?.remember(row.public.question, row.node, {
          requireReview: true,
          learn: false,
        });
      }
      // The row is still the one the answer was resolved for; otherwise the
      // answer is obsolete and this field is looked at again.
      async function unchanged(row, expected) {
        await binding();
        assertCurrent();
        const live = reader.scan().find((item) => item.node === row.node);
        if (live && shape(live) === expected && !live.public.filled)
          return live;
        note(
          "auto_answer_obsolete",
          row.node,
          live?.public.filled ? "already_filled" : "control_changed",
        );
        return null;
      }
      // A rule answer in the form its control is written with.
      function ruleAnswer(row, result) {
        if (isChoice(row))
          return { specs: [result.optionSpec || literal(result.answer)] };
        if (isCheckbox(row))
          return /^(yes|no)$/i.test(result.answer)
            ? { value: /^yes$/i.test(result.answer) }
            : null;
        if (row.dateParts) {
          const date = JobsControlFields.calendarDate(result.answer);
          return date ? { value: date.iso } : null;
        }
        return { value: result.answer };
      }
      const ready = () => current() && reader.state({ review }).ready;
      const beforeReady = async () => {
        await binding();
        if (action !== "fill")
          await JobsQueuePage?.beforeNavigate(
            action,
            root,
            target || document.querySelector(selector),
          );
      };
      async function finish(prepared, canProceed = () => true) {
        if (JobsPlatformConfig.appliedStatus(document)) {
          flow.block();
          setMessage("already-applied");
          return false;
        }
        flow.move("checking");
        const next = navigation?.();
        if (next && action !== next.action) {
          action = next.action;
          selector = next.selector;
          target = next.target;
          review = next.review;
          prepared = null;
        }
        // Every step uses the same readiness barrier, including Review and a
        // fill-only step. Wait for stable committed values, never retry a click.
        if (review)
          note(
            "auto_review_waiting",
            null,
            "Waiting for stable review and submit button",
          );
        const settled =
          prepared ||
          (await reader.settle({
            review,
            selector: action === "fill" ? undefined : selector,
            target: action === "fill" ? undefined : target,
            canProceed: () => current() && canProceed(),
            beforeReady,
          }));
        if (!settled) throw Error("页面尚未就绪，请检查校验提示和继续按钮");
        // settle includes navigation authorization and revalidates its snapshot.
        // Keep the accepted barrier and click in one synchronous continuation.
        if (!ready()) throw Error("仍有必填、校验错误或不支持的控件");
        if (hold) {
          flow.block();
          note("auto_navigation_held", null, hold);
          setMessage("complete-manually");
          return false;
        }
        if (action === "fill") {
          flow.move("complete");
          setMessage("page-complete");
          return true;
        }
        const buttons = (
          target ? [target] : [...document.querySelectorAll(selector)]
        ).filter(
          (node) =>
            reader.visible(node) &&
            !node.disabled &&
            node.getAttribute("aria-disabled") !== "true",
        );
        if (buttons.length !== 1 || buttons[0] !== settled.button)
          throw Error("继续按钮已变化");
        assertCurrent();
        if (!canProceed()) throw Error("补答命令已过期或页面已变化");
        if (JobsPlatformConfig.appliedStatus(document)) {
          flow.block();
          setMessage("already-applied");
          return false;
        }
        flow.navigate(action);
        note("auto_navigation_attempt", null, action);
        onNavigate();
        setMessage(action === "submit" ? "submitting" : "awaiting-transition");
        if (
          !(JobsQueuePage
            ? JobsQueuePage.clickNavigate(action, buttons[0])
            : JobsPageActions.click(buttons[0]))
        )
          throw Error("Navigation cancelled before click");
        return true; // Attempt only. The original ATS success observer owns receipts.
      }
      async function approve(
        nodes,
        release,
        { automatic = false, canProceed = () => true } = {},
      ) {
        // User corrections during the review are intentional. Guard fresh edits
        // during this confirmation and recheck the original tab Profile.
        operation.resume();
        try {
          flow.move("verifying");
          if (!canProceed()) throw Error("补答命令已过期或页面已变化");
          await binding();
          if (!canProceed()) throw Error("补答命令已过期或页面已变化");
          const rows = reader.scan(),
            on = (node) => ({
              row: rows.find((item) => item.node === node),
              card: book.peek(node)?.card,
            });
          const accepted = nodes.filter((node) => {
            const { row, card } = on(node);
            return (
              row &&
              card &&
              shape(row) === card.shape &&
              !row.public.invalid &&
              reader.response(row)
            );
          });
          const incomplete = () => {
            const currentRows = reader.scan();
            return nodes.some((node) => {
              const row = currentRows.find((item) => item.node === node),
                card = book.peek(node)?.card;
              return (
                !row ||
                !card ||
                shape(row) !== card.shape ||
                row.public.invalid ||
                (!reader.response(row) &&
                  (!card.allowEmpty || row.public.required))
              );
            });
          };
          onReviewCheck(incomplete);
          // Learn only committed, unchanged controls. Confirmation releases the
          // navigation lock even if another answer still needs manual repair.
          if (automatic) JobsAnswerMemory?.discardReview?.(nodes);
          else JobsAnswerMemory?.confirmReview(accepted);
          release();
          note("auto_review_confirmed", null, String(nodes.length));
          if (incomplete()) {
            flow.block();
            note(
              "auto_blocked",
              null,
              "部分补答待完善，已确认可读答案并交还手动操作",
            );
            setMessage("complete-required");
            return false;
          }
          try {
            return await finish(undefined, canProceed);
          } catch (error) {
            flow.block();
            note("auto_blocked", null, error.message);
            setMessage(failurePhase(root));
            return false;
          }
        } finally {
          if (needsReview()) {
            if (flow.state === "verifying") flow.move("review");
            operation.pause();
          } else operation.release();
        }
      }
      try {
        flow.move("verifying");
        await binding();
        flow.move("filling");
        setMessage("in-progress");
        if (fill) {
          note(
            "auto_adapter_fill_started",
            null,
            root.getAttribute("data-automation-id") || root.tagName,
          );
          const filled = await operation.write(() =>
            JobsFormPipeline.within(
              { root, ledger: book, canProceed: current },
              () => {
                assertCurrent();
                return fill(current);
              },
            ),
          );
          if (filled?.hold) {
            hold = String(filled.hold).slice(0, 80);
            note("auto_fill_held", null, hold);
          }
          note("auto_adapter_fill_finished", null);
          await binding();
        }
        let prepared;
        const open = (row) =>
          !row.public.filled &&
          row.public.supported &&
          !row.public.dependencyBlocked &&
          row.public.commitState !== "unconfirmed" &&
          (!row.public.conditional || row.public.conditional.active === true) &&
          !["file", "contenteditable"].includes(row.public.type);
        // Not yet seen by any layer: the rules come first.
        const unruled = (row) => {
          const record = book.peek(row.node);
          return !record || (!record.ruled && record.state === "open");
        };
        // Every visible empty field visits the resolver once, required or optional.
        // Choices carry their spec to one open/search-and-commit transaction.
        async function fillByRules() {
          if (!resolveAnswers) return 0;
          const rows = reader.scan().filter((row) => open(row) && unruled(row));
          if (!rows.length) return 0;
          for (const row of rows) book.entry(row).ruled = true;
          const items = rows.map((row) => ({ row, shape: shape(row) })),
            reports = [];
          flow.move("resolving");
          const known = await resolveAnswers(
            rows.map((row) => ({
              ...row.public,
              node: row.node,
              inputType: row.public.type,
              options: (row.public.options || [])
                .filter((option) => option.value && option.label)
                .map((option) => option.label),
            })),
            profile,
            { root, onDecision: (decision) => reports.push(decision) },
          );
          await binding();
          let written = 0;
          for (const result of reports.length ? reports : known || []) {
            const item = items[result.index];
            if (!item) continue;
            book.entry(item.row).hint = hint(result);
            const row = reader.scan().find((row) => row.node === item.row.node);
            if (!row || !open(row) || shape(row) !== item.shape) {
              note("auto_answer_obsolete", item.row.node, "control_changed");
              continue;
            }
            if (result.status === "omit") {
              if (row.public.required)
                omit(row, { ...result, needsConfirmation: false });
              continue;
            }
            if (
              result.status === "needs-input" &&
              result.profileAnswer?.profileOnly
            ) {
              if (!row.public.required) continue;
              // A choice gets an AI proposal to confirm; exact text the Profile lacks stays with the person.
              if (isChoice(row) || isCheckbox(row))
                book.entry(row).confirm = true;
              else leave(row, result.reason);
              continue;
            }
            if (
              (result.status && result.status !== "answered") ||
              typeof result.answer !== "string"
            )
              continue;
            if (
              !row.public.required &&
              !(
                result.source === "profile" ||
                (result.source === "saved" &&
                  result.reason === "saved_exact_question")
              )
            )
              continue;
            const answer = ruleAnswer(row, result);
            if (!answer) continue;
            flow.move("writing");
            await binding();
            assertCurrent();
            const outcome = await operation.write(() =>
              JobsFormPipeline.write(row.node, answer, {
                ledger: book,
                root,
                decider: result.source === "saved" ? "saved" : "rule",
                source: "rule:" + result.source,
                reason: result.reason,
                canProceed: current,
              }),
            );
            assertCurrent();
            if (outcome.ok) {
              written++;
              note("auto_known_answer_applied", row.node, result.reason);
            } else
              note(
                row.public.required
                  ? "auto_rule_abstained"
                  : "auto_optional_skipped",
                row.node,
                outcome.reason.slice(0, 120),
              );
          }
          if (written)
            await JobsFormPipeline.settled(root, { canProceed: current });
          return written;
        }
        // Assemble only unresolved required fields with fresh, exact options.
        async function prepareSupplement(candidates) {
          let submitted = [];
          for (let row of candidates) {
            book.entry(row).aiTried = true;
            // A decided value that is gone again is the person's to check.
            if (book.peek(row.node).state === "decided") {
              leave(row, "Decided value missing");
              continue;
            }
            let options =
              row.public.options?.filter(
                (option) => option.value && option.label,
              ) || [];
            if (JobsControlFields.component(row.node)) {
              await binding();
              options = await operation.write(() =>
                reader.readOptions(
                  row,
                  current,
                  book.peek(row.node)?.hint || {},
                ),
              );
              row = reader.scan().find((item) => item.node === row.node);
              if (!row || row.public.filled) {
                note("auto_answer_obsolete", row?.node, "options_changed");
                continue;
              }
            }
            assertCurrent();
            // A searchable field may have no options until the user types.
            if (isChoice(row) && !options.length) {
              note("auto_unhandled_control", row.node, "No exact options");
              leave(row, "No exact options");
              continue;
            }
            // A segmented calendar needs day precision; a model must not invent the day.
            if (row.dateParts) {
              leave(row, "A complete calendar date is required", {
                source: undefined,
              });
              continue;
            }
            submitted.push({
              row,
              shape: shape(row),
              field: {
                fieldId: row.public.id,
                question: row.public.question,
                type:
                  row.public.type === "search-choice"
                    ? "combobox"
                    : row.public.type,
                required: row.public.required,
                options,
                description: (row.node.getAttribute("aria-describedby") || "")
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((id) => document.getElementById(id)?.textContent || "")
                  .join(" ")
                  .slice(0, 2000),
              },
            });
          }
          const fresh = reader.scan();
          submitted = submitted.filter((item) => {
            const row = fresh.find(
              (candidate) => candidate.node === item.row.node,
            );
            if (row && !row.public.filled && shape(row) === item.shape)
              return true;
            if (row && !row.public.filled) book.entry(row).aiTried = false;
            note(
              "auto_answer_obsolete",
              row?.node,
              row?.public.filled ? "already_filled" : "control_changed",
            );
            return false;
          });
          for (const item of submitted.slice(30))
            book.entry(item.row).aiTried = false;
          submitted = submitted.slice(0, 30);
          return submitted;
        }
        // Request one bounded batch and commit each answer through the shared ledger.
        async function applySupplement(submitted) {
          const formContext = reader
            .scan()
            .slice(0, 150)
            .map((row) => ({
              question: row.public.question,
              answer: reader.response(row)?.response || "",
            }));
          const initial = new Map(
            submitted.map((item) => [item.field.fieldId, item]),
          );
          for (const { row } of submitted)
            note("auto_luna_requested", row.node);
          flow.move("resolving");
          setMessage("ai-thinking");
          const reply = await chrome.runtime.sendMessage({
            type: "jobs:auto-answers",
            profileStamp: stamp,
            fields: submitted.map((item) => item.field),
            formContext,
            jobTitle: (
              document.querySelector(
                'h1,[data-automation-id="jobTitleHeading"]',
              )?.textContent || document.title
            )
              .trim()
              .slice(0, 500),
          });
          if (reply?.error) throw Error(reply.error);
          await binding();
          flow.move("writing");
          setMessage("ai-filling");
          const answers = reply?.data?.answers;
          if (
            !Array.isArray(answers) ||
            answers.length !== initial.size ||
            new Set(answers.map((answer) => answer.fieldId)).size !==
              initial.size ||
            answers.some((answer) => !initial.has(answer.fieldId))
          )
            throw Error("Luna 返回的字段不完整");
          for (const answer of answers) {
            const previous = initial.get(answer.fieldId);
            // Site updates can finish the original fill while AI is pending; keep
            // that result. Trusted user edits still stop via assertCurrent.
            const row = await unchanged(previous.row, previous.shape);
            if (!row) {
              book.entry(previous.row).aiTried = false;
              continue;
            }
            if (answer.state === "needs_input") {
              leave(row, answer.reason, {
                source: undefined,
                questionZh: answer.questionZh,
              });
              continue;
            }
            if (answer.state !== "answer") {
              leave(row, "Invalid AI answer state");
              continue;
            }
            if (
              answer.value === "" &&
              !row.public.required &&
              !isChoice(row) &&
              !isCheckbox(row) &&
              answer.reason?.trim()
            ) {
              omit(row, answer);
              continue;
            }
            if (isChoice(row)) {
              const values =
                row.public.type === "select-multiple"
                  ? answer.value
                  : [answer.value];
              if (
                !Array.isArray(values) ||
                values.some(
                  (value) =>
                    !previous.field.options.some(
                      (option) => option.value === value,
                    ),
                )
              ) {
                leave(row, "AI returned an unknown option");
                continue;
              }
            }
            const needsConfirmation =
              answer.needsConfirmation !== false || book.entry(row).confirm;
            const outcome = await operation.write(() =>
              JobsFormPipeline.write(
                row.node,
                { value: answer.value },
                {
                  ledger: book,
                  root,
                  decider: "ai",
                  source: "ai:" + answer.source,
                  reason: answer.reason,
                  canProceed: current,
                },
              ),
            );
            assertCurrent();
            const after =
              reader.scan().find((item) => item.node === row.node) || row;
            // The AI answer is on the card either way; one field never stops the others.
            if (!outcome.ok) {
              note(
                "auto_value_not_kept",
                row.node,
                outcome.reason.slice(0, 120),
              );
              leave(after, "AI answer not kept: " + outcome.reason, {
                questionZh: answer.questionZh,
              });
              continue;
            }
            note(
              "auto_field_applied",
              row.node,
              `${answer.source}: ${answer.reason}`,
            );
            toCard(after, {
              reason: answer.reason,
              source: answer.source,
              questionZh: answer.questionZh,
              answerZh: answer.answerZh,
              needsConfirmation,
            });
            if (needsConfirmation)
              note("auto_answer_needs_confirmation", row.node);
            JobsAnswerMemory?.remember(after.public.question, after.node, {
              requireReview: true,
              learn: answer.source === "suggestion",
            });
          }
          // Late site validation of the written answers decides review below.
          await JobsFormPipeline.quiet(root);
          assertCurrent();
        }
        // Bounded dependency waves; large forms may need several batches but
        // known Profile answers do not consume the provider's 30-field limit.
        for (let round = 0; round < 10; round++) {
          // An optional Profile answer can reveal a required conditional field.
          // Keep it inside the same settle/scan wave so that field is resolved
          // before this step can navigate.
          flow.move("scanning");
          assertCurrent();
          const written = await fillByRules();
          assertCurrent();
          flow.move("scanning");
          if (written) continue;
          const rows = reader.scan();
          // A Profile answer an optional field could not take (its binding
          // abstained) is shown on the card, never silently left blank.
          for (const row of rows) {
            const record = book.peek(row.node);
            if (
              record?.state === "abstained" &&
              String(record.decider).startsWith("binding:") &&
              !record.card &&
              !row.public.required &&
              !row.public.filled
            )
              leave(row, "The Profile answer did not match this field");
          }
          const pending = (row) => {
            const record = book.peek(row.node);
            return (
              row.public.required &&
              supplement(row) &&
              !(
                record &&
                (record.aiTried || record.card || record.state === "omitted")
              )
            );
          };
          note(
            "auto_fields_scanned",
            null,
            JSON.stringify({
              fields: rows.length,
              candidates: rows.filter(pending).length,
              round,
            }),
          );
          if (needsReview() && !rows.some(pending)) break;
          const settled = await reader.settle({
            review,
            selector: action === "fill" ? undefined : selector,
            target: action === "fill" ? undefined : target,
            canProceed: current,
            pending,
            beforeReady,
          });
          if (!settled) throw Error("页面尚未就绪，请检查校验提示和继续按钮");
          if (!settled.pending) {
            prepared = settled;
            break;
          }
          const candidates = settled.state.rows.filter(pending);
          if (resolveAnswers && candidates.some(unruled)) {
            note("auto_fields_discovered", null, String(candidates.length));
            continue;
          }
          if (!rows.some(pending))
            note("auto_fields_discovered", null, String(candidates.length));
          for (const row of candidates)
            note("auto_gap_stable", row.node, row.public.type);
          const submitted = await prepareSupplement(candidates);
          if (!submitted.length) continue;
          await applySupplement(submitted);
        }
        if (needsReview()) {
          flow.move("review");
          if (autoConfirm && ready() && JobsAIReview.canAutoConfirm(root)) {
            setMessage("checking");
            note("auto_review_automatic", null, "Complete answers validated");
            return await approve(
              book.carded().map((record) => record.node),
              () => JobsAIReview.release(root),
              { automatic: true },
            );
          }
          setMessage("ai-review");
          note(
            "auto_awaiting_review",
            null,
            "Unresolved answers require attention",
          );
          return false;
        }
        return await finish(prepared);
      } finally {
        // One timing record per run: where its time went.
        note(
          "auto_run_timing",
          null,
          JSON.stringify({
            ms: Date.now() - started,
            scans: (JobsControlFields.scans?.() || 0) - scans,
            structuralScans:
              (JobsControlFields.structuralScans?.() || 0) - structuralScans,
            writes: book.stats,
            profileChecks: operation.checks(),
          }),
        );
        if (needsReview()) {
          if (
            ![
              "review",
              "cancelled",
              "blocked",
              "navigation-attempted",
              "complete",
            ].includes(flow.state)
          )
            flow.move("review");
          operation.pause();
          JobsAIReview.ready(approve, action, {
            validate: async () => {
              operation.resume();
              try {
                await binding();
              } finally {
                operation.pause();
              }
            },
          });
        } else operation.release();
      }
    }
    JobsAutomatic = Object.freeze({
      advance,
      observe,
      createFlow,
      state: (root) => runs.get(root)?.flow.snapshot() || null,
      // The root the page's latest run owns, while that page is still shown.
      root: () =>
        latest && latest.root.isConnected && latest.url === location.href
          ? latest.root
          : null,
      release(root) {
        JobsAutomatic.cancel(root);
        for (const record of pendingRuns) {
          if (record.root === root || root?.contains(record.root)) {
            runs.delete(record.root);
            JobsFormPipeline.release?.(record.root);
          }
        }
        runs.delete(root);
        JobsFormPipeline.release?.(root);
        if (latest?.root === root || root?.contains(latest?.root))
          latest = null;
      },
      cancel(root) {
        for (const record of pendingRuns)
          if (
            record.root === root ||
            record.root.contains(root) ||
            root?.contains(record.root)
          ) {
            record.flow.cancel();
            JobsAIReview.release?.(record.root);
          }
        const record = runs.get(root);
        if (record) {
          record.flow.cancel();
          JobsAIReview.release?.(root);
        }
      },
    });
  })();
}
