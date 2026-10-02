"""Read-only recovery audit. Reports hashes, paths and classifications, never values.

A clean result means the supported structures were fully inspected and no known
credential marker was found. Unsupported/encrypted/corrupt input is unresolved,
not an allow rule. No archive is extracted and no Git object is written to disk.
"""
import argparse
import base64
import bz2
import configparser
import hashlib
import importlib.util
import io
import json
import re
import stat
import struct
import sqlite3
import tarfile
import threading
import tomllib
import xml.etree.ElementTree as ET
import zipfile
import zlib
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath

VERSION = 1
MAX_FILE = 256 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
MAX_ENTRIES = 200000
MAX_NODES = 1000000
MAX_DEPTH = 8
MAX_FINDINGS = 1000
MAX_JSON_DEPTH = 64
PDF_LOCK = threading.RLock()
TEXT_SUFFIXES = {'.txt', '.md', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.xml', '.rels', '.toml', '.yaml', '.yml', '.py', '.sh', '.ps1', '.log', '.csv', '.svg', '.ini', '.cfg', '.conf', '.sql', '.lock', '.map'}


def _policy():
    path = Path(__file__).with_name('backup_workspace.py')
    spec = importlib.util.spec_from_file_location('_backup_policy', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


POLICY = _policy()
_REVIEWS_PATH = Path(__file__).with_name('audit-reviewed-content.json')
# This repository-controlled evidence is code review material, not an input
# manifest supplied by the backup caller. Only exact immutable bytes match.
CONTENT_REVIEWS = json.loads(_REVIEWS_PATH.read_text(encoding='utf-8'))['objects'] if _REVIEWS_PATH.exists() else {}


class Unresolved(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def credential_name(name):
    lower = PurePosixPath(name).name.casefold()
    return lower == '.env' or lower.startswith('.env.') or lower in POLICY.SKIP_NAMES or lower.endswith(('.pem', '.key', '.p12', '.pfx'))


def safe_member(name):
    value = PurePosixPath(name)
    if not name or '\0' in name or value.is_absolute() or '..' in value.parts or '\\' in name or re.match(r'^[A-Za-z]:', name):
        raise Unresolved('unsafe-member-path')


def zip_directory(data):
    """Validate the footer before ZipFile allocates its directory object list."""
    end = data.rfind(b'PK\x05\x06', max(0, len(data) - 65557))
    if end < 0 or end + 22 > len(data):
        raise Unresolved('invalid-zip-layout')
    _, disk, directory_disk, disk_count, count, size, offset, comment_size = struct.unpack_from('<4s4H2IH', data, end)
    if disk or directory_disk or disk_count != count:
        raise Unresolved('multi-disk-zip')
    directory_end = end
    if end >= 20 and data[end - 20:end - 16] == b'PK\x06\x07':
        _, zip64_disk, record, disks = struct.unpack_from('<4sIQI', data, end - 20)
        if zip64_disk or disks != 1 or record + 56 != end - 20:
            raise Unresolved('invalid-zip64-locator')
        if record + 56 > len(data):
            raise Unresolved('invalid-zip64-record')
        signature, record_size, _, _, this_disk, central_disk, this_count, total_count, total_size, total_offset = struct.unpack_from('<4sQ2H2I4Q', data, record)
        if signature != b'PK\x06\x06' or record_size != 44 or this_disk or central_disk or this_count != total_count:
            raise Unresolved('invalid-zip64-record')
        if any(small not in (large, maximum) for small, large, maximum in ((count, total_count, 65535), (size, total_size, 0xffffffff), (offset, total_offset, 0xffffffff))):
            raise Unresolved('inconsistent-zip64-record')
        count, size, offset, directory_end = total_count, total_size, total_offset, record
    elif count == 65535 or size == 0xffffffff or offset == 0xffffffff:
        raise Unresolved('missing-zip64-record')
    if count > MAX_ENTRIES:
        raise Unresolved('inspection-limit')
    if end + 22 + comment_size != len(data) or offset + size != directory_end:
        raise Unresolved('unparsed-zip-bytes')
    return count, offset, directory_end


def exact_zip_layout(data, archive):
    """Reject unparsed prefixes, appended archives and trailing payloads."""
    count, offset, end = zip_directory(data)
    if archive.start_dir != offset:
        raise Unresolved('unparsed-zip-bytes')
    entries = archive.infolist()
    if count != len(entries):
        raise Unresolved('invalid-zip-entry-count')
    cursor, ranges = 0, {}
    for item in sorted(entries, key=lambda row: row.header_offset):
        if item.header_offset != cursor or cursor + 30 > offset:
            raise Unresolved('unparsed-zip-bytes')
        values = struct.unpack_from('<4s5H3I2H', data, cursor)
        signature, _, flags, method, _, _, crc, compressed, expanded, name_size, extra_size = values
        if signature != b'PK\x03\x04' or flags != item.flag_bits or method != item.compress_type:
            raise Unresolved('inconsistent-zip-header')
        try:
            local_name = data[cursor + 30:cursor + 30 + name_size].decode('utf-8' if flags & 0x800 else 'cp437')
        except UnicodeError:
            raise Unresolved('invalid-zip-member-encoding')
        if local_name != item.orig_filename:
            raise Unresolved('inconsistent-zip-member-name')
        zip64 = compressed == 0xffffffff or expanded == 0xffffffff
        extra = data[cursor + 30 + name_size:cursor + 30 + name_size + extra_size]
        extras, extra_cursor = {}, 0
        while extra_cursor < len(extra):
            if extra_cursor + 4 > len(extra):
                raise Unresolved('invalid-zip-extra')
            code, length = struct.unpack_from('<2H', extra, extra_cursor)
            extra_cursor += 4
            if extra_cursor + length > len(extra) or code in extras:
                raise Unresolved('invalid-zip-extra')
            extras[code] = extra[extra_cursor:extra_cursor + length]
            extra_cursor += length
        if any(code != 1 for code in extras) or (1 in extras and not zip64):
            raise Unresolved('zip-extra-needs-content-review')
        if zip64:
            values64 = extras.get(1, b'')
            needed = 8 * ((expanded == 0xffffffff) + (compressed == 0xffffffff))
            if len(values64) != needed:
                raise Unresolved('invalid-zip64-extra')
            position = 0
            if expanded == 0xffffffff:
                expanded = struct.unpack_from('<Q', values64, position)[0]; position += 8
            if compressed == 0xffffffff:
                compressed = struct.unpack_from('<Q', values64, position)[0]
        start = cursor + 30 + name_size + extra_size
        cursor = start + item.compress_size
        if cursor > offset:
            raise Unresolved('invalid-zip-data-range')
        ranges[item.header_offset] = (start, cursor)
        if flags & 8:
            if data[cursor:cursor + 4] == b'PK\x07\x08':
                cursor += 4
            descriptor_size = 20 if zip64 else 12
            if cursor + descriptor_size > offset:
                raise Unresolved('invalid-zip-descriptor')
            crc, compressed, expanded = struct.unpack_from('<I2Q' if zip64 else '<3I', data, cursor)
            cursor += descriptor_size
        if (crc, compressed, expanded) != (item.CRC, item.compress_size, item.file_size):
            raise Unresolved('inconsistent-zip-descriptor')
    if cursor != offset:
        raise Unresolved('unparsed-zip-bytes')
    for _ in entries:
        if cursor + 46 > end or data[cursor:cursor + 4] != b'PK\x01\x02':
            raise Unresolved('invalid-zip-directory')
        name_size, extra_size, comment_size = struct.unpack_from('<3H', data, cursor + 28)
        extra = data[cursor + 46 + name_size:cursor + 46 + name_size + extra_size]
        # Only the ZIP64 values actually required by saturated directory fields
        # have defined semantics here. Unknown/unused metadata is not cleared.
        if extra:
            required = sum(struct.unpack_from('<I', data, cursor + at)[0] == 0xffffffff for at in (20, 24, 42)) * 8
            required += 4 if struct.unpack_from('<H', data, cursor + 34)[0] == 0xffff else 0
            if len(extra) != 4 + required or required == 0 or struct.unpack_from('<HH', extra) != (1, required):
                raise Unresolved('zip-extra-needs-content-review')
        cursor += 46 + name_size + extra_size + comment_size
    if cursor != end:
        raise Unresolved('unparsed-zip-bytes')
    return ranges


class Scanner:
    def __init__(self):
        self.expanded = 0
        self.entries = 0
        self.nodes = 0
        self.findings = []
        self.methods = set()

    def reviewed(self, data, kind):
        row = CONTENT_REVIEWS.get(digest(data), {})
        return row if row.get('kind') == kind and row.get('size') == len(data) and row.get('basis') else {}

    def source_finding(self, data, location, reason):
        row = self.reviewed(data, 'source-syntax')
        if reason in row.get('allowedFindings', ()):
            self.methods.add('exact-source-syntax-review')
        else:
            self.finding(location, reason)

    def null_connection(self, data, name):
        return (PurePosixPath(name).name.casefold() == 'private-connection.js'
                and bool(self.reviewed(data, 'null-connection'))
                and bool(re.fullmatch(rb'(?:\s|//[^\r\n]*(?:\r?\n|$)|/\*[\s\S]*?\*/)*(?:globalThis|window)\.JobsPrivateConnection\s*=\s*null\s*;?\s*', data)))

    def charge(self, data):
        self.expanded += len(data)
        self.entries += 1
        if self.expanded > MAX_EXPANDED or len(data) > MAX_FILE or self.entries > MAX_ENTRIES:
            raise Unresolved('inspection-limit')

    def finding(self, location, reason):
        if len(self.findings) >= MAX_FINDINGS:
            raise Unresolved('inspection-limit')
        self.findings.append({'member': location, 'reason': reason})

    def node(self, data=b''):
        self.expanded += len(data)
        self.nodes += 1
        if self.expanded > MAX_EXPANDED or len(data) > MAX_FILE or self.nodes > MAX_NODES:
            raise Unresolved('inspection-limit')

    def text(self, data, location):
        self.methods.add('credential-patterns')
        views = [data]
        if data.startswith((b'\xff\xfe', b'\xfe\xff')):
            try:
                views.append(data.decode('utf-16').encode())
            except UnicodeError:
                raise Unresolved('invalid-text-encoding')
        if any(pattern.search(value) for value in views for pattern in POLICY.SECRET_PATTERNS):
            self.source_finding(data, location, 'possible-credential-content')
        for value in views:
            text = value.decode('utf-8', errors='replace')
            if re.search(r'(?im)(?:\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)|密码|口令|验证码)\s*[:：=]\s*[^\s<>]{4,}', text):
                self.source_finding(data, location, 'possible-credential-assignment')

    def child(self, data, name, location, depth):
        try:
            self.scan(data, name, location, depth)
        except Unresolved as error:
            if str(error) == 'inspection-limit':
                raise
            self.finding(location, str(error))

    def scan(self, data, name, location='$', depth=0):
        if depth > MAX_DEPTH:
            raise Unresolved('nesting-limit')
        self.charge(data)
        if credential_name(name) and not self.null_connection(data, name):
            self.finding(location, 'credential-file-name')
        self.text(data, location)
        suffix = PurePosixPath(name).suffix.casefold()
        structured = data.decode('utf-16').encode() if data.startswith((b'\xff\xfe', b'\xfe\xff')) else data
        leading = structured.removeprefix(b'\xef\xbb\xbf').lstrip()
        if data.startswith((b'# v2 git bundle\n', b'# v3 git bundle\n')) or suffix == '.bundle':
            self.bundle(data, location, depth)
        elif data.startswith(b'PK\x03\x04') or suffix in {'.zip', '.docx', '.xlsx', '.pptx'}:
            self.zip(data, location, depth)
        elif data.startswith(b'\x1f\x8b') or suffix in {'.gz', '.tgz'}:
            self.gzip(data, name, location, depth)
        elif suffix == '.tar' or len(data) > 262 and data[257:262] == b'ustar':
            self.tar(data, location, depth)
        elif suffix in {'.html', '.htm'} or leading.lower().startswith(b'<!doctype html'):
            self.html(structured, location)
        elif suffix in {'.xml', '.rels'} or leading.startswith(b'<'):
            self.xml(structured, location)
        elif suffix in {'.toml', '.service', '.timer'}:
            self.configuration(structured, location, suffix)
        elif suffix in {'.json', '.jsonl', '.map'} or (suffix not in TEXT_SUFFIXES or suffix in {'.txt', '.log'}) and leading.startswith((b'{', b'[')):
            first, newline, rest = leading.partition(b'\n')
            json_suffix = '.jsonl' if suffix not in {'.json', '.map'} and newline and first.strip().endswith(b'}') and rest.lstrip().startswith(b'{') else suffix
            self.json(structured, location, json_suffix, depth)
        elif data.startswith(b'%PDF-'):
            self.pdf(data, location, depth)
        elif len(data) >= 8 and data[4:8] == b'jumb':
            self.c2pa(data, location)
        elif data.startswith(b'\x89PNG\r\n\x1a\n') or suffix == '.png':
            self.png(data, location)
        elif data.startswith(b'SQLite format 3\x00'):
            self.sqlite(data, location, depth)
        elif suffix in {'.sqlite', '.sqlite3', '.db', '.ldb', '.7z', '.rar'}:
            raise Unresolved('unsupported-database-or-container')
        elif b'\0' in data and not data.startswith((b'\xff\xfe', b'\xfe\xff')):
            raise Unresolved('binary-needs-content-review')
        elif not data.startswith((b'\xff\xfe', b'\xfe\xff')):
            try:
                data.decode('utf-8')
            except UnicodeError:
                raise Unresolved('binary-needs-content-review')
        self.methods.add('complete-content-scan')

    def c2pa(self, data, location):
        # Keep the helper adjacent to this script so backup_workspace's dynamic
        # loading does not depend on cwd or a globally installed Python module.
        path = Path(__file__).with_name('c2pa_audit.py')
        if not path.is_file():
            raise Unresolved('c2pa-reader-unavailable')
        spec = importlib.util.spec_from_file_location('_recovery_c2pa_audit', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        try:
            module.audit(data, self, location, self.reviewed(data, 'c2pa-structure'))
        except ValueError as error:
            message = str(error)
            raise Unresolved(message if message.startswith('c2pa-') else 'c2pa-parse-failed') from None
        except Exception:
            raise Unresolved('c2pa-parse-failed') from None

    def png(self, data, location):
        if not data.startswith(b'\x89PNG\r\n\x1a\n'):
            raise Unresolved('invalid-png')
        cursor, kinds, compressed, header = 8, [], bytearray(), None
        while cursor + 12 <= len(data):
            size = struct.unpack_from('!I', data, cursor)[0]
            end = cursor + 12 + size
            if end > len(data):
                raise Unresolved('invalid-png-chunk')
            kind, payload = data[cursor + 4:cursor + 8], data[cursor + 8:end - 4]
            if zlib.crc32(kind + payload) != struct.unpack_from('!I', data, end - 4)[0]:
                raise Unresolved('png-crc-mismatch')
            self.charge(payload)
            if not kinds and kind != b'IHDR' or b'IEND' in kinds:
                raise Unresolved('invalid-png-order')
            if kind == b'IHDR':
                if kinds or size != 13:
                    raise Unresolved('invalid-png-header')
                width, height, bits, color, compression, filter_method, interlace = struct.unpack('!IIBBBBB', payload)
                if not width or not height or bits != 8 or color not in {0, 2, 4, 6} or compression or filter_method or interlace:
                    raise Unresolved('png-layout-needs-review')
                header = width, height, {0: 1, 2: 3, 4: 2, 6: 4}[color]
            elif kind == b'IDAT':
                if b'IDAT' in kinds and kinds[-1] != b'IDAT':
                    raise Unresolved('invalid-png-order')
                compressed.extend(payload)
            elif kind == b'IEND':
                if size or b'IDAT' not in kinds or end != len(data):
                    raise Unresolved('unparsed-png-bytes')
            elif kind in {b'gAMA', b'pHYs', b'sRGB'}:
                if b'IDAT' in kinds or kind in kinds or size != {b'gAMA': 4, b'pHYs': 9, b'sRGB': 1}[kind]:
                    raise Unresolved('invalid-png-metadata')
                if kind == b'sRGB' and payload[0] > 3 or kind == b'pHYs' and payload[8] > 1:
                    raise Unresolved('invalid-png-metadata')
            elif kind == b'tEXt':
                self.text(payload.replace(b'\0', b'='), location + '/png-text')
                raise Unresolved('png-text-needs-review')
            else:
                # Unknown ancillary bytes may be another payload, not pixels.
                raise Unresolved('png-chunk-needs-review')
            kinds.append(kind); cursor = end
        if cursor != len(data) or not kinds or kinds[-1] != b'IEND' or not header:
            raise Unresolved('invalid-png')
        width, height, channels = header
        row_size = 1 + width * channels
        expected = height * row_size
        if expected > MAX_FILE or expected + self.expanded > MAX_EXPANDED:
            raise Unresolved('inspection-limit')
        inflater = zlib.decompressobj()
        try:
            pixels = inflater.decompress(compressed, expected + 1)
        except zlib.error:
            raise Unresolved('invalid-png-compression') from None
        if len(pixels) != expected or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
            raise Unresolved('invalid-png-pixel-stream')
        if any(pixels[offset] > 4 for offset in range(0, expected, row_size)):
            raise Unresolved('invalid-png-filter')
        self.charge(pixels)
        if not self.reviewed(data, 'png-visual'):
            raise Unresolved('png-visual-review-required')
        self.methods.add('png-all-chunks-and-exact-visual-review')

    def sqlite(self, data, location, depth):
        page_size = int.from_bytes(data[16:18], 'big')
        page_size = 65536 if page_size == 1 else page_size
        if len(data) < 100 or page_size < 512 or page_size > 65536 or page_size & (page_size - 1) or len(data) % page_size:
            raise Unresolved('invalid-sqlite-layout')
        pages = len(data) // page_size
        if int.from_bytes(data[28:32], 'big') != pages or data[20] or data[18:20] != b'\1\1':
            raise Unresolved('sqlite-layout-or-journal-needs-review')
        # Decode the complete physical file, including free/unallocated pages,
        # in both UTF-16 alignments as well as ASCII. Do not VACUUM or rewrite.
        for offset in range(0, len(data), page_size):
            self.node()
            block = data[offset:offset + page_size]
            self.text(block, location + '/sqlite-physical-page')
            for encoding in ('utf-16-le', 'utf-16-be'):
                for alignment in (0, 1):
                    decoded = block[alignment:].decode(encoding, errors='ignore')
                    self.text(decoded.encode(), location + '/sqlite-physical-page')
        free, cursor = set(), int.from_bytes(data[32:36], 'big')
        while cursor:
            if cursor in free or not 1 < cursor <= pages:
                raise Unresolved('invalid-sqlite-freelist')
            free.add(cursor); block = data[(cursor - 1) * page_size:cursor * page_size]
            count = int.from_bytes(block[4:8], 'big')
            if count > (page_size - 8) // 4:
                raise Unresolved('invalid-sqlite-freelist')
            for index in range(count):
                leaf = int.from_bytes(block[8 + index * 4:12 + index * 4], 'big')
                if leaf in free or not 1 < leaf <= pages:
                    raise Unresolved('invalid-sqlite-freelist')
                free.add(leaf)
            cursor = int.from_bytes(block[:4], 'big')
        if len(free) != int.from_bytes(data[36:40], 'big'):
            raise Unresolved('invalid-sqlite-freelist')
        db = sqlite3.connect(':memory:')
        try:
            db.deserialize(data); db.execute('PRAGMA query_only=ON'); db.execute('PRAGMA trusted_schema=OFF')
            db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, min(MAX_FILE, MAX_EXPANDED - self.expanded))
            instructions = 0
            def progress():
                nonlocal instructions
                instructions += 1000
                return instructions > MAX_ENTRIES * 100
            db.set_progress_handler(progress, 1000)
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise Unresolved('invalid-sqlite-integrity')
            schema = list(db.execute("SELECT name,sql FROM sqlite_schema WHERE type='table'"))
            for name, sql in schema:
                self.node(); self.text((sql or '').encode(), location + '/sqlite-schema')
                if sql and re.search(r'(?i)\bCREATE\s+VIRTUAL\b', sql):
                    raise Unresolved('sqlite-virtual-table-needs-review')
                quoted = '"' + name.replace('"', '""') + '"'
                columns = [row[1] for row in db.execute('PRAGMA table_info(' + quoted + ')')]
                secret_columns = {i for i, column in enumerate(columns) if re.search(r'(?i)password|passwd|secret|api.?key|access.?token|refresh.?token|cookie', column)}
                for row in db.execute('SELECT * FROM ' + quoted):
                    self.node()
                    if any(row[i] not in (None, '', b'') for i in secret_columns):
                        self.finding(location, 'credential-sqlite-column')
                    for cell in row:
                        if isinstance(cell, str):
                            raw = cell.encode(); self.node(raw); self.text(raw, location + '/sqlite-cell')
                            if raw.lstrip().startswith((b'{', b'[')):
                                self.json(raw, location + '/sqlite-cell', '.json', depth + 1)
                        elif isinstance(cell, bytes):
                            self.child(cell, 'sqlite-blob', location + '/sqlite-cell', depth + 1)
            allocated = {row[0] for row in db.execute('SELECT pageno FROM dbstat')}
            if allocated & free or allocated | free != set(range(1, pages + 1)):
                raise Unresolved('sqlite-unmapped-pages')
        except sqlite3.Error:
            raise Unresolved('sqlite-read-failed') from None
        finally:
            db.close()
        self.methods.add('sqlite-schema-cells-and-all-physical-pages')

    def xml(self, data, location):
        if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
            raise Unresolved('xml-external-or-expanded-entities')
        try:
            tree = ET.fromstring(data)
        except ET.ParseError:
            raise Unresolved('invalid-xml')
        # Flatten split Word runs so e.g. "pass" + "word=..." remains visible.
        self.text(''.join(tree.itertext()).encode(), location)
        for element in tree.iter():
            self.node()
            tag = element.tag.rsplit('}', 1)[-1]
            if re.search(r'(?i)^(?:password|passwd|secret|token|api.?key|access_token|refresh_token)$', tag) and ''.join(element.itertext()).strip():
                self.finding(location, 'credential-xml-element')
            attributes = {key.rsplit('}', 1)[-1].casefold(): value for key, value in element.attrib.items()}
            sensitive = r'(?i)^(?:password|passwd|secret|token|api.?key|access_token|refresh_token|accountPassword)$'
            if any(re.fullmatch(sensitive, key) and value for key, value in attributes.items()):
                self.finding(location, 'credential-xml-attribute')
            if any(re.fullmatch(sensitive, attributes.get(key, '')) for key in ('key', 'name')) and attributes.get('value'):
                self.finding(location, 'credential-xml-key-value')
            for value in attributes.values():
                self.text(value.encode(), location)
        self.methods.add('xml-text-and-attributes')

    def html(self, data, location):
        scanner, text_parts = self, []
        class InspectHTML(HTMLParser):
            def handle_decl(self, declaration):
                if declaration.casefold().strip() != 'doctype html':
                    raise Unresolved('html-declaration-needs-review')
            def unknown_decl(self, declaration):
                raise Unresolved('html-declaration-needs-review')
            def handle_comment(self, value):
                scanner.text(value.encode(), location)
            def handle_data(self, value):
                scanner.node(value.encode()); text_parts.append(value)
            def handle_starttag(self, tag, attributes):
                scanner.node()
                values = {}
                for key, value in attributes:
                    if key in values:
                        raise Unresolved('duplicate-html-attribute')
                    values[key] = value
                    if value is not None:
                        scanner.text(value.encode(), location)
                identity = values.get('name', '') or values.get('id', '') or ''
                if re.fullmatch(r'(?i)(?:password|passwd|secret|token|api.?key|access_token|refresh_token)', identity) and values.get('value'):
                    scanner.finding(location, 'credential-html-input')
                for key, value in values.items():
                    if re.fullmatch(r'(?i)(?:password|passwd|secret|token|api.?key|access_token|refresh_token)', key) and value:
                        scanner.finding(location, 'credential-html-attribute')
            handle_startendtag = handle_starttag
        try:
            # The raw source has already been inspected. HTMLParser also
            # inspects entity-decoded text/attributes; it never fetches URLs.
            parser = InspectHTML(convert_charrefs=True)
            parser.feed(data.decode('utf-8-sig')); parser.close()
            self.text(''.join(text_parts).encode(), location)
        except UnicodeError:
            raise Unresolved('invalid-html-encoding') from None
        self.methods.add('html-decoded-text-and-attributes')

    def configuration(self, data, location, suffix):
        try:
            text = data.decode('utf-8-sig')
            if suffix == '.toml':
                values = tomllib.loads(text)
            else:
                parser = configparser.RawConfigParser(strict=True, delimiters=('=',))
                parser.read_string(text)
                values = {section: dict(parser.items(section)) for section in parser.sections()}
            self.json(json.dumps(values, default=str).encode(), location, '.json')
        except (ValueError, configparser.Error, UnicodeError) as error:
            if isinstance(error, Unresolved):
                raise
            raise Unresolved('invalid-configuration') from None
        self.methods.add('configuration-decoded-values')

    def json(self, data, location, suffix, depth=0):
        try:
            text = data.decode('utf-8-sig')
        except (ValueError, UnicodeError):
            raise Unresolved('invalid-json')
        def unique_object(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    # Keys are already unescaped here. A later empty value
                    # must not erase the evidence in an earlier property.
                    raise Unresolved('duplicate-json-key')
                value[key] = item
            return value
        def visit(value, nesting=0):
            self.node()
            if nesting > MAX_JSON_DEPTH:
                raise Unresolved('nesting-limit')
            if isinstance(value, dict):
                for key, item in value.items():
                    if re.search(r'(?i)^(?:password|passwd|secret|token|api.?key|access_token|refresh_token|accountPassword)$', key) and item not in (None, '', False):
                        self.finding(location, 'credential-json-property')
                    if isinstance(item, str) and re.search(r'(?i)(?:base64|fileData)$', key) and item:
                        encoded = item.split(';base64,', 1)[-1]
                        try:
                            binary = base64.b64decode(encoded, validate=True)
                        except (ValueError, base64.binascii.Error):
                            self.finding(location, 'invalid-embedded-base64')
                        else:
                            self.child(binary, 'embedded', location + '/base64:' + key, depth + 1)
                    visit(item, nesting + 1)
            elif isinstance(value, list):
                for item in value:
                    visit(item, nesting + 1)
            elif isinstance(value, str):
                self.text(value.encode(), location)
        try:
            lines = io.StringIO(text) if suffix == '.jsonl' else (text,)
            for line in lines:
                if not line.strip():
                    continue
                # Charge before parsing; never construct all JSONL values first.
                self.node()
                visit(json.loads(line, object_pairs_hook=unique_object))
        except (ValueError, UnicodeError) as error:
            if isinstance(error, Unresolved):
                raise
            raise Unresolved('invalid-json') from None
        self.methods.add('json-decoded-values')

    def zip(self, data, location, depth):
        self.methods.add('zip-all-members')
        try:
            zip_directory(data)
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                ranges = exact_zip_layout(data, archive)
                if archive.comment:
                    self.child(archive.comment, 'zip-comment', location + '/zip-comment', depth + 1)
                seen = set()
                if len(archive.infolist()) > MAX_ENTRIES:
                    raise Unresolved('inspection-limit')
                for item in archive.infolist():
                    if item.comment:
                        self.child(item.comment, 'zip-member-comment', location + '/zip-member-comment', depth + 1)
                    safe_member(item.orig_filename)
                    safe_member(item.filename)
                    if item.filename in seen:
                        raise Unresolved('duplicate-archive-member')
                    seen.add(item.filename)
                    if item.flag_bits & 1 or stat.S_ISLNK(item.external_attr >> 16):
                        raise Unresolved('encrypted-or-linked-zip-member')
                    if item.is_dir():
                        if item.file_size:
                            raise Unresolved('nonempty-zip-directory')
                        self.zip_payload(data, ranges[item.header_offset], item)
                        self.charge(b'')
                        continue
                    if item.file_size > MAX_FILE or self.expanded + item.file_size > MAX_EXPANDED:
                        raise Unresolved('inspection-limit')
                    plain = self.zip_payload(data, ranges[item.header_offset], item)
                    self.child(plain, item.filename, location + '/zip:' + item.filename, depth + 1)
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError):
            raise Unresolved('invalid-or-unsupported-zip')

    def zip_payload(self, data, span, item):
        encoded = data[span[0]:span[1]]
        limit = min(MAX_FILE, MAX_EXPANDED - self.expanded, item.file_size)
        if limit < 0:
            raise Unresolved('inspection-limit')
        try:
            if item.compress_type == zipfile.ZIP_STORED:
                plain = encoded
            elif item.compress_type in (zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2):
                inflater = zlib.decompressobj(-zlib.MAX_WBITS) if item.compress_type == zipfile.ZIP_DEFLATED else bz2.BZ2Decompressor()
                plain = inflater.decompress(encoded, limit + 1)
                if len(plain) > limit:
                    raise Unresolved('inspection-limit')
                if not inflater.eof or inflater.unused_data:
                    raise Unresolved('unparsed-zip-compressed-bytes')
            else:
                raise Unresolved('zip-compression-needs-bounded-review')
        except (zlib.error, OSError, EOFError):
            raise Unresolved('invalid-zip-compression') from None
        if len(plain) != item.file_size or zlib.crc32(plain) != item.CRC:
            raise Unresolved('zip-content-checksum')
        return plain

    def gzip(self, data, name, location, depth):
        inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            plain = inflater.decompress(data, min(MAX_FILE, MAX_EXPANDED - self.expanded) + 1)
        except zlib.error:
            raise Unresolved('invalid-gzip')
        if not inflater.eof or inflater.unconsumed_tail or inflater.unused_data:
            raise Unresolved('gzip-limit-trailing-data-or-multiple-members')
        child = name[:-3] if name.lower().endswith('.gz') else name + '.tar'
        self.methods.add('gzip-complete-stream')
        self.scan(plain, child, location + '/gzip', depth + 1)

    def tar(self, data, location, depth):
        self.methods.add('tar-all-members')
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
                seen = set()
                for item in archive:
                    safe_member(item.name)
                    if item.name in seen:
                        raise Unresolved('duplicate-archive-member')
                    seen.add(item.name)
                    if item.isdir():
                        if item.size:
                            raise Unresolved('nonempty-tar-directory')
                        self.charge(b'')
                        continue
                    if not item.isfile():
                        raise Unresolved('non-regular-tar-member')
                    if item.size > MAX_FILE or self.expanded + item.size > MAX_EXPANDED:
                        raise Unresolved('inspection-limit')
                    self.child(archive.extractfile(item).read(), item.name, location + '/tar:' + item.name, depth + 1)
                if any(data[archive.offset:]):
                    raise Unresolved('unparsed-tar-bytes')
        except tarfile.TarError:
            raise Unresolved('invalid-tar')

    def pdf(self, data, location, depth):
        # A latest-only reader hides overwritten objects. History is supported
        # only for exact independently reviewed revision boundaries; every
        # prefix is parsed/scanned again, and its Prev pointer must match.
        boundaries = list(re.finditer(rb'startxref[ \t\r\n]+(\d+)[ \t\r\n]+%%EOF(?:\r\n|\r|\n)?', data))
        if not boundaries or data[boundaries[-1].end():].strip():
            raise Unresolved('pdf-revision-layout-needs-review')
        review = self.reviewed(data, 'pdf-visual')
        prefixes = [data[:match.end()] if i < len(boundaries) - 1 else data for i, match in enumerate(boundaries)]
        if len(boundaries) > MAX_DEPTH or len(re.findall(rb'\bstartxref\b', data)) != len(boundaries):
            raise Unresolved('pdf-incremental-history-needs-review')
        if len(boundaries) > 1 and (not review or review.get('pdfRevisions') != [digest(part) for part in prefixes]):
            raise Unresolved('pdf-incremental-history-needs-review')
        previous = None
        for index, (part, boundary) in enumerate(zip(prefixes, boundaries)):
            self.pdf_revision(part, location + '/pdf-revision:' + str(index + 1), depth, bool(review), previous, int(boundary.group(1)))
            previous = int(boundary.group(1))
        self.methods.add('pdf-every-reviewed-revision')

    def pdf_revision(self, data, location, depth, visual_review, expected_previous, xref_offset):
        try:
            from pypdf import PdfReader
            from pypdf import filters
            from pypdf.generic import (ArrayObject, ByteStringObject, DictionaryObject,
                                      IndirectObject, NameObject, NullObject, StreamObject, TextStringObject, read_object)
        except ImportError:
            raise Unresolved('pdf-reader-unavailable')
        def inflate(encoded):
            limit = min(MAX_FILE, MAX_EXPANDED - self.expanded)
            if limit <= 0:
                raise Unresolved('inspection-limit')
            inflater = zlib.decompressobj()
            try:
                plain = inflater.decompress(encoded, limit + 1)
            except zlib.error:
                raise Unresolved('invalid-pdf-compression') from None
            if len(plain) > limit or inflater.unconsumed_tail:
                raise Unresolved('inspection-limit')
            if not inflater.eof or inflater.unused_data:
                raise Unresolved('invalid-pdf-compression')
            # Charge before predictor processing or any subsequent filter.
            self.charge(plain)
            return plain
        def decode(stream):
            names = stream.get('/Filter', ())
            if isinstance(names, IndirectObject):
                names = names.get_object()
            names = names if isinstance(names, (tuple, list)) else [names]
            if len(names) > MAX_DEPTH or any(name not in {'/FlateDecode', '/Fl', '/ASCIIHexDecode', '/AHx', '/ASCII85Decode', '/A85', '/Crypt'} for name in names):
                raise Unresolved('pdf-filter-needs-bounded-review')
            params = stream.get('/DecodeParms', [{}] * len(names))
            if isinstance(params, IndirectObject):
                params = params.get_object()
            params = params if isinstance(params, (list, tuple)) else [params]
            if len(params) != len(names):
                raise Unresolved('pdf-filter-parameters-mismatch')
            if '/Crypt' in names:
                # PDF 1.7 7.4.10: an omitted Crypt Name selects Identity. The
                # audit supports only this no-op, never an unknown crypt filter.
                if list(names).count('/Crypt') != 1 or names[0] != '/Crypt':
                    raise Unresolved('pdf-crypt-filter-needs-review')
                parameter = params[0]
                if isinstance(parameter, IndirectObject):
                    parameter = parameter.get_object()
                if not isinstance(parameter, (dict, NullObject)) or isinstance(parameter, dict) and parameter:
                    raise Unresolved('pdf-crypt-filter-needs-review')
            plain = original_decode(stream)
            self.charge(plain)
            self.text(plain, location + '/pdf-stream')
            return plain
        try:
            # This is a standalone audit tool, never a service request handler.
            # Apply bounded decoding even to xref/object streams read at startup.
            with PDF_LOCK:
                original_decode, original_inflate = filters.decode_stream_data, filters.decompress
                filters.decode_stream_data, filters.decompress = decode, inflate
                try:
                    reader = PdfReader(io.BytesIO(data), strict=True)
                    previous = reader.trailer.get('/Prev')
                    if not 0 <= xref_offset < len(data):
                        raise Unresolved('pdf-revision-layout-needs-review')
                    if data[xref_offset:xref_offset + 4] != b'xref':
                        # pypdf does not preserve Prev from an xref stream in
                        # reader.trailer. Inspect its actual unencrypted dict.
                        stream = io.BytesIO(data); stream.seek(xref_offset)
                        reader.read_object_header(stream)
                        xref = read_object(stream, reader)
                        if not isinstance(xref, StreamObject) or xref.get('/Type') != '/XRef':
                            raise Unresolved('pdf-revision-layout-needs-review')
                        previous = xref.get('/Prev')
                    if previous != expected_previous:
                        raise Unresolved('pdf-incremental-history-needs-review')
                    if reader.is_encrypted and not reader.decrypt(''):
                        raise Unresolved('encrypted-pdf')
                    if reader.is_encrypted:
                        encryption = reader._encryption
                        original_decrypt = encryption.decrypt_object
                        def decrypt(value, number, generation):
                            # ISO 32000-2 7.6.2 excludes signature Contents and
                            # metadata stream data when EncryptMetadata=false.
                            # pypdf 6.10 otherwise tries AES on these raw bytes.
                            # They are retained and inspected by visit below.
                            if isinstance(value, DictionaryObject) and value.get('/Type') == '/Sig':
                                contents = value.raw_get('/Contents')
                                if not isinstance(contents, (ByteStringObject, TextStringObject)):
                                    raise Unresolved('pdf-signature-layout-needs-review')
                                copied = DictionaryObject(value)
                                del copied['/Contents']
                                copied = original_decrypt(copied, number, generation)
                                copied[NameObject('/Contents')] = ByteStringObject(contents.original_bytes)
                                return copied
                            if isinstance(value, StreamObject) and value.get('/Type') == '/Metadata' and encryption.EncryptMetadata is False:
                                copied = original_decrypt(DictionaryObject(value), number, generation)
                                value.update(copied)
                                return value
                            return original_decrypt(value, number, generation)
                        encryption.decrypt_object = decrypt
                    seen = set()
                    def visit(value, nesting=0):
                        self.node()
                        if nesting > MAX_JSON_DEPTH:
                            raise Unresolved('nesting-limit')
                        if isinstance(value, IndirectObject):
                            identity = (value.idnum, value.generation)
                            if identity in seen:
                                return
                            seen.add(identity)
                            visit(value.get_object(), nesting + 1)
                        elif isinstance(value, dict):
                            if isinstance(value, StreamObject):
                                plain = value.get_data()
                                self.charge(plain)
                                self.text(plain, location + '/pdf-stream')
                                if value.get('/Type') == '/Metadata':
                                    if value.get('/Subtype') != '/XML':
                                        raise Unresolved('pdf-metadata-needs-review')
                                    self.xml(plain, location + '/pdf-metadata')
                                if value.get('/Subtype') == '/Image' and not visual_review:
                                    raise Unresolved('pdf-image-needs-visual-review')
                            for key, item in value.items():
                                if re.fullmatch(r'(?i)/(?:password|passwd|secret|token|api.?key|accountPassword)', str(key)) and item:
                                    self.finding(location, 'credential-pdf-property')
                                visit(item, nesting + 1)
                        elif isinstance(value, (list, tuple)):
                            for item in value:
                                visit(item, nesting + 1)
                        elif isinstance(value, (str, bytes)):
                            self.text(value.encode() if isinstance(value, str) else value, location)
                    # Include unreferenced objects in this single revision;
                    # incremental revision history was rejected above.
                    references = [(number, generation) for generation, objects in reader.xref.items() if generation != 65535 for number in objects if number]
                    references += [(number, 0) for number in reader.xref_objStm]
                    if len(references) > MAX_ENTRIES:
                        raise Unresolved('inspection-limit')
                    for number, generation in references:
                        visit(IndirectObject(number, generation, reader))
                    for page in reader.pages:
                        self.node()
                        text = (page.extract_text() or '').encode()
                        self.charge(text)
                        self.text(text, location)
                        contents = page.get_contents()
                        if contents is not None:
                            for _, operator in contents.operations:
                                self.node()
                                if operator == b'INLINE IMAGE' and not visual_review:
                                    raise Unresolved('pdf-image-needs-visual-review')
                    fields = reader.get_fields() or {}
                    self.json(json.dumps(fields, default=str).encode(), location, '.json')
                    for key, attachments in reader.attachments.items():
                        for attachment in attachments:
                            self.scan(attachment, key, location + '/pdf-attachment:' + key, depth + 1)
                finally:
                    filters.decode_stream_data, filters.decompress = original_decode, original_inflate
        except Unresolved:
            raise
        except Exception:
            raise Unresolved('pdf-parse-failed') from None
        self.methods.add('pdf-text-fields-attachments')

    def bundle(self, data, location, depth):
        split = data.find(b'\n\n')
        if split < 0:
            raise Unresolved('invalid-git-bundle-header')
        header, pack = data[:split].splitlines(), data[split + 2:]
        if header[0] not in (b'# v2 git bundle', b'# v3 git bundle'):
            raise Unresolved('unsupported-git-bundle-version')
        algorithm, refs = 'sha1', []
        for line in header[1:]:
            if line.startswith(b'-'):
                raise Unresolved('git-bundle-requires-external-history')
            if line == b'@object-format=sha256':
                algorithm = 'sha256'
            elif line == b'@object-format=sha1':
                pass
            elif line.startswith(b'@'):
                raise Unresolved('unsupported-git-bundle-capability')
            else:
                try:
                    oid, ref = line.split(b' ', 1)
                    if not ref or not re.fullmatch(rb'[0-9a-f]+', oid):
                        raise ValueError()
                    refs.append(oid.decode())
                except ValueError:
                    raise Unresolved('invalid-git-bundle-ref')
        hash_size = hashlib.new(algorithm).digest_size
        if any(len(ref) != hash_size * 2 for ref in refs) or not refs or len(pack) < 12 + hash_size or pack[:4] != b'PACK':
            raise Unresolved('invalid-git-pack-header')
        version, count = struct.unpack('!II', pack[4:12])
        if version not in (2, 3) or count > MAX_ENTRIES:
            raise Unresolved('unsupported-git-pack')
        if hashlib.new(algorithm, pack[:-hash_size]).digest() != pack[-hash_size:]:
            raise Unresolved('git-pack-checksum')
        objects, by_offset, by_oid = [], {}, {}
        cursor, end = 12, len(pack) - hash_size
        for _ in range(count):
            offset = cursor
            if cursor >= end:
                raise Unresolved('truncated-git-object')
            first = pack[cursor]; cursor += 1
            kind, size, shift, byte = (first >> 4) & 7, first & 15, 4, first
            while byte & 128:
                if cursor >= end or shift > 63:
                    raise Unresolved('invalid-git-object-size')
                byte = pack[cursor]; cursor += 1
                size |= (byte & 127) << shift; shift += 7
            base = None
            if kind == 6:
                if cursor >= end:
                    raise Unresolved('invalid-git-delta-offset')
                byte = pack[cursor]; cursor += 1
                distance = byte & 127
                while byte & 128:
                    if cursor >= end or distance > len(pack):
                        raise Unresolved('invalid-git-delta-offset')
                    byte = pack[cursor]; cursor += 1
                    distance = ((distance + 1) << 7) | (byte & 127)
                base = offset - distance
                if base not in by_offset:
                    raise Unresolved('missing-git-delta-base')
            elif kind == 7:
                base = pack[cursor:cursor + hash_size].hex(); cursor += hash_size
            elif kind not in (1, 2, 3, 4):
                raise Unresolved('invalid-git-object-type')
            if size > MAX_FILE or cursor >= end:
                raise Unresolved('inspection-limit')
            inflater = zlib.decompressobj()
            try:
                payload = inflater.decompress(pack[cursor:end], size + 1)
            except zlib.error:
                raise Unresolved('invalid-git-zlib')
            if not inflater.eof or len(payload) != size:
                raise Unresolved('invalid-git-object-size')
            cursor = end - len(inflater.unused_data)
            self.charge(payload)
            item = {'kind': kind, 'base': base, 'data': payload, 'offset': offset}
            objects.append(item); by_offset[offset] = item
            if kind < 5:
                item['oid'] = git_oid(algorithm, kind, payload)
                by_oid[item['oid']] = item
        if cursor != end:
            raise Unresolved('trailing-git-pack-data')
        pending = [item for item in objects if item['kind'] > 5]
        while pending:
            before = len(pending)
            for item in pending[:]:
                base = by_offset.get(item['base']) if isinstance(item['base'], int) else by_oid.get(item['base'])
                if base is None or base['kind'] > 5:
                    continue
                plain = apply_delta(base['data'], item['data'])
                self.charge(plain)
                item.update(kind=base['kind'], data=plain)
                item['oid'] = git_oid(algorithm, item['kind'], plain)
                by_oid[item['oid']] = item
                pending.remove(item)
            if len(pending) == before:
                raise Unresolved('missing-or-cyclic-git-delta-base')
        if any(ref not in by_oid for ref in refs):
            raise Unresolved('missing-git-bundle-ref-object')
        names = {}
        for item in objects:
            if item['kind'] == 2:
                for name, oid in tree_entries(item['data'], hash_size):
                    names.setdefault(oid, set()).add(name)
                    child = by_oid.get(oid)
                    if credential_name(name) and not (child and child['kind'] == 3 and self.null_connection(child['data'], name)):
                        self.finding(location + '/git:' + item['oid'], 'historical-credential-file-name')
        # Every packed object is examined, including unreachable objects not named
        # by any advertised ref. Delta content is scanned after reconstruction.
        for item in objects:
            member = location + '/git:' + item['oid']
            if item['kind'] == 3:
                for name in sorted(names.get(item['oid'], {'unreachable-blob'})):
                    self.child(item['data'], name, member, depth + 1)
            elif item['kind'] in (1, 4):
                self.text(item['data'], member)
        self.methods.add('git-all-packed-objects-and-resolved-deltas')


def git_oid(algorithm, kind, data):
    name = {1: b'commit', 2: b'tree', 3: b'blob', 4: b'tag'}[kind]
    return hashlib.new(algorithm, name + b' ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def tree_entries(data, hash_size):
    cursor = 0
    while cursor < len(data):
        space, zero = data.find(b' ', cursor), data.find(b'\0', cursor)
        if space < cursor or zero < space or zero + 1 + hash_size > len(data):
            raise Unresolved('invalid-git-tree')
        try:
            name = data[space + 1:zero].decode('utf-8')
        except UnicodeError:
            raise Unresolved('unsupported-git-tree-encoding')
        safe_member(name)
        yield name, data[zero + 1:zero + 1 + hash_size].hex()
        cursor = zero + 1 + hash_size


def apply_delta(base, delta):
    cursor = 0
    def number():
        nonlocal cursor
        value, shift = 0, 0
        while True:
            if cursor >= len(delta) or shift > 63:
                raise Unresolved('invalid-git-delta-header')
            byte = delta[cursor]; cursor += 1
            value |= (byte & 127) << shift
            if not byte & 128:
                return value
            shift += 7
    if number() != len(base):
        raise Unresolved('invalid-git-delta-base-size')
    result_size = number()
    if result_size > MAX_FILE:
        raise Unresolved('inspection-limit')
    output = bytearray()
    while cursor < len(delta):
        opcode = delta[cursor]; cursor += 1
        if opcode & 128:
            offset, size = 0, 0
            for bit in range(7):
                if opcode & (1 << bit):
                    if cursor >= len(delta):
                        raise Unresolved('truncated-git-delta')
                    if bit < 4:
                        offset |= delta[cursor] << (8 * bit)
                    else:
                        size |= delta[cursor] << (8 * (bit - 4))
                    cursor += 1
            size = size or 65536
            if offset + size > len(base):
                raise Unresolved('git-delta-copy-outside-base')
            output.extend(base[offset:offset + size])
        elif opcode:
            if cursor + opcode > len(delta):
                raise Unresolved('truncated-git-delta')
            output.extend(delta[cursor:cursor + opcode]); cursor += opcode
        else:
            raise Unresolved('invalid-git-delta-opcode')
        if len(output) > result_size:
            raise Unresolved('git-delta-result-overflow')
    if len(output) != result_size:
        raise Unresolved('git-delta-result-size')
    return bytes(output)


def audit_bytes(data, name):
    scanner = Scanner()
    try:
        scanner.scan(data, name)
    except Unresolved as error:
        scanner.findings.append({'member': '$', 'reason': str(error)})
    except Exception:
        # Parser exception details can contain untrusted source values.
        scanner.findings.append({'member': '$', 'reason': 'unexpected-parser-failure'})
    return {'sha256': digest(data), 'size': len(data), 'status': 'blocked' if scanner.findings else 'reviewed', 'findings': scanner.findings, 'methods': sorted(scanner.methods), 'expandedBytes': scanner.expanded, 'members': scanner.entries, 'structureNodes': scanner.nodes}


def read_file_bytes(path):
    with Path(path).open('rb') as source:
        data = source.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise Unresolved('file-size-limit')
    return data


def audit_file(path, relative=None):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        return {'path': relative or path.name, 'status': 'blocked', 'findings': [{'member': '$', 'reason': 'non-regular-file'}]}
    if path.stat().st_size > MAX_FILE:
        return {'path': relative or path.name, 'status': 'blocked', 'findings': [{'member': '$', 'reason': 'file-size-limit'}]}
    try:
        return {'path': relative or path.name, **audit_bytes(read_file_bytes(path), path.name)}
    except Unresolved as error:
        return {'path': relative or path.name, 'status': 'blocked', 'findings': [{'member': '$', 'reason': str(error)}]}
    except OSError:
        return {'path': relative or path.name, 'status': 'blocked', 'findings': [{'member': '$', 'reason': 'unreadable-file'}]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('files', type=Path, nargs='*')
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workspace', action='store_true')
    args = parser.parse_args(argv)
    root = args.root.resolve(strict=True)
    if args.workspace:
        if args.files:
            parser.error('Use either --workspace or individual files')
        report = audit_workspace(root, omit={args.output.resolve()})
        rows = report['files']
    else:
        if not args.files:
            parser.error('Select files or --workspace')
        rows = []
        for path in args.files:
            relative = path.resolve(strict=True).relative_to(root).as_posix()
            rows.append(audit_file(path, relative))
        report = {'version': VERSION, 'files': rows, 'complete': all(row['status'] == 'reviewed' for row in rows)}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'files': len(rows), 'reviewed': sum(row['status'] == 'reviewed' for row in rows), 'blocked': sum(row['status'] != 'reviewed' for row in rows)}))


def audit_workspace(root, extra_roots=(), omit=frozenset()):
    import os
    rows, excluded = [], []
    for source, prefix in POLICY._sources(root, extra_roots):
        def unreadable(error):
            name = prefix + Path(error.filename).relative_to(source).as_posix() + '/'
            rows.append({'path': name, 'status': 'blocked', 'findings': [{'member': '$', 'reason': 'unreadable-directory'}]})
        for directory, dirs, names in os.walk(source, onerror=unreadable):
            parent = Path(directory)
            kept = []
            for name in sorted(dirs):
                path = parent / name
                relative = prefix + path.relative_to(source).as_posix() + '/'
                if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
                    rows.append({'path': relative, 'status': 'blocked', 'findings': [{'member': '$', 'reason': 'linked-directory'}]})
                elif name.casefold() in POLICY.SKIP_DIRS or name.casefold().startswith('.build-'):
                    excluded.append({'path': relative, 'reason': 'credential-container-or-reproducible-output'})
                else:
                    kept.append(name)
            dirs[:] = kept
            for name in sorted(names):
                path = parent / name
                if path.resolve() in omit:
                    continue
                relative = prefix + path.relative_to(source).as_posix()
                if credential_name(name):
                    excluded.append({'path': relative, 'reason': 'credential-file'})
                    continue
                row = audit_file(path, relative)
                row['category'] = 'history' if path.suffix.lower() == '.bundle' else 'original-material' if any(part in {'resumes', 'source-materials'} for part in path.parts) else 'evidence' if any(part in POLICY.REVIEW_DIRS for part in path.parts) else 'workspace-source'
                rows.append(row)
    return {'version': VERSION, 'files': rows, 'excluded': excluded, 'complete': all(row['status'] == 'reviewed' for row in rows)}


if __name__ == '__main__':
    main()
