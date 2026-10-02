"""Synthetic cases for exact reviewed content and newly supported containers."""
import hashlib
import io
import json
import sqlite3
import struct
import zlib

import pytest
from test_workspace_audit import implementation, reasons, bundle, packed, oid


def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))


def png(extra=b'', raw=b'\x00\xff\xff\xff'):
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + extra
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def approved(audit, data, kind='png-visual', findings=()):
    audit.CONTENT_REVIEWS = {hashlib.sha256(data).hexdigest(): {'kind': kind, 'size': len(data), 'allowedFindings': list(findings), 'basis': 'synthetic exact-byte review'}}


def test_png_requires_exact_visual_review_and_validates_all_chunks():
    audit = implementation(); data = png(); approved(audit, data)
    assert audit.audit_bytes(data, 'figure.png')['status'] == 'reviewed'
    assert implementation().audit_bytes(data, 'figure.png')['status'] == 'blocked'
    for changed in [data + b'hidden', data[:-1] + bytes([data[-1] ^ 1])]:
        assert audit.audit_bytes(changed, 'figure.png')['status'] == 'blocked'


@pytest.mark.parametrize('extra', [chunk(b'tEXt', b'password\0SYNTHETIC-CREDENTIAL'), chunk(b'aaAA', b'hidden')])
def test_png_exact_review_cannot_override_secret_metadata_or_unknown_chunks(extra):
    audit = implementation(); data = png(extra); approved(audit, data)
    assert audit.audit_bytes(data, 'figure.png')['status'] == 'blocked'


def test_png_expansion_and_filter_rows_are_bounded():
    for raw in [b'\0' * 100000, b'\x05abc']:
        audit = implementation(); data = png(raw=raw); approved(audit, data)
        assert audit.audit_bytes(data, 'figure.png')['status'] == 'blocked'


def test_source_review_is_exact_bytes_and_limited_to_one_kind_of_false_positive():
    data = b'const access_token = readRuntimeToken();'
    audit = implementation(); approved(audit, data, 'source-syntax', ['possible-credential-assignment'])
    assert audit.audit_bytes(data, 'source.js')['status'] == 'reviewed'
    assert audit.audit_bytes(data + b'\npassword="SYNTHETIC-CREDENTIAL"', 'source.js')['status'] == 'blocked'
    secret = b'const token = "SYNTHETIC-CREDENTIAL";'
    approved(audit, secret, 'source-syntax', ['possible-credential-assignment'])
    assert 'possible-credential-content' in reasons(audit.audit_bytes(secret, 'source.js'))
    approved(audit, data, 'png-visual', ['possible-credential-assignment'])
    assert audit.audit_bytes(data, 'source.js')['status'] == 'blocked'


def test_null_connection_review_does_not_exempt_arbitrary_private_files():
    data = b'globalThis.JobsPrivateConnection = null;'
    audit = implementation(); approved(audit, data, 'null-connection', ['credential-file-name', 'historical-credential-file-name'])
    assert audit.audit_bytes(data, 'private-connection.js')['status'] == 'reviewed'
    assert audit.audit_bytes(data, '.env')['status'] == 'blocked'
    tree = b'100644 private-connection.js\0' + bytes.fromhex(oid(data))
    assert audit.audit_bytes(bundle([packed(3, data), packed(2, tree)], oid(data)), 'history.bundle')['status'] == 'reviewed'
    assert audit.audit_bytes(data.replace(b'null', b'{token:"SYNTHETIC-CREDENTIAL"}'), 'private-connection.js')['status'] == 'blocked'


def database(tmp_path, sensitive=False):
    path = tmp_path / 'synthetic.sqlite'; db = sqlite3.connect(path)
    db.execute('PRAGMA secure_delete=OFF')
    db.execute('CREATE TABLE records(value TEXT)')
    db.execute('INSERT INTO records VALUES (?)', ('Synthetic facts',))
    if sensitive:
        db.execute('CREATE TABLE old(value TEXT)')
        db.execute('INSERT INTO old VALUES (?)', ('password="SYNTHETIC-CREDENTIAL"' * 1000,))
        db.execute('DROP TABLE old')
    db.commit(); db.close(); return path.read_bytes()


def test_sqlite_scans_current_cells_and_deleted_free_pages(tmp_path):
    data = database(tmp_path)
    audit = implementation()
    assert audit.audit_bytes(data, 'facts.sqlite')['status'] == 'reviewed'
    other = tmp_path / 'other'; other.mkdir()
    deleted = database(other, sensitive=True)
    assert int.from_bytes(deleted[36:40], 'big') > 0
    result = audit.audit_bytes(deleted, 'facts.sqlite')
    assert result['status'] == 'blocked'
    assert 'possible-credential-content' in reasons(result)
    assert 'SYNTHETIC-CREDENTIAL' not in json.dumps(result)
    assert audit.audit_bytes(data + b'\0', 'facts.sqlite')['status'] == 'blocked'


