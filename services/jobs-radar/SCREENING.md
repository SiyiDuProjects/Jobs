# Job screening

One policy (`jobs_radar/screening-policy.json`) defines initial screening and
company preference. Initial screening applies the same occupation, geography,
clearance, citizenship and sponsorship exclusions to both employment kinds.
Missing information is not a rejection. Front-end roles are allowed; there is
no employer blacklist or salary, experience or graduation-date threshold.

Initial screening is evaluated per job. Company selection is evaluated once
per normalized company name, independently of role, location, employment kind
and application outcomes. `company_preferences` stores both selected and
not-selected companies. Case and whitespace variants share a key; subsidiaries
and merely similar names are not guessed to be the same employer. The previous
per-job company cache is retained for recovery but is no longer read or written.

After collection, Luna first screens new/changed jobs, then evaluates only
previously unseen companies in bounded batches. Only company names go into the
company request. Validated company batches commit atomically. Both positive and
negative results are checkpoints, so retries and future days reuse them. Job or
policy changes do not automatically erase a known company decision. Owner edits
via `set_company_preference` are versioned and win over in-flight model results.

The board has independent region and company switches. Region defaults on for
both kinds; company defaults off for full-time and on for internships. All jobs
of one company read the same set membership. Region focus keeps CA/WA/NY/MA/TX,
US remote and unresolved locations, with a visible US-wide exception for source
FAANG+ or selected companies. Explicit narrower regions have no company exception.
Foreign-only exclusion belongs to initial screening, regardless of switches.

For owner-requested historical company backfill, run
`screen-companies --include-history --max-batches 100`. This includes closed
submitted jobs and company names in standalone application records, without
changing job reviews, application states or recruiting events. It does not
reopen closed jobs. Blank company names remain unresolved rather than guessed.
`get_company_preferences` reads the common list and its versions. No per-company
reason, score or tier is shown or stored.

Luna uses existing model knowledge with no browsing tools. Unknown employers
are conservatively not selected; selection is a preference heuristic, not a
verified employer rating. Source FAANG+ labels and received OAs are not selection
criteria. Explicit owner exclusions in the UI remain separate saved preferences.
