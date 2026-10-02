"""Synthetic adversarial cases for the recovery preflight boundary."""
import io
import json
import tarfile

import pytest
from test_workspace_audit import implementation, zip_bytes, packed, bundle, oid


@pytest.mark.parametrize('layout', ['prefix-archive', 'suffix-bytes', 'prefix-bytes'])
def test_zip_requires_exact_single_container_coverage(layout):
    credential = zip_bytes([('capture.json', b'{"token":"SYNTHETIC-CREDENTIAL"}')])
    ordinary = zip_bytes([('facts.txt', b'Synthetic facts')])
    data = {'prefix-archive': credential + ordinary, 'suffix-bytes': ordinary + b'unparsed',
            'prefix-bytes': b'unparsed' + ordinary}[layout]
    assert implementation().audit_bytes(data, 'history.zip')['status'] == 'blocked'


def test_git_blob_is_checked_in_every_historical_name_context():
    value = b'{"accountPassword":"SYNTHETIC-CREDENTIAL"}'
    tree = b'100644 first.txt\0' + bytes.fromhex(oid(value)) + b'100644 second.json\0' + bytes.fromhex(oid(value))
    report = implementation().audit_bytes(bundle([packed(3, value), packed(2, tree)], oid(value)), 'history.bundle')
    assert report['status'] == 'blocked'
    assert 'credential-json-property' in {item['reason'] for item in report['findings']}


def test_xml_credential_key_value_attributes_are_checked():
    data = b'<settings><add key="password" value="SYNTHETIC-CREDENTIAL"/></settings>'
    assert implementation().audit_bytes(data, 'settings.xml')['status'] == 'blocked'


def test_reviewed_file_missing_at_preparation_is_incomplete(tmp_path):
    source = tmp_path / 'source'; source.mkdir()
    original = source / 'original.md'; original.write_text('Synthetic original')
    audit, backup = implementation(), implementation('backup_workspace')
    manifest = tmp_path / 'review.json'; manifest.write_text(json.dumps(audit.audit_workspace(source)))
    original.unlink()
    plan = backup.prepare(source, review_manifest=manifest)
    assert not backup.summary(plan)['complete']
    assert any(row['path'] == 'original.md' for row in plan['excluded'])


@pytest.mark.parametrize('name', ['captured.bin', 'captured.txt'])
def test_basic_mode_does_not_bypass_content_review_by_renaming_a_container(tmp_path, name):
    data = zip_bytes([('capture.json', b'{"token":"SYNTHETIC-CREDENTIAL"}')])
    (tmp_path / name).write_bytes(data)
    backup = implementation('backup_workspace')
    assert not backup.summary(backup.prepare(tmp_path))['complete']


def test_binary_data_with_text_suffix_is_not_declared_reviewed():
    assert implementation().audit_bytes(b'\xff\x81\x80unknown bytes', 'facts.txt')['status'] == 'blocked'


def test_tar_directory_members_share_the_global_entry_budget():
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        for index in range(5):
            item = tarfile.TarInfo('folder' + str(index) + '/'); item.type = tarfile.DIRTYPE
            archive.addfile(item)
    audit = implementation(); audit.MAX_ENTRIES = 2
    assert audit.audit_bytes(output.getvalue(), 'directories.tar')['status'] == 'blocked'


def test_json_nodes_share_the_global_structure_budget():
    audit = implementation(); audit.MAX_NODES = 3
    assert audit.audit_bytes(json.dumps(['value'] * 10).encode(), 'many.json')['status'] == 'blocked'


