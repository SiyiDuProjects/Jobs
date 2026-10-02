import hashlib
import importlib.util
import io
import json
import struct
import tarfile
import zipfile
import zlib
from pathlib import Path

import pytest


def implementation(name='audit_workspace'):
    path = Path(__file__).parents[1] / 'deploy' / (name + '.py')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def zip_bytes(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, value in entries:
            archive.writestr(name, value)
    return output.getvalue()


def tar_bytes(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        for name, value in entries:
            info = tarfile.TarInfo(name)
            info.size = len(value)
            archive.addfile(info, io.BytesIO(value))
    return output.getvalue()


def gzip(data):
    compressor = zlib.compressobj(wbits=16 + zlib.MAX_WBITS)
    return compressor.compress(data) + compressor.flush()


def packed(kind, data, base=b''):
    size = len(data)
    first, size = (kind << 4) | (size & 15), size >> 4
    header = bytearray([first | (128 if size else 0)])
    while size:
        part, size = size & 127, size >> 7
        header.append(part | (128 if size else 0))
    return bytes(header) + base + zlib.compress(data)


def bundle(objects, advertised, algorithm='sha1'):
    pack = b'PACK' + struct.pack('!II', 2, len(objects)) + b''.join(objects)
    pack += hashlib.new(algorithm, pack).digest()
    header = b'# v2 git bundle\n' if algorithm == 'sha1' else b'# v3 git bundle\n@object-format=sha256\n'
    return header + advertised.encode() + b' refs/heads/main\n\n' + pack


def oid(data, algorithm='sha1', kind='blob'):
    return hashlib.new(algorithm, kind.encode() + b' ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def reasons(report):
    return {item['reason'] for item in report['findings']}


def test_safe_nested_docx_and_tgz_are_fully_scanned_without_extraction(tmp_path):
    content = zip_bytes([('word/document.xml', b'<document><p>Confirmed synthetic facts</p></document>')])
    payload = gzip(tar_bytes([('notes/facts.docx', content)]))
    result = implementation().audit_bytes(payload, 'evidence.tgz')
    assert result['status'] == 'reviewed'
    assert {'gzip-complete-stream', 'tar-all-members', 'zip-all-members', 'xml-text-and-attributes'} <= set(result['methods'])
    assert list(tmp_path.iterdir()) == []


def test_docx_split_runs_and_escaped_json_do_not_hide_credentials():
    cases = [
        (zip_bytes([('word/document.xml', b'<document><r>pass</r><r>word="SYNTHETIC-CREDENTIAL"</r></document>')]), 'note.docx'),
        (b'{"pass\\u0077ord":"SYNTHETIC-CREDENTIAL"}', 'capture.json'),
        ('密码：SYNTHETIC-CREDENTIAL'.encode(), 'facts.md'),
    ]
    for data, name in cases:
        report = implementation().audit_bytes(data, name)
        assert report['status'] == 'blocked'
        assert 'SYNTHETIC-CREDENTIAL' not in json.dumps(report)


@pytest.mark.parametrize('name', ['../escape.txt', '/absolute.txt', 'C:/absolute.txt', 'folder\\escape.txt'])
def test_archive_paths_are_never_extracted_or_accepted(name):
    data = zip_bytes([(name.replace('\\', '/'), b'safe')])
    if '\\' in name:
        data = data.replace(name.replace('\\', '/').encode(), name.encode())
    report = implementation().audit_bytes(data, 'archive.zip')
    assert report['status'] == 'blocked'
    assert 'unsafe-member-path' in reasons(report)


def test_binary_member_does_not_prevent_later_credential_member_review():
    report = implementation().audit_bytes(zip_bytes([('image.bin', b'\0binary'), ('capture.json', b'{"token":"SYNTHETIC-CREDENTIAL"}')]), 'archive.zip')
    assert {'binary-needs-content-review', 'credential-json-property'} <= reasons(report)


def test_linked_tar_and_corrupt_gzip_are_blocked():
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        info = tarfile.TarInfo('link')
        info.type = tarfile.SYMTYPE
        info.linkname = 'somewhere'
        archive.addfile(info)
    scanner = implementation()
    assert 'non-regular-tar-member' in reasons(scanner.audit_bytes(output.getvalue(), 'archive.tar'))
    assert scanner.audit_bytes(gzip(b'safe')[:-3], 'capture.gz')['status'] == 'blocked'
    assert scanner.audit_bytes(gzip(b'safe') + gzip(b'password=SECRET'), 'capture.gz')['status'] == 'blocked'


def test_expansion_limit_is_fail_closed(monkeypatch):
    scanner = implementation()
    monkeypatch.setattr(scanner, 'MAX_FILE', 32)
    assert scanner.audit_bytes(zip_bytes([('huge.txt', b'a' * 100)]), 'large.zip')['status'] == 'blocked'


@pytest.mark.parametrize('algorithm', ['sha1', 'sha256'])
def test_git_bundle_scans_unreachable_packed_objects(algorithm):
    safe = b'safe source'
    secret = b'password="SYNTHETIC-CREDENTIAL"'
    data = bundle([packed(3, safe), packed(3, secret)], oid(safe, algorithm), algorithm)
    report = implementation().audit_bytes(data, 'history.bundle')
    assert report['status'] == 'blocked'
    assert 'possible-credential-content' in reasons(report)
    assert 'git-all-packed-objects-and-resolved-deltas' in report['methods']
    assert 'SYNTHETIC-CREDENTIAL' not in json.dumps(report)


def test_git_ofs_delta_is_resolved_before_scanning():
    base = b'password="'
    suffix = b'SYNTHETIC-CREDENTIAL"'
    # base/result lengths, copy first ten bytes, then insert the suffix.
    delta = bytes([len(base), len(base) + len(suffix), 0x90, len(base), len(suffix)]) + suffix
    first = packed(3, base)
    assert len(first) < 128
    data = bundle([first, packed(6, delta, bytes([len(first)]))], oid(base))
    result = implementation().audit_bytes(data, 'history.bundle')
    assert result['status'] == 'blocked'
    assert 'possible-credential-content' in reasons(result)
    assert 'git-all-packed-objects-and-resolved-deltas' in result['methods']


def test_git_ref_delta_can_resolve_a_later_base_and_plain_history_is_reviewed():
    base, suffix = b'original ', b'facts'
    delta = bytes([len(base), len(base) + len(suffix), 0x90, len(base), len(suffix)]) + suffix
    data = bundle([packed(7, delta, bytes.fromhex(oid(base))), packed(3, base)], oid(base))
    result = implementation().audit_bytes(data, 'history.bundle')
    assert result['status'] == 'reviewed'
    assert 'git-all-packed-objects-and-resolved-deltas' in result['methods']


def test_git_tree_marks_deleted_credential_file_and_pack_integrity_is_required():
    value = b'synthetic history value'
    tree = b'100644 .env\0' + bytes.fromhex(oid(value))
    data = bundle([packed(3, value), packed(2, tree)], oid(value))
    result = implementation().audit_bytes(data, 'history.bundle')
    assert 'historical-credential-file-name' in reasons(result)
    damaged = data[:-1] + bytes([data[-1] ^ 1])
    assert 'git-pack-checksum' in reasons(implementation().audit_bytes(damaged, 'history.bundle'))
    thin = data.replace(b'\n\n', b'\n-' + b'a' * 40 + b' prerequisite\n\n', 1)
    assert 'git-bundle-requires-external-history' in reasons(implementation().audit_bytes(thin, 'history.bundle'))


def test_review_manifest_allows_exact_audited_qa_files_and_stops_changed_or_forged_content(tmp_path):
    audit, backup = implementation(), implementation('backup_workspace')
    root = tmp_path / 'workspace'
    root.mkdir(); (root / '.qa').mkdir()
    path = root / '.qa' / 'original.docx'
    path.write_bytes(zip_bytes([('word/document.xml', b'<doc>Synthetic confirmed facts</doc>')]))
    report = audit.audit_workspace(root)
    assert report['complete'] and report['files'][0]['category'] == 'evidence'
    manifest = tmp_path / 'review.json'
    manifest.write_text(json.dumps(report))
    plan = backup.prepare(root, review_manifest=manifest)
    assert backup.summary(plan)['complete']
    assert [item['path'] for item in plan['files']] == ['.qa/original.docx']
    path.write_bytes(zip_bytes([('word/document.xml', b'<doc>changed facts</doc>')]))
    assert not backup.summary(backup.prepare(root, review_manifest=manifest))['complete']
    path.write_bytes(zip_bytes([('word/document.xml', b'<doc>password="SYNTHETIC-CREDENTIAL"</doc>')]))
    report['files'][0].update(sha256=hashlib.sha256(path.read_bytes()).hexdigest(), size=path.stat().st_size)
    manifest.write_text(json.dumps(report))
    plan = backup.prepare(root, review_manifest=manifest)
    assert not backup.summary(plan)['complete']
    assert plan['excluded'][0]['reason'] == 'content-audit-no-longer-passes'


def test_workspace_inventory_does_not_blanket_exclude_personal_evidence(tmp_path):
    for directory in ['.qa', 'artifacts', 'notes/source-materials', 'node_modules', '.private']:
        (tmp_path / directory).mkdir(parents=True)
        (tmp_path / directory / 'proof.txt').write_text('Synthetic evidence')
    report = implementation().audit_workspace(tmp_path)
    paths = {item['path'] for item in report['files']}
    assert paths == {'.qa/proof.txt', 'artifacts/proof.txt', 'notes/source-materials/proof.txt'}
    assert {row['category'] for row in report['files']} == {'evidence', 'original-material'}


def test_review_cannot_omit_new_files_or_duplicate_paths(tmp_path):
    audit, backup = implementation(), implementation('backup_workspace')
    root = tmp_path / 'source'
    root.mkdir(); (root / 'facts.md').write_text('safe')
    report = audit.audit_workspace(root)
    path = tmp_path / 'review.json'; path.write_text(json.dumps(report))
    (root / 'new.txt').write_text('new facts')
    assert not backup.summary(backup.prepare(root, review_manifest=path))['complete']
    report['files'].append(report['files'][0])
    path.write_text(json.dumps(report))
    with pytest.raises(ValueError, match='review path'):
        backup.prepare(root, review_manifest=path)


def test_real_git_bundle_history_is_audited_without_extracting_objects(tmp_path):
    import subprocess
    repo = tmp_path / 'synthetic-repo'
    repo.mkdir()
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.STDOUT)
    git('init', '-q')
    git('config', 'user.name', 'Synthetic fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    for revision in range(6):
        text = ('Repeated synthetic source line.\n' * 1000) + str(revision)
        if revision == 1:
            text += '\npassword="SYNTHETIC-CREDENTIAL"\n'
        (repo / 'facts.txt').write_text(text)
        git('add', 'facts.txt')
        git('commit', '-q', '-m', 'Synthetic revision')
    git('repack', '-ad', '--depth=50', '--window=50')
    git('bundle', 'create', 'history.bundle', '--all')
    report = implementation().audit_file(repo / 'history.bundle')
    assert report['status'] == 'blocked'
    assert 'git-all-packed-objects-and-resolved-deltas' in report['methods']
    assert 'possible-credential-content' in reasons(report)
    assert 'SYNTHETIC-CREDENTIAL' not in json.dumps(report)
