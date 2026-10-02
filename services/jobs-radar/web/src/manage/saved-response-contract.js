// One Saved Response contract for content, worker, the legacy editor and website.
// The generated copies embed the server-owned declarative field contract.
export const JobsResponseContract = (() => {
  const rules = {"version":1,"keywordNormalization":"NFKC","keywordCategoryPrefixes":["L","N"],"keywordCharacters":"_","keywordWhitespace":true,"fields":{"keywords":{"type":"keywords","required":true,"minItems":1},"ignore":{"type":"strings"},"key":{"type":"string","required":true,"nonempty":true},"appearances":{"type":"integer","required":true,"minimum":1},"response":{"type":"string","required":true,"trim":true,"nonempty":true},"fromAutofill":{"type":"boolean","default":false},"question":{"type":"string"},"id":{"type":"string"},"jobKey":{"type":"string","nonempty":true}},"appearancesCannotExceedKeywords":true,"questionKeywords":{"categories":["L","N"],"characters":"_","stopWords":["am","an","as","at","be","by","co","do","eg","et","ex","go","he","hi","ie","if","in","is","it","me","mr","my","nd","of","oh","ok","on","or","qv","rd","re","so","th","to","un","up","us","vs","we"],"minimumLetters":2}};
  const cleanPattern = new RegExp(
    "[^" +
      rules.keywordCategoryPrefixes
        .map((category) => "\\p{" + category + "}")
        .join("") +
      rules.keywordCharacters +
      (rules.keywordWhitespace ? "\\s" : "") +
      "]",
    "gu",
  );
  const normalizeKeyword = (value) =>
    value
      .normalize(rules.keywordNormalization)
      .trim()
      .toLowerCase()
      .replace(cleanPattern, "")
      .replace(/\s+/gu, " ")
      .trim();
  const questionRules = rules.questionKeywords;
  const questionPattern = new RegExp(
    "[" +
      questionRules.categories
        .map((category) => "\\p{" + category + "}")
        .join("") +
      questionRules.characters +
      "]+",
    "gu",
  );
  const questionStopWords = new Set(questionRules.stopWords);
  function questionKeywords(question) {
    return [
      ...new Set(
        (
          String(question)
            .normalize(rules.keywordNormalization)
            .toLowerCase()
            .match(questionPattern) || []
        ).filter(
          (word) =>
            ([...word].length >= questionRules.minimumLetters ||
              /^[0-9]+$/.test(word)) &&
            !questionStopWords.has(word),
        ),
      ),
    ];
  }
  function normalizeField(value, rule, name) {
    if (value === undefined) {
      if ("default" in rule) return rule.default;
      if (!rule.required) return undefined;
      throw Error("Missing " + name);
    }
    if (rule.type === "keywords" || rule.type === "strings") {
      if (
        !Array.isArray(value) ||
        value.some((word) => typeof word !== "string")
      )
        throw Error("Invalid " + name);
      const list =
        rule.type === "keywords"
          ? [...new Set(value.map(normalizeKeyword))]
          : [...value];
      if (rule.type === "keywords" && list.some((word) => !word))
        throw Error("Keyword cannot be empty");
      if (list.length < (rule.minItems || 0)) throw Error("Missing keywords");
      return list;
    }
    if (rule.type === "integer") {
      if (!Number.isInteger(value) || value < rule.minimum)
        throw Error("Invalid " + name);
      return value;
    }
    if (typeof value !== rule.type) throw Error("Invalid " + name);
    const result = rule.trim ? value.trim() : value;
    if (rule.nonempty && !result.trim()) throw Error(name + " cannot be empty");
    return result;
  }
  function normalizeRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid saved response");
    // Preserve optional and future metadata through edit/import/save cycles.
    const result = { ...value };
    for (const [name, rule] of Object.entries(rules.fields)) {
      const field = normalizeField(value[name], rule, name);
      if (field !== undefined) result[name] = field;
    }
    if (
      rules.appearancesCannotExceedKeywords &&
      result.appearances > result.keywords.length
    )
      throw Error("Appearances exceed distinct keywords");
    return result;
  }
  function readList(raw) {
    if (!Array.isArray(raw))
      return {
        data: [],
        rejected: [{ index: -1, reason: "Expected a response list" }],
        invalidCount: 1,
      };
    const data = [],
      rejected = [];
    raw.forEach((row, index) => {
      try {
        data.push(normalizeRecord(row));
      } catch (error) {
        rejected.push({ index, reason: error.message });
      }
    });
    return { data, rejected, invalidCount: rejected.length };
  }
  function parseList(raw) {
    const result = readList(raw);
    if (result.invalidCount)
      throw Error(
        "Invalid saved responses at entries: " +
          result.rejected.map((item) => item.index + 1).join(", "),
      );
    return result.data;
  }
  function preserveRejected(raw, next) {
    if (!Array.isArray(raw))
      throw Error(
        "Saved Responses storage is not a list; original data has been preserved",
      );
    const valid = parseList(next);
    // Invalid history is quarantined in place, not silently deleted by an edit
    // of the usable list. Export retains every original entry for repair.
    const replaced = new Set(valid.map((row) => row.key));
    return [
      ...valid,
      ...readList(raw)
        .rejected.map((item) => raw[item.index])
        .filter((row) => !row?.key || !replaced.has(row.key)),
    ];
  }
  function schema(z) {
    const shape = {};
    for (const [name, rule] of Object.entries(rules.fields)) {
      let field;
      if (rule.type === "keywords" || rule.type === "strings") {
        let word = z.string();
        if (rule.type === "keywords")
          word = word
            .transform(normalizeKeyword)
            .refine((value) => !!value, "Keyword cannot be empty");
        field = word.array();
        if (rule.minItems) field = field.min(rule.minItems);
        if (rule.type === "keywords")
          field = field.transform((value) => [...new Set(value)]);
      } else if (rule.type === "integer")
        field = z.number().int().min(rule.minimum);
      else field = z[rule.type]();
      if (rule.trim) field = field.trim();
      if (rule.nonempty)
        field = field.refine(
          (value) => !!value.trim(),
          name + " cannot be empty",
        );
      if ("default" in rule) field = field.default(rule.default);
      else if (!rule.required) field = field.optional();
      shape[name] = field;
    }
    // Keep the Zod object shape so the original editor can extend its fields.
    // Cross-field validation runs at every persistence/import/read boundary.
    return z.object(shape).passthrough();
  }
  // "Why" also introduces stable personal history (leaving a previous job,
  // choosing a major). Only an explicit current employer/role reference makes
  // a manually saved answer local to this application.
  const jobSpecific = (question) =>
    /\b(?:our|this) (?:company|team|role|position|organization|organisation)\b|\b(?:work(?:ing)?|apply(?:ing)?) here\b|\b(?:join(?:ing)?|work(?:ing)? (?:for|with)) us\b/i.test(
      question,
    );
  return Object.freeze({
    version: rules.version,
    questionKeywords,
    normalizeKeyword,
    normalizeRecord,
    readList,
    parseList,
    preserveRejected,
    schema,
    jobSpecific,
  });
})();
