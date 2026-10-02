"""Small local ledger: prevent duplicate real applications and record evidence.

This does not drive a browser, classify forms, or make application decisions.
"""
import argparse
import json
from pathlib import Path
import re
import sqlite3
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "notes" / "benchmark-2026-09-08"
DB = OUT / "claims.sqlite"


def identity(url):
    p = urlsplit(url.strip().rstrip(".,);"))
    host = p.netloc.lower().replace("boards.greenhouse.io", "job-boards.greenhouse.io")
    host = host.replace("job-job-boards.greenhouse.io", "job-boards.greenhouse.io")
    pairs = dict(parse_qsl(p.query))
    if pairs.get("gh_jid"):
        return "greenhouse:" + pairs["gh_jid"]
    if "greenhouse.io" in host:
        match = re.search(r"/jobs/(\d+)", p.path)
        if match:
            return "greenhouse:" + match[1]
    if "ashbyhq.com" in host or "lever.co" in host:
        match = re.search(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", p.path, re.I)
        if match:
            return host + ":" + match[0].lower()
    if "myworkdayjobs.com" in host:
        match = re.search(r"_([A-Za-z]+[-_]?\d+)", p.path)
        if match:
            return host + ":" + match[1].upper()
    query = [(k, v) for k, v in parse_qsl(p.query) if not k.startswith("utm_") and k not in {"source", "gh_src", "embed", "ref"}]
    path = p.path.rstrip("/")
    for suffix in ("/application", "/confirmation", "/apply"):
        if path.endswith(suffix):
            path = path[:-len(suffix)]
    return urlunsplit(("https", host, path, urlencode(query), ""))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["init", "claim", "record", "summary", "key"])
    parser.add_argument("--owner", choices=["astra-medium", "astra-low", "sol-high", "coordinator"])
    parser.add_argument("--url")
    parser.add_argument("--company", default="")
    parser.add_argument("--role", default="")
    parser.add_argument("--status", choices=["Submitted", "Duplicate", "Skipped", "Failed", "Pending"])
    parser.add_argument("--detail", default="")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.action == "key":
        print(identity(args.url))
        return
    con = sqlite3.connect(DB, timeout=30)
    con.execute("CREATE TABLE IF NOT EXISTS roles (key TEXT PRIMARY KEY, owner TEXT, url TEXT, company TEXT, role TEXT, status TEXT, detail TEXT, created TEXT, updated TEXT)")
    con.execute("BEGIN IMMEDIATE")
    now = datetime.now(timezone.utc).isoformat()
    if args.action == "init":
        paths = [ROOT / "notes" / name for name in ["application-log.md", "application-goal-30-2026-09-08.md", "application-goal-50-2026-09-08.md", "github-ten-role-batch-2026-09-08.md", "wecom-tech-application-queue.md", "application-prior-identities.md"]]
        before = con.total_changes
        for path in paths:
            for url in re.findall(r'https?://[^\s<>|`]+', path.read_text(encoding="utf-8-sig")):
                if not any(part in url for part in ["ashbyhq.com", "greenhouse.io", "myworkdayjobs.com", "jobs.lever.co", "careers.roblox.com", "fastly.com/about/jobs", "github.careers", "ats.rippling.com", "careers.lindy.ai/jobs", "app.careerpuck.com/job-board/"]):
                    continue
                con.execute("INSERT OR IGNORE INTO roles VALUES (?,?,?,?,?,?,?,?,?)", (identity(url), "historical", url.rstrip(".,);"), "", "", "Historical", path.name, now, now))
        result = {"historical_identities_seeded": con.total_changes - before}
    elif args.action == "summary":
        result = [dict(zip(["owner", "status", "count"], row)) for row in con.execute("SELECT owner,status,count(*) FROM roles GROUP BY owner,status ORDER BY owner,status")]
    else:
        if not args.owner or not args.url:
            parser.error("--owner and --url are required")
        key = identity(args.url)
        old = con.execute("SELECT owner,status FROM roles WHERE key=?", (key,)).fetchone()
        if args.action == "claim":
            if old:
                result = {"claimed": False, "key": key, "owner": old[0], "status": old[1]}
            else:
                con.execute("INSERT INTO roles VALUES (?,?,?,?,?,?,?,?,?)", (key, args.owner, args.url, args.company, args.role, "Claimed", "", now, now))
                result = {"claimed": True, "key": key, "owner": args.owner}
        else:
            if not args.status or not args.detail:
                parser.error("record requires --status and a concise --detail with evidence/blocker")
            if not old or old[0] != args.owner:
                raise SystemExit("Not owned by this worker; do not apply or overwrite another worker's role")
            if old[1] == "Submitted":
                result = {"recorded": False, "reason": "already Submitted; counted once"}
            else:
                con.execute("UPDATE roles SET status=?,detail=?,updated=? WHERE key=?", (args.status, args.detail, now, key))
                row = con.execute("SELECT company,role,url FROM roles WHERE key=?", (key,)).fetchone()
                event = {"time": now, "owner": args.owner, "company": row[0], "role": row[1], "url": row[2], "status": args.status, "detail": args.detail}
                with (OUT / (args.owner + ".jsonl")).open("a", encoding="utf-8") as f:
                    f.write(json.dumps(event, ensure_ascii=False) + "\n")
                if args.status == "Submitted":
                    with (ROOT / "notes" / "application-log.md").open("a", encoding="utf-8") as f:
                        f.write("\n- " + now + " | " + args.owner + " benchmark | " + row[0] + " / " + row[1] + " | Submitted | " + row[2] + " | " + args.detail.replace("\n", " ") + "\n")
                result = {"recorded": True, "status": args.status}
    con.commit()
    con.close()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
