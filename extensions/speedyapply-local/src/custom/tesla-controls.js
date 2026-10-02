import { JobsPageActions } from "./page-actions.js";
import { JobsControlFields } from "./control-fields.js";
import { JobsPlatformConfig } from "./platform-config.js";
import { JobsDOMWait } from "./dom-wait.js";
export var JobsTeslaControls;
let initialized = false;
export function initializeTeslaControls() {
  if (initialized) return;
  initialized = true;
  // Tesla's read-only date input opened through its own month calendar.
  // Only complete calendar dates are written; a month/year is never padded.
  (() => {
    const text = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const act = () => JobsPageActions;
    const calendarDate = (value) => JobsControlFields.calendarDate(value);
    function box(node) {
      return JobsPlatformConfig.detect(node.ownerDocument).teslaCalendar &&
        node.matches?.("input.tds-form-input-date[readonly]")
        ? node.closest('.tds-form-item[variant="date"]')
        : null;
    }
    const isControl = (node) => !!box(node);
    function value(node) {
      const shown = text(node.value),
        match = shown.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
      return (
        calendarDate(shown)?.iso ||
        (match
          ? calendarDate(
              `${match[3]}-${String(monthNames.indexOf(match[1]) + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`,
            )?.iso
          : null) ||
        shown
      );
    }
    // The same facts the common scanner read for this input before it became a
    // component: its own label reader; required and invalid stay common.
    function facts(node, ctx) {
      const calendar = box(node);
      if (!calendar) return null;
      return {
        type: "date",
        value: value(node),
        question: ctx?.labelled(node),
        supported: !!calendar.querySelector(".tds-date-picker"),
        readonly: true,
      };
    }
    async function choose(
      node,
      answer,
      { canProceed = /** @type {() => boolean} */ (() => true) } = {},
    ) {
      canProceed = act().guard(canProceed);
      const date = calendarDate(answer),
        calendar = box(node);
      if (!date || !calendar)
        throw Error("A complete calendar date is required");
      const current = () =>
        act().live(canProceed) &&
        node.isConnected &&
        box(node) === calendar &&
        !node.disabled;
      const shownMonth = () => {
        const match = text(
          calendar.querySelector(".tds-date-picker-month > label")?.textContent,
        ).match(/^([A-Za-z]+) (\d{4})$/);
        const month = match ? monthNames.indexOf(match[1]) : -1;
        return month < 0 ? null : Number(match[2]) * 12 + month;
      };
      const goal = date.year * 12 + date.month - 1;
      if (
        !current() ||
        shownMonth() === null ||
        Math.abs(goal - shownMonth()) > 36
      )
        throw Error(
          "Calendar month is unavailable or outside the supported range",
        );
      if (calendar.querySelector(".tds-tooltip--closed")) {
        const buttons = calendar.querySelectorAll(
          ".tds-form-input-trailing > button",
        );
        if (buttons.length !== 1) throw Error("Calendar opener is ambiguous");
        act().click(buttons[0]);
      }
      if (
        !(await JobsDOMWait.until(
          () => current() && !calendar.querySelector(".tds-tooltip--closed"),
          { root: calendar, timeout: 1200 },
        ))
      )
        throw Error("Calendar did not open");
      for (let step = 0; shownMonth() !== goal && step < 36; step++) {
        const before = shownMonth(),
          buttons = calendar.querySelectorAll(
            ".tds-date-picker-month > button",
          );
        if (!current() || before === null || buttons.length !== 2)
          throw Error("Calendar changed during selection");
        const direction = goal > before ? 1 : -1,
          button = buttons[direction > 0 ? 1 : 0];
        if (button.disabled || button.getAttribute("aria-disabled") === "true")
          throw Error("Calendar month is disabled");
        act().click(button);
        if (
          !(await JobsDOMWait.until(
            () => current() && shownMonth() === before + direction,
            { root: calendar, timeout: 1200 },
          ))
        )
          throw Error("Calendar month did not advance");
      }
      const days = [
        ...calendar.querySelectorAll(
          ".tds-date-picker-days-grid button.tds-day:not(.tds-day--not-this-month)",
        ),
      ].filter((day) => text(day.textContent) === String(date.day));
      if (
        !current() ||
        shownMonth() !== goal ||
        days.length !== 1 ||
        days[0].disabled ||
        days[0].getAttribute("aria-disabled") === "true"
      )
        throw Error("Calendar day is unavailable");
      act().click(days[0]);
      if (
        !(await JobsDOMWait.until(() => current() && value(node) === date.iso, {
          root: calendar,
          timeout: 1200,
        }))
      )
        throw Error("Calendar selection was not committed");
      return node;
    }
    // The only public component transaction. Selection belongs to the caller;
    // this component exposes page facts, commits the selection and reads it back.
    async function chooseFrom(node, pick, options = {}) {
      return choose(node, pick([]), options);
    }
    JobsTeslaControls = Object.freeze({ isControl, chooseFrom, facts, value });
  })();
}
