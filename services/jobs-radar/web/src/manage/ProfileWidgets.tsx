import { useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  Chip,
  CloseButton,
  Input,
  Separator,
  TextField,
} from "@heroui/react";
import { DataGrid, type DataGridColumn } from "@heroui-pro/react";
import { store, useManagement } from "./store";
import { savedResponses } from "./saved-responses";
import {
  assertProfile,
  blankEducation,
  blankJob,
  defaultProfile,
  questionKeywords,
  safeHref,
  type Profile as ProfileData,
  type ProfileRecord,
  type Response,
} from "./model";
import options from "./profile-options.json";
import { ApplicationDetailsCard } from "./ApplicationDetails";
import {
  act,
  Choice,
  Dialog,
  download,
  Field,
  Menu,
  Toggle,
  Upload,
} from "./components";

export function SaveField({
  label,
  value,
  onSave,
  multiline = false,
  autoSave = false,
}: {
  label: string;
  value: string;
  onSave: (v: string) => Promise<unknown>;
  multiline?: boolean;
  autoSave?: boolean;
}) {
  const [draft, setDraft] = useState(value),
    [saving, setSaving] = useState(false);
  const latest = useRef({ draft, value, onSave });
  latest.current = { draft, value, onSave };
  useEffect(() => {
    if (!autoSave || draft === value) return;
    const timer = setTimeout(() => {
      setSaving(true);
      Promise.resolve()
        .then(() => latest.current.onSave(draft))
        .catch(store.report)
        .finally(() => setSaving(false));
    }, 1000);
    return () => clearTimeout(timer);
  }, [draft, autoSave]);
  return (
    <div className="w-full space-y-2">
      <Field
        label={label}
        value={draft}
        onChange={setDraft}
        multiline={multiline}
      />
      {draft !== value && !autoSave && (
        <Button
          size="sm"
          variant="secondary"
          isPending={saving}
          onPress={() => {
            setSaving(true);
            void onSave(draft)
              .catch(store.report)
              .finally(() => setSaving(false));
          }}
        >
          Save
        </Button>
      )}
    </div>
  );
}
export function Tags({
  label,
  value,
  onChange,
  limit = 99,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  limit?: number;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const next = draft.trim();
    if (next && !value.includes(next) && value.length < limit) {
      onChange([...value, next]);
      setDraft("");
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex flex-wrap gap-2">
        {value.map((v) => (
          <Chip key={v} variant="soft">
            <Chip.Label>{v}</Chip.Label>
            <CloseButton
              aria-label={`Remove ${v}`}
              onPress={() => onChange(value.filter((x) => x !== v))}
            />
          </Chip>
        ))}
      </div>
      <div className="flex gap-2">
        <TextField
          aria-label={`Add ${label}`}
          value={draft}
          onChange={setDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        >
          <Input placeholder={`Add ${label.toLowerCase()}…`} />
        </TextField>
        <Button
          variant="secondary"
          onPress={add}
          isDisabled={!draft.trim() || value.length >= limit}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
