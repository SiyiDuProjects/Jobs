"""Collect scoped source data; expose full-time and internship pools."""
import asyncio
import html
import re
import time
import json
import os
from pathlib import Path
from dataclasses import dataclass
from hashlib import sha256

import httpx

from .simplify_scope import category_in_scope
from .scope import STREAM_IDS

@dataclass(frozen=True)
class Stream:
    id: str
    source: str
    kind: str
    url: str
    category: str = ""
    repository: str = ""
    file: str = ""
    cohort: int = 0


def configured_streams(cohort=None):
    config = json.loads((Path(__file__).parents[1] / 'config' / 'collector.json').read_text(encoding='utf-8'))
    cohort = int(os.environ.get('JOBS_COHORT', config['cohort']) if cohort is None else cohort)
    if not 2000 <= cohort <= 2100:
        raise ValueError('Collection cohort must be a four-digit year between 2000 and 2100')
    streams = []
    for kind, template in config['simplify'].items():
        repo = template.format(cohort=cohort)
        streams.append(Stream('simplify:' + kind, 'simplify', kind,
            f'https://raw.githubusercontent.com/{repo}/dev/.github/scripts/listings.json',
            repository=repo, file='.github/scripts/listings.json', cohort=cohort))
    for topic in ('SWE', 'AI'):
        repo = config['speedyapply'].format(cohort=cohort, topic=topic)
        for kind, file in [('internship', 'README.md'), ('newgrad', 'NEW_GRAD_USA.md')]:
            streams.append(Stream(f'speedyapply:{topic}:{kind}', 'speedyapply', kind,
                f'https://raw.githubusercontent.com/{repo}/main/{file}', topic, repo, file))
    if {stream.id for stream in streams} != set(STREAM_IDS):
        raise ValueError('Configured streams do not match the approved source scope')
    return streams


STREAMS = ACTIVE_STREAMS = configured_streams()


def plain(text):
    text = re.sub(r"<br\s*/?>", ", ", text, flags=re.I)
    return html.unescape(re.sub(r"<[^>]*>", "", text)).strip()


def links(text):
    return [html.unescape(u) for u in re.findall(r'href=["\'](https?://[^"\']+)["\']', text)] + re.findall(r"\]\((https?://[^)]+)\)", text)


def base(s):
    return {"source": s.source, "kind": s.kind, "category": s.category, "repository": s.repository,
            "file": s.file, "source_url": s.url, "active": True, "visible": True,
            "description_complete": False, "description": "", "h1b": None,
            "apply_url": None, "apply_url_status": "unresolved", "posted_at": None,
            "time_precision": "unknown", "country_scope": "US source stream; not independently verified"}


def simplify_rows(s, data, *, observed_at=None):
    if not isinstance(data, list):
        raise ValueError("Simplify payload is not a list")
    now = time.time() if observed_at is None else observed_at
    result = []
    for row in data:
        category = category_in_scope(row, s.kind, s.cohort, now)
        if category is None:
            continue
        if (not all(isinstance(row.get(k), str) and row[k].strip()
                    for k in ("id", "title", "company_name", "url"))
                or not isinstance(row.get("locations"), list)
                or any(not isinstance(location, str) for location in row["locations"])):
            raise ValueError("Simplify required field missing or invalid")
        result.append({**base(s), "source_id": row["id"], "title": row["title"], "company": row["company_name"],
                       "collection_scope": "json-three-tracks-v2",
                       "locations": row["locations"], "active": row["active"], "visible": row["is_visible"],
                       "apply_url": row["url"], "apply_url_status": "source_provided",
                       "posted_at": row.get("date_posted"), "updated_at": row.get("date_updated"),
                       "time_precision": "source_timestamp", "category": category,
                       "source_category": row.get("category", ""),
                       "upstream_source": row.get("source"), "sponsorship": row.get("sponsorship"),
                       "terms": row.get("terms", []), "degrees": row.get("degrees", []), "raw": row})
    return result


