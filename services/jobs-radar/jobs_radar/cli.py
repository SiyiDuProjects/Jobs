import argparse
import asyncio
import json
import os
from pathlib import Path

from .store import Store


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description="Private Jobs Radar administration")
    parser.add_argument("--db", default=os.environ.get("JOBS_DB", "data/jobs.sqlite"))
    commands = parser.add_subparsers(dest="command", required=True)
    collect = commands.add_parser("collect")
    collect.add_argument("--stream", action="append")
    screening = commands.add_parser('screen')
    screening.add_argument('--max-batches',type=int,default=20)
    screening.add_argument('--backfill-company', action='store_true', help='Reevaluate existing unprocessed jobs and fill employer preference labels')
    companies=commands.add_parser('screen-companies')
    companies.add_argument('--max-batches',type=int,default=20)
    companies.add_argument('--include-history',action='store_true',help='Include submitted and closed historical companies')
    commands.add_parser("status")
    identities = commands.add_parser('refresh-workday-identities')
    identities.add_argument('--limit', type=int, default=200)
    commands.add_parser("serve")
    backup = commands.add_parser("backup")
    backup.add_argument("destination")
    approve = commands.add_parser("approve-auth")
    approve.add_argument("request_id")
    commands.add_parser("pending-auth")
    web = commands.add_parser('approve-web')
    web.add_argument('request_id')
    args = parser.parse_args()
    from .maintenance import paused
    if args.command in {'collect', 'screen', 'screen-companies', 'refresh-workday-identities'} and paused():
        print(json.dumps({'status': 'release_maintenance'}))
        return
    from .restricted_recovery import active_recovery, RecoveryStore
    recovery_bundle=active_recovery(args.db)
    if recovery_bundle is not None:
        from .recovery_server import create_app, existing, profile_writes_paused
        origin=os.environ.get('JOBS_ORIGIN','https://jobs.siyidu.com')
        if args.command=='approve-web':
            from .web import WebAccess
            recovery_store=RecoveryStore(recovery_bundle)
            if profile_writes_paused(recovery_store): raise RuntimeError('Recovery Profile writes are paused')
            print(json.dumps(existing(WebAccess,recovery_store,origin=origin).approve(args.request_id)))
        elif args.command=='serve':
            import uvicorn
            uvicorn.run(create_app(recovery_bundle,origin),host=os.environ.get('JOBS_HOST','127.0.0.1'),
                        port=int(os.environ.get('JOBS_PORT','8796')),access_log=False,log_level='warning',proxy_headers=False)
        else:
            raise RuntimeError('Restricted recovery permits only website service and website approval')
        return
    store = Store(args.db)
    if os.name != "nt":
        os.chmod(args.db, 0o600)
    if args.command == 'refresh-workday-identities':
        import httpx
        from .workday_identity import refresh
        async def refresh_identities():
            async with httpx.AsyncClient(follow_redirects=False, trust_env=False,
                                         headers={'User-Agent': 'JobsRadar/0.1'}) as client:
                return await refresh(store, client, limit=args.limit)
        print(json.dumps(asyncio.run(refresh_identities())))
    elif args.command == "collect":
        from .sources import collect
        rows = asyncio.run(collect(store, args.stream))
        if os.environ.get('JOBS_SCREENING_ENABLED')=='1':
            from .luna_screening import run, failure_summary
            try:
                print(json.dumps(run(store)),flush=True)
            except Exception as exc:
                print(json.dumps(failure_summary(exc)),flush=True)
                raise SystemExit(1)
        raise SystemExit(0 if all(r["ok"] for r in rows) else 1)
    elif args.command == 'screen':
        from .luna_screening import run, failure_summary
        try:
            print(json.dumps(run(store,max_batches=args.max_batches,backfill_company=args.backfill_company)),flush=True)
        except Exception as exc:
            print(json.dumps(failure_summary(exc)),flush=True)
            raise SystemExit(1)
    elif args.command == 'screen-companies':
        from .company_screening import run_companies
        from .luna_screening import failure_summary
        try:
            print(json.dumps(run_companies(store,max_batches=args.max_batches,include_history=args.include_history)),flush=True)
        except Exception as exc:
            print(json.dumps(failure_summary(exc)),flush=True)
            raise SystemExit(1)
    elif args.command == "status":
        print(json.dumps({**store.health(), **store.progress()}, ensure_ascii=False, indent=2))
    elif args.command == "backup":
        print(store.backup(args.destination))
    elif args.command in {"approve-auth", "pending-auth"}:
        from .auth import OwnerOAuth
        auth = OwnerOAuth(store, os.environ.get("JOBS_ORIGIN", "https://jobs.siyidu.com"))
        print(json.dumps(auth.approve(args.request_id) if args.command == "approve-auth" else auth.pending(), ensure_ascii=False))
    elif args.command == 'approve-web':
        from .web import WebAccess
        print(json.dumps(WebAccess(store,os.environ.get('JOBS_ORIGIN','https://jobs.siyidu.com')).approve(args.request_id)))
    else:
        from .server import create_server
        import uvicorn
        server = create_server(store)
        uvicorn.run(server.streamable_http_app(), host=os.environ.get("JOBS_HOST", "127.0.0.1"), port=int(os.environ.get("JOBS_PORT", "8796")),
                    access_log=False, log_level="warning", proxy_headers=False)


if __name__ == "__main__":
    main()
