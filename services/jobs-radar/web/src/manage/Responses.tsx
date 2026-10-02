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

import { Tags } from "./ProfileWidgets";
export function Responses({ profileId }: { profileId: string }) {
  const { docs } = useManagement(),
    key = "jobsResponses:" + profileId,
    rawRows = docs[key]?.value ?? [],
    parsed = savedResponses.readList(rawRows),
    rows = parsed.data,
    [query, setQuery] = useState(""),
    [limit, setLimit] = useState(5),
    [dialog, setDialog] = useState<{ type: string; row?: Response } | null>(
      null,
    ),
    close = () => setDialog(null);
  const filtered = rows.filter((r) =>
    (r.keywords.join(" ") + " " + r.response)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const columns: DataGridColumn<Response>[] = [
    {
      id: "keywords",
      header: "Keywords",
      isRowHeader: true,
      cell: (r) => (
        <Button
          variant="ghost"
          onPress={() => setDialog({ type: "edit", row: r })}
        >
          {r.keywords.join(", ")}
        </Button>
      ),
    },
    {
      id: "response",
      header: "Response",
      cell: (r) => (
        <Button
          variant="ghost"
          className="max-w-xl truncate justify-start"
          onPress={() => setDialog({ type: "edit", row: r })}
        >
          {r.response}
        </Button>
      ),
    },
    {
      id: "actions",
      header: "",
      width: 70,
      cell: (r) => (
        <Menu
          label="⋯"
          ariaLabel="Response actions"
          items={[
            {
              id: "edit",
              label: "Edit",
              action: () => setDialog({ type: "edit", row: r }),
            },
            {
              id: "delete",
              label: "Delete",
              danger: true,
              action: () => setDialog({ type: "delete", row: r }),
            },
          ]}
        />
      ),
    },
  ];
  return (
    <Card>
      <Card.Header className="flex-row justify-between">
        <Card.Title>Saved Responses</Card.Title>
        <Menu
          items={[
            {
              id: "add",
              label: "Add",
              action: () => setDialog({ type: "add" }),
            },
            {
              id: "import",
              label: "Import",
              action: () => setDialog({ type: "import" }),
            },

            {
              id: "delete-all",
              label: "Delete All",
              danger: true,
              action: () => setDialog({ type: "delete-all" }),
            },
          ]}
        />
      </Card.Header>
      <Card.Content className="gap-4">
        {parsed.invalidCount > 0 && (
          <p role="status">
            {parsed.invalidCount}{" "}
            条回答格式有误，已暂停使用。原始记录保留在导出文件中；修复后可使用覆盖导入恢复。
          </p>
        )}
        <TextField
          aria-label="Search responses"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setLimit(5);
          }}
        >
          <Input placeholder="Search responses…" />
        </TextField>
        <DataGrid
          aria-label="Saved responses"
          data={filtered.slice(0, limit)}
          columns={columns}
          getRowId={(r) => r.key}
          renderEmptyState={() => "No saved responses."}
        />
        {filtered.length > limit && (
          <Button variant="secondary" onPress={() => setLimit(limit + 5)}>
            Show More
          </Button>
        )}
        <p className="text-muted text-sm">{filtered.length} Responses</p>
      </Card.Content>
      {(dialog?.type === "edit" || dialog?.type === "add") && (
        <ResponseEditor
          row={dialog.row}
          rows={rows}
          rawRows={rawRows}
          documentKey={key}
          onClose={close}
        />
      )}{" "}
      {dialog?.type === "import" && (
        <ResponseImport
          rows={rows}
          rawRows={rawRows}
          documentKey={key}
          onClose={close}
        />
      )}{" "}
      {(dialog?.type === "delete" || dialog?.type === "delete-all") && (
        <Dialog
          title="Delete saved responses?"
          danger
          saveLabel="Delete"
          onClose={close}
          onSave={() =>
            store.write({
              [key]: dialog.row
                ? savedResponses.preserveRejected(
                    rawRows,
                    rows.filter((r) => r.key !== dialog.row!.key),
                  )
                : [],
            })
          }
        >
          <p>This action cannot be undone.</p>
        </Dialog>
      )}
    </Card>
  );
}
function ResponseEditor({
  row,
  rows,
  rawRows,
  documentKey,
  onClose,
}: {
  row?: Response;
  rows: Response[];
  rawRows: unknown;
  documentKey: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Response>(
      structuredClone(
        row || {
          key: crypto.randomUUID(),
          keywords: [],
          response: "",
          appearances: 3,
          fromAutofill: false,
        },
      ),
    ),
    [question, setQuestion] = useState("");
  const [base] = useState(rows);
  const [original] = useState(rawRows);
  const [deleting, setDeleting] = useState(false);
  return (
    <Dialog
      title={row ? "Edit Response" : "Add Response"}
      wide
      onClose={onClose}
      danger={deleting}
      saveLabel={deleting ? "Delete" : row ? "Update" : "Save"}
      onSave={() => {
        if (deleting && row)
          return store.write(
            {
              [documentKey]: savedResponses.preserveRejected(
                original,
                base.filter((r) => r.key !== row.key),
              ),
            },
            { [documentKey]: original },
          );
        if (
          !draft.response.trim() ||
          (!row && draft.keywords.length < 3) ||
          (!row && draft.appearances < 3) ||
          draft.appearances > draft.keywords.length
        )
          throw Error(
            "Use at least 3 keywords and 3 appearances, and enter a response",
          );
        const value = savedResponses.normalizeRecord({
          ...draft,
          key:
            row?.key ||
            [...draft.keywords]
              .map(savedResponses.normalizeKeyword)
              .sort()
              .join("|"),
        });
        return store.write(
          {
            [documentKey]: savedResponses.preserveRejected(
              original,
              row
                ? base.map((r) => (r.key === row.key ? value : r))
                : [...base, value],
            ),
          },
          { [documentKey]: original },
        );
      }}
    >
      <Tags
        label="Keywords"
        value={draft.keywords}
        onChange={(keywords) => setDraft({ ...draft, keywords })}
      />
      <Field
        label="Appearances"
        type="number"
        value={draft.appearances}
        onChange={(v) => setDraft({ ...draft, appearances: Number(v) })}
      />
      <Field
        label="Response"
        value={draft.response}
        onChange={(response) => setDraft({ ...draft, response })}
        multiline
        required
      />
      {draft.fromAutofill && <Chip variant="soft">Autofill</Chip>}
      {draft.question && (
        <p className="text-muted text-sm">
          Original Question: {draft.question}
        </p>
      )}
      <Separator />
      <Field label="Test Keywords" value={question} onChange={setQuestion} />
      <Button
        variant="secondary"
        isDisabled={question.trim().split(/\s+/).filter(Boolean).length < 3}
        onPress={() => {
          const keywords = questionKeywords(question);
          setDraft({
            ...draft,
            keywords,
            appearances: Math.min(
              Math.max(3, draft.appearances),
              keywords.length,
            ),
          });
        }}
      >
        Set Keywords
      </Button>
      {question && (
        <p>
          {draft.keywords.filter(
            (k) =>
              !!savedResponses.normalizeKeyword(k) &&
              question
                .toLowerCase()
                .includes(savedResponses.normalizeKeyword(k)),
          ).length >= draft.appearances
            ? "Passing"
            : "Failing"}
        </p>
      )}
      {row && (
        <Button variant="danger-soft" onPress={() => setDeleting(!deleting)}>
          {deleting ? "Keep Response" : "Delete"}
        </Button>
      )}
    </Dialog>
  );
}
function ResponseImport({
  rows,
  rawRows,
  documentKey,
  onClose,
}: {
  rows: Response[];
  rawRows: unknown;
  documentKey: string;
  onClose: () => void;
}) {
  const [imported, setImported] = useState<Response[]>(),
    [mode, setMode] = useState("merge");
  return (
    <Dialog
      title="Import Responses"
      onClose={onClose}
      saveLabel="Import"
      onSave={() => {
        if (!imported?.length)
          throw Error("Select a response JSON file with at least one response");
        const merged = new Map(rows.map((r) => [r.key, r]));
        imported.forEach((r) =>
          merged.set(r.key, { ...merged.get(r.key), ...r }),
        );
        return store.write(
          {
            [documentKey]:
              mode === "overwrite"
                ? imported
                : savedResponses.preserveRejected(rawRows, [
                    ...merged.values(),
                  ]),
          },
          { [documentKey]: rawRows },
        );
      }}
    >
      <Upload
        label="Upload response JSON"
        accept=".json,application/json"
        onFile={async (f) => {
          const list = savedResponses.parseList(JSON.parse(await f.text()));
          if (!list.length) throw Error("Invalid saved responses");
          setImported(list);
        }}
      />
      <Choice
        label="Import Mode"
        value={mode}
        options={{ merge: "Merge", overwrite: "Overwrite" }}
        onChange={setMode}
      />
    </Dialog>
  );
}
