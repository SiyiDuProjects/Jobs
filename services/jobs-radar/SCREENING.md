# Job screening

One policy (`jobs_radar/screening-policy.json`) defines initial screening and
company preference. Initial screening applies the same occupation, geography,
clearance, citizenship and sponsorship exclusions to both employment kinds.
Missing information is not a rejection. Front-end roles are allowed; there is
no employer blacklist or salary, experience or graduation-date threshold.

Initial-screening input preserves public source facts: title, company, location,
degree eligibility, sponsorship, available description and its completeness,
source categories, terms, salary and evidence URLs. Raw ingestion metadata and
application/Profile records stay outside the model request. Missing fields stay
unknown. Terms and salary do not create new eligibility thresholds.

Doctoral-only degree lists and PhD-only/postdoctoral titles are excluded before
publication using the same evidence check as model and manual review validation.
Mixed-degree eligibility (including BS/MS/PhD titles) and explicit non-doctoral
eligibility in another source prevent a doctoral-only rejection. Missing data
in another source is not a contradiction. URL slugs are not eligibility facts.
Changed evidence reopens automatic doctoral exclusions; submitted/claimed and
manually kept roles remain protected. Exact degree labels are accepted evidence
only when the current sources support a doctoral-only restriction.

Regression case (2026-10-05): Autodesk's `26WD101433` research internship had a
plain research title and `degrees: ["PhD"]` in both Simplify observations. The
old model input omitted degrees, the policy required PhD in the title, and the
review validator rejected degree evidence. It was incorrectly kept. The parser
to provider contract and degree screening tests cover this case, mixed-degree
alternatives, cross-source conflicts and protected application history.

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

Company selection prioritizes credible positioning in the high-paying technology
talent market and software/AI/quant career value. Exact pay disclosure is not a
prerequisite: core products, engineering importance and known employer standing
support the judgment. Internet products, fintech/payments, quant, software/cloud/
data infrastructure, substantive AI and mainstream advanced computing are the
target. NVIDIA, AMD, Cerebras, SpaceX, Whatnot, TensorWave, Niantic Spatial and
Pure Storage are positive reference points. Hardware is not a blanket exclusion.
Ordinary contractors, niche industrial/medical manufacturers, research labs and
traditional businesses do not qualify merely by hiring engineers, using AI or
having funding. Sector labels alone do not establish pay, funding or quality.
Dandy, Space Dynamics Laboratory and Mach Industries are owner-negative examples.
Company membership ignores sponsorship, citizenship, clearance and job eligibility;
SpaceX can be selected while a specific job is excluded on explicit source facts.
Known company choices stay cached; changing this prompt does not reclassify them.
The owner's requested review is a separate version-fenced preference update.

Luna uses existing model knowledge with no browsing tools. Unknown employers
are conservatively not selected; selection is a preference heuristic, not a
verified employer rating. Source FAANG+ labels and received OAs are not selection
criteria. Explicit owner exclusions in the UI remain separate saved preferences.
