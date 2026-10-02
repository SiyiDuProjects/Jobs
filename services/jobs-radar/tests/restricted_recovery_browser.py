"""Run the existing packaged website against the real restricted ASGI server.

Manual synthetic acceptance: python tests/restricted_recovery_browser.py WORK
PLAYWRIGHT_MODULE CHROMIUM_EXECUTABLE. No production service or browser profile.
"""
import hashlib
import json
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import threading
import time

import uvicorn

sys.path.insert(0, str(Path(__file__).parents[1]))
from test_legacy_recovery import databases
from jobs_radar.restricted_recovery import prepare, fingerprint, export_resume
from jobs_radar.recovery_server import create_app


def main():
    work = Path(sys.argv[1]).resolve(); work.mkdir(exist_ok=False)
    data = databases.__wrapped__(work)
    with sqlite3.connect(data['current']) as db:
        db.execute('INSERT INTO web_sessions VALUES(?,?,?,?,1)', (hashlib.sha256(b'browser-synthetic-cookie').hexdigest(), 'browser-synthetic-session', time.time(), time.time()+3600))
    baseline = fingerprint(data['current'])
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); sock.listen(32)
    port = sock.getsockname()[1]; origin = 'http://127.0.0.1:'+str(port)
    bundle = work/'bundle'
    report = prepare(data['current'], bundle, release='a'*12, image_id='sha256:'+'b'*64)
    server = uvicorn.Server(uvicorn.Config(create_app(bundle, origin), log_level='warning', access_log=False))
    thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    thread.start()
    try:
        cutoff = time.monotonic()+10
        while not server.started:
            if not thread.is_alive() or time.monotonic()>cutoff: raise RuntimeError('Synthetic ASGI server did not start')
            time.sleep(.02)
        result = subprocess.run(['node',str(Path(__file__).with_name('restricted-recovery-browser.mjs')),origin,
                                 str(work),sys.argv[2],sys.argv[3]],capture_output=True,text=True,encoding='utf-8',timeout=90)
        (work/'browser.log').write_text(result.stdout+'\n'+result.stderr,encoding='utf-8')
        if result.returncode: raise RuntimeError('Browser acceptance failed; see synthetic browser.log')
    finally:
        server.should_exit = True; thread.join(10); sock.close()
        if thread.is_alive(): raise RuntimeError('Synthetic ASGI server did not stop')
    with sqlite3.connect(bundle/'recovery.sqlite') as db:
        value=json.loads(db.execute('SELECT profile FROM owner_profiles WHERE id=?',(data['profile']['id'],)).fetchone()[0])
        assert value['nameData']['firstName']=='RecoveryBrowser'
        assert json.loads(db.execute("SELECT value FROM management_documents WHERE key='dailyGoal'").fetchone()[0])==17
        answers=json.loads(db.execute('SELECT value FROM management_documents WHERE key=?',('jobsResponses:'+data['profile']['id'],)).fetchone()[0])
        assert answers[0]['response']=='Recovery response saved' and answers[0]['keywords']==['synthetic','recovery','answer']
    assert fingerprint(bundle/'recovery.sqlite', selected=set(report['frozen']))==report['frozen']
    assert fingerprint(data['current'])==baseline
    (bundle/'.pause-profile-writes').touch()
    exported=export_resume(bundle)
    evidence=dict(browser=json.loads((work/'browser-result.json').read_text()),
                  staticHashes={key:value for key,value in report['runtime'].items() if key.startswith('static/')},
                  applicationDataUnchanged=True,originalDatabaseUnchanged=True,recoveryEditsExported=exported['resumeDatabase'])
    (work/'result.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(evidence,ensure_ascii=False))


if __name__=='__main__': main()
