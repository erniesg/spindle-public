#!/usr/bin/env python3
"""Build source-runner review ZIPs with a checksum-pinned portable Node runtime.

Cross-compiles the Windows managed helper; the Mac Swift helper builds locally.
No hosting, production signing or device acceptance is performed here.
"""
import argparse
import hashlib
import io
import json
import os
import shutil
from pathlib import Path
import subprocess
import tarfile
import time
from urllib.request import Request, urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def package_files(root):
    manifest = json.loads((root / 'contracts/capture-check.package.json').read_text(encoding='utf-8'))
    files = manifest['files']
    for file in files:
        path = Path(file)
        if path.is_absolute() or '..' in path.parts or path.as_posix() != file:
            raise ValueError('INVALID_PACKAGE_PATH')
        if not (root / path).is_file() or (root / path).is_symlink():
            raise ValueError('MISSING_PACKAGE_SOURCE')
    if len(files) != len(set(files)):
        raise ValueError('DUPLICATE_PACKAGE_PATH')
    return files


def fingerprint(root, files):
    digest = hashlib.sha256()
    for file in files:
        digest.update(file.encode() + b'\0')
        digest.update((root / file).read_bytes())
        digest.update(b'\0')
    return digest.hexdigest()


def verified_download(content, expected):
    if hashlib.sha256(content).hexdigest() != expected:
        raise ValueError('CHECKSUM_MISMATCH')
    return content


def extract_runtime(content, archive):
    # Never extract an archive wholesale; read exactly these two upstream files.
    if archive.endswith('.zip'):
        prefix = archive[:-4]
        with zipfile.ZipFile(io.BytesIO(content)) as source:
            return source.read(prefix + '/node.exe'), source.read(prefix + '/LICENSE')
    prefix = archive.removesuffix('.tar.gz')
    with tarfile.open(fileobj=io.BytesIO(content), mode='r:gz') as source:
        binary = source.extractfile(prefix + '/bin/node')
        notice = source.extractfile(prefix + '/LICENSE')
        if binary is None or notice is None:
            raise ValueError('MISSING_RUNTIME_FILE')
        return binary.read(), notice.read()


