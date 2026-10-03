import React, { useEffect, useRef, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import {
  readAccountSettings,
  saveAccountSettings,
} from "./account-settings.js";

function AccountForm({ open }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取本机设置…");
  const [error, setError] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open || draft) return;
    let active = true;
    setError(false);
    setMessage("正在读取本机设置…");
    async function load() {
      try {
        const settings = await readAccountSettings(chrome.storage.local);
        if (!active) return;
        setDraft({ ...settings, password: "", clearPassword: false });
        setMessage("");
      } catch {
        if (!active) return;
        setError(true);
        setMessage("无法读取本机设置，请关闭后重新打开。 ");
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [open]);
  const edit = (change) => {
    revision.current++;
    setDraft((current) => ({ ...current, ...change }));
    setMessage("");
    setError(false);
  };
  async function save(event) {
    event.preventDefault();
    if (saving.current || !draft) return;
    saving.current = true;
    const savedRevision = revision.current;
    setBusy(true);
    setError(false);
    try {
      const result = await saveAccountSettings(chrome.storage.local, draft);
      if (!mounted.current) return;
      if (revision.current !== savedRevision) {
        setDraft((current) => ({ ...current, ...result }));
        setMessage("先前修改已保存；当前修改尚未保存。");
        return;
      }
      setDraft((current) => ({
        ...current,
        ...result,
        password: "",
        clearPassword: false,
      }));
      setMessage(
        "已保存。新打开的申请页生效；已打开的页面需在保留进度后刷新。",
      );
    } catch {
      if (!mounted.current) return;
      setError(true);
      setMessage("保存失败，请重试。 ");
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!open) return null;
  return (
    <form id="jobs-account-form" className="popup-section" onSubmit={save}>
      <p className="popup-hint">
        用于支持的网站登录和注册。仅保存在当前浏览器，不会跨设备同步。
      </p>
      {draft && (
        <>
          <label className="popup-account-check">
            <input
              type="checkbox"
              checked={draft.useProfileEmail}
              disabled={busy}
              onChange={(event) =>
                edit({ useProfileEmail: event.target.checked })
              }
            />
            使用当前申请档案的邮箱
          </label>
          <TextField
            isDisabled={busy || draft.useProfileEmail}
            value={draft.accountEmail}
            onChange={(accountEmail) => edit({ accountEmail })}
          >
            <Label>登录邮箱</Label>
            <Input id="jobs-account-email" type="email" autoComplete="off" />
          </TextField>
          <TextField
            isDisabled={busy || draft.clearPassword}
            value={draft.password}
            onChange={(password) => edit({ password })}
          >
            <Label>
              {draft.hasPassword ? "更换密码（留空保留）" : "自动填充密码"}
            </Label>
            <Input
              id="jobs-account-password"
              type="password"
              autoComplete="new-password"
            />
          </TextField>
          {draft.hasPassword && (
            <label className="popup-account-check">
              <input
                type="checkbox"
                checked={draft.clearPassword}
                disabled={busy}
                onChange={(event) =>
                  edit({ clearPassword: event.target.checked, password: "" })
                }
              />
              清除已保存的密码
            </label>
          )}
          <Button
            id="jobs-account-save"
            type="submit"
            isPending={busy}
            isDisabled={busy}
            fullWidth
          >
            保存账号设置
          </Button>
        </>
      )}
      <p
        id="jobs-account-status"
        className="popup-hint"
        role="status"
        data-error={error}
      >
        {message}
      </p>
    </form>
  );
}

export function PopupAccount() {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return (
    <section className="popup-section" aria-label="账号自动填充">
      <Button
        id="jobs-account-toggle"
        variant="secondary"
        aria-expanded={open}
        aria-controls="jobs-account-form"
        onPress={() => {
          setOpened(true);
          setOpen((current) => !current);
        }}
        fullWidth
      >
        {open ? "收起账号设置" : "账号自动填充"}
      </Button>
      {opened && <AccountForm open={open} />}
    </section>
  );
}