def test_compressed_pdf_content_cannot_escape_the_expansion_budget():
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    writer = PdfWriter(); page = writer.add_blank_page(width=300, height=300)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject(); stream.set_data(b'BT /F1 12 Tf 0 0 Td (' + b'A' * 200000 + b') Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream.flate_encode())
    data = io.BytesIO(); writer.write(data)
    audit = implementation(); audit.MAX_FILE = 8192; audit.MAX_EXPANDED = 16384
    report = audit.audit_bytes(data.getvalue(), 'synthetic.pdf')
    assert report['status'] == 'blocked'
    assert 'inspection-limit' in {item['reason'] for item in report['findings']}

def test_safe_pdf_is_still_reviewed_and_parser_hooks_are_restored():
    from pypdf import PdfWriter, filters
    writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
    output = io.BytesIO(); writer.write(output)
    original = filters.decode_stream_data, filters.decompress
    report = implementation().audit_bytes(output.getvalue(), 'blank.pdf')
    assert report['status'] == 'reviewed'
    assert (filters.decode_stream_data, filters.decompress) == original


def test_tar_trailing_archive_and_nonempty_directory_are_unresolved():
    from test_workspace_audit import tar_bytes
    first = tar_bytes([('safe.txt', b'Synthetic facts')])
    second = tar_bytes([('nested.zip', zip_bytes([('capture.json', b'{"token":"SYNTHETIC-CREDENTIAL"}')]))])
    assert implementation().audit_bytes(first + second, 'history.tar')['status'] == 'blocked'
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as tar:
        item = tarfile.TarInfo('directory/'); item.type = tarfile.DIRTYPE; item.size = 5
        tar.addfile(item, io.BytesIO(b'bytes'))
    assert implementation().audit_bytes(output.getvalue(), 'directory.tar')['status'] == 'blocked'


def test_zip_directory_cannot_hide_compressed_contents():
    data = zip_bytes([('directory/', b'{"token":"SYNTHETIC-CREDENTIAL"}')])
    assert implementation().audit_bytes(data, 'directory.zip')['status'] == 'blocked'


def test_zip_stream_must_consume_its_whole_record_even_when_crc_matches():
    import struct
    data = bytearray(zip_bytes([('safe.txt', b'Synthetic facts')]))
    directory = data.index(b'PK\x01\x02'); end = data.index(b'PK\x05\x06')
    original_size = struct.unpack_from('<I', data, 18)[0]
    struct.pack_into('<I', data, 18, original_size + 4)
    struct.pack_into('<I', data, directory + 20, original_size + 4)
    struct.pack_into('<I', data, end + 16, directory + 4)
    data[directory:directory] = b'JUNK'
    report = implementation().audit_bytes(bytes(data), 'trailing-stream.zip')
    assert report['status'] == 'blocked'
    assert 'unparsed-zip-compressed-bytes' in {item['reason'] for item in report['findings']}


def test_zip_data_descriptors_stored_and_bzip2_remain_supported():
    import zipfile
    class Streaming(io.BytesIO):
        def seekable(self): return False
        def seek(self, *args): raise io.UnsupportedOperation()
    for compression in [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2]:
        output = Streaming()
        with zipfile.ZipFile(output, 'w', compression) as archive:
            archive.writestr('safe.txt', b'Synthetic facts')
        assert implementation().audit_bytes(output.getvalue(), 'stream.zip')['status'] == 'reviewed'


def test_findings_and_json_nesting_fail_closed_at_their_limits():
    audit = implementation(); audit.MAX_FINDINGS = 2
    report = audit.audit_bytes(json.dumps([{'token': 'SYNTHETIC'}] * 10).encode(), 'many.json')
    assert report['status'] == 'blocked' and len(report['findings']) <= 3
    assert 'inspection-limit' in {item['reason'] for item in report['findings']}
    audit = implementation(); audit.MAX_JSON_DEPTH = 2
    assert audit.audit_bytes(b'[[[["safe"]]]]', 'deep.json')['status'] == 'blocked'

def test_zip64_local_records_descriptors_and_footer_are_fully_supported(monkeypatch):
    import zipfile
    class Streaming(io.BytesIO):
        def seekable(self): return False
        def seek(self, *args): raise io.UnsupportedOperation()
    for output in [io.BytesIO(), Streaming()]:
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            with archive.open('safe.txt', 'w', force_zip64=True) as member:
                member.write(b'Synthetic facts')
        assert implementation().audit_bytes(output.getvalue(), 'zip64.zip')['status'] == 'reviewed'
    monkeypatch.setattr(zipfile, 'ZIP_FILECOUNT_LIMIT', 1)
    data = zip_bytes([('one.txt', b'one'), ('two.txt', b'two')])
    assert b'PK\x06\x06' in data
    assert implementation().audit_bytes(data, 'zip64.zip')['status'] == 'reviewed'