def test_sqlite_sensitive_column_and_encoded_json_cannot_hide_secrets(tmp_path):
    for field, value in [('password', 'SYNTHETIC-CREDENTIAL'), ('value', '{"pass\\u0077ord":"SYNTHETIC-CREDENTIAL"}')]:
        db = sqlite3.connect(':memory:'); db.execute(f'CREATE TABLE records({field} TEXT)'); db.execute('INSERT INTO records VALUES (?)', (value,)); db.commit()
        data = db.serialize(); db.close()
        assert implementation().audit_bytes(data, 'facts.sqlite')['status'] == 'blocked'


def encrypted_pdf(password=''):
    from pypdf import PdfWriter
    writer = PdfWriter(); writer.add_blank_page(width=100, height=100); writer.encrypt(password)
    output = io.BytesIO(); writer.write(output); return output.getvalue()


def test_empty_password_pdf_is_read_without_rewriting_and_nonempty_password_stays_blocked():
    audit = implementation(); data = encrypted_pdf(); before = hashlib.sha256(data).hexdigest()
    assert audit.audit_bytes(data, 'transcript.pdf')['status'] == 'reviewed'
    assert hashlib.sha256(data).hexdigest() == before
    assert 'encrypted-pdf' in reasons(audit.audit_bytes(encrypted_pdf('SYNTHETIC'), 'transcript.pdf'))


def exception_pdf(signature=b'public synthetic signature', metadata=b'<public>synthetic</public>', crypt='/Crypt'):
    """Write the PDF-standard encryption exceptions pypdf's writer omits."""
    from pypdf import PdfWriter
    from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject, DictionaryObject,
                               EncodedStreamObject, NameObject, NumberObject)
    writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
    sig = DictionaryObject({NameObject('/Type'): NameObject('/Sig'), NameObject('/Contents'): ByteStringObject(signature),
                            NameObject('/ByteRange'): ArrayObject([NumberObject(0)] * 4)})
    writer._add_object(sig)  # Intentionally unreferenced: it must still be inspected.
    stream = EncodedStreamObject(); stream._data = metadata
    stream.update({NameObject('/Type'): NameObject('/Metadata'), NameObject('/Subtype'): NameObject('/XML'), NameObject('/Filter'): NameObject(crypt)})
    writer._add_object(stream)
    writer.encrypt('', algorithm='AES-128')
    writer._encryption.EncryptMetadata = False
    entry = writer._encryption.write_entry('', '')
    entry[NameObject('/EncryptMetadata')] = BooleanObject(False)
    writer._encrypt_entry.clear(); writer._encrypt_entry.update(entry)
    original = writer._encryption.encrypt_object
    def encrypt(obj, number, generation):
        if isinstance(obj, DictionaryObject) and obj.get('/Type') == '/Sig':
            plain = obj.raw_get('/Contents')
            copied = DictionaryObject(obj); del copied['/Contents']
            encrypted = original(copied, number, generation)
            encrypted[NameObject('/Contents')] = plain
            return encrypted
        if isinstance(obj, EncodedStreamObject) and obj.get('/Type') == '/Metadata':
            return obj
        return original(obj, number, generation)
    writer._encryption.encrypt_object = encrypt
    output = io.BytesIO(); writer.write(output); return output.getvalue()


def test_pdf_standard_unencrypted_signature_and_metadata_are_inspected():
    data = exception_pdf(); audit = implementation()
    assert audit.audit_bytes(data, 'signed.pdf')['status'] == 'reviewed'
    secret = b'password="SYNTHETIC-CREDENTIAL"'
    for changed in [exception_pdf(signature=secret), exception_pdf(metadata=b'<password>SYNTHETIC-CREDENTIAL</password>')]:
        result = audit.audit_bytes(changed, 'signed.pdf')
        assert result['status'] == 'blocked'
        assert any('credential' in reason for reason in reasons(result))
        assert 'SYNTHETIC-CREDENTIAL' not in json.dumps(result)


def test_pdf_encryption_exception_does_not_allow_unknown_filter_and_restores_hooks():
    from pypdf import filters
    before = filters.decode_stream_data, filters.decompress
    result = implementation().audit_bytes(exception_pdf(crypt='/Unknown'), 'signed.pdf')
    assert result['status'] == 'blocked'
    assert (filters.decode_stream_data, filters.decompress) == before
    assert implementation().audit_bytes(exception_pdf(), 'signed.pdf')['status'] == 'reviewed'
    assert (filters.decode_stream_data, filters.decompress) == before


