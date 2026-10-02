"""Join the live Radar snapshot with private application records.

Default output stays in the private Jobs workspace. This never submits applications,
pushes Git, or copies profile facts, receipt IDs, or failure details into the view.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sqlite3
from datetime import datetime, timezone

from application_benchmark import identity

ROOT = Path(__file__).resolve().parents[1]
LABELS = {
    "Submitted": "✅ 已投递",
    "Pending": "⏸ 待处理",
    "Claimed": "⏳ 处理中",
    "Skipped": "⏭ 已跳过",
    "Failed": "⚠️ 失败",
    "Duplicate": "🔎 需核实",
    "Historical": "🔎 需核实",
    "Unknown": "— 无记录",
}
URL_RE = re.compile(r"https?://[^\s<>|`]+")
APPLY_RE = re.compile(r"\[Apply\]\((https?://[^)]+)\)")
LEGEND = (
    "<!-- application-status:start -->\n"
    "> **投递状态**：✅ 已投递 = 已有提交证据；⏸ 待处理 / ⏳ 处理中 = 不要重复申请；"
    "⏭ 已跳过 / ⚠️ 失败 = 先查原记录；🔎 需核实 = 只有历史或重复标记、没有确认回执；"
    "— 无记录 = 本地账本未找到，不等于确定未投。\n"
    "<!-- application-status:end -->"
)


def key(url):
    return identity(url.rstrip(".,);"))


def markdown_events(text):
    """Accept explicit status fields, never a status mentioned inside evidence prose."""
    for line in text.splitlines():
        urls = [u.rstrip(".,);") for u in URL_RE.findall(line)]
        if not urls:
            continue
        cells = [c.strip() for c in line.split("|")]
        status = next((c for c in cells if c in LABELS), None)
        if not status:
            match = re.match(r"^- (?:\*\*[^*]+\*\*:\s*)?(Submitted|Pending|Skipped|Failed|Duplicate)(?:\b|:)", line)
            status = match.group(1) if match else None
        if status:
            for url in urls:
                yield key(url), status


def load_statuses(root):
    statuses = {}
    # Read the older ledgers in chronology; a confirmed submission remains sticky.
    for name in ["wecom-tech-application-queue.md", "github-ten-role-batch-2026-09-08.md",
                 "application-goal-30-2026-09-08.md", "application-goal-50-2026-09-08.md",
                 "application-prior-identities.md", "application-log.md"]:
        path = root / "notes" / name
        if not path.exists():
            continue
        for k, status in markdown_events(path.read_text(encoding="utf-8-sig")):
            if statuses.get(k) != "Submitted":
                statuses[k] = status
    # Current database outcomes supersede older nonterminal notes. Historical
    # imports only prevent an unknown entry from being labelled as unrecorded.
    db = root / "notes/archive/benchmark-2026-09-08/claims.sqlite"
    if db.exists():
        with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True) as con:
            for url, status in con.execute("SELECT url,status FROM roles"):
                k = key(url)
                if statuses.get(k) != "Submitted" and (status != "Historical" or k not in statuses):
                    statuses[k] = status
    current = root / "notes/application-status.json"
    if current.exists():
        for k, entry in json.loads(current.read_text(encoding="utf-8"))["roles"].items():
            if statuses.get(k) != "Submitted":
                statuses[k] = entry["status"]
    # Confirmed same-requisition aliases from application-prior-identities.md.
    aliases = [
        ["https://job-boards.greenhouse.io/twitch/jobs/8751076002",
         "https://job-boards.greenhouse.io/twitch/jobs/8748320002",
         "https://www.amazon.jobs/en/jobs/10515912/software-engineer-i-memberships"],
    ]
    for group in aliases:
        if any(statuses.get(key(url)) == "Submitted" for url in group):
            statuses.update((key(url), "Submitted") for url in group)
    return statuses


def annotate(text, statuses):
    text = re.sub(r"<!-- application-status:start -->.*?<!-- application-status:end -->\n*", "", text, flags=re.S)
    output, counts = [], Counter()
    in_table = False
    for line in text.splitlines():
        if line.startswith("| Company | Role |"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if "投递状态" not in cells:
                cells.append("投递状态")
            output.append("| " + " | ".join(cells) + " |")
            in_table = True
        elif in_table and re.fullmatch(r"[|\s:-]+", line):
            columns = len(output[-1].strip().strip("|").split("|"))
            output.append("|" + "|".join(["---"] * (columns - 2) + ["---:", "---"]) + "|")
        elif in_table and (match := APPLY_RE.search(line)):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) == 7:
                cells.pop()
            if len(cells) != 6:
                raise ValueError("Unexpected Radar columns; inspect the source before changing it")
            status = statuses.get(key(match.group(1)), "Unknown")
            cells.append(LABELS.get(status, LABELS["Unknown"]))
            counts[status] += 1
            output.append("| " + " | ".join(cells) + " |")
        else:
            if in_table and not line.startswith("|"):
                in_table = False
            output.append(line)
    # Keep source content/order intact; only add a column and one legend.
    result = "\n".join(output).rstrip() + "\n\n" + LEGEND + "\n"
    return result, dict(counts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--radar-root", type=Path, default=Path("D:/Projects/new-grad-radar"))
    parser.add_argument("--jobs-root", type=Path, default=ROOT)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "notes/archive/radar")
    parser.add_argument("--record-url", help="Canonical application URL after its outcome has been verified")
    parser.add_argument("--status", choices=["Submitted", "Pending", "Skipped", "Failed", "Duplicate"])
    args = parser.parse_args()
    source, dest = args.radar_root.resolve(), args.output_dir.resolve()
    if source == dest or source in dest.parents:
        parser.error("Output must remain outside the public Radar checkout; use a private output directory")
    if bool(args.record_url) != bool(args.status):
        parser.error("--record-url and --status must be supplied together")
    statuses = load_statuses(args.jobs_root.resolve())
    if args.record_url:
        path = args.jobs_root.resolve() / "notes/application-status.json"
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"version": 1, "roles": {}}
        k = key(args.record_url)
        if statuses.get(k) == "Submitted" and args.status != "Submitted":
            parser.error("A confirmed submission cannot be downgraded by a later attempt")
        data["roles"][k] = {"url": args.record_url, "status": args.status,
                              "updatedUtc": datetime.now(timezone.utc).isoformat()}
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(path)
        statuses = load_statuses(args.jobs_root.resolve())
    dest.mkdir(parents=True, exist_ok=True)
    report = {"generatedUtc": datetime.now(timezone.utc).isoformat(), "files": {}}
    for filename in ("README.md", "INTERNSHIPS.md"):
        text, counts = annotate((source / filename).read_text(encoding="utf-8-sig"), statuses)
        (dest / filename).write_text(text, encoding="utf-8")
        report["files"][filename] = counts
    (dest / "status-summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
