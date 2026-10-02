"""Synthetic large-database acceptance for a separately resource-limited runner.

No personal inputs, Docker, network, or existing workspace reads. The operator
must impose process/container RAM/CPU limits; tracemalloc is only Python memory.
"""
import argparse
import json
from pathlib import Path
import sys
import time
import tracemalloc

sys.path.insert(0,str(Path(__file__).parents[1]))
from jobs_radar.store import Store
from jobs_radar.server import create_server
from jobs_radar.restricted_recovery import prepare, export_resume


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work',type=Path,required=True)
    parser.add_argument('--size-mib',type=int,default=815)
    parser.add_argument('--timeout',type=float,default=120)
    args=parser.parse_args()
    if not 1<=args.size_mib<=1024: raise ValueError('Synthetic fixture size must be 1..1024 MiB')
    args.work.mkdir(mode=0o700,exist_ok=False)
    store=Store(args.work/'synthetic.sqlite')
    create_server(store,'https://synthetic.invalid')  # Schema construction only; never serve.
    raw=json.dumps({'syntheticHistoricalValue':'x'*(1024*1024)})
    with store.connect(True) as db:
        for index in range(args.size_mib):
            db.execute('INSERT INTO management_revisions VALUES(?,?,?,?)',('settings',index,raw,0))
    del raw
    bytes_=store.path.stat().st_size
    tracemalloc.start(); started=time.monotonic()
    report=prepare(store.path,args.work/'bundle',release='a'*12,image_id='sha256:'+'b'*64,timeout=args.timeout)
    prepared=time.monotonic()-started
    (args.work/'bundle/.pause-profile-writes').touch()
    started=time.monotonic(); exported=export_resume(args.work/'bundle',timeout=args.timeout)
    finished=time.monotonic()-started
    _,peak=tracemalloc.get_traced_memory()
    evidence=dict(synthetic=True,databaseBytes=bytes_,prepareSeconds=prepared,exportSeconds=finished,
                  pythonPeakBytes=peak,osMemoryLimit='must be supplied by the external runner',
                  restore=report['restoreProof'],export=exported['resumeDatabase'])
    (args.work/'result.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
    print(json.dumps(evidence))


if __name__=='__main__':main()
