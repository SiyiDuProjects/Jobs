import React, { useEffect, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import {
  readAccountSettings,
  saveAccountSettings,
} from "./account-settings.js";

function AccountForm() {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取本机设置…");
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    readAccountSettings(chrome.storage.local).then(
      (settings) => {
        if (!active) return;
        setDraft({ ...settings, password: "", clearPassword: false });
        setMessage("");
      },
      () => {
        if (!active) return;
        setError(true);
        setMessage("无法读取本机设置，请关闭后重新打开。 ");
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const edit = (change) => {
    setDraft((current) => ({ ...current, ...change }));
    setMessage("");
    setError(false);
  };
  async function save(event) {
    event.preventDefault();
    if (busy || !draft) return;
    setBusy(true);
    setError(false);
    try {
      const result = await saveAccountSettings(chrome.storage.local, draft);
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
      setError(true);
      setMessage("保存失败，请重试。 ");
    } finally {
      setBusy(false);
    }
  }
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
  return (
    <section className="popup-section" aria-label="账号自动填充">
      <Button
        id="jobs-account-toggle"
        variant="secondary"
        aria-expanded={open}
        aria-controls="jobs-account-form"
        onPress={() => setOpen(!open)}
        fullWidth
      >
        {open ? "收起账号设置" : "账号自动填充"}
      </Button>
      {open && <AccountForm />}
    </section>
  );
}
