export var JobsOptionMatch;
let initialized = false;
export function initializeOptionMatch() {
  if (initialized) return;
  initialized = true;
  (() => {
    const normalize = (value) =>
      String(value ?? "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    // Presentation punctuation only; symbols that carry meaning (C++, C#, 1-2,
    // "No," clauses) are never removed.
    const loose = (value) =>
      normalize(value)
        .replace(/[.!?。！？]+$/u, "")
        .trim();
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // An answer is a string, an ordered list of equivalent aliases, or a spec
    // {tiers:[[preferred...],[fallback...]]}. Earlier tiers always win.
    function spec(answer) {
      if (
        answer &&
        typeof answer === "object" &&
        !Array.isArray(answer) &&
        Array.isArray(answer.tiers)
      )
        return {
          ...answer,
          tiers: answer.tiers
            .map((tier) =>
              tier.filter((alias) => typeof alias === "string" && alias.trim()),
            )
            .filter((tier) => tier.length),
        };
      if (Array.isArray(answer))
        return {
          tiers: [
            answer.filter((alias) => typeof alias === "string" && alias.trim()),
          ].filter((tier) => tier.length),
        };
      return {
        tiers: typeof answer === "string" && answer.trim() ? [[answer]] : [],
      };
    }
    const aliases = (answer) => spec(answer).tiers.flat();
    const describe = (answer) => {
      const tiers = spec(answer).tiers;
      return tiers.length === 1 && tiers[0].length === 1
        ? tiers[0][0]
        : tiers.map((tier) => tier.join(" | ")).join(" → ");
    };

    const contains = {
      // A whole word or phrase inside the label (Workday's legacy policy).
      word: (label, alias) =>
        new RegExp(
          "(?:^|[^\\p{L}\\p{N}])" +
            escape(loose(alias)) +
            "(?=$|[^\\p{L}\\p{N}])",
          "u",
        ).test(loose(label)),
      // Any substring (Greenhouse / iCIMS legacy policy).
      substring: (label, alias) => loose(label).includes(loose(alias)),
    };

    /**
     * labels: visible option labels (strings) or objects with .label.
     * policy.equals(label, alias)  equivalence (default: case/space/punctuation-insensitive)
     * policy.accept(label, index)   caller predicate checked first (original XPath predicates)
     * policy.contains               false | 'word' | 'substring'   fallback when nothing is equal
     * policy.firstMatch            several equal/containing options: take the first instead of refusing
     * policy.firstOption           nothing matched: take the first option (original "allowFirstOption")
     * Returns {index,label,method,alias,tier} or null; null.reason is on pick.last.
     */
    function pick(labels, answer, policy = {}) {
      const items = labels.map((item, index) => ({
        index,
        label: typeof item === "string" ? item : (item?.label ?? ""),
      }));
      const wanted = spec(answer),
        tiers = wanted.tiers;
      // A semantic spec carries its own equivalence (degree punctuation, school
      // campuses) and may allow whole-phrase containment for its preferred tiers.
      const equals =
        policy.equals ||
        wanted.equals ||
        ((label, alias) => loose(label) === loose(alias));
      const containment =
        policy.contains || (wanted.containsTier >= 0 ? "word" : false);
      const containsUpTo = policy.contains ? Infinity : wanted.containsTier;
      const resolve = (matches, method, alias, tier) => {
        if (matches.length === 1 || (matches.length > 1 && policy.firstMatch))
          return {
            ...matches[0],
            method,
            alias,
            tier,
            candidates: matches.length,
          };
        return fail(matches.length ? "ambiguous" : "none", matches);
      };
      let reason = "none",
        ambiguous = [];
      const fail = (why, matches = []) => {
        reason = why;
        ambiguous = matches;
        return null;
      };
      const finish = (result) => {
        api.last = result
          ? { ...result, reason: "matched" }
          : {
              reason,
              ambiguous: ambiguous.map((item) => item.label),
              indexes: ambiguous.map((item) => item.index),
            };
        return result;
      };
      if (wanted.select) {
        const label = wanted.select(items.map((item) => item.label));
        return finish(
          label
            ? resolve(
                items.filter((item) => item.label === label),
                "semantic",
                label,
                0,
              )
            : null,
        );
      }
      if (policy.accept) {
        const matches = items.filter((item) =>
          policy.accept(item.label, item.index),
        );
        if (matches.length)
          return finish(resolve(matches, "predicate", null, -1));
      }
      for (const [tier, list] of tiers.entries())
        for (const alias of list) {
          const matches = items.filter((item) => equals(item.label, alias));
          // Ambiguity at the preferred wording stops: a later, looser alias must
          // never pick one of two equally valid options behind the caller's back.
          if (matches.length)
            return finish(resolve(matches, "exact", alias, tier));
        }
      if (containment) {
        const test = contains[containment];
        for (const [tier, list] of tiers.entries())
          if (tier <= containsUpTo)
            for (const alias of list) {
              if (wanted.containsWhen && !wanted.containsWhen(tier, alias))
                continue;
              const matches = items.filter((item) => test(item.label, alias));
              if (matches.length)
                return finish(resolve(matches, "contains", alias, tier));
            }
      }
      if (
        wanted.fallback === "first-authorized" &&
        typeof wanted.acceptFallback === "function"
      ) {
        const allowed = items.filter((item) =>
          wanted.acceptFallback(item.label),
        );
        if (allowed.length)
          return finish({
            ...allowed[0],
            method: "authorized-fallback",
            alias: null,
            tier: -1,
            candidates: allowed.length,
          });
      }
      if (policy.firstOption && items.length)
        return finish({
          ...items[0],
          method: "first-option",
          alias: null,
          tier: -1,
          candidates: items.length,
        });
      return finish(fail(reason, ambiguous));
    }

    // A component that matches by itself (search lists, virtual lists) notes the
    // options it chose from and how, so the fill trace can explain its choice.
    const notes = new WeakMap();
    const note = (node, { options = [], method = null } = {}) => {
      if (node && typeof node === "object")
        notes.set(node, {
          options: options.slice(0, 60),
          optionCount: options.length,
          method,
        });
    };
    const noted = (node) =>
      node && typeof node === "object" ? notes.get(node) || null : null;
    // last: the most recent pick's outcome, read by the fill trace right after a pick.
    const api = {
      normalize,
      loose,
      spec,
      aliases,
      describe,
      pick,
      note,
      noted,
      last: null,
    };
    JobsOptionMatch = api;
  })();
}
