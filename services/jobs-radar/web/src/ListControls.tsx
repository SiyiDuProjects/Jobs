import { useState, type ReactNode } from "react";
import {
  Button,
  Dropdown,
  Input,
  Label,
  Popover,
  TextField,
  Tooltip,
} from "@heroui/react";

export type MenuAction = {
  id: string;
  label: string;
  onAction: () => void;
  danger?: boolean;
  disabled?: boolean;
};
export function ActionMenu({
  label = "更多操作",
  items,
}: {
  label?: string;
  items: MenuAction[];
}) {
  return (
    <Tooltip delay={400}>
      <Dropdown>
        <Button size="sm" variant="secondary" isIconOnly aria-label={label}>
          ⋯
        </Button>
        <Dropdown.Popover>
          <Dropdown.Menu
            aria-label={label}
            onAction={(key) =>
              items.find((item) => item.id === key)?.onAction()
            }
          >
            {items.map((item) => (
              <Dropdown.Item
                key={item.id}
                id={item.id}
                textValue={item.label}
                variant={item.danger ? "danger" : undefined}
                isDisabled={item.disabled}
              >
                <Label>{item.label}</Label>
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

function Search({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TextField
        aria-label={label}
        value={value}
        onChange={onChange}
        className="list-search-desktop"
      >
        <Input placeholder="搜索公司或岗位" variant="secondary" />
      </TextField>
      <div className="list-search-mobile">
        <Popover isOpen={open} onOpenChange={setOpen}>
          <Button size="sm" variant="secondary" isIconOnly aria-label={label}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 5 5" />
            </svg>
          </Button>
          <Popover.Content placement="bottom end">
            <Popover.Dialog aria-label={label} className="p-3">
              <TextField aria-label={label} value={value} onChange={onChange}>
                <Input
                  autoFocus
                  placeholder="搜索公司或岗位"
                  variant="secondary"
                />
              </TextField>
              {value && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onPress={() => onChange("")}
                >
                  清空搜索
                </Button>
              )}
            </Popover.Dialog>
          </Popover.Content>
        </Popover>
      </div>
    </>
  );
}

export function ListToolbar({
  navigation,
  totals,
  filters,
  date,
  query,
  onQuery,
  menu,
  searchLabel = "搜索公司或岗位",
}: {
  navigation: ReactNode;
  totals: ReactNode;
  filters?: ReactNode;
  date?: ReactNode;
  query: string;
  onQuery: (value: string) => void;
  menu: MenuAction[];
  searchLabel?: string;
}) {
  return (
    <div className="list-toolbar">
      <div className="list-views">{navigation}</div>
      <div className="list-totals">{totals}</div>
      <div className="list-filters">{filters}</div>
      <div className="list-date">{date}</div>
      <div className="list-search">
        <Search value={query} onChange={onQuery} label={searchLabel} />
      </div>
      <div className="list-more">
        <ActionMenu label="列表更多操作" items={menu} />
      </div>
    </div>
  );
}

export function ListPagination({
  page,
  pages,
  busy = false,
  onPage,
}: {
  page: number;
  pages: number;
  busy?: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <nav className="list-pagination" aria-label="列表翻页">
      <span className="text-muted">
        第 {page} / {pages} 页
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={page <= 1 || busy}
          onPress={() => onPage(page - 1)}
        >
          上一页
        </Button>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={page >= pages || busy}
          onPress={() => onPage(page + 1)}
        >
          下一页
        </Button>
      </div>
    </nav>
  );
}
