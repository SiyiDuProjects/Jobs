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
import {
  PersonalFields,
  HistoryFields,
  Employment,
  readResume,
} from "./ProfileEditors";
export function NewProfile() {
  const [createId] = useState(() => crypto.randomUUID());
  const [p, setP] = useState<ProfileData>(structuredClone(defaultProfile)),
    [step, setStep] = useState(0),
    [error, setError] = useState(""),
    { profiles, pending } = useManagement(),
    [source, setSource] = useState("");
  const sections = [
    "Create New Profile",
    "Personal Details",
    "Contact Information",
    "Resume, Websites, & Skills",
    "Work History",
    "Education History",
    "Equal Employment Information",
  ];
  return (
    <>
      <h1 className="text-3xl font-semibold">Create New Profile</h1>
      <Card>
        <Card.Header>
          <Card.Title>{sections[step]}</Card.Title>
        </Card.Header>
        <Card.Content className="gap-6">
          {step === 0 ? (
            <>
              <Upload
                label="Upload your resume or profile JSON"
                accept=".pdf,.json"
                onFile={async (f) => {
                  if (f.name.endsWith(".json")) {
                    const data = JSON.parse(await f.text());
                    assertProfile(data);
                    setP(data);
                    setStep(1);
                  } else {
                    setP({ ...p, resumeData: await readResume(f) });
                    setError(
                      "Resume parsing is not connected. The PDF is attached; continue with manual profile details.",
                    );
                  }
                }}
              />
              <Choice
                label="Copy an existing profile"
                value={source}
                options={Object.fromEntries(
                  profiles.map((x) => [x.id, x.profileName]),
                )}
                onChange={setSource}
              />
              <Button
                variant="secondary"
                isDisabled={!source}
                onPress={() =>
                  act(
                    store.profileAPI("?id=" + source).then((record) => {
                      setP({
                        ...record.profile,
                        profileName: (
                          "Copy of " + record.profile.profileName
                        ).slice(0, 20),
                      });
                      setStep(1);
                    }),
                  )
                }
              >
                Copy Profile
              </Button>
              <Button onPress={() => setStep(1)}>Create Manually</Button>
            </>
          ) : step <= 2 ? (
            <PersonalFields
              p={p}
              onChange={setP}
              section={step === 1 ? "personal" : "contact"}
            />
          ) : step === 3 ? (
            <>
              <Upload
                label="Resume"
                accept=".pdf"
                onFile={async (f) =>
                  setP({ ...p, resumeData: await readResume(f) })
                }
              />
              {["linkedin", "github", "twitter", "personal"].map((key) => (
                <Field
                  key={key}
                  label={key}
                  value={p.websiteData[key]}
                  onChange={(v) =>
                    setP({ ...p, websiteData: { ...p.websiteData, [key]: v } })
                  }
                />
              ))}
              <Tags
                label="Skills"
                value={p.skillsData || []}
                onChange={(v) => setP({ ...p, skillsData: v })}
                limit={25}
              />
            </>
          ) : step <= 5 ? (
            <>
              {(step === 4 ? p.jobData : p.educationData).map((item, i) => (
                <HistoryFields
                  key={i}
                  kind={step === 4 ? "jobData" : "educationData"}
                  item={item}
                  onChange={(value) => {
                    const key = step === 4 ? "jobData" : "educationData";
                    setP({
                      ...p,
                      [key]: p[key].map((v, n) => (n === i ? value : v)),
                    });
                  }}
                />
              ))}
              <Button
                variant="secondary"
                onPress={() => {
                  const key = step === 4 ? "jobData" : "educationData";
                  setP({
                    ...p,
                    [key]: [
                      ...p[key],
                      structuredClone(step === 4 ? blankJob : blankEducation),
                    ],
                  });
                }}
              >
                {step === 4 ? "Add Job" : "Add School"}
              </Button>
            </>
          ) : (
            <>
              <Employment
                data={p.employmentData}
                onChange={(employmentData) => setP({ ...p, employmentData })}
              />
              <Field
                label="Profile Name"
                value={p.profileName}
                onChange={(profileName) => setP({ ...p, profileName })}
                required
                maxLength={20}
              />
            </>
          )}
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </Card.Content>
        <Card.Footer className="justify-end gap-3">
          {step > 0 && (
            <Button variant="secondary" onPress={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          {step > 0 && step < 6 && (
            <Button onPress={() => setStep(step + 1)}>Next</Button>
          )}
          {step === 6 && (
            <Button
              isPending={pending > 0}
              onPress={() => {
                if (
                  !(p.nameData.firstName || "").trim() ||
                  !(p.nameData.lastName || "").trim() ||
                  !p.profileName.trim()
                ) {
                  setError("Enter your name and profile name");
                  return;
                }
                if (
                  profiles.some((x) => x.profileName === p.profileName.trim())
                ) {
                  setError("Profile name already exists");
                  return;
                }
                void store
                  .saveProfile(
                    { ...p, profileName: p.profileName.trim() },
                    null,
                    createId,
                  )
                  .then(() => {
                    location.hash = "/profile";
                  })
                  .catch((e) => setError(e.message));
              }}
            >
              Finish
            </Button>
          )}
        </Card.Footer>
      </Card>
      <p className="text-muted text-center">{step + 1} / 7</p>
    </>
  );
}
