import { createDraftChecklist } from "./draft-checklist.js";
// One checklist across steps, displayed by the shared review surface.
export function createDraftReview(
  root,
  reader,
  reviewSurface,
  assertCurrent,
  checklist = createDraftChecklist(root, reader),
) {
  let revision = null;
  const show = (state) => {
    revision = state.revision;
    reviewSurface.summary(root, reader, state.items);
  };
  return {
    add: checklist.add,
    async beforeFinish({ action, review, button }) {
      const final =
        action === "submit" ||
        review ||
        (action === "fill" &&
          button &&
          /^(?:submit|apply|提交)(?:\b|\s|$)/i.test(
            (button.textContent || button.value || "").trim(),
          ));
      if (!final) return false;
      const state = await checklist.read();
      assertCurrent();
      if (!state.items.length || state.approved === state.revision)
        return false;
      show(state);
      return true;
    },
    async confirm() {
      if (revision === null) return;
      const state = await checklist.read();
      assertCurrent();
      if (state.revision !== revision) {
        show(state);
        throw Error("草稿已改变，请核对更新后的清单");
      }
      await checklist.approve(revision);
      assertCurrent();
      revision = null;
    },
    dispose: checklist.dispose,
  };
}
