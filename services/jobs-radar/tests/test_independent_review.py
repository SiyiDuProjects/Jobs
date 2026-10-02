"""Independent synthetic regressions; no workspace facts or network access."""
import gzip
import io
import re
import struct
import zipfile
import zlib

import pytest
from test_workspace_audit import implementation


@pytest.mark.parametrize('value', [
    b'{"pass\\u0077ord":"SYNTHETIC-CREDENTIAL"}',
    b'<config><password>SYNTHETIC&#45;CREDENTIAL</password></config>',
])
def test_renamed_structured_credentials_remain_blocked(value):
    assert implementation().audit_bytes(value, 'escaped.txt')['status'] == 'blocked'


@pytest.mark.parametrize('metadata', ['comment', 'extra'])
def test_zip_metadata_must_be_completely_audited(metadata):
    value = b'{"accountPassword":"SYNTHETIC-CREDENTIAL"}'
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        info = zipfile.ZipInfo('safe.txt')
        if metadata == 'comment':
            archive.comment = value
        else:
            compressed = zlib.compress(value)
            info.extra = struct.pack('<HH', 0xCAFE, len(compressed)) + compressed
        archive.writestr(info, b'Synthetic safe text')
    assert implementation().audit_bytes(output.getvalue(), 'metadata.zip')['status'] == 'blocked'


def test_pdf_overwritten_incremental_object_retains_original_secret():
    from pypdf import PdfWriter, PdfReader
    from pypdf.generic import DecodedStreamObject
    writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
    stream = DecodedStreamObject(); stream.set_data(b'{"token":"SYNTHETIC-CREDENTIAL"}')
    ref = writer._add_object(stream.flate_encode())
    output = io.BytesIO(); writer.write(output); base = output.getvalue()
    assert implementation().audit_bytes(base, 'original.pdf')['status'] == 'blocked'
    reader = PdfReader(io.BytesIO(base)); root = reader.trailer.raw_get('/Root')
    previous = int(re.findall(rb'startxref\s+(\d+)', base)[-1])
    body = f'{ref.idnum} 0 obj\n<< /Length 4 >>\nstream\nsafe\nendstream\nendobj\n'.encode()
    tail = (f'xref\n{ref.idnum} 1\n{len(base):010} 00000 n \ntrailer\n'
            f'<< /Size {reader.trailer["/Size"]} /Root {root.idnum} {root.generation} R /Prev {previous} >>\n'
            f'startxref\n{len(base) + len(body)}\n%%EOF\n').encode()
    assert implementation().audit_bytes(base + body + tail, 'incremental.pdf')['status'] == 'blocked'


def test_recovery_receiver_rejects_unmanifested_second_gzip_member(tmp_path):
    backup = implementation('backup_workspace')
    source = tmp_path / 'source'; source.mkdir()
    (source / 'facts.txt').write_text('Synthetic safe facts')
    output = io.BytesIO(); backup.archive(source, output)
    target = tmp_path / 'recovery.tgz'
    target.write_bytes(output.getvalue() + gzip.compress(b'password=SYNTHETIC-CREDENTIAL'))
    with pytest.raises(ValueError):
        backup.verify_archive(target)


def test_jsonl_budget_stops_parsing_before_all_lines_are_materialized(monkeypatch):
    audit = implementation(); audit.MAX_NODES = 3
    original = audit.json.loads; calls = []
    def counted(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(audit.json, 'loads', counted)
    assert audit.audit_bytes(b'{}\n' * 30, 'many.jsonl')['status'] == 'blocked'
    assert len(calls) <= 4
