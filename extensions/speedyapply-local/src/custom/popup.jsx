import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Label,
  Dropdown,
  Modal,
  Card,
  buttonVariants,
  TextArea,
  TextField,
} from "@heroui/react";
import { JobsBrand } from "./brand.js";
import { JobsBuildInfo } from "./build-info.js";
import { createPopupProfiles } from "./popup-profiles.js";
import { createPopupJob } from "./popup-job.js";
import { PanelProgress } from "./panel-progress.jsx";
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

// Pages across all tabs whose answers wait for the person.
function useWaitingPages() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let active = true,
      timer;
    const read = () =>
      chrome.runtime
        .sendMessage({ type: "jobs:console-read" })
        .then((result) => {
          if (active && !result?.error)
            setCount(
              (result?.data?.tabs || []).filter((tab) => tab.reviewPending)
                .length,
            );
        })
        .catch(() => {});
    const changed = (message, sender) => {
      if (
        sender.id !== chrome.runtime.id ||
        message?.type !== "jobs:panel-changed"
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(read, 200);
    };
    chrome.runtime.onMessage.addListener(changed);
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(changed);
    };
  }, []);
  return count;
}

export function Popup() {
  const waiting = useWaitingPages();
  const [versionNotice, setVersionNotice] = useState("");
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: "jobs:runtime-version", build: JobsBuildInfo.id })
      .then((version) => {
        if (!version?.running || version.reloadRequired)
          setVersionNotice(
            "插件已更新。请先保存正在填写的内容，再到扩展管理页重新加载插件；无需刷新投递页面。",
          );
      })
      .catch(() =>
        setVersionNotice("暂时无法核对插件版本，请检查扩展是否已重新加载。"),
      );
  }, []);
  const [profile, profiles] = useController(createPopupProfiles, {
    message: "正在读取本页资料…",
  });
  const [job, jobs] = useController(createPopupJob, {
    loading: true,
    message: "正在读取当前页面…",
  });
  return (
    <main className="popup">
      <header className="popup-header">
        <strong className="popup-brand">jobs</strong>
        <div className="panel-actions popup-header-actions">
          <Button
            id="jobs-open-console"
            size="sm"
            variant={waiting ? "primary" : "secondary"}
            onPress={() =>
              void chrome.runtime
                .sendMessage({ type: "jobs:console-open" })
                .catch(() => {})
            }
          >
            答题台{waiting ? ` · ${waiting}` : ""}
          </Button>
          <a
            id="jobs-manage"
            className={buttonVariants({ variant: "secondary", size: "sm" })}
            href={JobsBrand.website + "/#/applications"}
            target="_blank"
            rel="noreferrer"
          >
            投递管理
          </a>
          <Dropdown>
            <Button
              size="sm"
              variant="secondary"
              isIconOnly
              aria-label="更多操作"
            >
              ⋯
            </Button>
            <Dropdown.Popover>
              <Dropdown.Menu
                aria-label="扩展工具"
                onAction={(key) => {
                  if (key === "diagnostics")
                    window.open("diagnostics.html", "_blank");
                  else setDialog(String(key));
                }}
              >
                <Dropdown.Item
                  id="delete"
                  isDisabled={!job.actionable && !job.deleting}
                  textValue="删除当前岗位"
                >
                  <Label>{job.undo ? "恢复当前岗位" : "删除当前岗位"}</Label>
                </Dropdown.Item>
                <Dropdown.Item id="account" textValue="本页账号">
                  <Label>本页账号</Label>
                </Dropdown.Item>
                <Dropdown.Item id="diagnostics" textValue="填写诊断">
                  <Label>填写诊断</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </header>
      {versionNotice && (
        <p className="popup-hint" role="status">
          {versionNotice}
        </p>
      )}
      <PanelProgress />
      <Card
        id="jobs-profile-switch"
        className="popup-section"
        aria-label="本页资料"
      >
        <Card.Content>
          <div className="popup-section-heading">
            <h2>
              本页：
              {profile.kind === "intern"
                ? "实习"
                : profile.kind === "newgrad"
                  ? "全职"
                  : "待识别"}
              {profile.profileName ? `（${profile.profileName}）` : ""}
            </h2>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={
                profile.busy ||
                !profile.available ||
                !profile.choices?.[
                  profile.kind === "intern" ? "newgrad" : "intern"
                ]
              }
              onPress={() =>
                void profiles.current.choose(
                  profile.kind === "intern" ? "newgrad" : "intern",
                )
              }
            >
              改为{profile.kind === "intern" ? "全职" : "实习"}
            </Button>
          </div>
          <p
            id="jobs-profile-hint"
            className="popup-hint"
            role="status"
            data-error={profile.error || false}
          >
            {profile.message}
          </p>
          {profile.bound && (
            <p className="popup-hint">
              简历：{profile.resume?.fileName || "未绑定文件"}
              {profile.profileUpdatedAt &&
              Number.isFinite(Date.parse(profile.profileUpdatedAt))
                ? ` · 资料更新 ${new Date(profile.profileUpdatedAt).toLocaleString()}`
                : ""}
            </p>
          )}
          {profile.settings && (
            <p className="popup-hint">
              {profile.settings.enabled ? "自动填写已开" : "自动填写已关"}
              {" · 自动继续"}
              {profile.settings.autofillSettings.autoClickNextPage
                ? "开"
                : "关"}
              {" · 自动提交"}
              {profile.settings.autofillSettings.autoSubmit ? "开" : "关"}
            </p>
          )}
        </Card.Content>
      </Card>
      <Modal.Backdrop
        isOpen={!!dialog}
        onOpenChange={(open) => {
          if (!open && !job.busy) setDialog(null);
        }}
      >
        <Modal.Container>
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>
                {dialog === "account" ? "本页账号" : "当前岗位"}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {dialog === "account" ? (
                <PopupAccount />
              ) : (
                <section
                  id="jobs-current-job"
                  className="popup-section"
                  aria-label="当前岗位"
                >
                  {job.actionable || job.deleting ? (
                    <>
                      <h2>当前岗位</h2>
                      <p
                        id="jobs-current-job-title"
                        className="popup-job-title"
                      >
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
                            variant="secondary"
                            rows={2}
                            maxLength={500}
                            fullWidth
                            placeholder="例如：岗位已下线、方向不匹配"
                          />
                        </TextField>
                      )}
                      {job.deleting && (
                        <p
                          id="jobs-removal-detail"
                          className="popup-hint popup-detail"
                        >
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
                      <p
                        id="jobs-delete-status"
                        className="popup-hint"
                        role="status"
                      >
                        {job.message}
                      </p>
                    </>
                  ) : (
                    <p className="popup-hint">{job.message}</p>
                  )}
                </section>
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<Popup />);
