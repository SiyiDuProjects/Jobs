"""Prepare/finish the explicit Profile/settings-only recovery; never starts a server.

Stop all application writers and verify the immutable image before prepare.
Stop the recovery server before export-resume. Use the returned latest resume
copy for reactivation; the sealed current-v2 snapshot is evidence, not live data.
"""
import argparse
import json
import os
from pathlib import Path

from jobs_radar.restricted_recovery import prepare, export_resume, write_marker, clear_marker


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    start = commands.add_parser('prepare')
    start.add_argument('--current', type=Path, required=True)
    start.add_argument('--bundle', type=Path, required=True)
    start.add_argument('--release', required=True)
    start.add_argument('--image-id', required=True)
    start.add_argument('--timeout',type=float,default=120)
    finish = commands.add_parser('export-resume')
    finish.add_argument('--bundle', type=Path, required=True)
    finish.add_argument('--timeout',type=float,default=120)
    marker=commands.add_parser('write-marker')
    marker.add_argument('--current',type=Path,required=True)
    marker.add_argument('--bundle',type=Path,required=True)
    marker.add_argument('--release',required=True)
    marker.add_argument('--image-id',required=True)
    clear=commands.add_parser('clear-marker')
    clear.add_argument('--current',type=Path,required=True)
    clear.add_argument('--timeout',type=float,default=120)
    args = parser.parse_args()
    if args.command=='prepare': result=prepare(args.current,args.bundle,release=args.release,image_id=args.image_id,timeout=args.timeout)
    elif args.command=='export-resume': result=export_resume(args.bundle,timeout=args.timeout)
    elif args.command=='write-marker': result=write_marker(args.current,args.bundle,release=args.release,image_id=args.image_id)
    else: result=clear_marker(args.current,timeout=args.timeout)
    print(json.dumps({key: result[key] for key in ('mode', 'resumeDatabase', 'applicationWrites', 'oldRuntimeStarted', 'restoreProof','marker','markerCleared','bundle') if key in result}, sort_keys=True))


if __name__ == '__main__': main()
