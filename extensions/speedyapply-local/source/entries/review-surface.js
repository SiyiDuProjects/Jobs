import { initializeReviewPresenter } from "../../src/custom/review-presenter.js";
import { initializeControlFields } from "../../src/custom/control-fields.js";

// Presentation only. Never start adapters, fill fields or advance an application.
if (window === window.top) {
  // Register the presenter's date/continuation helpers without scanning a form.
  initializeControlFields();
  initializeReviewPresenter();
}
