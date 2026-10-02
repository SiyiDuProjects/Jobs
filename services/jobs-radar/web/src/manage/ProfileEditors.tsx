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

const names = (values: string[]) =>
  Object.fromEntries(values.map((v) => [v, v]));
const boolOptions = {
  true: "Yes",
  false: "No",
  undisclosed: "I choose not to disclose",
};
const employmentLabels: Record<string, string> = {
  eligibilityUS: "Work Authorization",
  sponsorship: "Visa Sponsorship",
  disability: "Disability",
  veteran: "Veteran",
  age: "Age",
  gender: "Gender",
  ethnicity: "Ethnicity",
};
export function PersonalFields({
  p,
  onChange,
  section = "all",
}: {
  p: ProfileData;
  onChange: (p: ProfileData) => void;
  section?: "all" | "personal" | "contact";
}) {
  const update = (group: string, key: string, value: any) =>
    onChange({ ...p, [group]: { ...(p as any)[group], [key]: value } });
  return (
    <div className="space-y-6">
      {section !== "contact" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {["firstName", "middleName", "lastName", "prefix", "suffix"].map(
              (key) => (
                <Field
                  key={key}
                  label={
                    {
                      firstName: "First Name",
                      middleName: "Middle Name",
                      lastName: "Last Name",
                      prefix: "Prefix",
                      suffix: "Suffix",
                    }[key]!
                  }
                  value={p.nameData[key]}
                  required={["firstName", "lastName"].includes(key)}
                  onChange={(v) => update("nameData", key, v)}
                />
              ),
            )}
          </div>
          <Toggle
            label="Use preferred name"
            value={!!p.nameData.preferredName}
            onChange={(v) => update("nameData", "preferredName", v)}
          />
          {p.nameData.preferredName && (
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                "preferredFirstName",
                "preferredMiddleName",
                "preferredLastName",
              ].map((key) => (
                <Field
                  key={key}
                  label={
                    key === "preferredFirstName"
                      ? "Preferred First Name"
                      : key === "preferredMiddleName"
                        ? "Preferred Middle Name"
                        : "Preferred Last Name"
                  }
                  value={p.nameData[key]}
                  onChange={(v) => update("nameData", key, v)}
                />
              ))}
            </div>
          )}
        </>
      )}
      {section === "all" && <Separator />}
      {section !== "personal" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {Object.entries({
              email: "Email",
              phoneDeviceType: "Phone Device Type",
              phoneCountryCode: "Phone Country Code",
              phoneNumber: "Phone Number",
            }).map(([key, label]) => (
              <Field
                key={key}
                label={label}
                value={p.contactData[key]}
                onChange={(v) => update("contactData", key, v)}
                type={key === "email" ? "email" : "text"}
              />
            ))}
            {Object.entries({
              line1: "Address Line 1",
              line2: "Address Line 2",
              city: "City",
              state: "State",
              postalCode: "Postal Code",
            }).map(([key, label]) => (
              <Field
                key={key}
                label={label}
                value={p.addressData[key]}
                onChange={(v) => update("addressData", key, v)}
              />
            ))}
            <Choice
              label="Country"
              value={p.addressData.country}
              options={names(options.countries)}
              onChange={(v) => update("addressData", "country", v)}
            />
          </div>
        </>
      )}
      {section !== "contact" && (
        <>
          <Separator />
          <p className="font-medium">Languages</p>
          {p.languageData.map((l, i) => (
            <div key={i} className="grid gap-4 sm:grid-cols-2">
              <Choice
                label="Language"
                value={l.language}
                options={names(options.languages)}
                onChange={(v) =>
                  onChange({
                    ...p,
                    languageData: p.languageData.map((x, n) =>
                      n === i ? { ...x, language: v } : x,
                    ),
                  })
                }
              />
              <Choice
                label="Proficiency"
                value={l.proficiency}
                options={names(options.proficiencies)}
                onChange={(v) =>
                  onChange({
                    ...p,
                    languageData: p.languageData.map((x, n) =>
                      n === i ? { ...x, proficiency: v } : x,
                    ),
                  })
                }
              />
              <Toggle
                label="Fluent"
                value={!!l.fluent}
                onChange={(v) =>
                  onChange({
                    ...p,
                    languageData: p.languageData.map((x, n) =>
                      n === i ? { ...x, fluent: v } : x,
                    ),
                  })
                }
              />
              <Button
                variant="danger-soft"
                onPress={() =>
                  onChange({
                    ...p,
                    languageData: p.languageData.filter((_, n) => n !== i),
                  })
                }
              >
                Remove Language
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            onPress={() =>
              onChange({
                ...p,
                languageData: [
                  ...p.languageData,
                  { language: "", proficiency: "", fluent: false },
                ],
              })
            }
          >
            Add Language
          </Button>
        </>
      )}
    </div>
  );
}
export function PersonalEditor({
  record,
  onClose,
}: {
  record: ProfileRecord;
  onClose: () => void;
}) {
  const [p, setP] = useState(structuredClone(record.profile));
  return (
    <Dialog
      wide
      title="Personal Details"
      onClose={onClose}
      onSave={() => store.saveProfile(p, record)}
    >
      <PersonalFields p={p} onChange={setP} />
    </Dialog>
  );
}
export function HistoryFields({
  kind,
  item,
  onChange,
}: {
  kind: string;
  item: Record<string, any>;
  onChange: (v: Record<string, any>) => void;
}) {
  const job = kind === "jobData",
    update = (key: string, v: any) => onChange({ ...item, [key]: v }),
    present = job ? "currentlyWorkHere" : "currentlyAttending";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {Object.entries(
        job
          ? { jobTitle: "Job Title", company: "Company", location: "Location" }
          : { school: "School", fieldOfStudy: "Field of Study", gpa: "GPA" },
      ).map(([key, label]) => (
        <Field
          key={key}
          label={label}
          required={["jobTitle", "company", "school"].includes(key)}
          value={item[key]}
          onChange={(v) => update(key, v)}
        />
      ))}
      {!job && (
        <Choice
          label="Degree"
          value={item.degree}
          options={names(options.degrees)}
          onChange={(v) => update("degree", v)}
        />
      )}
      <Field
        label="Start Date"
        type="month"
        value={item.startDate?.slice(0, 7)}
        onChange={(v) => update("startDate", v)}
      />
      {(!job || !item[present]) && (
        <Field
          label={job ? "End Date" : "Graduation month"}
          type="month"
          value={item.endDate?.slice(0, 7)}
          onChange={(v) =>
            onChange({
              ...item,
              endDate: v,
              ...(!job &&
              item.graduationDate &&
              item.graduationDate.slice(0, 7) !== v
                ? { graduationDate: "" }
                : {}),
            })
          }
        />
      )}
      {!job && (
        <Field
          label="Exact graduation date (optional)"
          type="date"
          value={item.graduationDate}
          description="If the exact day is unknown, keep only the graduation month."
          onChange={(v) =>
            onChange({
              ...item,
              graduationDate: v,
              ...(v ? { endDate: v.slice(0, 7) } : {}),
            })
          }
        />
      )}
      <Toggle
        label={job ? "Currently work here" : "Currently attending"}
        value={item[present]}
        onChange={(v) => update(present, v)}
      />
      {job && (
        <div className="sm:col-span-2">
          <Field
            label="Description"
            value={item.description}
            onChange={(v) => update("description", v)}
            multiline
          />
        </div>
      )}
    </div>
  );
}
export function HistoryEditor({
  record,
  kind,
  index,
  onClose,
}: {
  record: ProfileRecord;
  kind: string;
  index?: number;
  onClose: () => void;
}) {
  const key = kind as "jobData" | "educationData",
    [item, setItem] = useState(
      structuredClone(
        index === undefined
          ? key === "jobData"
            ? blankJob
            : blankEducation
          : record.profile[key][index],
      ),
    ),
    [remove, setRemove] = useState(false);
  return (
    <Dialog
      wide
      title={`${index === undefined ? "Add" : "Edit"} ${key === "jobData" ? "Job" : "Education"}`}
      onClose={onClose}
      danger={remove}
      saveLabel={remove ? "Delete" : "Save"}
      onSave={() => {
        const values = [...record.profile[key]];
        if (remove && index !== undefined) values.splice(index, 1);
        else if (index === undefined) values.push(item);
        else values[index] = item;
        return store.saveProfile({ ...record.profile, [key]: values }, record);
      }}
    >
      {remove ? (
        <p>Delete this entry?</p>
      ) : (
        <HistoryFields kind={kind} item={item} onChange={setItem} />
      )}{" "}
      {index !== undefined && (
        <Button variant="danger-soft" onPress={() => setRemove(!remove)}>
          {remove ? "Keep entry" : "Delete"}
        </Button>
      )}
    </Dialog>
  );
}
export function Employment({
  data,
  onChange,
}: {
  data: Record<string, any>;
  onChange: (v: Record<string, any>) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {Object.entries(employmentLabels).map(([key, label]) => {
        const choices =
          key === "gender"
            ? names(options.genders)
            : key === "ethnicity"
              ? names(options.ethnicities)
              : key === "age"
                ? {
                    undisclosed: "I choose not to disclose",
                    ...Object.fromEntries(
                      Array.from({ length: 78 }, (_, i) => [
                        String(i + 13),
                        String(i + 13),
                      ]),
                    ),
                  }
                : boolOptions;
        return (
          <Choice
            key={key}
            label={label}
            value={data[key] === undefined ? "" : String(data[key])}
            options={choices}
            onChange={(v) =>
              onChange({
                ...data,
                [key]: ["gender", "ethnicity"].includes(key)
                  ? v
                  : v === "undisclosed"
                    ? v
                    : key === "age"
                      ? Number(v)
                      : v === "true",
                ...(key === "ethnicity"
                  ? {
                      hispanicOrLatino:
                        v === "I choose not to disclose"
                          ? "undisclosed"
                          : v === "Hispanic or Latino",
                    }
                  : {}),
              })
            }
          />
        );
      })}
    </div>
  );
}
export function RenameProfile({
  record,
  onClose,
}: {
  record: ProfileRecord;
  onClose: () => void;
}) {
  const [name, setName] = useState(record.profile.profileName);
  return (
    <Dialog
      title="Change Profile Name"
      onClose={onClose}
      saveLabel="Update"
      onSave={() => {
        if (
          !name.trim() ||
          store.state.profiles.some(
            (p) => p.id !== record.id && p.profileName === name.trim(),
          )
        )
          throw Error("Choose a unique profile name");
        return store.saveProfile(
          { ...record.profile, profileName: name.trim() },
          record,
        );
      }}
    >
      <Field
        label="New Profile Name"
        value={name}
        onChange={setName}
        maxLength={20}
        required
      />
    </Dialog>
  );
}
export async function readResume(f: File) {
  if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf"))
    throw Error("Choose a PDF resume");
  if (f.size > 1024 * 1024) throw Error("Resume must be smaller than 1 MB");
  return new Promise<ProfileData["resumeData"]>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        resumeBase64: String(reader.result).split(",")[1],
        fileName: f.name,
        fileSize: f.size / 1024,
        dateUploaded: new Date().toISOString(),
      });
    reader.onerror = () => reject(Error("Unable to read file"));
    reader.readAsDataURL(f);
  });
}
export function ResumeEditor({
  record,
  onClose,
}: {
  record: ProfileRecord;
  onClose: () => void;
}) {
  const [resume, setResume] = useState(record.profile.resumeData);
  return (
    <Dialog
      title="Upload Resume"
      onClose={onClose}
      onSave={() =>
        store.saveProfile({ ...record.profile, resumeData: resume }, record)
      }
    >
      <Upload
        label="Upload your resume"
        accept=".pdf,application/pdf"
        onFile={async (f) => setResume(await readResume(f))}
      />
      <p className="text-muted text-sm">{resume.fileName}</p>
    </Dialog>
  );
}
export function ProfileImport({
  record,
  onClose,
}: {
  record?: ProfileRecord;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<ProfileData>();
  return (
    <Dialog
      title="Import Profile"
      onClose={onClose}
      saveLabel="Import"
      onSave={() => {
        if (!profile) throw Error("Select a profile JSON file");
        return store.saveProfile(profile, record);
      }}
    >
      <Upload
        label="Import profile JSON"
        accept=".json,application/json"
        onFile={async (f) => {
          const data = JSON.parse(await f.text());
          assertProfile(data);
          setProfile(data);
        }}
      />
      {record && (
        <p>This replaces the selected profile after you press Import.</p>
      )}
    </Dialog>
  );
}
