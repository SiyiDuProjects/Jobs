"""Synthetic content tests; no private resumes or reusable credentials."""
import copy
import datetime
import hashlib
import json
import struct

import pytest

from test_workspace_audit import implementation, reasons


def sha(value):
    return hashlib.sha256(value).hexdigest()


def tlv(tag, value):
    size = len(value)
    length = bytes([size]) if size < 128 else bytes([128 + (size.bit_length() + 7) // 8]) + size.to_bytes((size.bit_length() + 7) // 8, 'big')
    return bytes([tag]) + length + value


def seq(*values):
    return tlv(0x30, b''.join(values))


def oid(value):
    return tlv(6, bytes.fromhex(value))


def cbor(value):
    def head(major, size):
        if size < 24:
            return bytes([(major << 5) | size])
        width = next(n for n in (1, 2, 4, 8) if size < 2 ** (n * 8))
        return bytes([(major << 5) | {1: 24, 2: 25, 4: 26, 8: 27}[width]]) + size.to_bytes(width, 'big')
    if value is None:
        return b'\xf6'
    if isinstance(value, bool):
        return b'\xf5' if value else b'\xf4'
    if isinstance(value, int):
        return head(0, value) if value >= 0 else head(1, -1 - value)
    if isinstance(value, (bytes, str)):
        data = value.encode() if isinstance(value, str) else value
        return head(3 if isinstance(value, str) else 2, len(data)) + data
    if isinstance(value, tuple):
        assert value[0] == 'COSE_Sign1'
        return b'\xd2' + cbor(value[1])
    if isinstance(value, list):
        return head(4, len(value)) + b''.join(cbor(item) for item in value)
    return head(5, len(value)) + b''.join(cbor(key) + cbor(item) for key, item in value.items())


def box(kind, data):
    return struct.pack('>I4s', len(data) + 8, kind) + data


def superbox(label, content, module, identity=None):
    return box(b'jumb', box(b'jumd', bytes.fromhex(module.UUIDS[identity or label]) + b'\x03' + label.encode() + b'\0') + content)


@pytest.fixture(scope='module')
def public_crypto():
    # These short-lived keys only construct public DER test data. They are not
    # serialized, logged, saved, or used to establish any signature trust.
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509 import ocsp
    from cryptography.x509.oid import NameOID, ObjectIdentifier
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Synthetic public signer')])
    start = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    builder = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(17).not_valid_before(start).not_valid_after(start + datetime.timedelta(days=1))
    cert = builder.sign(key, hashes.SHA256())
    bad_ext = x509.UnrecognizedExtension(ObjectIdentifier('1.2.3.4'), tlv(30, 'password=SYNTHETIC-ONLY'.encode('utf-16be')))
    encoded_cert = cert.public_bytes(serialization.Encoding.DER)
    bad_cert = builder.add_extension(bad_ext, critical=False).sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.DER)
    ocsp_base = ocsp.OCSPResponseBuilder().add_response(cert=cert, issuer=cert, algorithm=hashes.SHA1(), cert_status=ocsp.OCSPCertStatus.GOOD, this_update=start, next_update=start + datetime.timedelta(hours=1), revocation_time=None, revocation_reason=None).responder_id(ocsp.OCSPResponderEncoding.HASH, cert).certificates([cert])
    response = ocsp_base.sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.DER)
    bad_response = ocsp_base.add_extension(bad_ext, critical=False).sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.DER)
    return dict(cert=encoded_cert, bad_cert=bad_cert, ocsp=response, bad_ocsp=bad_response)


def timestamp(cert, text='20260101000000Z'):
    alg = seq(oid('608648016503040201'), tlv(5, b''))
    content_type = oid('2a864886f70d0109100104')
    tst = seq(tlv(2, b'\x01'), oid('2a03'), seq(alg, tlv(4, b'h' * 32)), tlv(2, b'\x11'), tlv(24, text.encode()))
    attrs = [seq(oid('2a864886f70d010903'), tlv(0x31, content_type)), seq(oid('2a864886f70d010904'), tlv(0x31, tlv(4, b'h' * 32))), seq(oid('2a864886f70d010910022f'), tlv(0x31, seq(seq(tlv(4, b'h' * 32)))))]
    signer = seq(tlv(2, b'\x01'), seq(seq(), tlv(2, b'\x11')), alg, tlv(0xA0, b''.join(sorted(attrs))), alg, tlv(4, b's' * 256))
    signed = seq(tlv(2, b'\x03'), tlv(0x31, alg), seq(content_type, tlv(0xA0, tlv(4, tst))), tlv(0xA0, cert), tlv(0x31, signer))
    return seq(oid('2a864886f70d010702'), tlv(0xA0, signed))


