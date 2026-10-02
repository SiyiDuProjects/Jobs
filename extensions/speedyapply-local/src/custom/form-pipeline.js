import { JobsDiagnostics } from "./diagnostics.js";
import { JobsPageActions } from "./page-actions.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsDOMWait } from "./dom-wait.js";
export var JobsFormPipeline;
let initialized = false;
export function initializeFormPipeline() {
  if (initialized) return;
  initialized = true;
  (() => {
    const note = (type, node, detail) =>
      JobsDiagnostics?.note(type, node, detail);
    const act = () => JobsPageActions;
    let active = null,
      fillTail = Promise.resolve(undefined);
    const ledgers = new WeakMap();
    // A field outlives its element; the scanner owns that rule (JobsControlFields.follow).
    const fieldKey = (row) => JobsControlFields.fieldKey(row);
    const follow = (rows, node, key) =>
      JobsControlFields.follow(rows, node, key);
    const holds = (row, node) =>
      row.node === node || !!row.group?.includes(node);
    // The run's field ledger: one record per field (the scanner's canonical node).
    // A field has at most one decider, the layer whose value it holds; a layer
    // that cannot match or keep its value abstains and the next layer (AI, then
    // the person) decides instead.
    //   state    open | claimed | decided | abstained | omitted
    //   decider  binding:<name> | rule | saved | ai | user
    //   ruled    the rules were asked         aiTried  sent to AI and not obsolete
    //   hint     the rules' decision, for reading the field's options later
    //   confirm  an AI answer must be confirmed
    //   card     {shape, allowEmpty} while the field is on the review card
    function ledger(root) {
      const records = new Map();
      const scan = () =>
        JobsControlFields.create(root.ownerDocument || root, () => root).scan();
      const create = (node, key = null) => {
        const record = {
          node,
          key,
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
        if (records.has(node)) return { record: records.get(node), node };
        rows ??= scan();
        followAll(rows);
        // A radio member or a binding's wrapper maps to the row that owns it.
        const matches = rows.filter(
          (row) => holds(row, node) || node.contains?.(row.node),
        );
        const row = matches.length === 1 ? matches[0] : null,
          canonical = row?.node || node;
        return { record: records.get(canonical) || null, node: canonical, row };
      }
      const book = {
        root,
        // What this run's writes cost (timing diagnostics).
        stats: { writes: 0, ms: 0, heldMs: 0, scans: 0 },
        // A lookup scans only when an earlier record may have lost its element.
        peek(node) {
          if (records.has(node)) return records.get(node);
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
            !(decider === "remote" && replace) &&
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
          record.confirm = true;
          note(
            "auto_decider_abstained",
            record.node,
            decider + ": " + String(reason || "").slice(0, 120),
          );
        },
        // Binding and rule answers are not saved again as the person's own
        // answers, including a field whose element the page has since replaced.
        answered() {
          if ([...records.values()].some((record) => !record.node.isConnected))
            followAll(scan());
          return new Set(
            [...records.values()]
              .filter(
                (record) =>
                  record.state === "decided" &&
                  !["ai", "user"].includes(record.decider),
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
      book?.claim(node, decider, { replace });
      const started = Date.now(),
        scans = JobsControlFields.scans?.() || 0;
      let written = null,
        why = "not committed",
        heldMs = 0;
      try {
        if (answer.checked !== undefined) {
          // A check goes through the field's setter (a widget's own); one radio
          // of a group, or a native input the scanner does not list, is set
          // with the primitive that setter uses.
          const reader = JobsControlFields.create(
            root?.ownerDocument || node.ownerDocument,
            () => root || node.ownerDocument,
            { write: true },
          );
          const row = reader
              .scan()
              .find((row) => row.node === node || row.group?.includes(node)),
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
          const row = reader
            .scan()
            .find((row) => row.node === node || row.group?.includes(node));
          if (!row) throw Error("Field changed before writing");
          await reader.apply(row, answer.value, canProceed, {
            replace,
            source,
            reason,
            decider,
          });
          written = row.node;
        } else {
          written = node;
          for (const spec of answer.specs)
            if (
              !(await JobsControlFields.chooseSpec(node, spec, {
                canProceed,
                replace,
                source,
                decider,
              }))
            )
              written = null;
        }
        const holding = Date.now();
        if (written && root && !(await hold(root, node, { canProceed })).kept) {
          written = null;
          why = "value not kept";
        }
        heldMs = Date.now() - holding;
      } catch (error) {
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
      if (!/^\(*\.?\//.test(find)) return document.querySelector(find);
      return document.evaluate(
        find,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue;
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
        if (!node) {
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