def write_zip_entry(bundle, name, content, timestamp, executable=False):
    info = zipfile.ZipInfo(name, timestamp)
    info.create_system = 3
    info.external_attr = (0o100755 if executable else 0o100644) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    bundle.writestr(info, content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', action='append', choices=['macos-arm64', 'macos-x64', 'windows-x64', 'windows-arm64'])
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/capture-check')
    parser.add_argument('--dotnet', default=shutil.which('dotnet'), help='Build-time SDK path for the Windows managed helper; not needed on test machines')
    parser.add_argument('--allow-dirty', action='store_true', help='Development only; marks the source identity dirty')
    args = parser.parse_args()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    if dirty and not args.allow_dirty:
        parser.error('Commit source first, or use --allow-dirty for an explicitly unreviewed development package.')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    epoch = int(subprocess.check_output(['git', 'show', '-s', '--format=%ct', 'HEAD'], cwd=ROOT, text=True))
    timestamp = time.gmtime(max(epoch, 315532800))[:6]
    # Rebuild from checked source, never package a stale ignored output tree.
    subprocess.run(['npm.cmd' if os.name == 'nt' else 'npm', 'run', 'build'], cwd=ROOT, check=True)
    files = package_files(ROOT)
    build = fingerprint(ROOT, files)
    lock = json.loads((ROOT / 'contracts/node-runtime.lock.json').read_text(encoding='utf-8'))
    targets = args.target or list(lock['targets'])
    cache = ROOT / '.local/package-cache'
    cache.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    windows_output = ROOT / '.local/native-windows'
    if any(target.startswith('windows') for target in targets):
        if not args.dotnet:
            parser.error('Windows packages require a build-time .NET SDK (--dotnet); the end user does not install an SDK.')
        env = {**os.environ, 'DOTNET_CLI_TELEMETRY_OPTOUT': '1', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE': '1', 'DOTNET_GENERATE_ASPNET_CERTIFICATE': 'false'}
        subprocess.run([args.dotnet, 'build', str(ROOT / 'platforms/windows/CaptureCheck.csproj'), '-c', 'Release', '--output', str(windows_output), '--nologo'], cwd=ROOT, env=env, check=True)
    checksums = []
    for target in targets:
        runtime = lock['targets'][target]
        archive = runtime['archive']
        cached = cache / archive
        if not cached.exists():
            print('Downloading pinned runtime:', archive, flush=True)
            request = Request(lock['baseUrl'] + archive, headers={'User-Agent': 'Spindle-review-packager/1'})
            with urlopen(request, timeout=60) as response:
                content = response.read(100 * 1024 * 1024)
            verified_download(content, runtime['sha256'])
            cached.write_bytes(content)
        binary, notice = extract_runtime(verified_download(cached.read_bytes(), runtime['sha256']), archive)
        folder = 'SpindleCaptureCheck-' + target + '-' + commit[:10] + ('-dirty' if dirty else '')
        output = args.output / (folder + '.zip')
        native_binary = (windows_output / 'SpindleCaptureCheck.exe').read_bytes() if target.startswith('windows') else None
        manifest = {'schema': 'spindle-capture-check-build/v1', 'sourceCommit': commit, 'dirty': dirty,
                    'fingerprint': build, 'target': target, 'nodeVersion': lock['version'],
                    'runtimeArchiveSha256': runtime['sha256'], 'nativeAcceptance': 'not-validated',
                    'nativeHelperSha256': hashlib.sha256(native_binary).hexdigest() if native_binary else 'built-locally-on-mac',
                    'scope': 'fixture-only native accessibility text; no browser, pixels or OCR'}
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            def add(path, content, executable=False):
                write_zip_entry(bundle, folder + '/' + path, content, timestamp, executable)
            for file in files:
                add(file, (ROOT / file).read_bytes(), file.endswith('.command'))
            mac = target.startswith('macos')
            add('runtime/node' if mac else 'runtime/node.exe', binary, True)
            add('runtime/LICENSE.txt', notice)
            if native_binary:
                add('runtime/SpindleCaptureCheck.exe', native_binary, True)
                add('runtime/SpindleCaptureCheck.exe.config', (windows_output / 'SpindleCaptureCheck.exe.config').read_bytes())
            add('capture-check.build.json', (json.dumps(manifest, indent=2) + '\n').encode())
            launcher = 'platforms/macos/start-capture-check.command' if mac else 'platforms/windows/start-capture-check.cmd'
            add('Start Capture Check.command' if mac else 'Start Capture Check.cmd', (ROOT / launcher).read_bytes(), True)
            intro = ('SPINDLE CAPTURE CHECK — EXPERIMENTAL SOURCE RUNNER\n\n'
                     + 'Target: ' + target + '\nBuild: ' + build + '\nSource: ' + commit + '\n\n'
                     + ('Open Start Capture Check.command. Apple Command Line Tools are required for the first local Swift build.\n' if mac else 'Extract All, then open Start Capture Check.cmd. The compiled .NET Framework 4.8 helper is included.\n')
                     + 'The portable Node runtime is included; no Node installation is needed.\n'
                     + 'Native execution on this target is NOT yet validated. This is the handoff for your first run.\n'
                     + 'Only supplied synthetic windows are read. Nothing records until you click Start.\n\n')
            add('READ ME FIRST.txt', (intro + (ROOT / 'docs/TRY_CAPTURE.md').read_text(encoding='utf-8')).encode('utf-8'))
        with output.open('rb') as source:
            sha = hashlib.file_digest(source, 'sha256').hexdigest()
        checksums.append(sha + '  ' + output.name)
        print(output.name, output.stat().st_size, sha, flush=True)
    (args.output / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
