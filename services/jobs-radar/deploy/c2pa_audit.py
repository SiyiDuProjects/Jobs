"""Finite content inspection of independently reviewed C2PA/JUMBF attachments.

This is an archive privacy audit, not a certificate trust/signature validator.
Exact component reviews authorize public cryptographic bytes only; every box,
CBOR map, DER envelope, text string and vector element is still inspected.
"""
import hashlib
import re
import struct
import xml.etree.ElementTree as ET

MAX_BYTES = 65536
MAX_NODES = 4096
MAX_DEPTH = 24
UUIDS = {
    'c2pa': '6332706100110010800000aa00389b71',
    'manifest': '63326d6100110010800000aa00389b71',
    'c2pa.assertions': '6332617300110010800000aa00389b71',
    'c2pa.icon': '40cb0c32bb8a489da70b2ad6f47f4369',
    'c2pa.actions.v2': '63626f7200110010800000aa00389b71',
    'c2pa.hash.data': '63626f7200110010800000aa00389b71',
    'c2pa.claim.v2': '6332636c00110010800000aa00389b71',
    'c2pa.signature': '6332637300110010800000aa00389b71',
}


def check(ok, reason='c2pa-structure-needs-review'):
    if not ok:
        raise ValueError(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class Reader:
    def __init__(self, scanner, location):
        self.scanner, self.location, self.nodes = scanner, location, 0

    def node(self, depth):
        self.nodes += 1
        check(depth <= MAX_DEPTH and self.nodes <= MAX_NODES, 'c2pa-inspection-limit')
        self.scanner.node()

    def text(self, value):
        check(isinstance(value, str) and '\0' not in value)
        self.scanner.text(value.encode('utf-8'), self.location + '/c2pa-text')

    def cbor(self, data):
        check(isinstance(data, bytes) and len(data) <= MAX_BYTES, 'c2pa-inspection-limit')
        cursor = 0
        def item(depth=0):
            nonlocal cursor
            self.node(depth)
            check(cursor < len(data), 'c2pa-truncated-cbor')
            first = data[cursor]; cursor += 1
            major, argument = first >> 5, first & 31
            if argument >= 24:
                check(argument in {24, 25, 26, 27}, 'c2pa-indefinite-or-unsupported-cbor')
                size = {24: 1, 25: 2, 26: 4, 27: 8}[argument]
                check(cursor + size <= len(data), 'c2pa-truncated-cbor')
                argument = int.from_bytes(data[cursor:cursor + size], 'big'); cursor += size
                check(argument >= {1: 24, 2: 256, 4: 65536, 8: 4294967296}[size], 'c2pa-nonminimal-cbor')
            if major == 0: return argument
            if major == 1: return -argument - 1
            if major in {2, 3}:
                check(cursor + argument <= len(data), 'c2pa-truncated-cbor')
                value = data[cursor:cursor + argument]; cursor += argument
                if major == 3:
                    value = value.decode('utf-8', errors='strict'); self.text(value)
                return value
            if major == 4:
                check(argument <= MAX_NODES, 'c2pa-inspection-limit')
                return [item(depth + 1) for _ in range(argument)]
            if major == 5:
                check(argument <= MAX_NODES, 'c2pa-inspection-limit')
                result = {}
                for _ in range(argument):
                    key = item(depth + 1)
                    check(type(key) in {str, int} and key not in result, 'c2pa-duplicate-or-invalid-key')
                    result[key] = item(depth + 1)
                return result
            if major == 6:
                check(argument == 18, 'c2pa-unsupported-cbor-tag')
                return ('COSE_Sign1', item(depth + 1))
            if major == 7 and argument in {20, 21, 22}:
                return {20: False, 21: True, 22: None}[argument]
            raise ValueError('c2pa-unsupported-cbor-type')
        value = item()
        check(cursor == len(data), 'c2pa-unparsed-cbor-bytes')
        return value

    def boxes(self, data, depth=0):
        check(len(data) <= MAX_BYTES, 'c2pa-inspection-limit')
        cursor, result = 0, []
        while cursor < len(data):
            self.node(depth)
            check(cursor + 8 <= len(data), 'c2pa-truncated-box')
            size, kind = struct.unpack_from('>I4s', data, cursor)
            check(size >= 8 and cursor + size <= len(data), 'c2pa-invalid-box-size')
            value = data[cursor + 8:cursor + size]; cursor += size
            check(kind in {b'jumb', b'jumd', b'cbor', b'bfdb', b'bidb'}, 'c2pa-unknown-box')
            if kind == b'jumb':
                value = self.boxes(value, depth + 1)
            elif kind == b'jumd':
                check(len(value) >= 19 and value[16] == 3 and value[-1:] == b'\0' and b'\0' not in value[17:-1], 'c2pa-description-needs-review')
                label = value[17:-1].decode('utf-8', errors='strict'); self.text(label)
                value = {'uuid': value[:16].hex(), 'label': label}
            elif kind == b'cbor':
                value = self.cbor(value)
            result.append((kind, value))
        return result

    def der(self, data, depth=0):
        """Consume all DER TLVs; text is decoded, never treated as an opaque blob."""
        check(isinstance(data, bytes) and len(data) <= MAX_BYTES, 'c2pa-inspection-limit')
        cursor = 0
        def item(nesting):
            nonlocal cursor
            self.node(nesting)
            start = cursor
            check(cursor + 2 <= len(data), 'c2pa-truncated-der')
            tag, length = data[cursor], data[cursor + 1]; cursor += 2
            check(tag & 31 != 31, 'c2pa-unsupported-der-tag')
            if length & 128:
                size = length & 127
                check(1 <= size <= 3 and cursor + size <= len(data) and data[cursor] != 0, 'c2pa-invalid-der-length')
                length = int.from_bytes(data[cursor:cursor + size], 'big'); cursor += size
                check(length >= 128, 'c2pa-nonminimal-der')
            end = cursor + length
            check(end <= len(data), 'c2pa-truncated-der')
            content = data[cursor:end]
            children = []
            if tag & 32:
                check(tag in {0x30, 0x31} or tag & 0xC0 == 0x80, 'c2pa-unsupported-der-tag')
                while cursor < end:
                    children.append(item(nesting + 1))
                check(cursor == end, 'c2pa-der-child-overflow')
                if tag == 0x31:
                    check([child['raw'] for child in children] == sorted(child['raw'] for child in children), 'c2pa-noncanonical-der-set')
            else:
                cursor = end
                universal = tag & 0xC0 == 0
                check(not universal or tag in {1, 2, 3, 4, 5, 6, 10, 12, 18, 19, 20, 22, 23, 24, 26, 28, 30}, 'c2pa-unsupported-der-tag')
                if universal and tag in {2, 10}:
                    check(bool(content) and not (len(content) > 1 and (content[0] == 0 and content[1] < 128 or content[0] == 255 and content[1] >= 128)), 'c2pa-nonminimal-der-integer')
                if tag == 1: check(content in {b'\x00', b'\xff'}, 'c2pa-invalid-der-boolean')
                if tag == 5: check(not content, 'c2pa-invalid-der-null')
                if tag == 6:
                    check(bool(content) and not content[-1] & 128, 'c2pa-invalid-der-oid')
                    start_component = True
                    for octet in content:
                        check(not start_component or octet != 128, 'c2pa-noncanonical-der-oid')
                        start_component = not bool(octet & 128)
                if tag == 3:
                    check(bool(content) and content[0] <= 7 and (len(content) > 1 or content[0] == 0), 'c2pa-invalid-der-bits')
                    check(not content[0] or not content[-1] & ((1 << content[0]) - 1), 'c2pa-invalid-der-bits')
                if tag in {12, 18, 19, 20, 22, 23, 24, 26, 28, 30}:
                    codec = 'utf-16be' if tag == 30 else 'utf-32be' if tag == 28 else 'utf-8' if tag == 12 else 'latin-1' if tag == 20 else 'ascii'
                    self.text(content.decode(codec, errors='strict'))
                else:
                    self.scanner.text(content, self.location + '/c2pa-der-leaf')
            return {'tag': tag, 'value': content, 'children': children, 'raw': data[start:end]}
        result = item(depth)
        check(cursor == len(data), 'c2pa-unparsed-der-bytes')
        return result


def mapping(value, keys):
    check(isinstance(value, dict) and set(value) == set(keys), 'c2pa-unknown-or-missing-field')
    return value


def zero(value):
    check(isinstance(value, bytes) and len(value) <= 16384 and not any(value), 'c2pa-nonzero-or-invalid-padding')


def hashed_uri(value):
    mapping(value, {'url', 'hash'})
    check(isinstance(value['url'], str) and value['url'].startswith('self#jumbf=') and isinstance(value['hash'], bytes) and len(value['hash']) == 32)


def superbox(box, label, uuid):
    check(box[0] == b'jumb' and box[1] and box[1][0][0] == b'jumd')
    head = box[1][0][1]
    check(head == {'uuid': uuid, 'label': label} and all(kind != b'jumd' for kind, _ in box[1][1:]))
    return box[1][1:]


def reviewed_crypto(reader, raw, role, review):
    check(isinstance(raw, bytes) and digest(raw) in review.get('publicCrypto', {}).get(role, []), 'c2pa-unreviewed-crypto-bytes')
    tree = reader.der(raw)
    check(tree['tag'] == 0x30, 'c2pa-invalid-crypto-envelope')
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    def extensions(nodes):
        for extension in nodes:
            parts = extension['children']
            check(extension['tag'] == 0x30 and len(parts) in {2, 3} and parts[0]['tag'] == 6 and parts[-1]['tag'] == 4)
            if len(parts) == 3: check(parts[1]['tag'] == 1)
            # extnValue wraps another DER value, including OCSP nonce/time
            # extensions and certificate policy names encoded as BMP/UTF8.
            reader.der(parts[-1]['value'], 3)
    def explicit_extensions(wrapper):
        check(len(wrapper['children']) == 1 and wrapper['children'][0]['tag'] == 0x30)
        extensions(wrapper['children'][0]['children'])
    def certificate(encoded, parsed=None):
        parsed = parsed or reader.der(encoded, 2)
        cert = x509.load_der_x509_certificate(encoded)
        check(cert.public_bytes(serialization.Encoding.DER) == encoded, 'c2pa-noncanonical-certificate')
        list(cert.extensions); cert.public_key()
        check(parsed['tag'] == 0x30 and len(parsed['children']) == 3 and parsed['children'][0]['tag'] == 0x30)
        extension_wrappers = [node for node in parsed['children'][0]['children'] if node['tag'] == 0xA3]
        check(len(extension_wrappers) <= 1)
        for wrapper in extension_wrappers:
            explicit_extensions(wrapper)
        return cert
    if role == 'x509':
        certificate(raw, tree)
    elif role == 'ocsp':
        from cryptography.x509 import ocsp
        value = ocsp.load_der_ocsp_response(raw)
        check(value.response_status == ocsp.OCSPResponseStatus.SUCCESSFUL and value.public_bytes(serialization.Encoding.DER) == raw, 'c2pa-invalid-ocsp')
        children = tree['children']
        check(len(children) == 2 and children[0]['tag'] == 10 and children[0]['value'] == b'\0' and children[1]['tag'] == 0xA0)
        response = children[1]['children']
        check(len(response) == 1 and response[0]['tag'] == 0x30)
        body = response[0]['children']
        check(len(body) == 2 and body[0]['tag'] == 6 and body[0]['value'].hex() == '2b0601050507300101' and body[1]['tag'] == 4)
        basic = reader.der(body[1]['value'], 1)
        check(basic['tag'] == 0x30 and 3 <= len(basic['children']) <= 4)
        parts = basic['children']
        check([node['tag'] for node in parts[:3]] == [0x30, 0x30, 3])
        response_data = parts[0]['children']
        if response_data and response_data[0]['tag'] == 0xA0:
            response_data = response_data[1:]
        check(3 <= len(response_data) <= 4 and response_data[0]['tag'] in {0xA1, 0xA2} and response_data[1]['tag'] == 24 and response_data[2]['tag'] == 0x30)
        if len(response_data) == 4:
            check(response_data[3]['tag'] == 0xA1)
            explicit_extensions(response_data[3])
        for response in response_data[2]['children']:
            check(response['tag'] == 0x30 and 3 <= len(response['children']) <= 5)
            singles = response['children']
            check(singles[0]['tag'] == 0x30 and singles[1]['tag'] in {0x80, 0xA1, 0x82} and singles[2]['tag'] == 24)
            extras = singles[3:]
            check([node['tag'] for node in extras] in [[], [0xA0], [0xA1], [0xA0, 0xA1]])
            for wrapper in extras:
                if wrapper['tag'] == 0xA1: explicit_extensions(wrapper)
        if len(parts) == 4: check(parts[3]['tag'] == 0xA0)
        for cert in value.certificates:
            cert_raw = cert.public_bytes(serialization.Encoding.DER)
            certificate(cert_raw)
    elif role == 'timestamp':
        top = tree['children']
        check(len(top) == 2 and top[0]['tag'] == 6 and top[0]['value'].hex() == '2a864886f70d010702' and top[1]['tag'] == 0xA0)
        check(len(top[1]['children']) == 1 and top[1]['children'][0]['tag'] == 0x30)
        signed = top[1]['children'][0]['children']
        check(len(signed) == 5 and [node['tag'] for node in signed] == [2, 0x31, 0x30, 0xA0, 0x31])
        content = signed[2]['children']
        check(len(content) == 2 and content[0]['tag'] == 6 and content[0]['value'].hex() == '2a864886f70d0109100104' and content[1]['tag'] == 0xA0)
        wrapped = content[1]['children']
        check(len(wrapped) == 1 and wrapped[0]['tag'] == 4)
        tst = reader.der(wrapped[0]['value'], 1)
        check(tst['tag'] == 0x30 and 5 <= len(tst['children']) <= 10)
        check([node['tag'] for node in tst['children'][:5]] == [2, 6, 0x30, 2, 24])
        for optional in tst['children'][5:]:
            if optional['tag'] == 0xA1: extensions(optional['children'])
        certificates = [node for node in signed[3:-1] if node['tag'] == 0xA0]
        check(len(certificates) == 1 and 1 <= len(certificates[0]['children']) <= 8)
        for node in certificates[0]['children']:
            check(node['tag'] == 0x30)
            certificate(node['raw'], node)
        signers = signed[-1]['children']
        check(len(signers) == 1 and signers[0]['tag'] == 0x30)
        signer = signers[0]['children']
        check([node['tag'] for node in signer] == [2, 0x30, 0x30, 0xA0, 0x30, 4])
        check(128 <= len(signer[-1]['value']) <= 512)
        attributes = {}
        for attribute in signer[3]['children']:
            check(attribute['tag'] == 0x30 and [node['tag'] for node in attribute['children']] == [6, 0x31])
            oid, values = attribute['children']
            name = oid['value'].hex()
            check(name not in attributes and len(values['children']) == 1)
            attributes[name] = values['children'][0]
        check(set(attributes) == {'2a864886f70d010903', '2a864886f70d010904', '2a864886f70d010910022f'})
        check(attributes['2a864886f70d010903']['tag'] == 6 and attributes['2a864886f70d010903']['value'].hex() == '2a864886f70d0109100104')
        check(attributes['2a864886f70d010904']['tag'] == 4 and len(attributes['2a864886f70d010904']['value']) == 32)
        check(attributes['2a864886f70d010910022f']['tag'] == 0x30)
    else:
        raise ValueError('c2pa-unknown-crypto-role')


def audit(data, scanner, location, review):
    check(isinstance(data, bytes) and len(data) <= MAX_BYTES, 'c2pa-inspection-limit')
    check(review and review.get('kind') == 'c2pa-structure' and review.get('size') == len(data), 'c2pa-unreviewed-manifest')
    reader = Reader(scanner, location)
    boxes = reader.boxes(data)
    check(len(boxes) == 1)
    root = superbox(boxes[0], 'c2pa', UUIDS['c2pa'])
    check(len(root) == 1 and root[0][0] == b'jumb')
    name = root[0][1][0][1]['label']
    check(re.fullmatch(r'urn:c2pa:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', name) is not None)
    manifest = superbox(root[0], name, UUIDS['manifest'])
    check(len(manifest) == 3)
    stores = {}
    for box in manifest:
        check(box[0] == b'jumb' and box[1] and box[1][0][0] == b'jumd')
        label = box[1][0][1]['label']
        check(label in {'c2pa.assertions', 'c2pa.claim.v2', 'c2pa.signature'} and label not in stores)
        stores[label] = superbox(box, label, UUIDS[label])
    check(set(stores) == {'c2pa.assertions', 'c2pa.claim.v2', 'c2pa.signature'})
    assertions = {}
    for box in stores['c2pa.assertions']:
        check(box[0] == b'jumb' and box[1] and box[1][0][0] == b'jumd')
        label = box[1][0][1]['label']
        check(label in {'c2pa.icon', 'c2pa.actions.v2', 'c2pa.hash.data'} and label not in assertions)
        assertions[label] = superbox(box, label, UUIDS[label])
    check(set(assertions) == {'c2pa.icon', 'c2pa.actions.v2', 'c2pa.hash.data'})
    icon = assertions['c2pa.icon']
    check(len(icon) == 2 and icon[0] == (b'bfdb', b'\0image/svg+xml\0') and icon[1][0] == b'bidb')
    svg = icon[1][1]
    check(digest(svg) == review.get('svgSha256'), 'c2pa-unreviewed-svg')
    check(not any(mark in svg for mark in (b'<!--', b'<?', b'<!')), 'c2pa-svg-hidden-metadata')
    scanner.xml(svg, location + '/c2pa-svg')
    element = ET.fromstring(svg)
    ns = '{http://www.w3.org/2000/svg}'
    check(element.tag == ns + 'svg' and len(list(element.iter())) == 2 and len(element) == 1 and element[0].tag == ns + 'path', 'c2pa-svg-structure')
    check(set(element.attrib) == {'width', 'height', 'viewBox', 'fill'} and set(element[0].attrib) == {'d', 'fill'}, 'c2pa-svg-attributes')
    check(all(not (item.text or '').strip() and not (item.tail or '').strip() for item in element.iter()), 'c2pa-svg-hidden-text')
    def payload(items):
        check(len(items) == 1 and items[0][0] == b'cbor')
        return items[0][1]
    actions = mapping(payload(assertions['c2pa.actions.v2']), {'actions', 'allActionsIncluded'})
    check(type(actions['allActionsIncluded']) is bool and isinstance(actions['actions'], list) and 1 <= len(actions['actions']) <= 8)
    for action in actions['actions']:
        mapping(action, {'action', 'digitalSourceType', 'softwareAgent', 'when'})
        mapping(action['softwareAgent'], {'name', 'version'})
        check(all(isinstance(action[key], str) for key in ('action', 'digitalSourceType', 'when')) and all(isinstance(item, str) for item in action['softwareAgent'].values()))
    hashes = mapping(payload(assertions['c2pa.hash.data']), {'exclusions', 'name', 'alg', 'hash', 'pad'})
    check(hashes['alg'] == 'sha256' and isinstance(hashes['name'], str) and isinstance(hashes['hash'], bytes) and len(hashes['hash']) == 32)
    check(isinstance(hashes['exclusions'], list) and 1 <= len(hashes['exclusions']) <= 8)
    for exclusion in hashes['exclusions']:
        mapping(exclusion, {'start', 'length'})
        check(all(type(value) is int and 0 <= value < 2**32 for value in exclusion.values()))
    zero(hashes['pad'])
    claim = mapping(payload(stores['c2pa.claim.v2']), {'instanceID', 'claim_generator_info', 'signature', 'created_assertions', 'dc:title', 'alg'})
    check(claim['alg'] == 'sha256' and all(isinstance(claim[key], str) for key in ('instanceID', 'signature', 'dc:title')))
    check(claim['signature'] == 'self#jumbf=/c2pa/' + name + '/c2pa.signature')
    generator = mapping(claim['claim_generator_info'], {'name', 'icon', 'specVersion'})
    check(isinstance(generator['name'], str) and isinstance(generator['specVersion'], str))
    hashed_uri(generator['icon'])
    check(isinstance(claim['created_assertions'], list) and len(claim['created_assertions']) == 3)
    for assertion in claim['created_assertions']: hashed_uri(assertion)
    check({item['url'] for item in claim['created_assertions']} == {'self#jumbf=c2pa.assertions/' + key for key in assertions})
    tagged = payload(stores['c2pa.signature'])
    check(isinstance(tagged, tuple) and tagged[0] == 'COSE_Sign1')
    cose = tagged[1]
    check(isinstance(cose, list) and len(cose) == 4 and cose[2] is None)
    protected = mapping(reader.cbor(cose[0]), {1, 33})
    check(protected[1] == -37 and isinstance(protected[33], list) and len(protected[33]) == 2)
    for cert in protected[33]: reviewed_crypto(reader, cert, 'x509', review)
    header = mapping(cose[1], {'sigTst2', 'rVals', 'pad'})
    timestamp = mapping(header['sigTst2'], {'tstTokens'})['tstTokens']
    check(isinstance(timestamp, list) and len(timestamp) == 1)
    reviewed_crypto(reader, mapping(timestamp[0], {'val'})['val'], 'timestamp', review)
    statuses = mapping(header['rVals'], {'ocspVals'})['ocspVals']
    check(isinstance(statuses, list) and len(statuses) == 1)
    reviewed_crypto(reader, statuses[0], 'ocsp', review)
    zero(header['pad'])
    check(isinstance(cose[3], bytes) and len(cose[3]) == 256 and digest(cose[3]) in review.get('publicCrypto', {}).get('rsaSignature', []), 'c2pa-unreviewed-signature-bytes')
    scanner.text(cose[3], location + '/c2pa-public-signature')
    scanner.methods.add('c2pa-bounded-jumbf-cbor-der-svg-content')
