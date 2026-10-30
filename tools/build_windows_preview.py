#!/usr/bin/env python3
"""Build the net48 helper on Windows from pinned, hash-verified NuGet archives.

Uses installed .NET Framework to run Roslyn, without installing a system SDK or
adopting user NuGet feeds. --download explicitly populates the task-local cache.
"""
import argparse
import base64
import hashlib
import json
import os
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path, PurePosixPath
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'contracts/windows-native-tools.lock.json'


def verify_archive(data, package):
    if len(data) != package['bytes'] or base64.b64encode(hashlib.sha512(data).digest()).decode() != package['sha512']:
        raise ValueError('NATIVE_TOOL_HASH_MISMATCH: ' + package['id'])
    return data


def extract_archive(archive, destination):
    destination = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            name = PurePosixPath(entry.filename)
            # NuGet archive names are portable paths; reject Windows alternate
            # separators/drives and links before any member is written.
            if '\\' in entry.filename or ':' in entry.filename or name.is_absolute() or '..' in name.parts or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('NATIVE_TOOL_ARCHIVE_PATH')
            target = destination.joinpath(*name.parts).resolve()
            if not target.is_relative_to(destination):
                raise ValueError('NATIVE_TOOL_ARCHIVE_PATH')
        bundle.extractall(destination)


def build(cache, output, download=False):
    if os.name != 'nt':
        raise ValueError('WINDOWS_BUILD_HOST_REQUIRED')
    lock = json.loads(LOCK.read_text())
    cache = Path(cache).resolve(); output = Path(output).resolve()
    cache.mkdir(parents=True, exist_ok=True); output.mkdir(parents=True, exist_ok=True)
    # Extract afresh from verified bytes; a modified previous extraction must not
    # become a compiler/reference input. Retain these build inputs for diagnosis.
    inputs = Path(tempfile.mkdtemp(prefix='verified-inputs-', dir=cache))
    packages = {}
    for package in lock['packages']:
        name = package['id'] + '.' + package['version'] + '.nupkg'
        archive = cache / name
        if not archive.exists():
            if not download:
                raise ValueError('MISSING_NATIVE_TOOL: ' + name + '; rerun with --download')
            url = lock['baseUrl'] + package['id'] + '/' + package['version'] + '/' + name
            with urlopen(url, timeout=60) as response:
                data = response.read(package['bytes'] + 1)
            archive.write_bytes(verify_archive(data, package))
        verify_archive(archive.read_bytes(), package)
        destination = inputs / package['id']
        extract_archive(archive, destination); packages[package['id']] = destination
    framework = packages['microsoft.netframework.referenceassemblies.net48'] / 'build/.NETFramework/v4.8'
    project_path = ROOT / 'platforms/windows/Preview.csproj'
    project = ET.parse(project_path).getroot()
    pinned = {p['id'].lower(): p['version'] for p in lock['packages']}
    for item in project.findall('.//PackageReference'):
        if pinned.get(item.attrib['Include'].lower()) != item.attrib['Version']:
            raise ValueError('NATIVE_PROJECT_LOCK_MISMATCH')
    sources = [project_path.parent / item.attrib['Include'] for item in project.findall('.//Compile')]
    references = [framework / (name + '.dll') for name in ['mscorlib', 'System', 'System.Core', 'System.Xml']]
    for item in project.findall('.//Reference'):
        path = framework / (item.attrib['Include'] + '.dll')
        if not path.exists():
            path = framework / 'WPF' / path.name
        if not path.is_file():
            raise ValueError('MISSING_FRAMEWORK_REFERENCE: ' + path.name)
        references.append(path)
    references.extend(sorted((framework / 'Facades').glob('*.dll')))
    references.extend(sorted((packages['microsoft.windows.sdk.contracts'] / 'ref/netstandard2.0').glob('*.winmd')))
    references.append(packages['system.runtime.windowsruntime'] / 'ref/netstandard2.0/System.Runtime.WindowsRuntime.dll')
    generated = output / 'FrameworkAttribute.cs'
    generated.write_text('[assembly:System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8",FrameworkDisplayName=".NET Framework 4.8")]\n')
    manifest = project_path.parent / 'preview.manifest'
    executable = output / 'SpindlePreview.exe'
    args = ['/nologo', '/nostdlib+', '/target:exe', '/platform:anycpu', '/langversion:7.3', '/optimize+', '/debug-', '/deterministic+', f'/out:"{executable}"', f'/win32manifest:"{manifest}"']
    args.extend('/reference:"' + str(path) + '"' for path in references)
    args.extend('"' + str(path) + '"' for path in [*sources, generated])
    response = output / 'compile.rsp'; response.write_text('\n'.join(args), encoding='utf-8')
    compiler = packages['microsoft.net.compilers.toolset'] / 'tasks/net472/csc.exe'
    subprocess.run([str(compiler), '/noconfig', '@' + str(response)], check=True)
    (output / 'SpindlePreview.exe.config').write_text('<?xml version="1.0"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup></configuration>')
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    identity = {'schema': 'spindle-windows-native-build/v1', 'source': source, 'sourceDirty': dirty, 'nativeBuild': 'windows-roslyn-net48', 'nativeExecution': 'not-run', 'helperSha256': hashlib.sha256(executable.read_bytes()).hexdigest(), 'inputs': {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in [*sources, project_path, manifest, LOCK]}}
    (output / 'native-build.json').write_text(json.dumps(identity, indent=2) + '\n')
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=ROOT / '.local/windows-native-tools')
    parser.add_argument('--output', type=Path, default=ROOT / '.local/capture-preview/windows-runtime')
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    print(json.dumps(build(args.cache, args.output, args.download)))


if __name__ == '__main__':
    main()
