import { diagnosticEnums } from "./diagnostic-evidence.js";
import { JobsDiagnostics } from "./diagnostics.js";

export function canReportProfileFailure(record) {
  const { controller, root, url, owner } = record;
  return (
    controller.signal.aborted &&
    root.isConnected &&
    location.href === url &&
    (!owner || (owner.current() && owner.owns(record)))
  );
}

export function reportRunStop(record, evidence) {
  record.stopReason ||= evidence.reason;
  JobsDiagnostics?.evidence?.(null, evidence);
}
export function retainRunStop(record) {
  const reason = record.controller.signal.reason;
  const cause =
    diagnosticEnums.reason.includes(reason) && reason !== "cancelled"
      ? reason
      : record.stopReason || "cancelled";
  record.phase = "stopped-" + cause;
  JobsDiagnostics?.evidence?.(null, {
    stage: "lifecycle",
    result: "blocked",
    reason: cause,
  });
  return record.phase;
}
export function stoppedMessage(phase) {
  if (!phase?.startsWith("stopped-")) return "";
  const reasons = {
    user_input: "检测到手动操作",
    profile_changed: "本页资料已改变",
    form_hidden: "原表单已隐藏或移除",
    detached: "原表单已移除",
    root_changed: "表单已更换",
    url_changed: "页面地址已改变",
    page_left: "已离开页面",
    owner_changed: "页面操作权已改变",
    caller_invalid: "本次操作已失效",
    expired: "本次操作已过期",
  };
  return "填写已停止：" + (reasons[phase.slice(8)] || "本次操作已取消");
}
