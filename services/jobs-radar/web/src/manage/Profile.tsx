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

import { SaveField, Tags } from "./ProfileWidgets";
import {
  PersonalEditor,
  HistoryEditor,
  Employment,
  RenameProfile,
  ResumeEditor,
  ProfileImport,
} from "./ProfileEditors";
import { Responses } from "./Responses";
export { SaveField } from "./ProfileWidgets";
export { NewProfile } from "./NewProfile";
export function Profile() {
  const { current, profiles } = useManagement(),
    [edit, setEdit] = useState<{ type: string; index?: number } | null>(null);
  if (!current)
    return (
      <>
        <h1 className="text-3xl font-semibold">Profile</h1>
        <Card>
          <Card.Content>No profile yet.</Card.Content>
          <Card.Footer>
            <Button
              onPress={() => {
                location.hash = "/profile/new";
              }}
            >
              Create Profile
            </Button>
          </Card.Footer>
        </Card>
      </>
    );
  const p = current.profile,
    close = () => setEdit(null);
  const setPart = (part: string, value: any) =>
    act(store.saveProfile({ ...p, [part]: value }, current));
  return (
    <>
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>
        <Menu
          label={p.profileName}
          items={[
            {
              id: "new",
              label: "New",
              action: () => {
                location.hash = "/profile/new";
              },
            },
            {
              id: "rename",
              label: "Rename",
              action: () => setEdit({ type: "rename" }),
            },
            {
              id: "import",
              label: "Import",
              action: () => setEdit({ type: "import" }),
            },
            {
              id: "delete",
              label: "Delete",
              danger: true,
              disabled: profiles.length < 2,
              action: () => setEdit({ type: "delete" }),
            },
            ...profiles.map((profile) => ({
              id: profile.id,
              label: profile.profileName,
              action: () => act(store.selectProfile(profile.id)),
            })),
          ]}
        />
      </div>
      <Card>
        <Card.Header className="flex-row justify-between items-start">
          <div>
            <Card.Title>
              {[p.nameData.firstName, p.nameData.lastName]
                .filter(Boolean)
                .join(" ") || "Personal Details"}
            </Card.Title>
            <Card.Description>{p.contactData.email}</Card.Description>
          </div>
          <Button
            variant="secondary"
            onPress={() => setEdit({ type: "personal" })}
          >
            Edit Personal Details
          </Button>
        </Card.Header>
        <Card.Content>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-muted text-sm">Phone</p>
              <p>
                {[p.contactData.phoneCountryCode, p.contactData.phoneNumber]
                  .filter(Boolean)
                  .join(" ") || "—"}
              </p>
            </div>
            <div>
              <p className="text-muted text-sm">Location</p>
              <p>
                {[
                  p.addressData.line1,
                  p.addressData.city,
                  p.addressData.state,
                  p.addressData.country,
                ]
                  .filter(Boolean)
                  .join(", ") || "—"}
              </p>
            </div>
            {!!p.languageData.length && (
              <div className="sm:col-span-2">
                <p className="text-muted text-sm">Languages</p>
                <div className="flex gap-2 flex-wrap mt-2">
                  {p.languageData.map((l, i) => (
                    <Chip key={i} variant="soft">
                      {l.language} · {l.proficiency}
                    </Chip>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>
          <Card.Title>Resume, Websites, &amp; Skills</Card.Title>
        </Card.Header>
        <Card.Content className="gap-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-medium">
                {p.resumeData.fileName || "No resume uploaded"}
              </p>
              <p className="text-muted text-sm">
                {p.resumeData.fileSize
                  ? `${Math.round(p.resumeData.fileSize)} KB`
                  : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onPress={() => setEdit({ type: "resume" })}
              >
                Upload Resume
              </Button>
            </div>
          </div>
          <Separator />
          <div className="grid gap-4 sm:grid-cols-2">
            {["linkedin", "github", "twitter", "personal"].map((key) => (
              <SaveField
                key={current.id + key}
                label={
                  key === "personal"
                    ? "Personal Website"
                    : key[0].toUpperCase() + key.slice(1)
                }
                value={p.websiteData[key] || ""}
                onSave={(value) =>
                  store.saveProfile(
                    { ...p, websiteData: { ...p.websiteData, [key]: value } },
                    current,
                  )
                }
              />
            ))}
            {(p.websiteData.websites || []).map((url: string, i: number) => (
              <div className="flex gap-2 items-end" key={i}>
                <SaveField
                  label={`Website ${i + 1}`}
                  value={url}
                  onSave={(value) =>
                    store.saveProfile(
                      {
                        ...p,
                        websiteData: {
                          ...p.websiteData,
                          websites: (p.websiteData.websites || []).map(
                            (v: string, n: number) => (n === i ? value : v),
                          ),
                        },
                      },
                      current,
                    )
                  }
                />
                <Button
                  aria-label={`Remove website ${i + 1}`}
                  variant="ghost"
                  onPress={() =>
                    setPart("websiteData", {
                      ...p.websiteData,
                      websites: (p.websiteData.websites || []).filter(
                        (_: string, n: number) => n !== i,
                      ),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            className="self-start"
            onPress={() =>
              setPart("websiteData", {
                ...p.websiteData,
                websites: [...(p.websiteData.websites || []), ""],
              })
            }
          >
            Add Website
          </Button>
          <Tags
            key={current.id}
            label="Skills"
            value={p.skillsData || []}
            limit={25}
            onChange={(value) => setPart("skillsData", value)}
          />
        </Card.Content>
      </Card>
      {(["jobData", "educationData"] as const).map((kind) => (
        <Card key={kind}>
          <Card.Header className="flex-row justify-between">
            <Card.Title>
              {kind === "jobData" ? "Work History" : "Education History"}
            </Card.Title>
            <Button variant="secondary" onPress={() => setEdit({ type: kind })}>
              {kind === "jobData" ? "Add Job" : "Add Education"}
            </Button>
          </Card.Header>
          <Card.Content className="gap-4">
            {p[kind].length ? (
              p[kind].map((item, i) => (
                <div key={i} className="flex justify-between gap-4 items-start">
                  <div>
                    <p className="font-medium">
                      {kind === "jobData" ? item.jobTitle : item.school}
                    </p>
                    <p className="text-muted">
                      {kind === "jobData"
                        ? item.company
                        : [item.degree, item.fieldOfStudy]
                            .filter(Boolean)
                            .join(" · ")}
                    </p>
                    <p className="text-muted text-sm">
                      {item.startDate} –{" "}
                      {kind === "jobData" && item.currentlyWorkHere
                        ? "Present"
                        : item.graduationDate || item.endDate}
                    </p>
                    {item.description && (
                      <p className="text-sm whitespace-pre-wrap mt-2">
                        {item.description}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    onPress={() => setEdit({ type: kind, index: i })}
                  >
                    Edit
                  </Button>
                </div>
              ))
            ) : (
              <p className="text-muted">
                {kind === "jobData"
                  ? "No work history added"
                  : "No education added"}
              </p>
            )}
          </Card.Content>
        </Card>
      ))}
      <Card>
        <Card.Header>
          <Card.Title>Equal Employment Information</Card.Title>
        </Card.Header>
        <Card.Content>
          <Employment
            data={p.employmentData}
            onChange={(data) => setPart("employmentData", data)}
          />
        </Card.Content>
      </Card>
      <ApplicationDetailsCard key={current.id} record={current} />
      <Responses key={current.id} profileId={current.id} />
      {edit?.type === "personal" && (
        <PersonalEditor record={current} onClose={close} />
      )}
      {(edit?.type === "jobData" || edit?.type === "educationData") && (
        <HistoryEditor
          record={current}
          kind={edit.type}
          index={edit.index}
          onClose={close}
        />
      )}
      {edit?.type === "rename" && (
        <RenameProfile record={current} onClose={close} />
      )}
      {edit?.type === "delete" && (
        <Dialog
          title={`Delete ${p.profileName}?`}
          danger
          saveLabel="Delete"
          onClose={close}
          onSave={() => store.deleteProfile(current.id)}
        >
          <p>The selected profile will be removed. Other profiles are kept.</p>
        </Dialog>
      )}
      {edit?.type === "resume" && (
        <ResumeEditor record={current} onClose={close} />
      )}
      {edit?.type === "import" && (
        <ProfileImport record={current} onClose={close} />
      )}
    </>
  );
}
