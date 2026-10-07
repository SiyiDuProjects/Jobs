// Read-only page-world acknowledgement of Ashby's existing save, never a new
// request. savedValue is the initial prop and can remain empty after saving.
// Apollo's mutation ref holds the latest response even on an alternate fiber.
// No application callbacks are invoked and no answer text leaves this function.
export async function readAshbyCommit(path, phase, timeout = 8000) {
  if (location.hostname !== "jobs.ashbyhq.com") return { state: "unsupported" };
  const entries = [...document.querySelectorAll("[data-field-path]")].filter(
    (node) => node.getAttribute("data-field-path") === path,
  );
  if (entries.length !== 1) return { state: "unsupported" };
  const entry = entries[0];
  const file = /** @type {HTMLInputElement|null} */ (
    entry.querySelector('input[type="file"]')
  );
  const fieldValue = (item) =>
    item?.fieldValue?.value ?? item?.fieldValue?.filename;
  const text = /** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (
    entry.querySelector(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="file"]),textarea',
    )
  );
  const yesno = entry.querySelector(".ashby-application-form-input-yesno");
  const props = (node) => {
    const keys = Object.keys(node).filter((key) =>
      key.startsWith("__reactProps$"),
    );
    return keys.length === 1 ? node[keys[0]] : null;
  };
  const visible = () =>
    file
      ? file.files?.[0]?.name
      : yesno
        ? (() => {
            const selected = yesno.querySelectorAll(
              '[data-option][aria-pressed="true"]',
            );
            return selected.length === 1
              ? selected[0].getAttribute("data-option") === "yes"
              : undefined;
          })()
        : text?.value;
  if (!file && !yesno && !text) return { state: "unsupported" };
  const expected = visible(),
    url = location.href;
  // This function is serialized into MAIN and must be self-contained. Compare
  // calendar days only for Ashby's date widget; never parse ordinary text or
  // use Date/UTC conversions that can shift a date across time zones.
  const isCalendar = text?.matches(".ashby-application-form-input-date");
  const calendarDay = (value) => {
    if (typeof value !== "string") return null;
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/),
      us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!iso && !us) return null;
    const [year, month, day] = iso
      ? [+iso[1], +iso[2], +iso[3]]
      : [+us[3], +us[1], +us[2]];
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1])
      return null;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  const expectedSaved = isCalendar ? calendarDay(expected) : expected;
  if (isCalendar && expected && !expectedSaved)
    return { state: "invalid-date" };
  if (phase !== "upload-start" && (expected == null || expected === ""))
    return { state: "empty" };
  const started = Date.now();
  for (;;) {
    if (!entry.isConnected || location.href !== url || visible() !== expected)
      return { state: "changed" };
    // Current host props confirm that React rendered the draft before blur.
    const children = [props(entry)?.children].flat();
    const matches = children.filter(
      (child) =>
        child?.props?.field?.path === path &&
        Object.hasOwn(child.props, file ? "savedFile" : "savedValue"),
    );
    if (matches.length !== 1) return { state: "unsupported" };
    const rendered =
      file || yesno ? expected : (props(text)?.value ?? props(text)?.children);
    if (["draft", "saved", "upload-start"].includes(phase)) {
      const host = file || text || yesno;
      const key = Object.keys(host).find((key) =>
        key.startsWith("__reactFiber$"),
      );
      let fiber = host[key],
        mutation;
      for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber.return) {
        if (fiber.memoizedProps?.field?.path !== path) continue;
        for (
          let hook = fiber.memoizedState, count = 0;
          hook && count < 40;
          count++, hook = hook.next
        ) {
          const ref = hook.memoizedState?.current;
          if (
            ref?.mutation?.definitions?.some(
              (item) =>
                item.kind === "OperationDefinition" &&
                item.name?.value ===
                  (file ? "ApiSetFormValueToFile" : "ApiSetFormValue"),
            )
          ) {
            mutation = ref.result;
            break;
          }
        }
        break;
      }
      if (!mutation) return { state: "unsupported" };
      const uploadsKey = Symbol.for("jobs.ashby.upload-observations.v1");
      if (phase === "upload-start") {
        if (!file || file.disabled) return { state: "unsupported" };
        const uploads = (window[uploadsKey] ||= new WeakMap());
        uploads.set(entry, mutation.data?.setFormValueToFile);
        return { state: "confirmed" };
      }
      if (mutation.error) return { state: "rejected" };
      // A delayed bridge may arrive after the debounce already began saving.
      // Let that request finish before blur can start another save.
      if (phase === "draft" && rendered === expected && !mutation.loading)
        return { state: "confirmed" };
      if (
        phase === "saved" &&
        mutation.called &&
        !mutation.loading &&
        !file?.disabled
      ) {
        const form = file
          ? mutation.data?.setFormValueToFile
          : mutation.data?.setFormValue;
        const fields = form?.sections?.flatMap(
          (section) => section.fieldEntries || [],
        );
        const entryId = entry.getAttribute("data-field-entry-id");
        const saved = fields?.filter((item) => item.id === entryId);
        if (saved?.length !== 1) return { state: "unsupported" };
        const uploadStarted = file && window[uploadsKey]?.has(entry);
        const freshUpload =
          !uploadStarted || window[uploadsKey].get(entry) !== form;
        if (fieldValue(saved[0]) === expectedSaved && freshUpload) {
          // Per-document memory only. A later whole-form response must retain
          // earlier acknowledgements. Never let an older field's cached receipt
          // undo the latest observation during the final readiness check.
          const key = Symbol.for("jobs.ashby.save-observations.v1");
          const sessions = (window[key] ||= new Map());
          let session = sessions.get(form.id);
          if (!session) {
            session = { responses: new WeakSet(), values: new Map(), fields };
            sessions.set(form.id, session);
          }
          if (!session.responses.has(form)) {
            session.responses.add(form);
            session.fields = fields;
          }
          for (const [id, previous] of session.values) {
            if (
              id !== entryId &&
              fieldValue(session.fields.find((item) => item.id === id)) !==
                previous
            )
              return { state: "lost-previous" };
          }
          if (
            fieldValue(session.fields.find((item) => item.id === entryId)) !==
            expectedSaved
          )
            return { state: "lost-current" };
          session.values.set(entryId, expectedSaved);
          return { state: "confirmed" };
        }
      } else if (
        !file &&
        !mutation.called &&
        matches[0].props.savedValue === expectedSaved
      ) {
        return { state: "confirmed" };
      }
    }
    if (Date.now() - started >= timeout) return { state: "timeout" };
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
