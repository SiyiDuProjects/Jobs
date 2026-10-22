// The top-frame page presenter imports this editor only when AI review is shown.
// Side panel and answer-console callers retain their synchronous review view.
export { createReviewView } from "../../src/custom/review-view.js";
