// Recovery reads the website's current values. It never fills or navigates.
export function recoverReview(reader, add) {
  for (const row of reader.scan()) {
    if (
      row.node.matches("[data-jobs-ai-review],[data-jobs-review-pending]") ||
      (row.public.required && !row.public.filled)
    ) {
      add(row, {
        source: "unknown",
        needsConfirmation: true,
        needsInput: !row.public.filled,
      });
      row.node.removeAttribute("data-jobs-review-pending");
    }
  }
}

// A recovered populated draft still needs the page's validation and save gate.
export function finishRecovery(reader, review, flow, needsReview, setMessage) {
  flow.move("scanning");
  if (needsReview()) flow.move("review");
  else {
    flow.move("checking");
    if (reader.state({ review }).ready) flow.move("complete");
    else flow.block();
  }
  setMessage(needsReview() ? "ai-review" : reader.state({ review }).phase);
}