def model(crypto):
    name = 'urn:c2pa:00000000-0000-0000-0000-000000000001'
    uri = lambda label: {'url': 'self#jumbf=c2pa.assertions/' + label, 'hash': b'h' * 32}
    return {
        'name': name,
        'svg': b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1" fill="none"><path d="M0 0L1 1" fill="black"/></svg>',
        'actions': {'actions': [{'action': 'c2pa.created', 'digitalSourceType': 'https://example.invalid/source', 'softwareAgent': {'name': 'Synthetic fixture', 'version': '1'}, 'when': '2026-01-01T00:00:00Z'}], 'allActionsIncluded': True},
        'hash': {'exclusions': [{'start': 1, 'length': 2}], 'name': 'Synthetic PDF', 'alg': 'sha256', 'hash': b'h' * 32, 'pad': b'\0' * 8},
        'claim': {'instanceID': 'synthetic', 'claim_generator_info': {'name': 'Synthetic generator', 'icon': uri('c2pa.icon'), 'specVersion': '2.4'}, 'signature': 'self#jumbf=/c2pa/' + name + '/c2pa.signature', 'created_assertions': [uri(label) for label in ('c2pa.icon', 'c2pa.actions.v2', 'c2pa.hash.data')], 'dc:title': 'Synthetic document', 'alg': 'sha256'},
        'protected': {1: -37, 33: [crypto['cert'], crypto['cert']]},
        'header': {'sigTst2': {'tstTokens': [{'val': timestamp(crypto['cert'])}]}, 'rVals': {'ocspVals': [crypto['ocsp']]}, 'pad': b'\0' * 8},
        'signature': b'r' * 256,
    }


def manifest(value):
    module = implementation('c2pa_audit')
    sb = lambda label, data, identity=None: superbox(label, data, module, identity)
    assertions = sb('c2pa.icon', box(b'bfdb', b'\0image/svg+xml\0') + box(b'bidb', value['svg'])) + sb('c2pa.actions.v2', box(b'cbor', cbor(value['actions']))) + sb('c2pa.hash.data', box(b'cbor', cbor(value['hash'])))
    protected = value.get('protected_bytes', cbor(value['protected']))
    cose = ('COSE_Sign1', [protected, value['header'], None, value['signature']])
    return sb('c2pa', sb(value['name'], sb('c2pa.assertions', assertions) + sb('c2pa.claim.v2', box(b'cbor', cbor(value['claim']))) + sb('c2pa.signature', box(b'cbor', cbor(cose))), 'manifest'))


def approve(module, data, value):
    # A test-only review authorizes generated public components; production
    # supports exactly the two independently reviewed C2PA attachment digests.
    module.CONTENT_REVIEWS[sha(data)] = {
        'kind': 'c2pa-structure', 'size': len(data), 'basis': 'Synthetic structural test only', 'svgSha256': sha(value['svg']),
        'publicCrypto': {
            'x509': [sha(item) for item in value['protected'][33]],
            'timestamp': [sha(item['val']) for item in value['header']['sigTst2']['tstTokens']],
            'ocsp': [sha(item) for item in value['header']['rVals']['ocspVals']],
            'rsaSignature': [sha(value['signature'])],
        },
    }


def run(value):
    module = implementation()
    data = manifest(value)
    approve(module, data, value)
    result = module.audit_bytes(data, 'Content Credentials')
    assert 'SYNTHETIC-ONLY' not in json.dumps(result)
    return result


def test_full_jumbf_cbor_cose_der_and_svg_public_content(public_crypto):
    result = run(model(public_crypto))
    assert result['status'] == 'reviewed', result['findings']
    assert 'c2pa-bounded-jumbf-cbor-der-svg-content' in result['methods']
    assert result['structureNodes'] > 200


@pytest.mark.parametrize('change', ['action-secret', 'claim-secret', 'unknown-action-field', 'unknown-header-field', 'nonzero-pad', 'unknown-protected-field', 'bad-svg-attribute', 'hidden-svg-comment', 'certificate-extension-secret', 'ocsp-extension-secret', 'timestamp-secret', 'malformed-timestamp', 'malformed-certificate', 'malformed-ocsp'])
def test_even_reviewed_digest_never_bypasses_content_or_structure(public_crypto, change):
    value = model(public_crypto)
    if change == 'action-secret': value['actions']['actions'][0]['softwareAgent']['name'] = 'password=SYNTHETIC-ONLY'
    elif change == 'claim-secret': value['claim']['dc:title'] = 'password=SYNTHETIC-ONLY'
    elif change == 'unknown-action-field': value['actions']['actions'][0]['extra'] = 'ordinary but unreviewed'
    elif change == 'unknown-header-field': value['header']['extra'] = 'ordinary but unreviewed'
    elif change == 'nonzero-pad': value['header']['pad'] = b'\0\x01'
    elif change == 'unknown-protected-field': value['protected']['extra'] = 'ordinary but unreviewed'
    elif change == 'bad-svg-attribute': value['svg'] = value['svg'].replace(b'fill="none"', b'fill="none" onclick="anything"')
    elif change == 'hidden-svg-comment': value['svg'] = value['svg'].replace(b'<path', b'<!--hidden--><path')
    elif change == 'certificate-extension-secret': value['protected'][33][0] = public_crypto['bad_cert']
    elif change == 'ocsp-extension-secret': value['header']['rVals']['ocspVals'][0] = public_crypto['bad_ocsp']
    elif change == 'timestamp-secret': value['header']['sigTst2']['tstTokens'][0]['val'] = timestamp(public_crypto['cert'], 'password=SYNTHETIC-ONLY')
    elif change == 'malformed-timestamp': value['header']['sigTst2']['tstTokens'][0]['val'] = seq()
    elif change == 'malformed-certificate': value['protected'][33][0] = seq()
    elif change == 'malformed-ocsp': value['header']['rVals']['ocspVals'][0] = seq()
    result = run(value)
    assert result['status'] == 'blocked'
    if change.endswith('-secret'):
        assert any('credential' in reason for reason in reasons(result)), result['findings']


