# Job screening

One policy (`jobs_radar/screening-policy.json`) drives both employment kinds.
Initial screening removes unsupported occupations and explicit non-US-only,
clearance, citizenship or sponsorship restrictions. Front-end is allowed.
There is no employer blacklist. Missing/Other sponsorship is unknown; explicit
conflicting source labels stay unresolved. Mixed US/foreign locations remain.

Luna returns the initial decision and one independent employer preference flag
in the same bounded, schema-validated request. Both kinds use the same employer
standard. Source sponsorship is sent separately for each source. Company, role,
source context and policy changes invalidate saved recommendations. Unchanged
jobs do not need another call. Failed responses never grant a recommendation.

The board exposes two switches. Region defaults on for both kinds. Company
defaults off for full-time and on for internships; these settings are remembered
separately. Company filtering requires a current positive employer flag. It does
not delete records. The region focus preset keeps CA/WA/NY/MA/TX, US remote and
unresolved locations, with a visible US-wide exception for source FAANG+ or
recommended employers. Explicit narrower regions have no employer exception.
Foreign-only exclusion belongs to initial screening, regardless of switches.

There is no default TikTok exclusion or daily-screening bypass. Previously saved
owner exclusion preferences remain editable. Source FAANG+ remains a source
label, not a company ranking. Legacy `compact` and `intern_companies` requests
remain compatible while old pages are refreshed.

After deploying, `screen --backfill-company --max-batches 100` fills current
unprocessed jobs' employer labels and reevaluates former automatic exclusions
once for this policy. Repeated runs resume the durable batch without resetting
completed decisions. Owner deletions, manual keeps, and processed applications
are protected. The operation does not change application status/history.
