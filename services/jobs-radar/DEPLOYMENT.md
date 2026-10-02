# Deployment verification

## Release process — 2026-09-23 (current)

Releases are git commits: `services/jobs-radar/deploy/release.sh` (clean tree required) stages the commit, builds `jobs-radar:<commit>`, takes an online database backup and a code archive, switches only `mcp`, waits for health and restores `jobs-radar:previous` automatically on failure. `--build` stages without switching; `--rollback` restores the previous image. The live directory holds exactly one commit's files (`RELEASE`), plus `data/` and the website build in `jobs_radar/static` (not in git). No single-file copies.

First release `db0b3b53c5c2`: job resolution with website-hint corroboration (own site or the ATS behind the company's careers hub), shared key normalization and new ATS rules, `/api/extension/resolve`, per-field fill decisions in browser history. Dry run on a production copy: 7/7 historical unmatched deletions resolve to their launched job; 3 of 9 unmatched receipts now match (the rest are jobs not on the board); 7 new alias groups, all the same posting. Health and public checks passed; unauthenticated resolve 401. Rollback drill: previous image healthy (public 200), then re-released healthy.

Incident, same day: the first two releases nested the website build (`static/static`), so `/assets/board.js` returned 500 and the site was blank while the API worked. `3f8511f5a4cd` fixed the stage step (replace, assert layout) and the health check now also requires `/assets/board.js`; `previous` points to the known-good `before-rebuild-20260923` image. Current release: `3f8511f5a4cd`.

Cleanup: 63 legacy release directories/tarballs archived to `/home/ubuntu/siyi/jobs-radar-archive/legacy-release-dirs-20260923.tgz` (2,284 entries verified) and removed; image tags reduced to `0.1.0`, the current commit, `previous`, `before-rebuild-20260923`. Pre-rebuild database and code copies are in the same archive directory, outside backup pruning. Entries below describe the earlier file-copy releases.

## Agent recording responsibilities — 2026-09-22

Deployed only MCP instructions/descriptions in `jobs_radar/server.py`: routine plugin applications/remote review do not require per-job claims or duplicate result writes; agents still capture concrete failures and unsupported components the plugin misses. Evidence-based correction of existing records retains the actual lease/version/reconciliation contracts. AST comparison confirmed no executable behavior or schema/annotation change; 51 existing authenticated MCP/control/history tests passed. Isolated candidate and running registry contain 25 tools; health and native browser read passed.

Running SHA-256 `a875b6479571a960f0a61f745dac8f217fb02281a047f9831f5db794090dbe17`; exact preimage `43fe4c04be1bfb96d4b819c12d54403c138749565974b4e15a1b8366f386f37a`. Rollback `.releases/agent-recording-20260922/previous.py` and `jobs-radar:before-agent-recording-20260922`. Existing ChatGPT connection refreshed and visibly advertises the new four affected tool descriptions. Installed skill and platform bug index updated. Current-turn preloaded descriptions may require the next context load; actual application behavior was not exercised. Details: `../../notes/ats-bugs/2026-09-22-shared-agent-recording-contract.md`.

## Connector metadata repair — 2026-09-22

Post-restart acceptance: executing Codex now loads all 25 tools; native `get_browser_pages` returned successfully with observation and execution enabled. No ATS tabs were open and the page list was empty. Native discovery/read is verified; AI answer/confirmation execution is not yet exercised. This supersedes the pre-restart tool-context limitation below.

Production registered 25 MCP tools with browser observation/control enabled, but the existing ChatGPT developer-mode connection and current Codex turn both exposed 18. Refreshed the existing Jobs Radar connection in ChatGPT: 25 definitions now persist after reloading its settings page, including `get_browser_pages`, `get_browser_history`, `command_browser_page` (`answer_review` / `confirm_review`), and `get_browser_command`. Existing OAuth and approval defaults were unchanged. A native existing `get_service_status` call succeeded. The active turn still exposes 18 tools; new-context native browser read/review validation remains pending. No server deployment or application action occurred in this metadata repair. Evidence: `../../notes/archive/mcp-tool-discovery-2026-09-22.md`.

MCP release acceptance must separately verify deployed definitions, saved connector definitions after **Refresh**, and actual calls from the executing conversation. Server health or an in-container schema check alone does not establish that an agent can use newly added tools.

## GPT-6 Luna — 2026-09-22

Updated the shared model constant to `gpt-6-luna`, covering collector screening and application answers. Preserved the official Responses endpoint, low reasoning, schemas, prompts, storage settings and existing server credential. Related local tests: 21 passed. Two real provider calls using fictional screening/profile inputs passed; the answer test used a temporary database and neither test modified production application data.

Deployed only `jobs_radar/luna_screening.py` on top of the verified live image after checking no active answer jobs, browser commands or screening lock. Both runtime imports report the new model, service health passed, and the collector's shared image tag points to the new image. Source SHA-256: `b44c68447a0f386ee5cc70d160710885624dc41b66319db66bed4ecbc687d2d8`. Rollback: `.releases/luna6-20260922/previous.py`, image `jobs-radar:before-luna6-20260922`. No extension rebuild/reload is needed for this server-side model change.

## Remote review capacity — 2026-09-22

Deployed only `jobs_radar/browser_control.py` from the verified running image: 8 MiB control request cap and 5,000 options per field. Before activation, checked no recent pending AI jobs or live browser commands; recreated only mcp with rollback retained. Running SHA-256 `486effbc931494a08b6026fe528a1cab447b318487930b5b5a907fd14e65d9ce`, healthy. A network-isolated candidate with a temporary database accepted a 5,000-option review and queued its fixture answer. Related backend tests: 49 passed.

Public HTTP checks using the existing Jobs-Audit client identity: health 200, missing control authentication 401, authenticated 614,479-byte deliberately invalid schema 400 (past the former size limit, no application/session writes). Rollback: `.releases/application-flow-20260922/previous.py`, image `jobs-radar:before-application-flow-20260922`. Extension full suite: 957 passed; fixed-path package `ddaa0fd579dd36bc`, existing Chrome reload and real-page review remain separate. Detailed evidence: `../../notes/ats-bugs/2026-09-22-greenhouse-ashby-remote-review-budget.md`.

## Automatic job identity and deletion matching — 2026-09-21 PDT

Deployed the scoped requisition matching and source-alias fix using an image derived from the existing live image. New ingestion reuses existing matched IDs; deletion/restore and receipts handle validated same-job aliases. Workday application steps, Microsoft, Waymo, AMD and iCIMS URL variants share the server/extension rule file. No title-based merge. Preserved explicit resets, claim fences, undo windows and original application/audit rows.

Candidate image: 95 backend tests passed in a network-isolated container. Extension targeted tests: 34 passed. Live consolidation automatically merged 148 groups, with zero remaining same-key duplicate groups and 13,981 original application rows unchanged; integrity check passed. All 13 recent unmatched removal URLs now resolve without replaying their actions. Authenticated MCP and direct board/overview reads passed. Local service health returned 200; plain public HTTP probes returned 403, and browser control disconnected before UI acceptance, so a real popup deletion was not verified.

Backup: `/data/backups/before-identity-20260921-1790053457.sqlite`; previous image `jobs-radar:before-identity-20260921`; release/manifest/source backups `/home/ubuntu/siyi/jobs-radar/.releases/identity-20260921`. Only mcp was recreated. Extension fixed-path build `db7066d4eb11cf49` awaits user reload after preserving any active form. Full evidence: `../../notes/archive/job-identity-fix-2026-09-21.md`.

## Recoverable extension answer requests — 2026-09-21 PDT

After explicit user approval, deployed only `jobs_radar/web.py` and new `jobs_radar/answer_jobs.py` to the existing Jobs service. The new authenticated `/api/manage/answer/jobs` endpoint creates and polls idempotent answer tasks; the old `/api/manage/answer` route remains compatible. Added the task table without modifying Profile/application data. Activation checked for recent in-flight answers and restarted only the mcp container; it is healthy.

Public HTTPS checks passed for health (200), missing auth (401), authenticated unknown task and invalid ID (400), and retained legacy route authentication (401). Deployed source hashes match the uploaded two-file archive. No model generation or application write was used for verification. Rollback source: `.releases/answer-jobs-20260920/previous/web.py`; image: `jobs-radar:before-answer-jobs-20260920`. At the user's request, the extension now publishes to the existing `extensions/speedyapply-local/dist` (build `b3e391b35506162a`), retaining one previous package; users reload the existing extension without reinstalling or selecting another directory. This deployment did not reload the user's extension or active ATS pages. Full evidence: `notes/archive/extension-skills-fix-2026-09-20.md` at the workspace root.

## Backup retention and server cleanup — 2026-09-17 PDT

At the user's request, database backups now retain the three most recent recovery points across scheduled `jobs-*.sqlite` and pre-change `.sqlite`/`.sqlite.gz` files. The daily backup task creates a fresh online backup, verifies all three retained databases with SQLite integrity checks, then removes older database backups and their sidecars. Small JSON operation/audit records are preserved. Additional pre-change backups are pruned on the next successful daily run; avoid creating unnecessary full copies.

The first live run succeeded, removed 34 older database backups (10,452,071,242 bytes), and reduced `data/backups` to 968 MiB. Retained at cleanup: `jobs-20260918T031818Z.sqlite`, `pre-manage-20260917.sqlite`, and `pre-profile-autoconnect-20260917.sqlite`; future runs rotate these names. Older backup-retention claims below describe historical verification, not current file availability. Jobs Radar health returned `ok: true`.

The separately authorized sub2api removal deleted its container, dedicated data directory, image and approximately 12 GiB container log, and removed its service/dependency definitions from current and historical shared Compose files. Other services were preserved. Server disk usage after both cleanups: 53%, approximately 23 GiB available.

## Private board and initial-screening interface — 2026-09-15

Deployed the private full-time/internship website at the existing domain, then simplified it with CollectUI-distributed HeroUI Pro components. Persistent deleted tags, a 24-hour recycle view, shared application history, private browser pairing and four new MCP tools are live. 28 tests, production UI build, public OAuth/API smoke and actual browser login passed; all prior application rows were preserved. ChatGPT plugin tool definitions were refreshed from 9 to 13. See `BOARD-2026-09-15.md` for scope, cloud Work scheduling status and rollback evidence.

## Scope reduction — 2026-09-14 PDT

Deployed after explicit user approval. Four GitHub repositories still provide six full-time/internship streams; Simplify now admits only the three agreed README sections before ingestion. SpeedyApply subsection labels and normalized GitHub track filters are corrected. All six streams and both kinds with each of the three tracks passed live MCP checks. Pruned 35,897 unused retired source observations while preserving all 321 touched applications and audit/deduplication records. Verified fresh backups and rollback image/code are retained; the hourly timer is active. Full evidence and limits: `SCOPE-2026-09-14.md`.

## Original deployment — 2026-09-09

## Current state

Backend and public HTTPS deployed and verified. Jobs Radar is installed in ChatGPT developer mode with OAuth, and ChatGPT lists all nine tools. The real ChatGPT read-only acceptance check passed. No local Codex plugin was created. The old ChatGPT scheduled task was deleted on 2026-09-09 after explicit action-time confirmation; the task list now excludes it.

- Source: `D:/Projects/Jobs/services/jobs-radar`.
- Server: `ubuntu@49.51.38.235`, `/home/ubuntu/siyi/jobs-radar`.
- Live remote MCP: `https://jobs.siyidu.com/mcp`.
- ChatGPT application ID: `asdk_app_6aa1489a7f6c8191b92936c8ee01af76`; version `asdk_app_v_6aa1489a7f7481918dbc31853075c256`, development mode, OAuth.
- Running container: `jobs-radar-mcp-1`, healthy, loopback `127.0.0.1:8796` only.
- Collection: `jobs-radar-collect.timer`, enabled and active, hourly with jitter.
- Backup: `jobs-radar-backup.timer`, enabled and active, daily at 03:25 UTC.
- Latest ChatGPT-verified cloud snapshot: 43,349 canonical records from 45,999 observations; all 11 streams fresh. These are source identities, not a guarantee of unique employer requisitions.
- User-authorized private import: 305 minimal historical identities retained; 189 matched collected jobs (59 submitted, 69 needs input, 17 failed, 44 skipped). No new ATS applications were made.

## Verification evidence

- 16 tests passed on Windows and isolated Linux; Linux test container had no network or production data mount.
- Follow-up trial found numeric Workday requisition aliases across locale/site paths. A targeted history-import fix preserves current job IDs and matches only exact tenant + requisition; its new test passes, and the full Windows suite now has 17 passing tests. Deployed after `pre-legacy-alias-20260909.sqlite` backup; reimport of the same authorized 305 records protected six additional matching jobs. General cross-source title matches and unresolved Jobright links still need official URL checking.
- Real server HTTP OAuth flow passed: discovery, DCR, browser consent/owner approval, PKCE, token exchange, MCP initialization and nine-tool discovery.
- Real authenticated search returned three jobs; read scope rejected a write tool; temporary grant revocation succeeded.
- Public HTTPS smoke passed: OAuth, nine tools, eleven fresh sources, authenticated search, write rejection under read-only scope, and test-grant revocation.
- Real Chrome OAuth completed and ChatGPT displayed **Jobs Radar installed**; refreshing actions displayed all nine tools with read/write classifications.
- Browser-only consent issues were fixed: `Referrer-Policy: strict-origin` preserves the form POST Origin check; CSP allows the registered callback origin so Chrome can follow the OAuth 303. CSRF, browser binding, PKCE and owner approval remain enforced. References: [MDN Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy), [MDN form-action](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action).
- Container restart preserved database records.
- Online SQLite backup passed integrity checking. A separate restored copy passed integrity, job/application counts and search comparison. The live database was not replaced and the host was not rebooted.
- Backup: server-private `data/backups/jobs-verification-20260909.sqlite`.
- Off-host copy: private, Git-ignored `data/backups/server-20260909.sqlite` in this workspace; transfer SHA-256 and SQLite integrity both verified. This is a one-time copy, not a scheduled off-host backup.
- Service database approximately 240 MB; free server disk approximately 7.56 GB at verification. Historical snapshots retain 30 days plus the current payload. Collection pauses below 1 GiB free disk.
- Token cleanup was rejected by automatic approval review as potentially affecting legitimate sessions. The cleanup was removed from the rehearsal; no existing token records were deleted by that operation. Tokens belonging to a missing client cannot authenticate.

## Connection and cutover

1. Cloudflare login completed following the user's explicit confirmation. The existing `gaid` Tunnel is healthy and its eleven routes have been captured in `work/jobs-radar/tunnel-routes-before.json`.
2. Following explicit action-time approval, saved `jobs.siyidu.com -> http://localhost:8796`. Cloudflare reported both route and DNS creation success. The twelve-route table preserved all eleven previous entries and the 404 catch-all.
3. Ran `deploy/smoke.py` through public HTTPS without `--internal`; all checks passed.
4. Created **Jobs Radar** in ChatGPT developer mode, completed the approved trust/OAuth flow, matched the actual browser request to the server and granted only `jobs:read applications:write`. ChatGPT displayed installation success and all nine actions after refresh.
5. Read-only acceptance conversation: `https://chatgpt.com/c/6aa14a71-eb94-83ea-b98e-55e3e2036010`. Actual calls to `get_service_status`, `get_filter_options` and `search_jobs` passed, without claims, result writes or ATS activity.
6. Replacement verification is complete. The automation tool returned `not_found` for the old ChatGPT cloud task; it remains visible in the browser. Exact target: **New Grad 求职雷达**, ID `6a9db083c8f48191871a5790a9df2189`. Its prompt was backed up to `work/jobs-radar/old-automation.md`. User confirmed; browser deletion completed and the task list verified the exact task is absent. The public GitHub repository and unrelated tasks remain.

## Operating notes

Use the MCP as the private queue and outcome ledger. Browser execution still requires an active, authorized task and confirmed application facts. `not_started` is not proof of never applying. Jobright records without official ATS links still need duplicate checks before application. Source category names and California substring matches are not verified eligibility.

The local Jobs ledgers are a point-in-time import, not a bidirectional synchronization service. Existing local application instructions still require checking their newer outcomes. When applying through another task, write the final outcome to both its required local ledger and the MCP; do not assume an unrelated local application will automatically appear on the server.

The collector does not maintain the old public README or generate daily chat briefings. The replacement is the agreed private searchable database and hourly collection. Scheduled backups are on the same server; off-host copies need a separate cadence if continuous disk-loss protection is required.
# September 21 remote AI review card

Deployed `jobs_radar/browser_control.py` and `jobs_radar/server.py` for `answer_review` / `confirm_review` over the existing authenticated opt-in channel. Checked production source preimages and no recent pending answer jobs or active commands. Only mcp was restarted; healthy and HTTP 200. An isolated temporary-database smoke verified current MCP action schemas, review payload validation and at-most-once dispatch; no real browser commands or production application writes. Rollback source: `.releases/remote-review-20260922/previous`; image: `jobs-radar:before-remote-review-20260922`. Extension build `db7066d4eb11cf49` is in the fixed local dist; Chrome reload and page activation remain user-required because Browser Use blocked the extensions-management URL.
