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
    JobsJobMatch = Object.freeze({
      key,
      same,
      tracking: (name) => tracking.test(name),
    });
  })();
}
