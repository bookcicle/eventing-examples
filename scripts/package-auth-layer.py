#!/usr/bin/env python3
"""Package a real Linux arm64 executable as /opt/bin/event-context."""
import argparse
import json
import pathlib
import stat
import struct
import zipfile

def package(binary, output, config_dir=None, entrypoint="event-context"):
    if entrypoint not in {"event-context"}:
        raise ValueError("Unsupported layer entrypoint")
    data = pathlib.Path(binary).read_bytes()
    if len(data) < 20 or data[:6] != b'\x7fELF\x02\x01' or struct.unpack('<H', data[18:20])[0] != 183:
        raise ValueError('Expected a Linux arm64 little-endian ELF64 binary (Lambda uses arm64)')
    entries = {'bin/' + entrypoint: (data, 0o755)}
    if config_dir:
        source = pathlib.Path(config_dir)
        config = json.loads((source / 'config.json').read_text())
        if config.get('jwks_file') != 'jwks.json':
            raise ValueError('Packaged config must use jwks_file: jwks.json')
        jwks = json.loads((source / 'jwks.json').read_text())
        if not jwks.get('keys'):
            raise ValueError('Supply your identity provider public JWKS')
        for key in jwks['keys']:
            if any(field in key for field in ('d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k')):
                raise ValueError('Private or symmetric key material must not be packaged')
        for name in ['config.json', 'jwks.json']:
            entries['event-context/' + name] = ((source / name).read_bytes(), 0o644)
    output = pathlib.Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, (payload, mode) in entries.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, payload)
    print(f'{output}: ' + ', '.join(entries))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary')
    parser.add_argument('output')
    parser.add_argument('--config-dir')
    parser.add_argument('--entrypoint', choices=['event-auth', 'event-context'], default='event-auth')
    args = parser.parse_args()
    package(args.binary, args.output, args.config_dir, args.entrypoint)
