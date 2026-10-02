# First applications-v2 recovery rehearsal

`recover_legacy.py` is an offline conversion, **not a supported online rollback**.
The old release cannot enforce the new submit-attempt/confirmation and per-record
write contracts. It also ignores `.release-maintenance`. Do not attach its
candidate to the live Compose service or expose it to clients.

Inputs are a verified pre-change SQLite backup (for its actual schema) and a
current v2 SQLite database. Use a new bundle directory on the data disk; allow
space for the full current backup, the legacy candidate and a disposable copy
for old-runtime verification. Inputs and existing directories are never replaced.

With the **new** image, network disabled and the data directory mounted:

```text
python /app/deploy/recover_legacy.py --prechange /data/migrations/RELEASE/pre-change.sqlite --current /data/jobs.sqlite --bundle /data/migrations/legacy-rehearsal-UNIQUE
```

The bundle contains `current-v2.sqlite` (complete verified backup), a safe
count/fingerprint report and `candidate.sqlite`. A failed conversion keeps its
backup and `FAILED` marker, and never publishes a completed candidate.

The candidate takes current rows from every compatible shared table, including
Profile revisions, embedded attachments, authorization revocations, new grants,
settings, answers and job collection. Unknown schema differences fail closed.
Jobs/application columns and progress/mail/receipt tables are projected to the
actual old schema. All v2-only information remains in the complete backup.

Only confirmed, nondeleted records enter old `appliedList`. Unknown submissions
retain `submitted_unconfirmed`; deleted records do not reappear. Application
tables and whole-list writes are frozen by triggers. Claims and undo snapshots
cannot replay; browser sessions end and queued/dispatched commands are held.
Diagnostics retain their current redaction; raw values are never reconstructed.

For real old-runtime verification, run the **previous** image with `--network
none`, mount the recovery bundle writable and the new verifier script read-only,
and override its entrypoint to `python /check/verify_legacy_recovery.py /bundle`.
Do not run Compose or the server command. This script starts no HTTP listener,
uses a disposable adjacent copy, constructs the real old server, reads all
confirmed records and Profiles, edits settings/Profile on that copy, and proves
that application writes fail. Its output contains counts only. The candidate
and complete current backup stay unchanged.

This proves evidence-preserving offline recovery and old-code readability. It
does not prove a public rollback, client compatibility or safe resumed automatic
applications. Those require a separately reviewed traffic isolation and writer
compatibility plan. Any real writes after a later switch need their own durable
backup and reconciliation; restoring this rehearsal candidate would lose them.
