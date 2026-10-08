import { JobsResponseScope } from "../src/custom/response-scope.js";
import { JobsResponseContract } from "../src/custom/response-contract.js";
import { JobsDocumentStore } from "../src/custom/document-store.js";
import { JobsJobMatch } from "../src/custom/job-match.js";
import { readOperator } from "../src/custom/operator-background.js";
export async function saveResponses(entries, sender) {
  if (!Array.isArray(entries) || entries.length > 150)
    throw Error("Invalid answers");
  if (!sender?.tab?.id || sender.id !== chrome.runtime.id)
    throw Error("Application tab required");
  const operator = await readOperator(sender.tab.id);
  const accepted = entries.filter(
    (entry) =>
      entry?.origin === "person" &&
      operator.mode === "person" &&
      entry.operatorEpoch === operator.epoch,
  );
  const key = await JobsResponseScope.storageKey(
    JobsResponseScope.scopeFor(sender),
  );
  let saved = 0;
  await JobsDocumentStore.commit(async (current) => {
    const currentOperator = await readOperator(sender.tab.id);
    if (
      currentOperator.mode !== "person" ||
      currentOperator.epoch !== operator.epoch
    )
      return {};
    const original = current[key] ?? [],
      rows = JobsResponseContract.readList(original).data;
    for (const entry of accepted) {
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
          row.origin === "person" &&
          row.question
            ?.normalize("NFKC")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ") === normalized &&
          ((row.jobKey || "") === context ||
            (companyKey &&
              JobsJobMatch.companyFromKey(row.jobKey) === companyKey)),
      );
      const metadata = {
        origin: "person",
        ruleVersion: 2,
        context: {
          jobKey: context,
          companyKey: companyKey || "",
          capturedAt:
            entry.context?.capturedAt ||
            old?.context?.capturedAt ||
            new Date().toISOString(),
        },
      };
      if (old) {
        if (
          old.response !== response ||
          JSON.stringify(old.context) !== JSON.stringify(metadata.context)
        ) {
          old.response = response;
          Object.assign(old, metadata);
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
        const baseKey =
          "question:" +
          normalized +
          (context ? "|job:" + context : "") +
          "|person";
        let recordKey = baseKey;
        for (
          let suffix = 1;
          rows.some((row) => row.key === recordKey);
          suffix++
        )
          recordKey = baseKey + ":" + suffix;
        rows.push({
          ...metadata,
          question,
          response,
          key: recordKey,
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
