import { JobsDiagnostics } from "./diagnostics.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsDOMWait } from "./dom-wait.js";
import { JobsPageCommit } from "./page-commit.js";
export var JobsFormPipeline;
let initialized = false;
export function initializeFormPipeline() {
  if (initialized) return;
  initialized = true;
  (() => {
    const note = (type, node, detail) =>
      JobsDiagnostics?.note(type, node, detail);
    const act = () => JobsPageActions;
    let diagnosticOperation = 0;
    let active = null,
      fillTail = Promise.resolve(undefined);
    const ledgers = new WeakMap();
    // A field outlives its element; the scanner owns that rule (JobsControlFields.follow).
    const fieldKey = (row) => JobsControlFields.fieldKey(row);
    const follow = (rows, node, key) =>
      JobsControlFields.follow(rows, node, key);
    const holds = (row, node) =>
      row.node === node || !!row.group?.includes(node);
    // A shadow control still belongs to the form containing its host.
    const inScope = (root, node) => {
      if (!root) return true;
      for (
        let current = node;
        current;
        current = current.getRootNode?.().host
      ) {
        if (current === root || root.contains(current)) return true;
      }
      return false;
    };
    // The run's field ledger: one record per field (the scanner's canonical node).
    // A field has at most one decider, the layer whose value it holds; a layer
    // that cannot match or keep its value abstains and the next layer (AI, then
    // the person) decides instead.
    //   state    open | claimed | decided | abstained | omitted
    //   decider  binding:<name> | rule | saved | ai | user
    //   ruled    the rules were asked         aiTried  sent to AI and not obsolete
    //   hint     the rules' decision, for reading the field's options later
    //   confirm  a missing explicit fact requires review of an AI proposal
    //   card     {shape, allowEmpty} while the field is on the review card
    function ledger(root) {
      const records = new Map();
      const scan = () =>
        JobsControlFields.create(root.ownerDocument || root, () => root).scan();
      const create = (node, key = null) => {
        const record = {
          node,
          key,
          entryScope: JobsControlFields.entryScope(node),
          state: "open",
          decider: null,
          ruled: false,
          hint: null,
          aiTried: false,
          confirm: false,
          card: null,
        };
        records.set(node, record);
        return record;
      };
      function known(node) {
        const record = records.get(node);
        // Reusing the exact input element for a confirmed new entry is a new
        // field. Ordinary re-renders keep their entry and its decider guard.
        if (
          record &&
          node.isConnected &&
          record.entryScope !== JobsControlFields.entryScope(node)
        ) {
          records.delete(node);
          return null;
        }
        return record;
      }
      // A record whose element the page replaced moves to its field's new row
      // (same question and type, not already recorded). Ambiguity moves nothing.
      function followAll(rows) {
        for (const record of [...records.values()]) {
          if (record.node.isConnected || !record.key) continue;
          const row = follow(rows, record.node, record.key);
          if (!row || records.has(row.node)) continue;
          records.delete(record.node);
          record.node = row.node;
          records.set(row.node, record);
          note("auto_field_followed", row.node, record.decider || record.state);
        }
      }
      // The record of the field that holds this node, following a re-render.
      function find(node, rows) {
        if (known(node)) return { record: known(node), node };
        rows ??= scan();
        followAll(rows);
        // A radio member or a binding's wrapper maps to the row that owns it.
        const matches = rows.filter(
          (row) => holds(row, node) || node.contains?.(row.node),
        );
        const row = matches.length === 1 ? matches[0] : null,
          canonical = row?.node || node;
        return { record: known(canonical) || null, node: canonical, row };
      }
      const book = {
        root,
        // What this run's writes cost (timing diagnostics).
        stats: { writes: 0, ms: 0, heldMs: 0, scans: 0 },
        // A lookup scans only when an earlier record may have lost its element.
        peek(node) {
          if (known(node)) return known(node);
          if (![...records.values()].some((record) => !record.node.isConnected))
            return null;
          return find(node).record;
        },
        entry: (row) => book.peek(row.node) || create(row.node, fieldKey(row)),
        get(node) {
          const found = find(node);
          return (
            found.record ||
            create(found.node, found.row ? fieldKey(found.row) : null)
          );
        },
        carded: () => [...records.values()].filter((record) => record.card),
        claim(node, decider, { replace = false } = {}) {
          const record = book.get(node);
          // The person may always replace an automatic answer.
          if (
            decider !== "user" &&
            !(["remote", "agent", "page-tool"].includes(decider) && replace) &&
            ["claimed", "decided"].includes(record.state)
          ) {
            note(
              "auto_duplicate_decider",
              record.node,
              record.decider + " -> " + decider,
            );
            throw Error("A field already has a decider: " + record.decider);
          }
          record.state = "claimed";
          record.decider = decider;
          return record;
        },
        decide(node, decider) {
          const record = book.get(node);
          record.state = "decided";
          record.decider = decider;
          JobsDiagnostics?.trace?.(record.node, {
            decider,
            source: decider,
            result: "decided",
          });
        },
        abstain(node, decider, reason) {
          const record = book.get(node);
          record.state = "abstained";
          record.decider = decider;
          // A failed write does not make a later answer uncertain. The next
          // writer must still keep its value; AI and missing-fact review decide
          // confirmation independently of this past failure.
          note(
            "auto_decider_abstained",
            record.node,
            decider + ": " + String(reason || "").slice(0, 120),
          );
        },
        // Automatic and agent answers are not saved again as the person's own
        // answers, including a field whose element the page has since replaced.
        answered() {
          if ([...records.values()].some((record) => !record.node.isConnected))
            followAll(scan());
          return new Set(
            [...records.values()]
              .filter(
                (record) =>
                  known(record.node) === record &&
                  record.state === "decided" &&
                  record.decider !== "user",
              )
              .map((record) => record.node),
          );
        },
      };
      ledgers.set(root, book);
      return book;
    }
    const ledgerFor = (root) => ledgers.get(root) || null;
    function answered(root) {
      return ledgerFor(root)?.answered() || new Set();
    }
    // Inside a fill every page action belongs to its run: a cancelled or
    // superseded run takes no further action (JobsPageActions asks here).
    // Outside a fill there is no run to ask.
    let asking = false;
    function live() {
      if (!active || asking) return true;
      asking = true;
      try {
        return active.canProceed?.() !== false;
      } finally {
        asking = false;
      }
    }
    // One fill at a time owns the binding context, so a binding always reaches
    // the run whose fill declared it.
    async function within(context, fill) {
      const before = fillTail;
      let release;
      fillTail = new Promise((resolve) => {
        release = resolve;
      });
      await before;
      active = context;
      try {
        return await fill();
      } finally {
        active = null;
        release();
      }
    }
    // The one way an answer reaches a field: claim, write, confirm the page kept
    // it, then decide or abstain. A failure changes only this field's record.
    //   {specs}   semantic answers chosen from the control's own options
    //   {value}   an exact value (an AI or review-card answer, a rule's text)
    //   {checked} a checkbox state
    // A second automatic decider is a declaration error and is thrown.
    async function write(
      node,
      answer,
      {
        ledger: book = active?.ledger,
        root = book?.root || active?.root,
        decider = undefined,
        source = decider,
        reason = undefined,
        replace = false,
        canProceed = active?.canProceed || (() => true),
      } = {},
    ) {
      canProceed = act().guard(canProceed);
      if (!inScope(root, node))
        return { ok: false, reason: "Field is outside the active form" };
      const operation = ++diagnosticOperation;
      const evidence = (value) =>
        JobsDiagnostics?.evidence?.(node, { operation, ...value });
      evidence({
        stage: "write",
        result: "started",
        total: answer.specs?.length || 1,
      });
      try {
        book?.claim(node, decider, { replace });
      } catch (error) {
        if (!act().live(canProceed)) throw error;
        // Refuse the second writer without replacing the first field's ledger
        // entry or aborting unrelated bindings in this page.
        return { ok: false, reason: String(error.message || error) };
      }
      const started = Date.now(),
        scans = JobsControlFields.scans?.() || 0;
      let written = null,
        why = "not committed",
        heldMs = 0,
        commitRevision;
      try {
        if (
          JobsPageCommit &&
          !(await JobsPageCommit.wait(node, { canProceed, idle: true }))
        )
          throw Error("Page definition update is not confirmed");
        commitRevision = JobsPageCommit?.revision(node);
        if (answer.checked !== undefined) {
          // A check goes through the field's setter (a widget's own); one radio
          // of a group, or a native input the scanner does not list, is set
          // with the primitive that setter uses.
          const reader = JobsControlFields.create(
            root?.ownerDocument || node.ownerDocument,
            () => root || node.ownerDocument,
            { write: true },
          );
          const row = reader.field(node),
            radio = node.matches?.('input[type="radio"]');
          if (
            radio
              ? node.checked === answer.checked
              : row && (row.raw === true) === answer.checked
          )
            written = row?.node || node;
          else if (row && !radio) {
            await reader.apply(row, answer.checked, canProceed, {
              replace: true,
              source,
              reason,
              decider,
            });
            written = row.node;
          } else {
            written = radio
              ? answer.checked &&
                (await JobsControlFields.writeChoice(node, { canProceed }))
              : await JobsControlFields.writeChecked(node, answer.checked, {
                  canProceed,
                });
            JobsDiagnostics?.trace?.(node, {
              source,
              decider,
              result: written ? "committed" : "not-committed",
            });
          }
        } else if (answer.value !== undefined) {
          const reader = JobsControlFields.create(
            root.ownerDocument || root,
            () => root,
            { write: true },
          );
          const row = reader.field(node);
          if (!row) throw Error("Field changed before writing");
          await reader.apply(row, answer.value, canProceed, {
            replace,
            source,
            reason,
            decider,
          });
          written = row.node;
        } else {
          let committed = 0,
            lastCommitted = -1;
          const missing = new Set();
          const chooseItem = async (item, spec) => {
            evidence({
              stage: "item",
              result: "started",
              item,
              total: answer.specs.length,
            });
            const chosen = await JobsControlFields.chooseSpec(node, spec, {
              canProceed,
              replace,
              source,
              decider,
            });
            if (chosen) {
              committed++;
              lastCommitted = Math.max(lastCommitted, item);
              missing.delete(item);
            } else missing.add(item);
            evidence({
              stage: "item",
              result: chosen ? "committed" : "failed",
              item,
              total: answer.specs.length,
              committed,
              ...(!chosen ? { reason: "not_committed" } : {}),
            });
          };
          for (const [item, spec] of answer.specs.entries())
            await chooseItem(item, spec);
          // A later retained selection is new evidence that the widget responds.
          // Recover earlier append failures once, inside the same writer/claim;
          // chooseSpec checks existing pills before any search or click.
          const recover = [...missing].filter(
            (item) =>
              item < lastCommitted && answer.specs[item]?.append === true,
          );
          for (const item of recover) {
            if (!act().live(canProceed) || !node.isConnected) break;
            note(
              "auto_choice_recovery",
              node,
              "Retry earlier append after a later commit",
            );
            await chooseItem(item, answer.specs[item]);
          }
          written = missing.size ? null : node;
        }
        const holding = Date.now();
        if (
          written &&
          JobsPageCommit &&
          !(await JobsPageCommit.wait(node, {
            canProceed,
            since: commitRevision,
          }))
        )
          throw Error("Page definition update is not confirmed");
        if (written && root && !(await hold(root, node, { canProceed })).kept) {
          written = null;
          why = "value not kept";
        }
        heldMs = Date.now() - holding;
      } catch (error) {
        evidence({ stage: "write", result: "failed", reason: "exception" });
        if (!act().live(canProceed)) throw error;
        written = null;
        why = String(error?.message || error);
      }
      // One timing record per write: its duration, the kept check's share and the scans it used.
      const cost = {
        ms: Date.now() - started,
        heldMs,
        scans: (JobsControlFields.scans?.() || 0) - scans,
      };
      note("auto_write_timing", node, JSON.stringify(cost));
      if (book) {
        book.stats.writes++;
        book.stats.ms += cost.ms;
        book.stats.heldMs += cost.heldMs;
        book.stats.scans += cost.scans;
      }
      evidence({
        stage: "write",
        result: written ? "kept" : "failed",
        ...(!written
          ? {
              reason: why === "value not kept" ? "value_lost" : "not_committed",
            }
          : {}),
      });
      if (written) book?.decide(node, decider);
      else book?.abstain(node, decider, why);
      return written ? { ok: true, node: written } : { ok: false, reason: why };
    }
    // A written value counts once the page keeps it for a quiet interval. Some
    // sites (Workday) re-render neighbouring fields shortly after a commit; the
    // next write waits for this instead of a fixed delay. Native controls commit
    // synchronously and their writer already verified them; only a registered
    // widget can re-render afterwards.
    async function hold(
      root,
      node,
      { canProceed = () => true, quiet = 200, timeout = 2000 } = {},
    ) {
      if (!JobsControlFields.component(node)) return { kept: true };
      const doc = root.ownerDocument || root,
        reader = JobsControlFields.create(doc, () => root);
      const start = reader.scan().find((row) => holds(row, node)),
        key = start && fieldKey(start);
      let row = start,
        readable = false;
      const read = () => {
        row = follow(reader.scan(), node, key);
        readable =
          !!row &&
          !row.public.invalid &&
          (row.public.type !== "combobox" || !!reader.response(row));
        // A dropdown can already hold the selected value while its popup is
        // closing. Keep that value separate from whether it is readable yet;
        // a synthetic `true` would compare unequal to the eventual answer.
        return row?.public.filled ? JSON.stringify(row.raw) : null;
      };
      // Kept: the field holds a value at the end, the one the write produced or
      // one that appeared late. An empty field was not kept. The field is read
      // again only after the page changed; a quiet page needs no scan.
      let dirty = false;
      const observer = new doc.defaultView.MutationObserver(() => {
        dirty = true;
      });
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      const first = read(),
        kept = (now) =>
          readable && now !== null && (now === first || first === null);
      let last = first,
        since = Date.now();
      try {
        const done = await JobsDOMWait.until(
          () => {
            if (!act().live(canProceed)) return { cancelled: true };
            if (dirty) {
              dirty = false;
              const wasReadable = readable;
              const now = read();
              if (now !== last || readable !== wasReadable) {
                last = now;
                since = Date.now();
                return null;
              }
            }
            return Date.now() - since >= quiet && (readable || last === null)
              ? { kept: kept(last) }
              : null;
          },
          { root: doc, timeout, interval: 50 },
        );
        const result = done ? done.kept === true : kept(last);
        note(
          "auto_control_result",
          node,
          JSON.stringify({
            component: row?.public.component,
            completion: row?.public.completion || "detached",
          }),
        );
        return { kept: result, row };
      } finally {
        observer.disconnect();
      }
    }
    const held = async (root, node, options) =>
      (await hold(root, node, options)).kept;
    // The page has stopped changing (late validation, re-render) for a quiet
    // interval; bounded, never an error.
    function quiet(root, { interval = 150, timeout = 1500 } = {}) {
      const view = (root.ownerDocument || root).defaultView;
      return new Promise((resolve) => {
        let timer;
        const done = () => {
          observer.disconnect();
          view.clearTimeout(timer);
          view.clearTimeout(limit);
          resolve(undefined);
        };
        const observer = new view.MutationObserver(() => {
          view.clearTimeout(timer);
          timer = view.setTimeout(done, interval);
        });
        observer.observe(root, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        const limit = view.setTimeout(done, timeout);
        timer = view.setTimeout(done, interval);
      });
    }
    // A binding's field: a CSS selector, an XPath (starting with / or (), or a
    // function returning the node.
    function locate(find) {
      if (typeof find === "function") return find();
      const root = active?.root || document;
      if (!/^\(*\.?\//.test(find)) return root.querySelector(find);
      const doc = root.ownerDocument || root;
      const matches = doc.evaluate(
        find,
        root,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      // Absolute XPath expressions retain their document semantics. Filter all
      // results instead of silently choosing another form's first match.
      for (let i = 0; i < matches.snapshotLength; i++) {
        const node = matches.snapshotItem(i);
        if (inScope(root, node)) return node;
      }
      return null;
    }
    // Bindings locate a field and name its Profile fact; answers supports a
    // multi-value field (skills). after waits for fields revealed by this write.
    // Only replace:true may overwrite an existing value.
    async function bind(
      bindings,
      { canProceed = active?.canProceed || (() => true) } = {},
    ) {
      canProceed = act().guard(canProceed);
      const results = [];
      for (const binding of bindings) {
        if (!act().live(canProceed)) break;
        let node = null;
        try {
          node = locate(binding.find);
        } catch {
          node = null;
        }
        if (!node || !inScope(active?.root, node)) {
          results.push(null);
          continue;
        }
        if (active?.canFill?.(node) === false) {
          note("auto_binding_disabled", node, binding.name);
          results.push(null);
          continue;
        }
        if (binding.whenEmpty) {
          const reader = JobsControlFields.create(document);
          const rows = reader.scan();
          const occupied = [binding.whenEmpty].flat().some((find) => {
            let other;
            try {
              other = locate(find);
            } catch {
              return true;
            }
            if (!other) return false;
            const row = rows.find(
              (row) => row.node === other || row.group?.includes(other),
            );
            return (
              !row ||
              row.public.filled ||
              row.public.commitState === "unconfirmed"
            );
          });
          if (occupied) {
            note("auto_binding_preserved_existing", node, binding.name);
            results.push(null);
            continue;
          }
        }
        if (binding.topic) {
          // Structure only. The topic registry decides from the actual complete
          // caption; identifying a consent control never supplies agreement.
          node.dataset.jobsTopic = String(binding.topic);
          results.push(null);
          continue;
        }
        const answer =
          binding.answers ||
          (typeof binding.answer === "function"
            ? await binding.answer(node)
            : binding.answer);
        if (
          binding.checked === undefined &&
          (answer == null || answer === "")
        ) {
          results.push(null);
          continue;
        }
        const result = await write(
          node,
          binding.checked !== undefined
            ? { checked: binding.checked }
            : { specs: binding.answers || [answer] },
          {
            decider: "binding:" + binding.name,
            replace: binding.replace === true,
            canProceed,
          },
        );
        if (!result.ok)
          note(
            "auto_binding_failed",
            node,
            binding.name + ": " + result.reason.slice(0, 120),
          );
        results.push(result.ok ? result.node : null);
        if (result.ok && binding.after) await binding.after(node, canProceed);
      }
      return results;
    }
    // One adapter section (contact, history, disclosures...). A failing section
    // is recorded and the fill continues; the step's final readiness check, not
    // the section, decides whether it may navigate. A replaced page still stops.
    async function section(name, run, { canProceed = () => true } = {}) {
      try {
        return await run();
      } catch (error) {
        if (!act().live(canProceed)) throw error;
        note(
          "auto_section_failed",
          null,
          name + ": " + String(error?.message || error).slice(0, 120),
        );
        return null;
      }
    }
    // A step is ready when its fields stop changing: the same controls for a
    // short quiet interval. Replaces fixed delays; bounded, never an error.
    async function settled(
      root,
      { quiet = 300, timeout = 3000, canProceed = () => true } = {},
    ) {
      if (!root?.isConnected) return false;
      const reader = JobsControlFields.create(
        root.ownerDocument || root,
        () => root,
      );
      const shape = () =>
        reader
          .scan()
          .map((row) => row.public.id + ":" + row.public.type)
          .join("|");
      let previous = null,
        since = Date.now();
      const done = await JobsDOMWait.until(
        () => {
          if (!act().live(canProceed) || !root.isConnected)
            return { cancelled: true };
          const current = shape();
          if (current !== previous || !current) {
            previous = current;
            since = Date.now();
            return null;
          }
          return Date.now() - since >= quiet ? { ready: true } : null;
        },
        { root: root.ownerDocument || root, timeout, interval: 100 },
      );
      return done?.ready === true;
    }
    // Answers a person typed for questions the rules did not answer, for the
    // original saved-response capture at submit.
    function unresolved(root, answered) {
      if (!root?.isConnected) return [];
      const reader = JobsControlFields.create(
        root.ownerDocument || root,
        () => root,
      );
      return reader
        .scan()
        .filter((row) => !answered.has(row.node))
        .map((row) => reader.response(row))
        .filter(Boolean);
    }
    JobsFormPipeline = Object.freeze({
      beginEntry(scope) {
        if (
          !act().allowed() ||
          !scope?.isConnected ||
          (active && !inScope(active.root, scope))
        )
          return false;
        JobsControlFields.beginEntry(scope);
        return true;
      },
      bind,
      write,
      unresolved,
      settled,
      held,
      quiet,
      section,
      within,
      live,
      ledger,
      ledgerFor,
      release: (root) => ledgers.delete(root),
      answered,
    });
  })();
}
