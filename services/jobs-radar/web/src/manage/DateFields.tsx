import { useEffect, useRef, useState } from "react";
import {
  Calendar,
  DateField,
  DatePicker,
  Description,
  FieldError,
  Label,
  ListBox,
  NumberField,
  Select,
} from "@heroui/react";
import { parseDate } from "@internationalized/date";
import { I18nProvider } from "react-aria-components";

type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  description?: string;
};

export function CalendarField({
  label,
  value,
  onChange,
  required,
  description,
}: Props) {
  let selected = null;
  try {
    selected = value ? parseDate(value) : null;
  } catch {
    /* Keep incomplete dates blank. */
  }
  return (
    <I18nProvider locale="zh-CN">
      <DatePicker
        className="w-full min-w-0"
        value={selected}
        onChange={(date) => onChange(date?.toString() || "")}
        isRequired={required}
      >
        <Label>{label}</Label>
        <DateField.Group fullWidth variant="secondary">
          <DateField.Input>
            {(segment) => <DateField.Segment segment={segment} />}
          </DateField.Input>
          <DateField.Suffix>
            <DatePicker.Trigger>
              <DatePicker.TriggerIndicator />
            </DatePicker.Trigger>
          </DateField.Suffix>
        </DateField.Group>
        {description && <Description>{description}</Description>}
        <FieldError />
        <DatePicker.Popover>
          <Calendar aria-label={label}>
            <Calendar.Header>
              <Calendar.YearPickerTrigger>
                <Calendar.YearPickerTriggerHeading />
                <Calendar.YearPickerTriggerIndicator />
              </Calendar.YearPickerTrigger>
              <Calendar.NavButton slot="previous" />
              <Calendar.NavButton slot="next" />
            </Calendar.Header>
            <Calendar.Grid>
              <Calendar.GridHeader>
                {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
              </Calendar.GridHeader>
              <Calendar.GridBody>
                {(date) => <Calendar.Cell date={date} />}
              </Calendar.GridBody>
            </Calendar.Grid>
            <Calendar.YearPickerGrid>
              <Calendar.YearPickerGridBody>
                {({ year }) => <Calendar.YearPickerCell year={year} />}
              </Calendar.YearPickerGridBody>
            </Calendar.YearPickerGrid>
          </Calendar>
        </DatePicker.Popover>
      </DatePicker>
    </I18nProvider>
  );
}

// HeroUI dates require a day. Use its number/select controls for genuine month precision.
export function MonthField({
  label,
  value,
  onChange,
  required,
  description,
}: Props) {
  const [year, setYear] = useState(value ? Number(value.slice(0, 4)) : NaN);
  const [month, setMonth] = useState(value.slice(5, 7));
  const lastValue = useRef(value);
  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    setYear(value ? Number(value.slice(0, 4)) : NaN);
    setMonth(value.slice(5, 7));
  }, [value]);
  const commit = (y: number, m: string) => {
    lastValue.current =
      Number.isInteger(y) && y >= 1000 && y <= 9999 && m ? `${y}-${m}` : "";
    onChange(lastValue.current);
  };
  return (
    <fieldset className="w-full min-w-0 space-y-1.5">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          variant="secondary"
          aria-label={`${label}年份`}
          fullWidth
          value={year}
          minValue={1000}
          maxValue={9999}
          isRequired={required}
          formatOptions={{ useGrouping: false }}
          onChange={(y) => {
            setYear(y);
            commit(y, month);
          }}
        >
          <NumberField.Group>
            <NumberField.Input placeholder="年" />
          </NumberField.Group>
        </NumberField>
        <Select
          variant="secondary"
          aria-label={`${label}月份`}
          className="w-full min-w-0"
          value={month || null}
          placeholder="月"
          isRequired={required}
          onChange={(m) => {
            const next = String(m || "");
            setMonth(next);
            commit(year, next);
          }}
        >
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {Array.from({ length: 12 }, (_, i) =>
                String(i + 1).padStart(2, "0"),
              ).map((m) => (
                <ListBox.Item key={m} id={m} textValue={`${Number(m)} 月`}>
                  {Number(m)} 月<ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
      {description && <p className="text-sm text-muted">{description}</p>}
    </fieldset>
  );
}
