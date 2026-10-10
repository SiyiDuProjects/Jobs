# Jobs Workspace

Private workspace: this Jobs repository, including from a worktree. Resolve paths from the current checkout and host environment; never assume a drive letter, username or operating system. Never publish personal data or store passwords/verification codes. Current personal facts and application attachments belong to the server Profiles. Local recovery archives are not a runtime fact source.

## Restored Mac paths and server SSH

- The restored Mac checkout is `/Users/siyi/Projects/Jobs`; the Windows checkout is `D:/Projects/Jobs`. Resolve paths for the current host.
- Jobs server: `ubuntu@49.51.38.235`; service directory: `/home/ubuntu/siyi/jobs-radar`.
- The Jobs SSH private key is `Siyi.pem`. The migration package includes it at `Mac-migration/Projects/_private/Keys/Siyi.pem`; after restoration on this Mac, use `/Users/siyi/Projects/_private/Keys/Siyi.pem`.
- Check that restored path before reporting a missing key. An empty SSH agent or a missing `~/.ssh/Siyi.pem` does not establish that the restored private-key file is missing. SSH can use it directly with `-i`.
- `services/jobs-radar/deploy/release.sh` defaults to `~/.ssh/Siyi.pem`; on this Mac set `JOBS_RADAR_KEY=/Users/siyi/Projects/_private/Keys/Siyi.pem` for an authorized SSH/deployment task. Keep the existing service-release workflow and keep private-key contents outside Git and logs.

## HeroUI Pro through CollectUI

- Existing HeroUI UI work uses the global `heroui-react-pro` and `heroui-pro-design-taste` skills and the configured CollectUI-backed `heroui-pro` MCP. Use these proactively without requiring the user to name them again.
- Inspect the actual frontend package, including `services/jobs-radar/web` and the extension's shared dependency/build arrangement, before reporting missing components. Keep project versions and delivery commands unchanged.
- Follow the original CollectUI channel and existing project installation workflow; do not substitute official HeroUI account login. MCP/skill availability and installed package artifacts are independent checks. Credentials and authenticated tutorial URLs do not belong in repository instructions.

## Development and application work

This is a development workspace that is also used for applications. Follow the user's current task. For code, architecture or documentation work, read the relevant implementation and evidence; do not routinely fetch personal Profiles or load application handoffs, old ledgers or benchmarks.

For an actual application run, use the installed `jobs-apply` skill. Resolve its `SKILL.md` from the session's skill catalog or `$CODEX_HOME/skills/jobs-apply/SKILL.md` (default Codex home: `~/.codex` on the current host). It owns the operational workflow: get jobs through the native Jobs tools, open them in the requested browser, mark AI ownership before browser writes and use the shared page review surface. The interface reference is `notes/jobs-radar.md`. Editing the skill or workflow never starts or resumes applications by itself. Preserve any live form already in progress.

When a specific investigation needs a personal fact, obtain it from the application's bound server Profile with native `get_profiles`; keep it in memory only while needed. The contract excludes credentials and attachment binary data. Missing access is a blocker, not a reason to reconstruct facts from recovery archives. Later user corrections win. Keep unknown answers and new commitments unresolved.

## Record actual bugs, not routine applications

For an unsupported component, incorrect write, lost value, failed continuation or another concrete bug, the agent owns a focused diagnostic case using `notes/application-ui-repairs.md`, even when the plugin reports no error. Capture enough structure and behavior to reproduce it; redact personal answers and secrets. Keep company scope, priority, status and case links in `notes/ats-platform-cases.json`; regenerate `notes/ats-platform-status.md` with `scripts/generate-ats-index.py` using redacted diagnostic exports. Shared extension/service defects have one shared case referenced by affected platforms. Reuse confirmed matching cases; record new occurrences and affected companies, and link merely similar symptoms as possible duplicates until their mechanism is known. Prioritize incorrect critical answers/duplicate submissions, then blocked flows and recurring multi-company defects, then nonblocking issues. Capture before repair where possible, then continue applications; do not turn the run into a code investigation or refresh/resubmit to obtain evidence.

## Changing the autofill code or the service

- **Explain before changing.** For a wrong or missing fill, first read the current redacted diagnostics from `get_browser_history` detail (or the diagnostics page). Inspect the available field `decision`, `trace` and structural evidence to identify the responsible layer. Any displayed `value`, answer or option text may be synthetic or redacted; it is not a promise of access to the person's original answer. Read authorized facts from the bound server Profile when needed, and never copy raw personal answers into diagnostic evidence. Fix the layer supported by that record.
- **Fix generally.** Never add question-, page- or company-specific prompt clauses, regexes or hard-coded option sets. For a wrong answer, check in order: (1) missing or wrong Profile / saved-answer data — fix the data; (2) a local rule matched the wrong question — make the rule general; (3) the AI misjudged a whole class of questions — adjust the general instructions. Keep the AI answer prompt under 30 lines. AI is the fallback chooser and the person's review is the safety net; do not add prove-before-write gates. All saved answers are inputs to answering.
- Runtime ownership, writer and adapter invariants are documented in `extensions/speedyapply-local/source/ARCHITECTURE.md` and enforced by behavior and structure checks. Use synthetic regressions for the observed mechanism; passing tests do not establish real-page acceptance.
- **Deliver local extension fixes.** A requested fix includes updating the existing local installation: after editing, run `npm run update` in `extensions/speedyapply-local`. It checks the combined source, builds the private package and replaces the fixed `dist` with rollback protection. Do not stop at `npm run build` (candidate only), copy files into `dist`, or directly publish an old candidate. Report a blocked check explicitly rather than calling the fix delivered. Updating local `dist` is part of the authorized repair; it is not a server/store release. Preserve live forms and tell the user to reload the extension; disk update, browser reload and real-page acceptance remain separate evidence.
- **Parallel fixes share one delivery.** Coordinate overlapping edits; integrate worktree changes into the primary checkout before delivery. One agent runs `npm run update` after the participating edits settle. Other agents must not publish their own candidates or remove an active update lock. If source or installed-package checks detect concurrent changes, inspect the change and rerun the full update from the combined source. Tests cannot prove that an unmerged or overwritten source edit was retained; verify the participating fixes before delivery.
- **Service releases** only through `services/jobs-radar/deploy/release.sh` from a committed tree (`--build` to stage, `--rollback` to restore the previous image). Never copy single files to the server.
- Architecture, migrated/retained scope and acceptance: `notes/archive/autofill-architecture-2026-09-23.md`.

## Files used only when needed

`notes/ats-platform-status.md`: compact platform-grouped bug index. Keep one short row per issue with priority, status, company scope and its existing diagnostic link. Preserve user-confirmed working flows; fixed code awaiting real-page verification stays open. Details and deduplicated occurrences belong in the linked case. Read only when relevant.

`notes/jobs-radar.md`: native interfaces, remote review and transport questions. `notes/application-handoff-current.md`: stopped application state, read when applying or investigating that run. `notes/application-ui-repairs.md`: a specific UI failure. Server Profiles: current facts and attachment metadata; private recovery archives are used only for an explicitly scoped recovery task. `notes/benchmark-*`, `notes/archive/radar*`, `.qa/`, `work/`: previous runs, evidence or backups, not startup instructions. The plugin uploads the attachment bound to the selected server Profile; do not reinstate a local resume directory as the normal source. `services/` and `scripts/`: implementation/maintenance.
