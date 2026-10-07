import { JobsResponseScope } from "../src/custom/response-scope.js";
import { JobsResponseContract } from "../src/custom/response-contract.js";
import { JobsDocumentStore } from "../src/custom/document-store.js";
import { JobsJobMatch } from "../src/custom/job-match.js";
export async function saveResponses(entries, sender) {
  if (!Array.isArray(entries) || entries.length > 150)
    throw Error("Invalid answers");
  const key = await JobsResponseScope.storageKey(
    JobsResponseScope.scopeFor(sender),
  );
  let saved = 0;
  await JobsDocumentStore.commit((current) => {
    const original = current[key] ?? [],
      rows = JobsResponseContract.readList(original).data;
    for (const entry of entries) {
      const { question, response, jobKey } = entry;
      if (
        typeof question !== "string" ||
        typeof response !== "string" ||
        !question.trim() ||
        !response.trim() ||
        question.length > 4000 ||
        response.length > 4000
      )
        continue;
      const normalized = question
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      const context =
        typeof jobKey === "string" && jobKey.length <= 3000 ? jobKey : "";
      const companyKey = context ? JobsJobMatch.companyFromKey(context) : null;
      const old = rows.findLast(
        (row) =>
          row.question
            ?.normalize("NFKC")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ") === normalized &&
          ((row.jobKey || "") === context ||
            (companyKey &&
              JobsJobMatch.companyFromKey(row.jobKey) === companyKey)),
      );
      if (old) {
        if (old.response !== response) {
          old.response = response;
          // The matcher prefers the last exact answer. Preserve historical rows
          // but keep this newly confirmed company answer ahead of older copies.
          if (companyKey) {
            rows.splice(rows.indexOf(old), 1);
            rows.push(old);
          }
          saved++;
        }
      } else {
        const keywords = JobsResponseContract.questionKeywords?.(question) || [
          normalized,
        ];
        rows.push({
          question,
          response,
          key: "question:" + normalized + (context ? "|job:" + context : ""),
          keywords,
          appearances: keywords.length,
          fromAutofill: true,
          ...(context ? { jobKey: context } : {}),
        });
        saved++;
      }
    }
    return saved
      ? { [key]: JobsResponseContract.preserveRejected(original, rows) }
      : {};
  });
  return { ok: true, saved };
}
