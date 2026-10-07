import { JobsMatchRules } from "./job-match-rules.js";
export var JobsJobMatch;
let initialized = false;
export function initializeJobMatch() {
  if (initialized) return;
  initialized = true;
  (() => {
    const rules = JobsMatchRules;
    // Marketing/referral parameters never identify a posting (jobs_radar/job_match.py).
    const tracking =
      /^(?:utm_.*|gh_src|gclid|fbclid|msclkid|mc_[ce]id|_ga|lever-(?:source|origin).*|ref|refid|referrer|source|src|trk)$/i;
    const normalizedHost = (value) => {
      let host = value.toLowerCase();
      if (host.startsWith("www.")) host = host.slice(4);
      return host === "boards.greenhouse.io"
        ? "job-boards.greenhouse.io"
        : host;
    };
    // Python's urlencode: spaces become +, and only unreserved characters stay literal.
    const encode = (value) =>
      encodeURIComponent(value)
        .replace(
          /[!'()*]/g,
          (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
        )
        .replace(/%20/g, "+");
    function key(value) {
      try {
        const u = new URL(value);
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password
        )
          return null;
        const host = normalizedHost(u.hostname);
        for (const rule of rules) {
          if (!new RegExp(rule.host).test(host)) continue;
          let parts = [];
          if (rule.name === "greenhouse") {
            parts = u.pathname.includes("/embed")
              ? [u.searchParams.get("for"), u.searchParams.get("token")]
              : u.pathname.match(/^\/([^/]+)\/jobs\/([^/]+)/)?.slice(1) || [];
            // A tenantless embed is identifiable but cannot justify a company merge.
            if (
              !parts[0] &&
              parts[1] &&
              /^\/embed\/job_app\/?$/.test(u.pathname)
            )
              return JSON.stringify([host, "greenhouse_embed", parts[1]]);
          } else if (rule.query)
            parts = rule.query.map(
              (keys) =>
                keys.map((k) => u.searchParams.get(k)).find(Boolean) || "",
            );
          if ((!parts.length || !parts.every(Boolean)) && rule.pattern)
            parts = u.pathname.match(new RegExp(rule.pattern))?.slice(1) || [];
          if (parts.length && parts.every(Boolean))
            return JSON.stringify([
              host,
              rule.name,
              ...(rule.lowercaseParts
                ? parts.map((part) => part.toLowerCase())
                : parts),
            ]);
          // A generic identifier rule does not own its host; keep looking.
          if (!rule.fallthrough) return null;
        }
        const pairs = [...u.searchParams]
          .filter(([k]) => !tracking.test(k))
          .sort(([a, x], [b, y]) =>
            a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0,
          );
        return JSON.stringify([
          host,
          "exact",
          u.pathname.replace(/\/+$/, "") || "/",
          pairs.map(([k, v]) => encode(k) + "=" + encode(v)).join("&"),
          u.hash.slice(1),
        ]);
      } catch {
        return null;
      }
    }
    const same = (a, b) => {
      const k = key(a);
      return !!k && k === key(b);
    };
    // Saved answers reuse the employer tenant, while application identity stays
    // posting-specific. Derive from old keys too, without rewriting private data.
    function companyFromKey(value) {
      try {
        const parts = JSON.parse(value);
        if (
          !Array.isArray(parts) ||
          parts.length < 3 ||
          parts.some((part) => typeof part !== "string" || !part)
        )
          return null;
        const [host, kind, identity] = parts;
        const company = (tenant) => JSON.stringify([host, "company", tenant]);
        if (
          kind === "greenhouse" &&
          parts.length === 4 &&
          /(^|\.)greenhouse\.io$/.test(host)
        )
          return company(identity);
        if (
          kind === "smartrecruiters" &&
          parts.length === 4 &&
          host === "jobs.smartrecruiters.com"
        )
          return company(identity);
        if (
          kind === "adp" &&
          parts.length === 4 &&
          /(^|\.)adp\.com$/.test(host)
        )
          return company(identity);
        if (
          kind === "path" &&
          /^(?:jobs\.(?:eu\.)?lever\.co|jobs\.ashbyhq\.com|apply\.workable\.com|ats\.rippling\.com)$/.test(
            host,
          )
        ) {
          const tenant = identity.match(/^\/([^/]+)\/[^/]+/)?.[1];
          return tenant ? company(tenant) : null;
        }
        // Only known company-owned hosts qualify. Shared ATS roots, job boards,
        // tenantless embeds and unknown URL shapes never imply one employer.
        if (
          kind === "workday" &&
          /^[^.]+\.wd\d+\.(?:myworkdayjobs|myworkdaysite)\.com$/.test(host)
        )
          return company(host);
        if (
          [
            "icims",
            "eightfold",
            "taleo",
            "oracle",
            "avature",
            "pinpoint",
            "path",
          ].includes(kind) &&
          /^[^.]+\.(?:icims\.com|eightfold\.ai|taleo\.net|avature\.net|pinpointhq\.com|bamboohr\.com|breezy\.hr|applytojob\.com|theresumator\.com|freshteam\.com)$/.test(
            host,
          ) &&
          !/^(?:www|jobs|careers|apply|app|ats)\./.test(host)
        )
          return company(host);
        if (
          kind === "oracle" &&
          /^[^.]+\.fa\.[^.]+\.oraclecloud\.com$/.test(host)
        )
          return company(host);
        if (
          [
            "microsoft",
            "amd",
            "tesla",
            "tiktok",
            "amazon",
            "google",
            "bytedance",
            "apple",
            "meta",
            "greenhouse_custom",
          ].includes(kind)
        )
          return company(host);
        return null;
      } catch {
        return null;
      }
    }
    JobsJobMatch = Object.freeze({
      key,
      same,
      companyFromKey,
      tracking: (name) => tracking.test(name),
    });
  })();
}
