export var JobsReproCase;
let initialized = false;
export function initializeReproCase() {
  if (initialized) return;
  initialized = true;
  (() => {
    const LIMITS = { fields: 5, nodes: 900, depth: 18, bytes: 220000 };
    const tags = new Set(
      "form div span p section fieldset legend label input textarea select option optgroup button a ul ol li table tbody tr td th h1 h2 h3 h4 article main nav output".split(
        " ",
      ),
    );
    const booleans = [
      "required",
      "disabled",
      "multiple",
      "hidden",
      "inert",
      "readonly",
    ];
    const references = [
      "id",
      "for",
      "name",
      "aria-labelledby",
      "aria-describedby",
      "aria-errormessage",
      "aria-controls",
      "aria-owns",
      "data-uxi-multiselect-id",
      "data-uxi-popup-anchor",
      "data-associated-widget",
    ];
    const structure = [
      "role",
      "type",
      "aria-required",
      "aria-invalid",
      "aria-expanded",
      "aria-selected",
      "aria-checked",
      "aria-disabled",
      "aria-hidden",
      "aria-haspopup",
      "aria-multiselectable",
      "data-automation-id",
      "icimsdropdown-enabled",
      "icimsdropdown-search",
      "i_required",
      "data-uxi-widget-type",
    ];
    const sensitive =
      /password|passcode|one.?time|verification.?code|social.?security|\bssn\b|credit.?card|验证码|密码/i;
    const normalize = (s) =>
      String(s || "")
        .replace(/\s+/g, " ")
        .trim();
    const bytes = (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length;
    const token = (value) =>
      typeof value === "string" &&
      /^[a-zA-Z][a-zA-Z0-9_.:-]{0,100}$/.test(value)
        ? value
        : null;
    const marker = "data-jobs-repro-target";
    const allowedTag = (tag) =>
      tags.has(tag) || /^[a-z][a-z0-9]*-[a-z0-9-]{1,70}$/.test(tag || "");
    function capture({ report, rows, document: doc }) {
      const failures = (report.fields || []).filter(
        (f) =>
          f.invalid || !["filled", "optional-empty"].includes(f.completion),
      );
      if (!failures.length) return null;
      const symbols = new Map(),
        words = new Map();
      let nodes = 0,
        truncated = false,
        closedRootsUnknown = true;
      const symbol = (raw) => {
        if (!symbols.has(raw))
          symbols.set(raw, "fixture-id-" + (symbols.size + 1));
        return symbols.get(raw);
      };
      const text = (raw) => {
        const value = normalize(raw);
        if (!value) return "";
        if (
          /^(select(?: one)?|choose(?: one)?|search|请选择|选择)(?:\s*[.…]*)?$/i.test(
            value,
          )
        )
          return value;
        // Preserve only generic cues used by the shared reader: required markers
        // and exclusive choice wording. Never retain the original question.
        if (!words.has(value))
          words.set(value, "Fixture text " + (words.size + 1));
        return (
          (/\b(?:check|select|choose) (?:only |exactly )?one\b/i.test(value)
            ? "Select one: "
            : "") +
          words.get(value) +
          (/\bRequired\b/i.test(value) ? " Required" : "") +
          (/\*\s*$/.test(value) ? " *" : "")
        );
      };
      function tree(node, target, depth = 0) {
        if (nodes >= LIMITS.nodes || depth > LIMITS.depth) {
          truncated = true;
          return null;
        }
        if (node.nodeType === 3) {
          nodes++;
          return { text: text(node.textContent) };
        }
        if (node.nodeType !== 1 || !allowedTag(node.localName)) return null;
        if (
          sensitive.test(
            [
              node.getAttribute("type"),
              node.getAttribute("name"),
              node.getAttribute("autocomplete"),
              node.getAttribute("aria-label"),
            ].join(" "),
          )
        )
          return null;
        nodes++;
        const item = { tag: node.localName, attrs: {}, children: [] };
        if (node === target) item.attrs[marker] = "true";
        for (const name of booleans)
          if (node.hasAttribute(name)) item.attrs[name] = "";
        for (const name of references) {
          const value = node.getAttribute(name);
          if (value)
            item.attrs[name] = value.split(/\s+/).map(symbol).join(" ");
        }
        for (const name of structure) {
          const value = node.getAttribute(name);
          if (value && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value))
            item.attrs[name] = value;
        }
        const classes = [...node.classList].filter((v) =>
          /^[a-zA-Z_][a-zA-Z0-9_:-]{0,90}$/.test(v),
        );
        if (classes.length) item.attrs.class = classes.slice(0, 12).join(" ");
        for (const name of ["aria-label", "placeholder", "title"])
          if (node.hasAttribute(name))
            item.attrs[name] = text(node.getAttribute(name));
        const style = doc.defaultView.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden")
          item.hidden = true;
        if (node.localName === "input" || node.localName === "textarea") {
          if (node.type === "checkbox" || node.type === "radio")
            item.checked = !!node.checked;
          else if (node.type === "file")
            item.filePresent = !!node.files?.length;
          else if (node.value)
            item.value =
              {
                date: "2000-01-02",
                month: "2000-01",
                time: "09:00",
                number: "5",
                email: "fixture@example.invalid",
                url: "https://fixture.invalid",
              }[node.type] || "Fixture value";
          if (node.type === "hidden" && node.value)
            item.value = "fixture-selection";
        }
        if (node.localName === "option") {
          item.selected = !!node.selected;
          item.value = node.value ? symbol("option:" + node.value) : "";
          if (
            node.parentElement?.matches(
              ".iCIMS_Forms_MonthInput,.iCIMS_Forms_DayInput",
            ) &&
            node.value === "0"
          )
            item.value = "0";
        }
        if (node.willValidate && !node.validity.valid)
          item.validityInvalid = true;
        if (node.localName !== "textarea")
          item.children = [...node.childNodes]
            .map((n) => tree(n, target, depth + 1))
            .filter(Boolean);
        if (node.shadowRoot)
          item.shadow = [...node.shadowRoot.childNodes]
            .map((n) => tree(n, target, depth + 1))
            .filter(Boolean);
        return item;
      }
      const fields = [],
        ids = new Map();
      for (const failure of failures.slice(0, LIMITS.fields)) {
        const row = rows.find((row) => row.public.id === failure.id);
        if (!row?.node?.isConnected) continue;
        const id = "case-field-" + (fields.length + 1);
        ids.set(failure.id, id);
        // Take the field's existing wrapper, not the whole application document.
        const node = row.node;
        const root =
          node.getRootNode()?.host ||
          (node.matches(".iCIMS_Forms_DateOnlyField") &&
            node.closest(".iCIMS_FieldRow")) ||
          node.closest(
            'fieldset,.ashby-application-form-field-entry,[data-automation-id="formField"],.field,.form-group,.iCIMS_InfoData',
          ) ||
          node.parentElement?.parentElement ||
          node.parentElement ||
          node;
        const portals = [];
        const controls = (node.getAttribute("aria-controls") || "")
          .split(/\s+/)
          .filter(Boolean);
        for (const ref of controls) {
          const p = doc.getElementById(ref);
          if (p && !root.contains(p)) portals.push(tree(p, node));
        }
        const anchor = node.getAttribute("data-uxi-multiselect-id");
        if (anchor)
          for (const p of doc.querySelectorAll(
            "[data-uxi-popup-anchor],[data-associated-widget]",
          ))
            if (
              !root.contains(p) &&
              (p.getAttribute("data-uxi-popup-anchor") === anchor ||
                p.getAttribute("data-associated-widget") === anchor)
            )
              portals.push(tree(p, node));
        fields.push({
          id,
          observed: {
            kind: token(failure.kind) || "unknown",
            component: token(failure.component) || "unknown",
            required: !!failure.required,
            hasValue: !!failure.hasValue,
            invalid: !!failure.invalid,
            completion: token(failure.completion) || "unknown",
          },
          tree: tree(root, node),
          portals: portals.filter(Boolean),
        });
      }
      if (!fields.length) return null;
      const timeline = (report.events || [])
        .filter(
          (e) =>
            ids.has(e.fieldId) ||
            /^(phase|build_info|navigation_observed)$/.test(e.type),
        )
        .slice(-80)
        .map((e) => {
          /** @type {{ms:number,type:string,field?:string,decision?:Record<string,string>,state?:Record<string,Record<string,boolean|number>>}} */
          const entry = {
            ms: Math.max(0, e.at - report.startedAt),
            type: token(e.type) || "unknown",
            ...(ids.has(e.fieldId) ? { field: ids.get(e.fieldId) } : {}),
          };
          if (e.type === "answer_decision") {
            try {
              const d = JSON.parse(e.detail);
              entry.decision = Object.fromEntries(
                ["status", "source", "field", "reason", "inputType"]
                  .filter((k) => token(d[k]))
                  .map((k) => [k, d[k]]),
              );
            } catch {}
          }
          if (/^field_(state_changed|value_lost|detached)$/.test(e.type)) {
            try {
              const d = JSON.parse(e.detail);
              entry.state = {};
              for (const side of ["before", "after"])
                if (d[side])
                  entry.state[side] = Object.fromEntries(
                    [
                      "connected",
                      "hasValue",
                      "invalid",
                      "disabled",
                      "checked",
                      "ariaChecked",
                    ]
                      .filter(
                        (k) =>
                          typeof d[side][k] === "boolean" ||
                          (Number.isInteger(d[side][k]) &&
                            d[side][k] >= 0 &&
                            d[side][k] < 1000),
                      )
                      .map((k) => [k, d[side][k]]),
                  );
            } catch {}
          }
          return entry;
        });
      let build = "unbuilt";
      for (const event of report.events || [])
        if (event.type === "build_info") {
          try {
            const v = JSON.parse(event.detail).build;
            if (/^[a-f0-9]{16}$/.test(v)) build = v;
          } catch {}
        }
      const value = {
        schemaVersion: 1,
        valuePolicy: "synthetic_fixture",
        capturedAt: Date.now(),
        build,
        ats: token(report.ats) || "unknown",
        origin: doc.location.origin,
        fields,
        timeline,
        coverage: {
          truncated: truncated || failures.length > LIMITS.fields,
          nodes,
          closedRootsUnknown,
        },
        limitations: [
          "Original text, identifiers and answer values are replaced with synthetic data.",
          "Only observed field DOM and open shadow roots are retained; unopened options are unavailable.",
          "React handlers, stylesheets, network responses and site validation logic are not recorded.",
          "Replay verifies component reading against this snapshot, not full website behavior or submission.",
        ],
      };
      if (bytes(value) > LIMITS.bytes) throw Error("复现案例超过大小限制");
      return value;
    }
    function validate(value) {
      if (
        !value ||
        value.schemaVersion !== 1 ||
        value.valuePolicy !== "synthetic_fixture" ||
        bytes(value) > LIMITS.bytes ||
        !Array.isArray(value.fields) ||
        !value.fields.length ||
        value.fields.length > LIMITS.fields
      )
        throw Error("Invalid reproduction case");
      if (
        Object.keys(value).some(
          (k) =>
            ![
              "schemaVersion",
              "valuePolicy",
              "capturedAt",
              "build",
              "ats",
              "origin",
              "fields",
              "timeline",
              "coverage",
              "limitations",
            ].includes(k),
        ) ||
        !Array.isArray(value.timeline) ||
        value.timeline.length > 80
      )
        throw Error("Invalid reproduction metadata");
      const origin = new URL(value.origin);
      if (origin.protocol !== "https:" || origin.origin !== value.origin)
        throw Error("Invalid reproduction origin");
      let count = 0;
      const allowedAttrs = new Set([
        ...booleans,
        ...references,
        ...structure,
        "class",
        "aria-label",
        "placeholder",
        "title",
        marker,
      ]);
      function inspect(node, depth = 0) {
        if (!node || ++count > LIMITS.nodes || depth > LIMITS.depth + 1)
          throw Error("Invalid reproduction tree size");
        if (Object.hasOwn(node, "text")) {
          if (
            typeof node.text !== "string" ||
            node.text.length > 150 ||
            Object.keys(node).some((k) => k !== "text")
          )
            throw Error("Invalid fixture text");
          return;
        }
        if (
          !allowedTag(node.tag) ||
          !node.attrs ||
          !Array.isArray(node.children) ||
          Object.keys(node).some(
            (k) =>
              ![
                "tag",
                "attrs",
                "children",
                "shadow",
                "hidden",
                "checked",
                "selected",
                "value",
                "filePresent",
                "validityInvalid",
              ].includes(k),
          )
        )
          throw Error("Invalid fixture element");
        for (const [key, v] of Object.entries(node.attrs))
          if (
            !allowedAttrs.has(key) ||
            typeof v !== "string" ||
            v.length > 1200
          )
            throw Error("Unsafe fixture attribute");
        if (
          node.value !== undefined &&
          (typeof node.value !== "string" || node.value.length > 150)
        )
          throw Error("Invalid fixture value");
        for (const child of [...node.children, ...(node.shadow || [])])
          inspect(child, depth + 1);
      }
      for (const field of value.fields) {
        if (
          !/^case-field-[1-5]$/.test(field.id) ||
          !field.observed ||
          !field.tree ||
          !Array.isArray(field.portals)
        )
          throw Error("Invalid fixture field");
        inspect(field.tree);
        field.portals.forEach((p) => inspect(p));
      }
      return value;
    }
    function mount(doc, field) {
      function node(item) {
        if (Object.hasOwn(item, "text")) return doc.createTextNode(item.text);
        const el = doc.createElement(item.tag);
        for (const [key, value] of Object.entries(item.attrs))
          el.setAttribute(key, value);
        if (item.hidden) el.style.display = "none";
        for (const child of item.children) el.append(node(child));
        if (item.shadow) {
          const shadow = el.attachShadow({ mode: "open" });
          for (const child of item.shadow) shadow.append(node(child));
        }
        if (item.value !== undefined) el.value = item.value;
        if (item.checked !== undefined) el.checked = item.checked;
        if (item.selected !== undefined) el.selected = item.selected;
        if (item.validityInvalid)
          el.setCustomValidity?.("Fixture: observed native validation failure");
        if (item.filePresent)
          Object.defineProperty(el, "files", {
            value: [new doc.defaultView.File(["fixture"], "fixture.txt")],
          });
        return el;
      }
      // validate() must be called for the whole case before mounting untrusted data.
      const root = node(field.tree);
      doc.body.append(root);
      for (const p of field.portals) doc.body.append(node(p));
      return root;
    }
    JobsReproCase = Object.freeze({ capture, validate, mount, LIMITS });
  })();
}
