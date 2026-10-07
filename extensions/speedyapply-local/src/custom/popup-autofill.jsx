import React, { useEffect, useState } from "react";
import { Description, Switch } from "@heroui/react";
import {
  readAutofillPreferences,
  saveWorkdaySkillsPreference,
  workdaySkillsPreferenceKey,
} from "./autofill-preferences.js";

export function PopupAutofill() {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    const changed = (changes, area) => {
      if (area === "local" && changes[workdaySkillsPreferenceKey])
        setEnabled(changes[workdaySkillsPreferenceKey].newValue === true);
    };
    chrome.storage.onChanged.addListener(changed);
    async function load() {
      try {
        const preferences = await readAutofillPreferences(chrome.storage.local);
        if (active) {
          setEnabled(preferences.workdaySkills);
          setReady(true);
        }
      } catch {
        if (active) setMessage("无法读取填写设置，请重新打开插件。");
      }
    }
    void load();
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);
  async function save(value) {
    setBusy(true);
    try {
      await saveWorkdaySkillsPreference(value, chrome.storage.local);
      setEnabled(value);
      setMessage("已保存，从下一次填写开始生效。");
    } catch {
      setMessage("保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="popup-section" aria-label="填写设置">
      <h2>填写设置</h2>
      <Switch
        id="jobs-workday-skills"
        className="popup-autofill-switch"
        isSelected={enabled}
        isDisabled={!ready || busy}
        onChange={(value) => void save(value)}
      >
        <Switch.Content>
          Workday 自动填写技能
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
        <Description>
          默认关闭，跳过逐项技能搜索。已有技能保留；必填时请手动填写。仅限本机。
        </Description>
      </Switch>
      {message && (
        <p className="popup-hint" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
