# Recovery-content audit and transfer boundaries

The reviewed audit and receiver code is integrated into the local candidate.
No real private workspace archive has been created or transmitted by this
candidate, and no production deployment or backup completion is implied.

Install `requirements-audit.txt` for local full-suite/audit execution. It pins
`pypdf==6.10.0`, whose bounded decoder hooks are covered by the tests. Production
does not need this PDF dependency. Run the seven `test_workspace_*` and related
backup review/deadline/resource test files in `tests/` with the normal test
interpreter. The six Linux-only cases must also run under a bounded Linux
environment; skipping them on Windows is not evidence of Linux behavior.

The original draft red/green logs and exact source manifests remain in the
workspace's `.qa/backup-audit-phase2` and `.qa/backup-linux-review-*` evidence
directories. They contain synthetic fixtures only.

The independent seven-case reproduction first failed in `applications-red.log`.
The fixes recognize JSON/XML by content even under a renamed extension, inspect
ZIP comments, reject unsupported ZIP metadata, enforce JSONL budgets before each
parse, reject unreviewed incremental PDF revisions, and reject additional gzip
members or unmanifested tar suffix data. Unknown PDF history and ZIP extras stay
blocked for review. Originals are retained. An unsupported document is not a
completed backup and is not silently discarded from the review plan.

`audit-reviewed-content.json` is repository-controlled review evidence, separate
from the caller's backup manifest. Its entries bind the exact SHA-256, byte size,
Git object and review basis. Source entries suppress only their specified known
regex false positive; they do not suppress structural findings or approve a
changed file. The null connection placeholder also has to match the restricted
null-assignment grammar. There is no whole-directory exemption.

PNG review validates chunk CRCs/order, known metadata, the complete bounded pixel
stream and an exact visual review. Unknown chunks, text metadata, trailing bytes
and unreviewed image bytes remain blocked. For the reviewed empty-password PDF,
each exact revision prefix is inspected independently and its Prev pointer is
checked. Every xref object, decoded stream, field and attachment is inspected;
all image objects require the exact document's visual review. Signature Contents
and metadata streams follow the standard encryption exceptions, and their bytes
are still inspected. The original encrypted file is never rewritten. This checks
content, not the issuer's cryptographic signature or the document's truth.

SQLite review checks the original header, freelist and page coverage, scans every
physical page including unused/deleted space, and streams all schema/row values.
It neither vacuums nor exports the database. This is a known-credential-marker
scan of physical bytes, not a claim to reconstruct every deleted record or to
detect arbitrary unlabelled secrets. Unknown BLOBs, WAL-mode layouts and virtual
tables remain blocked. Real server snapshots containing auth/session records
need a separate controlled-credential-container decision and unique-record
reconciliation; they must not be assumed eligible because one historical roles
database was inspected.

Archive member accounting has a hard 200,000 limit; parsed structural nodes
have a separate hard 1,000,000 limit. Single inputs remain capped at 256 MiB and
total expansion at 512 MiB. These independent limits allow repeated historical
JSON documents without treating every scalar as another archive file; exceeding
either budget still fails closed. HTML5, TOML, systemd INI and JSONL text logs
use their structured/decoded views as well as the original byte-pattern scan.

On 2026-09-26 the fixed historical bundle with SHA-256
`161c4627e5313f01f228faf4560bc2fa01b47c05caac0c67c06ca19fcafe9287`
was fully inspected locally with these limits: 8,393 member operations, 642,139
structure nodes, 211,324,879 cumulatively expanded bytes and zero findings.
It is obsolete and excludes newer commits and uncommitted originals; this is
not a current-workspace backup or a remote recovery result. Rebuild and re-audit
the final selected scope before any cleanup.

The separate transfer deadline cases first failed in `deadline-red.log`. The
sender now starts its deadline before packing, creates only an already-reviewed
plan in the workspace's private `.qa/recovery-transfer` staging directory, checks
disk headroom, and caps the staged file at 2 GiB. Staging uses mode 0700/0600 on
Linux. A durable receipt contains only its relative archive path and plan/archive
hashes. Normal completion and handled errors clean staging; surviving crash
artifacts block another transfer and require a separate recovery review.

SSH receives an already-verified file descriptor rather than a parent-written
pipe. The total 300-second deadline includes packing and acknowledgement, output
is capped at 64 KiB, and failed Linux transfers terminate their process group.
Actual SSH sending is restricted to WSL until Windows process-tree cleanup is
verified. Local Windows audit/archive remains available. The receiver caps input
at 2 GiB and expanded archive content at 8 GiB, checks the same receive/validation
deadline, and publishes only after full archive validation. These are limits,
not measurements of a production host's available resources.

The Linux remote receiver now sets a permanent 256 MiB address-space ceiling,
a 30 CPU-second budget (with one additional hard-stop CPU second), and a zero
core-dump limit before reading input. It never raises tighter inherited limits.
Synthetic subprocess tests cover allocation failure and the CPU soft-limit
exception: both reject publication, clean their partial file and preserve the
original. A hard kill or machine crash can still leave a private partial file
for recovery review. These limits have not been validated against the intended
real backup or measured free capacity of the shared production host.

JSON inspection rejects duplicate decoded object keys in ordinary JSON, JSONL,
renamed structured text and embedded content. A later empty property therefore
cannot overwrite an earlier escaped credential key during inspection.

Regression inputs are synthetic; the separate exact-content review above reads
the explicitly selected original/historical objects without changing them.
The receipt/temporary local archive is not
the requested verified remote backup; that action requires its separate existing
authorization and final review. No real transfer is part of this test evidence.