def speedy_rows(s, content, observed_at=None):
    now = observed_at or time.time()
    section, identity_section, headers, result = "", "", [], []
    for line in content.splitlines():
        if line.startswith("## "):
            identity_section = plain(line.lstrip("# "))
            section, headers = identity_section, []
        elif line.startswith("### "):
            section, headers = plain(line.lstrip("# ")), []
        if not line.startswith("|"):
            continue
        cells = [v.strip() for v in line.strip().strip("|").split("|")]
        if "Company" in cells and "Position" in cells:
            headers = cells
            continue
        if re.fullmatch(r"[|\s:-]+", line) or not headers:
            continue
        if len(cells) != len(headers):
            raise ValueError("SpeedyApply column drift")
        row = dict(zip(headers, cells))
        apply_links = links(row.get("Posting", row.get("Application", row.get("Apply", ""))))
        if not apply_links:
            # Header names are contractually mapped; a changed apply heading must fail, not drop rows.
            apply_links = [u for k, v in row.items() if "apply" in v.lower() for u in links(v)]
        if not apply_links:
            raise ValueError("SpeedyApply data row lacks application URL")
        apply_url = apply_links[0]
        age = plain(row.get("Posting Age", row.get("Age", "")))
        age_match = re.fullmatch(r"(\d+)d", age)
        anchor = re.sub(r"[^\w\s-]", "", section.lower()).strip().replace(" ", "-")
        # Preserve existing source IDs while correctly recording ### subsections.
        result.append({**base(s), "source_id": sha256((identity_section + "|" + apply_url).encode()).hexdigest()[:24],
                       "source_category": s.category,
                       "category": "Quant" if section == "Quant" else ("Software" if s.category == "SWE" else "AI/ML/Data"),
                       "title": plain(row["Position"]), "company": plain(row["Company"]),
                       "locations": [plain(row.get("Location", ""))], "salary": plain(row["Salary"]) if "Salary" in row else None,
                       "apply_url": apply_url, "apply_url_status": "source_provided", "section": section,
                       "source_url": f"https://github.com/{s.repository}/blob/main/{s.file}#{anchor}",
                       "posting_age": age, "posted_at": now - int(age_match[1]) * 86400 if age_match else None,
                       "time_precision": "approximate_day" if age_match else "unknown", "raw": row})
    if not result:
        raise ValueError("SpeedyApply no parseable job tables")
    return result


async def request(client, method, url, **kwargs):
    for attempt in range(3):
        try:
            response = await client.request(method, url, **kwargs)
            if response.status_code in {429, 500, 502, 503, 504} and attempt < 2:
                try:
                    delay = min(30, max(1, float(response.headers.get("Retry-After", 2 ** attempt))))
                except ValueError:
                    delay = 2 ** attempt
                await asyncio.sleep(delay)
                continue
            response.raise_for_status()
            return response
        except (httpx.TimeoutException, httpx.NetworkError):
            if attempt == 2:
                raise
            await asyncio.sleep(2 ** attempt)


async def fetch_stream(client, stream):
    response = await request(client, "GET", stream.url)
    if stream.source == "simplify":
        return simplify_rows(stream, response.json())
    return speedy_rows(stream, response.text)


async def collect(store, selected=None):
    import secrets
    if selected and not set(selected) <= set(STREAM_IDS):
        raise ValueError("Only the four approved repositories may be collected")
    run_id, now = secrets.token_hex(12), time.time()
    with store.connect(True) as c:
        old = c.execute("SELECT * FROM locks WHERE name='collector'").fetchone()
        if old and old["expires"] > now:
            raise ValueError("Collector already running")
        c.execute("INSERT INTO locks VALUES('collector',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires", (run_id, now + 3600))
    results = []
    try:
        async with httpx.AsyncClient(timeout=45, follow_redirects=False, headers={"User-Agent": "JobsRadar/0.1 (+https://jobs.siyidu.com)"}) as client:
            for stream in ACTIVE_STREAMS:
                if selected and stream.id not in selected:
                    continue
                try:
                    if store.storage_health()["low_disk"]:
                        raise ValueError("Collection paused: less than 1 GiB free disk space")
                    rows = await fetch_stream(client, stream)
                    count = store.ingest(stream.id, rows, run_id, scoped_only=True)
                    results.append({"stream": stream.id, "count": count, "ok": True})
                except Exception as e:
                    # Do not log request URLs, response bodies or arbitrary exception content.
                    error = f"{type(e).__name__}: {e}" if isinstance(e, ValueError) else type(e).__name__
                    store.source_error(stream.id, error, run_id)
                    results.append({"stream": stream.id, "ok": False, "error": error})
                with store.connect(True) as c:
                    c.execute("UPDATE locks SET expires=? WHERE name='collector' AND owner=?", (time.time() + 3600, run_id))
                print(__import__("json").dumps(results[-1]), flush=True)
        store.prune_snapshots()
    finally:
        with store.connect(True) as c:
            c.execute("DELETE FROM locks WHERE name='collector' AND owner=?", (run_id,))
    return results