def test_nested_protected_cbor_text_is_scanned_before_rejecting_unknown_fields(public_crypto):
    value = model(public_crypto)
    value['protected']['extra'] = 'password=SYNTHETIC-ONLY'
    result = run(value)
    assert 'possible-credential-assignment' in reasons(result)


def test_public_component_hashes_are_independently_required(public_crypto):
    value = model(public_crypto)
    data = manifest(value)
    module = implementation()
    approve(module, data, value)
    module.CONTENT_REVIEWS[sha(data)]['publicCrypto']['ocsp'] = []
    result = module.audit_bytes(data, 'Content Credentials')
    assert 'c2pa-unreviewed-crypto-bytes' in reasons(result)


def test_unknown_manifest_or_appended_payload_cannot_use_reviewed_component_names(public_crypto):
    value = model(public_crypto)
    data = manifest(value)
    module = implementation()
    assert 'c2pa-unreviewed-manifest' in reasons(module.audit_bytes(data, 'Content Credentials'))
    approve(module, data, value)
    assert module.audit_bytes(data + b'hidden', 'Content Credentials')['status'] == 'blocked'


@pytest.mark.parametrize('data', [b'\x9f\xff', b'\x18\x01', b'\xa2\x01\x00\x01\x01', b'\x61\xff', b'\xd3\x00', b'\xfa\0\0\0\0', b'\x41', b'\x00\x00'])
def test_cbor_rejects_noncanonical_indefinite_duplicate_or_unparsed_bytes(data):
    reader = implementation('c2pa_audit').Reader(implementation().Scanner(), '$')
    with pytest.raises((ValueError, UnicodeError)):
        reader.cbor(data)


@pytest.mark.parametrize('data', [b'\x30\x80\0\0', b'\x02\x81\x01\x01', b'\x02\x02\0\x01', b'\x06\x02\x80\x01', b'\x05\x01\0', b'\x03\x02\x01\x01', b'\x01\x01\x01', b'\x07\0', b'\x05\0\0', tlv(0x31, tlv(2, b'\x02') + tlv(2, b'\x01'))])
def test_der_rejects_indefinite_nonminimal_unsupported_or_unparsed_bytes(data):
    reader = implementation('c2pa_audit').Reader(implementation().Scanner(), '$')
    with pytest.raises(ValueError):
        reader.der(data)


@pytest.mark.parametrize('data', [box(b'uuid', b'x'), b'\0\0\0\x07jumb', box(b'jumb', b'junk'), box(b'jumd', b'\0' * 16 + b'\x01label\0'), box(b'jumd', b'\0' * 16 + b'\x03a\0b\0')])
def test_jumbf_rejects_unknown_boxes_lengths_and_description_flags(data):
    reader = implementation('c2pa_audit').Reader(implementation().Scanner(), '$')
    with pytest.raises(ValueError):
        reader.boxes(data)


@pytest.mark.parametrize('kind', ['cbor-depth', 'cbor-nodes', 'cbor-bytes', 'der-depth', 'boxes-depth'])
def test_all_decoders_are_bounded(kind):
    module = implementation('c2pa_audit')
    reader = module.Reader(implementation().Scanner(), '$')
    if kind == 'cbor-depth': data, method = b'\x81' * 26 + b'\x00', reader.cbor
    elif kind == 'cbor-nodes': data, method = b'\x99\x10\x01', reader.cbor
    elif kind == 'cbor-bytes': data, method = b'\0' * (module.MAX_BYTES + 1), reader.cbor
    elif kind == 'der-depth':
        data, method = b'\x05\0', reader.der
        for _ in range(26): data = tlv(0x30, data)
    else:
        data, method = b'', reader.boxes
        for _ in range(27): data = box(b'jumb', data)
    with pytest.raises(ValueError, match='c2pa-inspection-limit'):
        method(data)


def test_unknown_padding_and_opaque_der_never_receive_generic_binary_allowance(public_crypto):
    module = implementation('c2pa_audit')
    with pytest.raises(ValueError, match='padding'):
        module.zero(b'\0' * 16385)
    result = implementation().audit_bytes(public_crypto['cert'], 'not-c2pa.bin')
    assert result['status'] == 'blocked'
