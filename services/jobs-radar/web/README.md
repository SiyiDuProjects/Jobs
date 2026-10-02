# Jobs website

This directory owns the website build and browser behavior tests.

- `npm ci`: install the committed lockfile, including the existing private HeroUI Pro package.
- `npm test`: run website behavior tests with synthetic accounts and data.
- `npm run build`: generate the shared answer contract, typecheck, then build into `../jobs_radar/static`.
- `npm run test:build`: verify that website and management entry pages reference the same built assets and no old runtime files remain.

The template is `index.html`; `jobs_radar/static` is generated and cleared on every build. Brand settings come from `../config/brand.json`. Do not edit generated assets or copy an old server's static directory into a release.

The service Dockerfile builds this website and packages it with the service from one commit. Use `../deploy/release.sh` from the repository root for staging, release and rollback.
