import assert from "node:assert/strict";

// Exercise real adapter entry points and the real resolver. Count by DOM
// identity, not question text (repeated education/work rows share captions).
export function inspectAnswerers(w) {
  const initial = new Set(
    w.JobsControlFields.create(w.document)
      .scan()
      .filter((row) => row.public.filled)
      .map((row) => row.node),
  );
  const visits = new Map(),
    claims = new Map(),
    resolver = w.JobsAnswerResolver;
  w.JobsAnswerResolver = Object.freeze({
    ...resolver,
    resolve: async (fields, ...args) => {
      for (const field of fields)
        visits.set(field.node, (visits.get(field.node) || 0) + 1);
      return resolver.resolve(fields, ...args);
    },
  });
  const trace = w.JobsDiagnostics.trace;
  w.JobsDiagnostics.trace = (node, entry) => {
    if (entry.result === "decided") {
      const owners = claims.get(node) || [];
      owners.push(entry.decider);
      claims.set(node, owners);
    }
    trace?.(node, entry);
  };
  return {
    visits,
    claims,
    check(root) {
      for (const [node, count] of visits)
        assert.equal(count, 1, "one resolver visit: " + node.id);
      for (const [node, owners] of claims)
        assert.equal(owners.length, 1, "one decider: " + node.id);
      const rows = w.JobsControlFields.create(w.document, () => root).scan();
      for (const row of rows.filter(
        (row) =>
          row.public.filled &&
          row.public.type !== "file" &&
          !initial.has(row.node),
      ))
        assert.equal(
          claims.get(row.node)?.length,
          1,
          "answered field has a decider: " + row.public.question,
        );
      assert(claims.size > 0, "actual decisions were observed");
    },
  };
}
