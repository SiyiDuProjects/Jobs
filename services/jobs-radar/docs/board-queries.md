# Job browsing and application progress

The job board shows submission state only. A confirmed submission has a green
“已投递” badge; subsequent replies, assessments and interviews belong to the
applications view. Its row labels describe progress (“等待回复”, “面试”, etc.).
The underlying submission ledger, confirmation requirements and undo checks
are unchanged by this presentation boundary.

The board toolbar has date/search, an unsubmitted-only toggle, and independent
region/company toggles. Excluded companies are edited separately. Retired fine
filters are removed when loading saved preferences, without dropping company
exclusions or explicit region choices. Today and last-seven-day presets use local
calendar days; custom ranges include their end date.

Opening an application link no longer writes tracking data. The recent-opened
card, batch mark/undo UI, opened action and browsing queries for opened history
are retired. Per-job manual submission and its versioned undo remain available.
Existing legacy opened-history storage is left untouched for rollback; the new
runtime neither creates nor reads it.

## Query path

`board_index.py` maintains rebuildable SQLite browsing fields from observations,
source visibility and title overrides. It stores normalized names, geographic
matches, provisional role classification, fingerprints and sort dates. It does
not duplicate descriptions, raw source evidence, Profiles or application records.

SQLite triggers enqueue affected job IDs. `Store.connect` refreshes those IDs
inside the writer's transaction before commit. Unchanged collector snapshots do
not toggle every source absent/present. Other-process writes use the same triggers;
queued external writes and future publication dates are checked on the next
connection. The derived-rule signature rebuilds the index on code changes or a
rollback. Source observations remain authoritative.

`board_query.py` has one SQL predicate for list rows and filter counts. Database
queries apply filtering, counting, ordering and pagination; only the requested
page is decoded for display. Current application state, screening, company
preferences, role decisions and expiring undo permission are joined at read time.
Counts and rows in a list response share a read transaction. Screening tools can
still explicitly request full source evidence through `Board._rows`.

There is no server response cache or Redis dependency. Normal reads do not rerun
classification, recompute fingerprints or issue one progress query per job.
Blocking board and management work runs in a bounded worker pool.

## Browser loading

The toolbar uses the counts already included with each list response; it does
not fetch separate filter totals or calculate draft previews. Header counts use the
authenticated `/api/application-counts` endpoint with browser-local day/week
boundaries, independent of Profile loading. `/api/manage/state?applications=0`
omits application history and pending recruiting mail; the default response
remains compatible with existing clients. The website requests the full response
only while the applications view is active and discards it on leaving that view.
Read and write acknowledgements respect the active view. Late responses cannot
restore an earlier view's history or overwrite newer edits.

## Verification

`tests/test_board_queries.py` covers repeated reads, unchanged ingestion,
cross-connection writes, rollback, future sources, expiry, company exceptions,
small authenticated summaries and event-loop responsiveness. Existing board,
geography, screening, title and application tests retain their business rules.
Browser tests cover submission-only badges, progress labels, navigation races,
manual marking/undo, date shortcuts and selecting visible adjacent-month dates.

A local comparison using 16,000 synthetic jobs returned identical list/count
results before and after the change. With a date filter, median computation fell
from approximately 248/486 ms (list/counts) to 8/7 ms; across all dates it fell from
257/510 ms to 18/26 ms. These are local synthetic measurements, not production or
browser end-to-end latency. Production release and live acceptance are separate.
