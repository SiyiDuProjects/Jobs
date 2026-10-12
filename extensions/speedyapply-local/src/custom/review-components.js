import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button, Input, TextArea } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react";
const roots = new WeakMap();
// Stable React roots provide HeroUI controls without replacing the editor draft.
// Native commit handlers retain the existing trusted-event and version checks.
function createReviewControl(parent, tag, props = {}) {
  const mount = document.createElement("span");
  mount.dataset.reviewControl = tag;
  mount.style.display = tag === "button" ? "contents" : "block";
  if (tag !== "button") mount.style.width = "100%";
  parent.append(mount);
  const root = createRoot(mount);
  roots.set(mount, root);
  const node =
    tag === "button"
      ? React.createElement(Button, {
          type: "button",
          size: "sm",
          variant: "secondary",
          ...props,
        })
      : tag === "textarea"
        ? React.createElement(TextArea, { variant: "secondary", ...props })
        : tag === "select"
          ? React.createElement(NativeSelect, {
              variant: "secondary",
              fullWidth: true,
              children: [
                React.createElement(NativeSelect.Trigger, {
                  key: "control",
                  "aria-label": "选择答案",
                  children: null,
                  ...props,
                }),
                React.createElement(NativeSelect.Indicator, {
                  key: "indicator",
                }),
              ],
            })
          : React.createElement(Input, { variant: "secondary", ...props });
  flushSync(() => root.render(node));
  return mount.querySelector(tag);
}
function releaseReviewControls(container, only) {
  for (const mount of only
    ? [only]
    : container.querySelectorAll("[data-review-control]")) {
    const root = roots.get(mount);
    if (root) {
      roots.delete(mount);
      queueMicrotask(() => root.unmount());
    }
  }
}
export { createReviewControl, releaseReviewControls };
