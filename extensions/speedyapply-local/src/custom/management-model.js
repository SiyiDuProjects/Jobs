export var JobsManagementModel;
let initialized = false;
export function initializeManagementModel() {
  if (initialized) return;
  initialized = true;
  (() => {
    const keys = new Set(["settings", "jobsKindProfiles"]);
    const allowed = (k) =>
      keys.has(k) || /^jobsResponses:[a-f0-9-]{36}$/i.test(k);
    const stable = (v) =>
      Array.isArray(v)
        ? v.map(stable)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, stable(v[k])]),
            )
          : v;
    const same = (a, b) =>
      JSON.stringify(stable(a)) === JSON.stringify(stable(b));
    /** @param {Array<{id:string,profileName:string}>} profiles
     * @param {Partial<Record<'intern'|'newgrad',string>>} explicit */
    function mappings(profiles, explicit = {}) {
      const result = { ...explicit };
      for (const [
        kind,
        pattern,
      ] of /** @type {Array<['intern'|'newgrad',RegExp]>} */ ([
        ["intern", /^(intern|internship|实习)$/i],
        ["newgrad", /^(new[ -]?grad|ng|全职)$/i],
      ])) {
        if (result[kind] && !profiles.some((p) => p.id === result[kind]))
          delete result[kind];
        const hits = profiles.filter((p) => pattern.test(p.profileName.trim()));
        if (!result[kind] && hits.length === 1) result[kind] = hits[0].id;
      }
      return result;
    }
    function indexed(list, key) {
      const seen = new Map();
      return new Map(
        (list || []).map((row) => {
          const identity = row?.key ?? "invalid:" + JSON.stringify(stable(row));
          const n = seen.get(identity) || 0;
          seen.set(identity, n + 1);
          return [identity + "#" + n, row];
        }),
      );
    }
    function merge(key, base, local, remote) {
      if (!allowed(key)) throw Error("Unsupported management document");
      if (same(local, base)) return remote;
      if (same(remote, base) || same(local, remote)) return local;
      if (remote === undefined) return local;
      if (local === undefined) return remote;
      if (key.startsWith("jobsResponses:")) {
        const a = indexed(base, key),
          b = indexed(local, key),
          c = indexed(remote, key),
          out = [];
        for (const id of new Set([...c.keys(), ...b.keys()])) {
          const before = a.get(id),
            left = b.get(id),
            right = c.get(id);
          if (same(left, before)) {
            if (right !== undefined) out.push(right);
          } else if (same(right, before) || same(left, right)) {
            if (left !== undefined) out.push(left);
          } else
            throw Error("同一条记录在两处修改，已保留本地修改，请核对后重试");
        }
        return out;
      }
      // Initial bootstrap must not overwrite existing website preferences with
      // extension defaults. Later concurrent preference edits require review.
      if (base === undefined) return remote;
      throw Error("同一项设置在两处修改，已保留本地修改，请核对后重试");
    }
    JobsManagementModel = { allowed, same, mappings, merge };
  })();
}
