import { Select as HeroSelect, ListBox } from "@heroui/react";
export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Record<string, string>;
  onChange: (v: string) => void;
}) {
  return (
    <HeroSelect
      className="w-full min-w-0"
      aria-label={label}
      variant="secondary"
      value={value || "__all__"}
      onChange={(key) => {
        if (key !== null) onChange(key === "__all__" ? "" : String(key));
      }}
    >
      <HeroSelect.Trigger>
        <HeroSelect.Value />
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <HeroSelect.Popover placement="bottom start" offset={6}>
        <ListBox aria-label={label}>
          {Object.entries(options).map(([v, n]) => (
            <ListBox.Item
              key={v || "__all__"}
              id={v || "__all__"}
              textValue={n}
            >
              {n}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  );
}
