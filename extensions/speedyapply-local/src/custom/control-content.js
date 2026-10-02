import { publicPageUrl } from "./public-job-url.js";
import { JobsControlConfig } from "./control-config.js";
import { JobsAutomatic } from "./automatic-fill.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsAnswerMemory } from "./answer-memory.js";
import { JobsDiagnostics } from "./diagnostics.js";
import { JobsAIReview } from "./ai-review.js";
import { JobsOperationContext } from "./operation-context.js";
import { JobsFormPipeline } from "./form-pipeline.js";
import { JobsQueuePage } from "./queue-page.js";
import { JobsProfileAnswers } from "./profile-answers.js";
import { JobsPlatformConfig } from "./platform-config.js";
export var JobsPageSession;
let initialized = false;
export function initializeControlContent() {
  if (initialized) return;
  initialized = true;
  (() => {
    const documentId = crypto.randomUUID();
    const phaseBusy = new Set([
      "in-progress",
      "ai-thinking",
      "ai-filling",
      "checking",
      "ai-review",
      "submitting",
      "awaiting-transition",
      "uploading-resume",
      "reloading",
      "select-profile",
      "awaiting_transition",
    ]);
    let adapter,
      profile,
      profileId = null,
      refill,
      phase = "idle",
      revision = 0,
      signature = "",
      busy = false,
      submitted = false;
    let profileVersion = null,
      runId = crypto.randomUUID(),
      sessionStartedAt = Date.now();
    const pageState = {
      documentId,
      get runId() {
        return runId;
      },
      get phase() {
        return phase;
      },
      set phase(value) {
        phase = value;
      },
      get profileName() {
        return profile?.profileName || "";
      },
      get startedAt() {
        return sessionStartedAt;
      },
    };
    let execution = Promise.resolve();
    const results = new Map();
    let transition;
    let nextWasRejected = false;
    let pipelineOptions;
    let pendingQueueStart;
    let releaseSession;
    let generation = 0;
    // A platform's declared root wins; otherwise the root its adapter's run
    // owns, and before any run the page's single visible form.
    const root = () => {
      return JobsPlatformConfig.root(
        document,
        adapter?.ats,
        adapter && JobsAutomatic?.root?.(),
      );
    };
    const fields = JobsControlFields.create(document, root);
    JobsDiagnostics?.useReader(fields);
    const safeUrl = () => publicPageUrl(location.href);
    function button(action) {
      return root()
        ? JobsPlatformConfig.navigation(document, adapter?.ats, action)
        : null;
    }
    function snapshot() {
      if (!adapter) throw Error("No active ATS adapter");
      const state = fields.state(),
        rows = state.rows,
        unresolved = rows.filter(
          (row) => !JobsControlFields.complete(row.public),
        );
      if (
        submitted &&
        phase !== "confirmed" &&
        !JobsPlatformConfig.appliedStatus(document) &&
        (state.errors.length || rows.some((row) => row.public.invalid))
      ) {
        phase = "submission-error";
        JobsQueuePage?.validationError?.();
      }
      if (transition) {
        const identity = JSON.stringify(
          rows.map((row) => [row.public.id, row.public.question]),
        );
        if (
          location.href !== transition.url ||
          root() !== transition.root ||
          identity !== transition.identity ||
          rows.some((row) => row.public.invalid) ||
          Array.from(
            root()?.querySelectorAll(
              '[role="alert"],[aria-live="assertive"]',
            ) || [],
          ).some((node) => fields.visible(node) && node.textContent.trim())
        ) {
          nextWasRejected =
            rows.some((row) => row.public.invalid) || state.errors.length > 0;
          transition = null;
          phase = "complete-required";
        }
      }
      const reportedPhase = fields.pageFailure()
        ? "site-error"
        : phase === "site-error"
          ? phase
          : root()
            ? phase
            : "unsupported_form";
      const review = JobsAIReview?.remoteState?.(root());
      const fingerprint = JSON.stringify([
        location.href,
        reportedPhase,
        profileId,
        profile?.profileName,
        rows.map((row) => [row.public, row.raw]),
        review,
      ]);
      if (signature !== fingerprint) {
        signature = fingerprint;
        revision++;
      }
      const actions = ["inspect"];
      if (
        JobsControlConfig?.enabled === true &&
        profileId &&
        profile &&
        !busy &&
        !submitted &&
        reportedPhase === "ai-review" &&
        review?.ready
      ) {
        if (
          review.items.some((item) =>
            rows.some(
              (row) => row.public.id === item.fieldId && row.public.supported,
            ),
          )
        )
          actions.push("answer_review");
        actions.push("confirm_review");
      }
      if (
        JobsControlConfig?.enabled === true &&
        profileId &&
        profile &&
        reportedPhase !== "site-error" &&
        !busy &&
        !phaseBusy.has(phase) &&
        !submitted &&
        root()
      ) {
        if (refill && !rows.some((row) => row.public.filled))
          actions.push("autofill");
        if (rows.some((row) => row.public.supported))
          actions.push("fill_answers");
        // Unknown controls are not proof of completeness. A supervised caller
        // can inspect them; this first version refuses automatic advancement.
        if (!JobsAIReview?.pending() && state.ready) {
          if (button("next")) actions.push("next");
          if (button("submit")) actions.push("submit");
        }
      }
      return {
        documentId,
        revision,
        url: safeUrl(),
        title: document.title.slice(0, 500),
        profileId,
        profileName: profile?.profileName || "",
        ats: adapter.ats,
        phase: reportedPhase,
        visibility: document.visibilityState,
        coverage: "partial",
        fields: rows
          .map((row) => {
            const {
              supplement,
              completionReadable,
              requiredKnown,
              component,
              capabilities,
              completion,
              commitState,
              topicHint,
              ...field
            } = row.public;
            return {
              ...field,
              ...(row.public.type === "file" ? {} : { value: row.raw }),
            };
          })
          .slice(0, 150),
        ...(JobsDiagnostics ? { events: JobsDiagnostics.recentEvents() } : {}),
        counts: {
          total: rows.length,
          unfilled: unresolved.length,
          unsupported: rows.filter((row) => !row.public.supported).length,
        },
        ...(review ? { review } : {}),
        actions,
        observedAt: Date.now(),
      };
    }
    const outcome = (action, extra = {}) => ({
      action,
      phase,
      evidence: { type: "none", text: "" },
      ...extra,
    });
    async function execute(command) {
      if (JobsControlConfig?.enabled !== true)
        throw Error("Remote execution is disabled");
      if (!adapter || command?.target?.documentId !== documentId)
        throw Error("Page was replaced");
      if (
        !Number.isFinite(command.expiresAt) ||
        command.expiresAt <= Date.now()
      )
        throw Error("Command expired");
      if (
        typeof command.id !== "string" ||
        command.id.length > 128 ||
        !command.id
      )
        throw Error("Invalid command ID");
      const key = JSON.stringify(command),
        existing = results.get(command.id);
      if (existing) {
        if (existing.key !== key) throw Error("Command ID reused");
        return existing.result;
      }
      const current = snapshot();
      if (command.target.revision !== current.revision)
        throw Error("Page changed; inspect it again");
      if (!current.actions.includes(command.action))
        throw Error("Action is unavailable in the current page state");
      const record = {
        key,
        result:
          /** @type {{id:string,state:string,error?:string,data?:object}} */ ({
            id: command.id,
            state: "unknown",
            error: "Action interrupted; do not repeat automatically",
          }),
      };
      results.set(command.id, record);
      busy = true;
      let operation;
      try {
        let data;
        if (command.action === "inspect") data = outcome("inspect");
        else {
          const owner = adapter;
          const reviewAction = ["answer_review", "confirm_review"].includes(
            command.action,
          );
          operation = JobsOperationContext.create({
            root: root(),
            getRoot: root,
            profile,
            profileId,
            expiresAt: command.expiresAt,
            canProceed: () =>
              adapter === owner &&
              !submitted &&
              (!JobsAIReview?.pending() ||
                (reviewAction &&
                  JobsAIReview.matches(root(), current.review?.id))),
          });
          await operation.verify();
          if (snapshot().revision !== command.target.revision)
            throw Error("Page changed while checking Profile");
        }
        if (command.action === "answer_review") {
          const answers = command.args?.answers;
          if (
            !Array.isArray(answers) ||
            !answers.length ||
            answers.length > 100 ||
            new Set(answers.map((answer) => answer.fieldId)).size !==
              answers.length
          )
            throw Error("Invalid review answers");
          const appliedFieldIds = [],
            failedFieldIds = [];
          for (const answer of answers) {
            const item = current.review.items.find(
              (item) => item.fieldId === answer.fieldId,
            );
            try {
              await operation.verify();
              if (!item) throw Error("Answer is not in the current review");
              const result = await operation.write(() =>
                JobsAIReview.remoteAnswer(
                  root(),
                  current.review.id,
                  item.itemId,
                  { version: item.version, value: answer.value },
                  operation.current,
                ),
              );
              if (!result?.ok)
                throw Error(result?.error || "Review did not accept answer");
              appliedFieldIds.push(answer.fieldId);
            } catch (error) {
              failedFieldIds.push(answer.fieldId);
              JobsDiagnostics?.note(
                "auto_remote_review_failed",
                null,
                String(error.message || error),
              );
            }
          }
          data = outcome(command.action, { appliedFieldIds, failedFieldIds });
        } else if (command.action === "confirm_review") {
          await operation.verify();
          if (snapshot().revision !== command.target.revision)
            throw Error("Review changed while checking Profile");
          const ok = await operation.write(() =>
            JobsAIReview.remoteConfirm(
              root(),
              current.review.id,
              operation.current,
            ),
          );
          if (!ok) throw Error("Review confirmation failed");
          if (current.review.action === "submit" && phase === "submitting")
            submitted = true;
          data = outcome(command.action);
        } else if (command.action === "autofill") {
          phase = "in-progress";
          await operation.write(() => refill(operation.current));
          await operation.verify();
          phase = "autofill-complete";
          data = outcome("autofill");
        } else if (command.action === "fill_answers") {
          const answers = command.args?.answers;
          if (
            !Array.isArray(answers) ||
            !answers.length ||
            answers.length > 100 ||
            new Set(answers.map((answer) => answer.fieldId)).size !==
              answers.length
          )
            throw Error("Invalid answer list");
          const appliedFieldIds = [],
            failedFieldIds = [];
          const canProceed = operation.current;
          const initial = new Map(
            fields
              .scan()
              .map((row) => [
                row.public.id,
                JSON.stringify([
                  row.public.question,
                  row.public.type,
                  row.public.options,
                ]),
              ]),
          );
          for (const answer of answers) {
            let row;
            try {
              await operation.verify();
              row = fields
                .scan()
                .find((item) => item.public.id === answer.fieldId);
              if (
                !row ||
                !canProceed() ||
                initial.get(answer.fieldId) !==
                  JSON.stringify([
                    row.public.question,
                    row.public.type,
                    row.public.options,
                  ]) ||
                JSON.stringify(answer.value).length > 10000
              )
                throw Error("Field changed or answer expired");
              const scope = root();
              const ledger =
                JobsFormPipeline.ledgerFor(scope) ||
                JobsFormPipeline.ledger(scope);
              const written = await operation.write(() =>
                JobsFormPipeline.write(
                  row.node,
                  { value: answer.value },
                  {
                    ledger,
                    root: scope,
                    decider: "remote",
                    source: "remote",
                    replace: answer.replace === true,
                    canProceed,
                  },
                ),
              );
              if (!written.ok)
                throw Error(
                  written.reason || "Page did not keep the remote answer",
                );
              appliedFieldIds.push(answer.fieldId);
            } catch (error) {
              failedFieldIds.push(answer.fieldId);
              JobsDiagnostics?.note(
                "auto_remote_field_failed",
                row?.node,
                String(error.message || error),
              );
            }
          }
          data = outcome("fill_answers", { appliedFieldIds, failedFieldIds });
        } else if (command.action !== "inspect") {
          const target = button(command.action);
          if (!target || !fields.state().ready)
            throw Error("Button is missing or page changed");
          // Remote and automatic navigation share the same finish barrier and
          // durable submission guard. A remote command is never a second writer.
          const advanced = await JobsAutomatic.advance({
            root: root(),
            profile,
            action: command.action,
            target,
            retry: true,
            retryAfterValidation: command.action === "next" && nextWasRejected,
            canProceed: operation.current,
            setMessage: (message) => {
              phase = message;
              if (message === "submitting") submitted = true;
              if (message === "awaiting-transition") {
                nextWasRejected = false;
                transition = {
                  url: location.href,
                  root: root(),
                  identity: JSON.stringify(
                    current.fields.map((row) => [row.id, row.question]),
                  ),
                };
              }
              pipelineOptions?.setMessage(message);
            },
          });
          if (!advanced) throw Error("Page did not permit continuation");
          if (command.action === "submit") submitted = true;
          data = outcome(command.action);
        }
        record.result = { id: command.id, state: "completed", data };
      } catch (error) {
        record.result = {
          id: command.id,
          state: submitted ? "unknown" : "failed",
          error: String(error.message || error).slice(0, 500),
        };
        if (phase === "in-progress") phase = "complete-required";
      } finally {
        operation?.release();
        busy = false;
      }
      return record.result;
    }
    function run(script, options) {
      const current = generation;
      return JobsQueuePage
        ? JobsQueuePage.configure(options).then(
            (next) => {
              if (current !== generation) return;
              pendingQueueStart = null;
              return start(script, next);
            },
            () => {
              if (current !== generation) return;
              // An owned document may load while paused or after browser recovery.
              // Preserve its adapter entry without starting it or refreshing the form.
              pendingQueueStart = () => run(script, options);
              phase = "queue-paused";
            },
          )
        : start(script, options);
    }
    function start(script, options) {
      const owner = { ats: options.jobsAdapterId || script.name };
      const lifecycleId = crypto.randomUUID();
      adapter = owner;
      JobsDiagnostics?.start(owner.ats, { ...options, pageSession: pageState });
      JobsAnswerMemory?.configure(
        options.autofillSettings?.saveResponses,
        options.ctx,
      );
      let heartbeat,
        stopped = false;
      const stopHeartbeat = () => {
        stopped = true;
        clearInterval(heartbeat);
        window.removeEventListener("pagehide", onPageHide);
      };
      const stop = (notify = true) => {
        if (!stopped && notify !== false) {
          try {
            void chrome.runtime
              .sendMessage({
                type: "jobs:control-unregister",
                documentId,
                lifecycleId,
              })
              .catch(() => {});
          } catch {}
        }
        stopHeartbeat();
        if (adapter === owner) {
          JobsAutomatic?.release?.(root());
          JobsAIReview?.release?.(root());
          results.clear();
          adapter = null;
          releaseSession = null;
          profile = null;
          profileId = null;
          profileVersion = null;
          refill = null;
          JobsDiagnostics?.clear?.();
          JobsAnswerMemory?.stop();
          pipelineOptions = null;
          JobsControlFields.dispose();
        }
      };
      const onPageHide = () => stop();
      releaseSession = () => {
        if (adapter !== owner) return;
        JobsAutomatic?.release?.(root());
        JobsAIReview?.release?.(root());
        JobsAnswerMemory?.stop({ discard: true });
        stop();
        options.ctx?.abort?.("连接已改变，请重新开始填写");
        phase = "profile-unavailable";
        releaseSession = null;
      };
      const live = () => {
        try {
          return !!chrome.runtime?.id && options.ctx?.isInvalid !== true;
        } catch {
          return false;
        }
      };
      const invalidate = () => {
        if (stopped) return;
        stop(false);
        // Notify the existing lifecycle so its observers/timers stop as well.
        options.ctx?.abort?.("Extension context invalidated");
      };
      const register = async () => {
        if (stopped) return null;
        try {
          if (!live()) {
            invalidate();
            return null;
          }
          return await chrome.runtime.sendMessage({
            type: "jobs:control-register",
            documentId,
            lifecycleId,
          });
        } catch (error) {
          // sendMessage can throw synchronously before returning a Promise.
          // A live worker's temporary connection failure should still retry.
          if (
            !live() ||
            /Extension context invalidated/i.test(
              String(error?.message || error),
            )
          )
            invalidate();
          return null;
        }
      };
      options.ctx?.onInvalidated?.(stop);
      const registration = register();
      if (stopped) return;
      // Loading notifications or a restarted worker can forget a live SPA frame.
      // Renew the read-only registration; this never restarts autofill.
      heartbeat = setInterval(() => {
        if (adapter === owner) return register();
      }, 10000);
      window.addEventListener("pagehide", onPageHide, { once: true });
      const setMessage = (message) => {
        if (JobsPlatformConfig.appliedStatus(document)) {
          phase = "confirmed";
          options.setMessage("already-applied");
          return;
        }
        phase = message || (submitted ? phase : "idle");
        options.setMessage(message);
        JobsDiagnostics?.phase(phase);
        JobsQueuePage?.phase();
      };
      const getProfile = async () => {
        await registration;
        await JobsQueuePage?.verify();
        if (stopped)
          throw Error("Extension context invalidated; refresh this page");
        if (profileVersion) JobsDiagnostics?.finishRun();
        phase = "in-progress";
        profileId = null;
        profileVersion = null;
        runId = crypto.randomUUID();
        sessionStartedAt = Date.now();
        JobsDiagnostics?.beginRun();
        try {
          // The original reader begins one fresh round; all later readers verify
          // that same version instead of silently replacing it mid-fill.
          const current = await options.getProfile();
          if (stopped) throw Error("连接已改变，请重新开始填写");
          const after = await chrome.runtime.sendMessage({
            type: "jobs:tab-profile",
          });
          if (stopped) throw Error("连接已改变，请重新开始填写");
          if (after?.error) throw Error(after.error);
          const signature = JobsProfileAnswers?.signature || JSON.stringify;
          if (
            !after?.data?.id ||
            signature(current) !== signature(after.data.profile)
          )
            throw Error("本页 Profile 已改变");
          profile = current;
          profileId = after.data.id;
          profileVersion = after.data.lastSync || after.data.revision || null;
          return profile;
        } catch (error) {
          if (/Profile|资料/.test(error.message || ""))
            setMessage("profile-unavailable");
          throw error;
        }
      };
      // Remote capability does not change the user's normal adapter settings.
      // Commands are explicit, serialized and refused while the adapter is busy;
      // fill_answers only invokes the field writer, never a continuation.
      const wrapped = {
        ...options,
        pageSession: pageState,
        setMessage,
        getProfile,
      };
      pipelineOptions = JobsAutomatic
        ? JobsAutomatic.observe(wrapped)
        : wrapped;
      return script(pipelineOptions);
    }
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (
        ![
          "jobs:control-inspect",
          "jobs:control-execute",
          "jobs:document-check",
          "jobs:private-session-invalidated",
        ].includes(message?.type)
      )
        return;
      if (sender.id !== chrome.runtime.id || sender.tab) {
        reply({ error: "Extension background only" });
        return;
      }
      if (message.type === "jobs:private-session-invalidated") {
        generation++;
        pendingQueueStart = null;
        releaseSession?.();
        reply({ ok: true });
        return;
      }
      if (message.type === "jobs:document-check") {
        reply({ active: !!adapter, url: location.href });
        return;
      }
      if (message.type === "jobs:control-inspect") {
        try {
          reply({ data: snapshot() });
        } catch (error) {
          reply({ error: error.message });
        }
        return;
      }
      const task = execution.then(() => execute(message.command));
      execution = task.catch(() => {});
      task.then(reply, (error) =>
        reply({
          id: message.command?.id,
          state: "failed",
          error: error.message,
        }),
      );
      return true;
    });
    async function advance(target, action = "next", { review = false } = {}) {
      const scope = root();
      if (
        !adapter ||
        !profile ||
        !scope ||
        !fields.visible(target) ||
        !pipelineOptions ||
        !JobsAutomatic
      ) {
        JobsDiagnostics?.note(
          "auto_blocked",
          target,
          "Application scope or bound Profile unavailable",
        );
        pipelineOptions?.setMessage("complete-manually");
        return false;
      }
      return JobsAutomatic.advance({
        root: scope,
        profile,
        action,
        target,
        review,
        setMessage: pipelineOptions.setMessage,
      });
    }
    function queueState() {
      if (JobsPlatformConfig.appliedStatus(document))
        return { phase: "confirmed", active: !!adapter, finalReady: false };
      const scope = root(),
        state = fields.state(),
        review = !!scope?.querySelector(
          '[data-automation-id="reviewJobApplicationPage"],[data-automation-id="applyFlowReviewPage"]',
        );
      const buttons = scope
        ? [
            ...scope.querySelectorAll(
              'button,input[type="submit"],[role="button"]',
            ),
          ].filter(
            (node) =>
              fields.visible(node) && JobsControlFields.continuation(node),
          )
        : [];
      const submit = buttons.filter(
        (node) =>
          review ||
          /^(?:submit|send application|apply)(?:\s|$)/i.test(
            (node.value || node.textContent).trim(),
          ),
      );
      return {
        phase,
        active: !!adapter && !!profile && !!scope,
        finalReady:
          !!profile &&
          !busy &&
          ["ready-submit", "page-complete", "autofill-complete"].includes(
            phase,
          ) &&
          !JobsAIReview?.pending() &&
          state.ready &&
          (phase === "ready-submit" || submit.length === 1),
      };
    }
    async function resumeQueue() {
      if (pendingQueueStart) {
        await pendingQueueStart();
        return;
      }
      if (!pipelineOptions || !root() || JobsAIReview?.pending()) return;
      try {
        const current = await pipelineOptions.getProfile();
        const configured = await JobsQueuePage.configure(pipelineOptions),
          scope = root();
        const buttons = [
          ...scope.querySelectorAll(
            'button,input[type="submit"],[role="button"]',
          ),
        ].filter(
          (node) =>
            fields.visible(node) &&
            !node.disabled &&
            node.getAttribute("aria-disabled") !== "true",
        );
        const next =
          button("next") ||
          buttons
            .filter((node) =>
              /^(?:next|continue|save (?:and|&) continue)$/i.test(
                (node.value || node.textContent).trim(),
              ),
            )
            .filter(
              () =>
                !scope.querySelector(
                  '[data-automation-id="reviewJobApplicationPage"],[data-automation-id="applyFlowReviewPage"]',
                ),
            );
        const target = Array.isArray(next)
          ? next.length === 1
            ? next[0]
            : null
          : next;
        const submit = configured.autofillSettings.autoSubmit
          ? button("submit") ||
            buttons.filter((node) =>
              /^(?:submit|submit application)$/i.test(
                (node.value || node.textContent).trim(),
              ),
            )
          : null;
        const final = Array.isArray(submit)
          ? submit.length === 1
            ? submit[0]
            : null
          : submit;
        await JobsAutomatic.advance({
          root: scope,
          profile: current,
          action: target ? "next" : final ? "submit" : "fill",
          target: target || final || undefined,
          retry: true,
          setMessage: pipelineOptions.setMessage,
        });
      } catch (error) {
        JobsDiagnostics?.note(
          "auto_queue_resume_failed",
          null,
          String(error.message || error),
        );
      }
    }
    JobsPageSession = {
      run,
      get state() {
        return pageState;
      },
      get profileVersion() {
        return profileVersion;
      },
      root,
      advance,
      queueState,
      resumeQueue,
      profile: () => profile,
      setAutofill: (callback) => {
        refill = callback;
      },
      confirmed: () => {
        submitted = true;
        phase = "confirmed";
        void JobsQueuePage?.confirmed();
      },
    };
    JobsQueuePage?.attach({
      get ats() {
        return adapter?.ats;
      },
      state: queueState,
      scan: (scope) => JobsControlFields.create(document, () => scope).scan(),
      pending: () => JobsAIReview?.pending(),
      cancel: () => JobsAutomatic?.cancel(root()),
      resume: resumeQueue,
    });
  })();
}
