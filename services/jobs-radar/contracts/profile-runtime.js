// JSON Schema runtime for the keywords used by profile.schema.json.
// Build checks reject unsupported validation keywords before producing an artifact.
function makeProfileContract(schema) {
  const fail = (path, message = "Invalid Profile field") => {
    throw Error(`${path || "Profile"}: ${message}`);
  };
  const object = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  function optionalDate(value) {
    if (value === "") return true;
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    if (!year || month < 1 || month > 12 || day < 1) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return (
      day <=
      [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    );
  }
  const amount = (value) =>
    typeof value === "string" &&
    /^[0-9]+(?:\.[0-9]{1,2})?$/.test(value) &&
    /[1-9]/.test(value);
  const cents = (value) =>
    BigInt(value.split(".")[0]) * 100n +
    BigInt((value.split(".")[1] || "").padEnd(2, "0"));
  function check(node, value, path) {
    if (node.anyOf) {
      if (
        !node.anyOf.some((branch) => {
          try {
            check(branch, value, path);
            return true;
          } catch {
            return false;
          }
        })
      )
        fail(path);
      return;
    }
    const matches = {
      object,
      array: Array.isArray,
      string: (v) => typeof v === "string",
      boolean: (v) => typeof v === "boolean",
      number: (v) => typeof v === "number" && Number.isFinite(v),
      integer: (v) => Number.isInteger(v),
    };
    if (node.type && !matches[node.type](value)) fail(path);
    if (node.enum && !node.enum.includes(value)) fail(path);
    if (typeof value === "string") {
      const length = [...value].length;
      if (
        length < (node.minLength || 0) ||
        length > (node.maxLength ?? Infinity) ||
        (node.pattern && !new RegExp(node.pattern, "u").test(value))
      )
        fail(path);
      if (node.format === "optional-date" && !optionalDate(value)) fail(path);
    }
    if (typeof value === "number" && value < (node.minimum ?? -Infinity))
      fail(path);
    if (Array.isArray(value) && node.items)
      value.forEach((item, index) =>
        check(node.items, item, `${path}.${index}`),
      );
    if (object(value)) {
      for (const key of node.required || [])
        if (!(key in value)) fail(`${path}.${key}`);
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue; // Absent optional form values serialize as omitted JSON members.
        if (node.properties?.[key])
          check(node.properties[key], item, path ? `${path}.${key}` : key);
        else if (node.additionalProperties === false)
          fail(path ? `${path}.${key}` : key);
      }
      for (const rule of node["x-invariants"] || []) {
        if (
          rule.kind === "dateMonth" &&
          value[rule.date] &&
          value[rule.month] !== value[rule.date].slice(0, 7)
        )
          fail(path, rule.message);
        if (rule.kind === "salary" && value[rule.when] === rule.equals) {
          if (
            !/^[A-Z]{3}$/.test(value[rule.currency] || "") ||
            !value[rule.period] ||
            !amount(value[rule.minimum]) ||
            (value[rule.maximum] && !amount(value[rule.maximum]))
          )
            fail(path, rule.message);
          if (
            value[rule.maximum] &&
            cents(value[rule.maximum]) < cents(value[rule.minimum])
          )
            fail(path, "薪资上限不能低于下限。");
        }
      }
    }
  }
  function credentials(value) {
    if (object(value)) {
      if (
        Object.keys(value).some((key) =>
          schema["x-forbiddenKeys"].includes(key.toLowerCase()),
        )
      )
        throw Error("Credentials are not Profile data");
      Object.values(value).forEach(credentials);
    } else if (Array.isArray(value)) value.forEach(credentials);
  }
  function assertProfile(value) {
    credentials(value);
    check(schema, value, "");
    if (
      new TextEncoder().encode(JSON.stringify(value)).length >
      schema["x-maxBytes"]
    )
      throw Error("Profile exceeds 8 MB");
    return value;
  }
  function projectAnswerProfile(value, { partial = false } = {}) {
    if (!object(value)) throw Error("Invalid answer Profile");
    const policies = schema["x-answerProjection"];
    if (partial) {
      if (
        Object.keys(value).some(
          (key) => !policies[key] || policies[key].mode === "exclude",
        )
      )
        throw Error("Invalid answer Profile");
      const defaults = Object.fromEntries(
        schema.required
          .filter((key) => key !== "profileName")
          .map((key) => [
            key,
            schema.properties[key].type === "array" ? [] : {},
          ]),
      );
      assertProfile({ ...defaults, ...value });
    } else assertProfile(value);
    const result = {};
    for (const [key, policy] of Object.entries(policies)) {
      if (policy.mode === "exclude" || value[key] === undefined) continue;
      result[key] =
        policy.mode === "project"
          ? Object.fromEntries(
              policy.include
                .filter((child) => value[key][child] !== undefined)
                .map((child) => [child, value[key][child]]),
            )
          : value[key];
    }
    return structuredClone(result);
  }
  function validate(value) {
    try {
      assertProfile(value);
      return { valid: true, errors: [] };
    } catch (error) {
      return { valid: false, errors: [error.message] };
    }
  }
  return Object.freeze({
    version: schema["x-version"],
    schema,
    options: schema["x-uiOptions"],
    assertProfile,
    validate,
    projectAnswerProfile,
  });
}