def test_pdf_images_require_exact_visual_review_and_cannot_mask_other_objects():
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, NameObject, NumberObject
    writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
    image = DecodedStreamObject(); image.set_data(b'\xff\xff\xff')
    image.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Image'),
                  NameObject('/Width'): NumberObject(1), NameObject('/Height'): NumberObject(1),
                  NameObject('/BitsPerComponent'): NumberObject(8), NameObject('/ColorSpace'): NameObject('/DeviceRGB')})
    writer._add_object(image)  # Unreferenced images need review too.
    output = io.BytesIO(); writer.write(output); data = output.getvalue()
    audit = implementation()
    assert 'pdf-image-needs-visual-review' in reasons(audit.audit_bytes(data, 'image.pdf'))
    approved(audit, data, 'pdf-visual')
    assert audit.audit_bytes(data, 'image.pdf')['status'] == 'reviewed'
    writer.add_metadata({'/password': 'SYNTHETIC-CREDENTIAL'})
    output = io.BytesIO(); writer.write(output); changed = output.getvalue()
    approved(audit, changed, 'pdf-visual')
    assert 'credential-pdf-property' in reasons(audit.audit_bytes(changed, 'image.pdf'))


def incremental_pdf(secret=False):
    from pypdf import PdfWriter
    writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
    if secret:
        writer.add_metadata({'/password': 'SYNTHETIC-CREDENTIAL'})
    out = io.BytesIO(); writer.write(out); first = out.getvalue()
    writer = PdfWriter(io.BytesIO(first), incremental=True)
    writer.metadata.clear(); writer.add_metadata({'/Title': 'Synthetic current revision'})
    out = io.BytesIO(); writer.write(out); return first, out.getvalue()


def review_revisions(audit, data):
    import re
    approved(audit, data, 'pdf-visual')
    boundaries = list(re.finditer(rb'startxref[ \t\r\n]+(\d+)[ \t\r\n]+%%EOF(?:\r\n|\r|\n)?', data))
    audit.CONTENT_REVIEWS[hashlib.sha256(data).hexdigest()]['pdfRevisions'] = [hashlib.sha256(data[:match.end()] if i < len(boundaries)-1 else data).hexdigest() for i, match in enumerate(boundaries)]


def test_pdf_exact_history_review_still_inspects_overwritten_old_objects():
    first, data = incremental_pdf(); audit = implementation()
    assert audit.audit_bytes(data, 'history.pdf')['status'] == 'blocked'
    review_revisions(audit, data)
    assert audit.audit_bytes(data, 'history.pdf')['status'] == 'reviewed'
    _, hidden = incremental_pdf(secret=True); review_revisions(audit, hidden)
    result = audit.audit_bytes(hidden, 'history.pdf')
    assert 'credential-pdf-property' in reasons(result)
    assert 'SYNTHETIC-CREDENTIAL' not in json.dumps(result)
    audit.CONTENT_REVIEWS[hashlib.sha256(hidden).hexdigest()]['pdfRevisions'] = []
    assert 'pdf-incremental-history-needs-review' in reasons(audit.audit_bytes(hidden, 'history.pdf'))


def test_html5_doctype_is_supported_but_decoded_secrets_and_external_dtd_block():
    audit = implementation()
    assert audit.audit_bytes(b'<!DOCTYPE html><html><body><input name="q"><br>Public</body></html>', 'page.html')['status'] == 'reviewed'
    for data in [b'<!DOCTYPE html><p>pass&#119;ord=SYNTHETIC-CREDENTIAL</p>',
                 b'<!DOCTYPE html><input name="pass&#119;ord" value="SYNTHETIC-CREDENTIAL">',
                 b'<!DOCTYPE html SYSTEM "https://invalid.test/schema"><p>Public</p>']:
        assert audit.audit_bytes(data, 'page.html')['status'] == 'blocked'


def test_configuration_headers_and_jsonl_logs_are_fully_decoded_not_misread_as_json():
    audit = implementation()
    for name, data in [('package.toml', b'[project]\nname="synthetic"\n'), ('worker.service', b'[Service]\nExecStart=/usr/bin/true\n'), ('run.txt', b'{"count":1}\n{"count":2}\n')]:
        assert audit.audit_bytes(data, name)['status'] == 'reviewed'
    for name, data in [('package.toml', b'[project]\n"pass\\u0077ord"="SYNTHETIC-CREDENTIAL"\n'), ('worker.service', b'[Service]\npassword=SYNTHETIC-CREDENTIAL\n'), ('run.txt', b'{"count":1}\n{"pass\\u0077ord":"SYNTHETIC-CREDENTIAL"}\n')]:
        assert audit.audit_bytes(data, name)['status'] == 'blocked'


def test_archive_member_and_structure_node_budgets_are_independent_hard_limits():
    audit = implementation(); audit.MAX_ENTRIES = 2; audit.MAX_NODES = 12
    report = audit.audit_bytes(json.dumps(['public'] * 8).encode(), 'facts.json')
    assert report['status'] == 'reviewed'
    assert report['members'] == 1 and report['structureNodes'] == 10
    assert 'inspection-limit' in reasons(audit.audit_bytes(json.dumps(['public'] * 12).encode(), 'facts.json'))
