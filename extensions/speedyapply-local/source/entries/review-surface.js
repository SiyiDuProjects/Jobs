import { initializeReviewPresenter } from "../../src/custom/review-presenter.js";
import { initializeControlFields } from "../../src/custom/control-fields.js";

// Top-frame continuation guard only. Review UI lives in the native side panel.
// Never start adapters, fill fields or advance an application.
if (window === window.top) {
  // Register continuation helpers without scanning a form.
  initializeControlFields();
  initializeReviewPresenter();
}
