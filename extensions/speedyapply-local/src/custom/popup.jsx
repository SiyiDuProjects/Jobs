import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Label,
  Link,
  Separator,
  TextArea,
  TextField,
} from "@heroui/react";
import { EmptyState, Segment } from "@heroui-pro/react";
import { JobsBrand } from "./brand.js";
import { createPopupProfiles } from "./popup-profiles.js";
import { createPopupJob } from "./popup-job.js";
import { PopupAccount } from "./popup-account.jsx";

function useController(create, initial) {
  const [state, setState] = useState(initial);
  const controller = useRef(null);
  useEffect(() => {
    const current = create(chrome, setState);
    controller.current = current;
    void current.start();
    return () => current.dispose();
  }, [create]);
  return [state, controller];
}

export function Popup() {
  const [profile, profiles] = useController(createPopupProfiles, {
    message: "正在读取当前档案…",
  });
  const [job, jobs] = useController(createPopupJob, {
    loading: true,
    message: "正在读取当前页面…",
  });
  return (
    <main className="popup">
      <header className="popup-header">
        <strong className="popup-brand">jobs</strong>
        <Link
          id="jobs-manage"
          href={JobsBrand.website + "/#/applications"}
          target="_blank"
          rel="noreferrer"
        >
          投递管理
          <Link.Icon />
        </Link>
      </header>
      <section
        id="jobs-profile-switch"
        className="popup-section"
        aria-label="当前档案"
      >
        <div className="popup-section-heading">
          <h2>{profile.bound === false ? "默认档案" : "当前档案"}</h2>
          <span id="jobs-profile-source" className="popup-source">
            {profile.sourceLabel}
          </span>
        </div>
        <Segment
          className="popup-profiles"
          aria-label="选择当前档案"
          variant="ghost"
          selectedKey={profile.kind || null}
          isDisabled={profile.busy || !profile.available}
          onSelectionChange={(kind) =>
            void profiles.current.choose(String(kind))
          }
        >
          <Segment.Item
            id="intern"
            data-kind="intern"
            isDisabled={!profile.choices?.intern}
          >
            实习<span className="popup-profile-kind">Intern</span>
          </Segment.Item>
          <Segment.Item
            id="newgrad"
            data-kind="newgrad"
            isDisabled={!profile.choices?.newgrad}
          >
            全职<span className="popup-profile-kind">Newgrad</span>
          </Segment.Item>
        </Segment>
        <p
          id="jobs-profile-hint"
          className="popup-hint"
          role="status"
          data-error={profile.error || false}
        >
          {profile.message}
        </p>
      </section>
      <Separator />
      <PopupAccount />
      <Separator />
      <section
        id="jobs-current-job"
        className="popup-section"
        aria-label="当前岗位"
      >
        {job.actionable || job.deleting ? (
          <>
            <h2>当前岗位</h2>
            <p id="jobs-current-job-title" className="popup-job-title">
              {job.title}
            </p>
            {!job.deleting && (
              <TextField
                id="jobs-delete-reason-field"
                isRequired
                isDisabled={job.busy}
                value={job.reason}
                onChange={(value) => jobs.current.setReason(value)}
              >
                <Label>删除原因</Label>
                <TextArea
                  id="jobs-delete-reason"
                  rows={2}
                  maxLength={500}
                  fullWidth
                  placeholder="例如：岗位已下线、方向不匹配"
                />
              </TextField>
            )}
            {job.deleting && (
              <p id="jobs-removal-detail" className="popup-hint popup-detail">
                删除原因：{job.detail}
              </p>
            )}
            <Button
              id="jobs-delete-job"
              variant={job.undo ? "secondary" : "danger-soft"}
              fullWidth
              isDisabled={job.disabled}
              isPending={job.busy}
              onPress={() => void jobs.current.act()}
            >
              {job.label}
            </Button>
            <p id="jobs-delete-status" className="popup-hint" role="status">
              {job.message}
            </p>
          </>
        ) : (
          <EmptyState size="sm" className="popup-empty">
            <EmptyState.Header>
              <EmptyState.Title>
                {job.loading ? "正在识别页面…" : "当前页面暂无可操作岗位"}
              </EmptyState.Title>
              <EmptyState.Description>
                <span id="jobs-delete-status" role="status">
                  {job.loading
                    ? job.message
                    : job.message + "，打开招聘岗位后可在这里操作。"}
                </span>
              </EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        )}
      </section>
      <Separator />
      <nav className="popup-footer" aria-label="插件工具">
        <Link href="diagnostics.html" target="_blank" rel="noreferrer">
          填写诊断
          <Link.Icon />
        </Link>
        <Link href="migration.html" target="_blank" rel="noreferrer">
          旧资料迁移
          <Link.Icon />
        </Link>
      </nav>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<Popup />);
