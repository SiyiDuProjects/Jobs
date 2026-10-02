import { useId, useState, type ReactNode } from "react";
import {
  Button,
  Description,
  Dropdown,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  TextArea,
  TextField,
  Switch,
} from "@heroui/react";
import { DropZone } from "@heroui-pro/react";
import { store } from "./store";

export function Field({
  label,
  value,
  onChange,
  type = "text",
  multiline = false,
  required = false,
  maxLength,
  description,
}: {
  label: string;
  value?: string | number;
  onChange: (v: string) => void;
  type?: string;
  multiline?: boolean;
  required?: boolean;
  maxLength?: number;
  description?: string;
}) {
  return (
    <TextField
      value={String(value ?? "")}
      onChange={onChange}
      isRequired={required}
      type={type as any}
      className="w-full"
      maxLength={maxLength}
    >
      <Label>{label}</Label>
      {multiline ? <TextArea rows={4} /> : <Input />}
      {description && <Description>{description}</Description>}
      <FieldError />
    </TextField>
  );
}
export function Choice({
  label,
  value,
  onChange,
  options,
  hideLabel = false,
  disabled = false,
}: {
  label: string;
  value?: string;
  onChange: (v: string) => void;
  options: Record<string, string>;
  hideLabel?: boolean;
  disabled?: boolean;
}) {
  return (
    <Select
      aria-label={label}
      value={value || null}
      onChange={(v) => onChange(String(v ?? ""))}
      isDisabled={disabled}
      placeholder="Select one…"
    >
      {!hideLabel && <Label>{label}</Label>}
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {Object.entries(options).map(([key, label]) => (
            <ListBox.Item id={key} key={key} textValue={label}>
              {label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
export function Toggle({
  label,
  value,
  onChange,
  description,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  description?: string;
}) {
  return (
    <Switch isSelected={value} onChange={onChange}>
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        {label}
      </Switch.Content>
      {description && <Description>{description}</Description>}
    </Switch>
  );
}
export function Menu({
  label = "Manage",
  ariaLabel,
  items,
}: {
  label?: string;
  ariaLabel?: string;
  items: {
    id: string;
    label: string;
    action: () => void;
    danger?: boolean;
    disabled?: boolean;
  }[];
}) {
  return (
    <Dropdown>
      <Button
        variant="ghost"
        aria-label={ariaLabel || label}
        isIconOnly={!!ariaLabel}
      >
        {label}
      </Button>
      <Dropdown.Popover>
        <Dropdown.Menu
          aria-label={label}
          onAction={(key) => items.find((x) => x.id === key)?.action()}
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
  );
}
export function Dialog({
  title,
  children,
  onClose,
  onSave,
  saveLabel = "Save",
  danger = false,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSave?: () => Promise<unknown>;
  saveLabel?: string;
  danger?: boolean;
  wide?: boolean;
}) {
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    id = useId();
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Modal.Backdrop isDismissable={false}>
        <Modal.Container>
          <Modal.Dialog className={wide ? "sm:max-w-3xl" : "sm:max-w-lg"}>
            <Modal.CloseTrigger isDisabled={saving} />
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <form
              id={id}
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Modal.Body className="max-h-[65vh] overflow-y-auto space-y-5">
                {children}
                {error && (
                  <p role="alert" className="text-danger text-sm">
                    {error}
                  </p>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="secondary"
                  isDisabled={saving}
                  onPress={onClose}
                >
                  Cancel
                </Button>
                {onSave && (
                  <Button
                    type="submit"
                    isPending={saving}
                    variant={danger ? "danger" : "primary"}
                  >
                    {saveLabel}
                  </Button>
                )}
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
export function Upload({
  label,
  accept,
  onFile,
}: {
  label: string;
  accept: string;
  onFile: (file: File) => Promise<unknown>;
}) {
  const [file, setFile] = useState(""),
    [error, setError] = useState("");
  const receive = async (f: File) => {
    setFile(f.name);
    setError("");
    try {
      await onFile(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <DropZone>
      <DropZone.Area
        onDrop={async (e) => {
          for (const item of e.items)
            if (item.kind === "file") {
              await receive(await item.getFile());
              break;
            }
        }}
      >
        <DropZone.Label>{label}</DropZone.Label>
        <DropZone.Description>{file || accept}</DropZone.Description>
        <DropZone.Trigger>Select file</DropZone.Trigger>
        <DropZone.Input
          accept={accept}
          onSelect={(files) => {
            if (files[0]) void receive(files[0]);
          }}
        />
      </DropZone.Area>
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
    </DropZone>
  );
}
export function download(
  name: string,
  content: string | Blob,
  type = "application/json",
) {
  const url = URL.createObjectURL(
    content instanceof Blob ? content : new Blob([content], { type }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const act = (operation: Promise<unknown>) => {
  void operation.catch(store.report);
};
