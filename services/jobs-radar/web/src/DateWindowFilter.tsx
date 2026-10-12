import { useContext, useState } from "react";
import { Button, Popover, RangeCalendar } from "@heroui/react";
import {
  getLocalTimeZone,
  isSameMonth,
  today,
  type CalendarDate,
} from "@internationalized/date";
import { I18nProvider, RangeCalendarStateContext } from "react-aria-components";
import { dateWindowLabel, readDateWindow } from "./date-window";

export function DateWindowFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const maximum = today(getLocalTimeZone());
  const selected = readDateWindow(value);
  const label = dateWindowLabel(value);
  return (
    <I18nProvider locale="zh-CN">
      <Popover isOpen={open} onOpenChange={setOpen}>
        <Button variant="secondary" size="sm" aria-label={`收录时间：${label}`}>
          <span>{label}</span>
          <span aria-hidden="true">▾</span>
        </Button>
        <Popover.Content placement="bottom start">
          <Popover.Dialog aria-label="收录日期">
            <div className="flex gap-1 px-3 pt-2 pb-1" aria-label="快捷日期">
              {[
                ["today", "今天"],
                ["last7", "近 7 天"],
                ["", "全部时间"],
              ].map(([key, text]) => (
                <Button
                  key={key}
                  slot={null}
                  size="sm"
                  variant="secondary"
                  aria-pressed={value === key}
                  onPress={() => {
                    onChange(key);
                    setOpen(false);
                  }}
                >
                  {text}
                </Button>
              ))}
            </div>
            <RangeCalendar
              aria-label="选择开始和结束日期"
              value={selected}
              maxValue={maximum}
              onChange={(range) => {
                if (
                  range &&
                  range.start.compare(range.end) <= 0 &&
                  range.end.compare(maximum) <= 0
                ) {
                  onChange(`${range.start}/${range.end}`);
                  setOpen(false);
                }
              }}
            >
              <RangeCalendar.Header>
                <RangeCalendar.YearPickerTrigger>
                  <RangeCalendar.YearPickerTriggerHeading />
                  <RangeCalendar.YearPickerTriggerIndicator />
                </RangeCalendar.YearPickerTrigger>
                <RangeCalendar.NavButton slot="previous" />
                <RangeCalendar.NavButton slot="next" />
              </RangeCalendar.Header>
              <RangeCalendar.Grid>
                <RangeCalendar.GridHeader>
                  {(day) => (
                    <RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>
                  )}
                </RangeCalendar.GridHeader>
                <RangeCalendar.GridBody>
                  {(date) => <DateCell date={date} />}
                </RangeCalendar.GridBody>
              </RangeCalendar.Grid>
              <RangeCalendar.YearPickerGrid>
                <RangeCalendar.YearPickerGridBody>
                  {({ year }) => <RangeCalendar.YearPickerCell year={year} />}
                </RangeCalendar.YearPickerGridBody>
              </RangeCalendar.YearPickerGrid>
            </RangeCalendar>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </I18nProvider>
  );
}

// React Aria disables padding days solely for being outside the displayed month.
// Use the same range state for those visible days without moving the month when
// the first boundary is chosen. All in-month cells retain the native behavior.
function DateCell({ date }: { date: CalendarDate }) {
  const state = useContext(RangeCalendarStateContext)!;
  if (isSameMonth(date, state.visibleRange.start))
    return <RangeCalendar.Cell date={date} />;
  const range = state.highlightedRange;
  const selected =
    !!range && date.compare(range.start) >= 0 && date.compare(range.end) <= 0;
  const disabled =
    state.isDisabled ||
    state.isReadOnly ||
    state.isInvalid(date) ||
    state.isCellUnavailable(date);
  const label = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "full",
    timeZone: state.timeZone,
  }).format(date.toDate(state.timeZone));
  return (
    <td role="gridcell" aria-selected={selected} className="p-0 text-center">
      <Button
        slot={null}
        size="sm"
        variant={selected ? "secondary" : "ghost"}
        className="size-9 min-w-0 p-0 text-muted"
        aria-label={label}
        isDisabled={disabled}
        onPress={() => state.selectDate(date)}
        onKeyDown={(event) => {
          const step = {
            ArrowLeft: -1,
            ArrowRight: 1,
            ArrowUp: -7,
            ArrowDown: 7,
          }[event.key];
          if (step) {
            event.preventDefault();
            event.stopPropagation();
            state.setFocusedDate(date.add({ days: step }));
            state.setFocused(true);
          }
        }}
      >
        {date.day}
      </Button>
    </td>
  );
}
