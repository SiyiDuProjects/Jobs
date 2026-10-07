import { readModule } from "./module-source.mjs";
const code = (
  await Promise.all(
    ["calendar-date", "review-view"].map((name) =>
      readModule(
        new URL(`../../src/custom/${name}.js`, import.meta.url),
        "utf8",
      ),
    ),
  )
).join("\n");
// Editor/pipeline unit tests mount the real side-panel view in their synthetic
// document. Transport and absence of in-page UI are tested separately.
export function mountReviewPanel(w) {
  w.eval(code);
  const view = w.createReviewView();
  const host = w.document.createElement("div");
  w.document.body.append(host);
  view.attach(host, host, () => host.remove());
  w.JobsReviewPresenter = view;
  return view;
}
