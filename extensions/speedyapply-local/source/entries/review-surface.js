import { connectOperator } from "../../src/custom/operator-state.js";
import { initializeReviewPresenter } from "../../src/custom/review-presenter.js";

// Top-frame continuation and shared review surface for an embedded ATS.
// Never start adapters, fill fields or advance an application.
if (window === window.top) {
  if (!globalThis.__jobsReviewPresenter) void connectOperator();
  initializeReviewPresenter();
}
