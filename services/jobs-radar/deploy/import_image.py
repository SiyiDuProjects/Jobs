"""Import an exact local-build artifact; never build, smoke or activate it."""
import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import re
import shutil

from local_build import build_lock, command, digest, verify_image_archive


ROOT = Path('/home/ubuntu/siyi')


def import_artifact(folder, commit, *, root=ROOT, invoke=command):
    folder = Path(folder).resolve(strict=True)
    stage = root / 'jobs-radar-stage'
    if (folder.parent != stage or not re.fullmatch(r'import-' + re.escape(commit) + r'-[a-f0-9]{12}', folder.name)
            or not re.fullmatch('[a-f0-9]{40}', commit)):
        raise ValueError('Import artifact escaped its assigned stage directory')
    manifest = json.loads((folder / 'manifest.json').read_text())
    short, image_id = manifest.get('release', ''), manifest.get('imageId', '')
    if (manifest.get('version') != 1 or manifest.get('commit') != commit
            or not re.fullmatch('[a-f0-9]{12,40}', short) or not commit.startswith(short)
            or not re.fullmatch('sha256:[a-f0-9]{64}', image_id)):
        raise ValueError('Invalid committed import manifest')
    for name, key in [('source.tar', 'sourceSha256'), ('image.tar', 'imageSha256')]:
        path = folder / name
        if path.is_symlink() or digest(path) != manifest[key]:
            raise ValueError('Transferred artifact checksum differs: ' + name)
    expected = {'release': short, 'org.opencontainers.image.revision': commit, 'jobs.source.sha256': manifest['sourceSha256']}
    verify_image_archive(folder / 'image.tar', image_id, expected)
    if shutil.disk_usage(root).free < 2 * (folder / 'image.tar').stat().st_size + 2 * 1024**3:
        raise ValueError('Insufficient disk headroom for the imported image')
    # These are the same lock files/order as switch_release and the admin gate.
    with ExitStack() as stack:
        for path in (root / '.jobs-radar-release-host.lock', root / 'jobs-radar/.release.lock'):
            stack.enter_context(build_lock(path))
        tag = 'jobs-radar:' + short
        existing = invoke(['docker', 'image', 'ls', '--no-trunc', '--filter', 'reference=' + tag, '--format', '{{.ID}}'])
        if existing and existing != image_id:
            raise ValueError('This commit already identifies another image; import refused')
        current = json.loads(invoke(['docker', 'image', 'inspect', 'jobs-radar:0.1.0']))[0]
        if current['Config'].get('Labels', {}).get('release') == short and current['Id'] != image_id:
            raise ValueError('Active commit already identifies another image; import refused')
        invoke(['docker', 'image', 'load', '--input', str(folder / 'image.tar')], timeout=180)
        imported = json.loads(invoke(['docker', 'image', 'inspect', image_id]))[0]
        if imported['Id'] != image_id or any(imported['Config'].get('Labels', {}).get(key) != value for key, value in expected.items()):
            raise ValueError('Imported image identity differs; no release tag was changed')
        invoke(['docker', 'tag', image_id, tag])
    return image_id


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path, required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    print(import_artifact(args.folder, args.commit))
