#!/usr/bin/env python3
"""Source-bound Windows/Mac integrated PREVIEW ZIPs; no upload/release/native-run claim."""
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time, zipfile
from pathlib import Path
from urllib.request import urlopen
from package_capture_check import verified_download, extract_runtime, write_zip_entry
from preview_sample import sample_image
from build_macos_preview import CacheError, MAX_BINARY_BYTES, read_regular, verify_cache, BINARY as MAC_BINARY, FIXTURE as MAC_FIXTURE, MANIFEST as MAC_MANIFEST
ROOT=Path(__file__).resolve().parents[1]
def clear_generated_build(root=ROOT):
    root=Path(root).resolve();target=root/'build'
    # Reject redirected paths, including Windows junctions, before cleanup.
    if target.resolve()!=target:raise ValueError('REDIRECTED_BUILD_DIRECTORY')
    if target.exists():shutil.rmtree(target)

# Deliberately bounded: expanding this list requires reviewing the shipping runtime.
RUNTIME_PACKAGES={'jose': {'version':'6.1.3','entry':'dist/webapi/index.js',
    'integrity':'sha512-0TpaTfihd4QMNwrz/ob2Bp7X04yuxJkjRGi4aKmOqwhov54i6u79oCv7T+C7lo70MKH6BesI3vscD1yb/yzKXQ=='}}
IMPORTS=re.compile(r"""(?:^|[;\n])\s*(?:import|export)\s+(?:[^;`=]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']""",re.MULTILINE)

def runtime_imports(source):
    return [static or dynamic for static,dynamic in IMPORTS.findall(source)]

def runtime_package_anchor(name):
    anchor=json.loads((Path(__file__).parent/'runtime-dependencies.lock.json').read_text())['packages'][name]
    expected=RUNTIME_PACKAGES[name]
    if any(anchor.get(key)!=expected[key] for key in ['version','integrity']):
        raise ValueError('RUNTIME_PACKAGE_LOCK_MISMATCH: '+name)
    return anchor

def verify_runtime_package_file(path, directory, anchor, data=None):
    relative=path.relative_to(directory).as_posix()
    expected=anchor['files'].get(relative)
    if (expected is None or path.is_symlink() or path.resolve()!=path or not path.is_file()):
        raise ValueError('RUNTIME_PACKAGE_FILE_MISMATCH: '+relative)
    data=path.read_bytes() if data is None else data
    if hashlib.sha256(data).hexdigest()!=expected:
        raise ValueError('RUNTIME_PACKAGE_FILE_MISMATCH: '+relative)
    return data

def runtime_dependency_snapshot(paths, root=ROOT):
    """Follow emitted ESM imports and the explicitly reviewed package entry only."""
    root=Path(root).resolve();build=root/'build'
    pending=[p.resolve() for p in paths if p.is_file()]
    included={};packages={};anchors={}
    def package(name):
        if name not in RUNTIME_PACKAGES:raise ValueError('UNSUPPORTED_RUNTIME_IMPORT: '+name)
        if name in packages:return packages[name]
        expected=RUNTIME_PACKAGES[name];directory=root/'node_modules'/name
        anchor=runtime_package_anchor(name)
        if directory.is_symlink() or directory.resolve()!=directory:raise ValueError('REDIRECTED_RUNTIME_PACKAGE')
        lock=json.loads((root/'package-lock.json').read_text())
        pin=lock['packages']['node_modules/'+name]
        metadata=directory/'package.json'
        metadata_bytes=verify_runtime_package_file(metadata,directory,anchor)
        info=json.loads(metadata_bytes)
        if (pin.get('version')!=expected['version'] or pin.get('integrity')!=expected['integrity'] or
            lock['packages'][''].get('dependencies',{}).get(name)!=expected['version'] or
            info.get('name')!=name or info.get('version')!=expected['version'] or
            info.get('type')!='module' or info.get('dependencies') or
            info.get('exports',{}).get('.',{}).get('default')!='./'+expected['entry']):
            raise ValueError('RUNTIME_PACKAGE_LOCK_MISMATCH: '+name)
        for extra in [metadata,directory/'LICENSE.md']:
            included[extra]=metadata_bytes if extra==metadata else verify_runtime_package_file(extra,directory,anchor)
        packages[name]=directory;anchors[name]=anchor
        return directory
    while pending:
        path=pending.pop()
        boundary=build if path.is_relative_to(build) else next((p for p in packages.values() if path.is_relative_to(p)),None)
        if boundary is None:raise ValueError('RUNTIME_IMPORT_OUTSIDE_BUILD')
        if path.is_symlink() or path.resolve()!=path:raise ValueError('REDIRECTED_RUNTIME_IMPORT')
        if path in included:continue
        data=verify_runtime_package_file(path,boundary,anchors[boundary.name]) if boundary!=build else path.read_bytes()
        included[path]=data
        if path.suffix!='.js':continue
        for dependency in runtime_imports(data.decode('utf-8')):
            if dependency.startswith('node:'):continue
            if dependency.startswith('.'):
                target=path.parent/dependency
                if target.is_symlink() or not target.resolve().is_relative_to(boundary):raise ValueError('RUNTIME_IMPORT_OUTSIDE_BUILD')
                target=target.resolve()
            else:
                directory=package(dependency)
                target=directory/RUNTIME_PACKAGES[dependency]['entry']
            if not target.is_file():
                if boundary!=build or not dependency.startswith('.'):
                    raise ValueError('RUNTIME_PACKAGE_FILE_MISMATCH: '+dependency)
                raise FileNotFoundError('MISSING_RUNTIME_IMPORT: '+dependency)
            pending.append(target)
    return dict(sorted(included.items()))

def runtime_dependency_closure(paths, root=ROOT):
    return list(runtime_dependency_snapshot(paths,root))

def runtime_dependency_receipt(files):
    dependencies={}
    for name,expected in RUNTIME_PACKAGES.items():
        prefix='node_modules/'+name+'/'
        hashes={path:hashlib.sha256(data).hexdigest()
                for path,data in files.items() if path.startswith(prefix)}
        if hashes:dependencies[name]={'version':expected['version'],'integrity':expected['integrity'],
            'integritySource':'tools/runtime-dependencies.lock.json (SHA512-verified registry tarball)','files':hashes}
    return (json.dumps({'schema':'spindle-runtime-dependencies/v1','dependencies':dependencies},indent=2)+'\n').encode()

def runtime_entry_paths():
    paths=[*sorted((ROOT/'build/core/preview').glob('*')), *sorted((ROOT/'build/core/classification').glob('*')), *sorted((ROOT/'build/core/models').glob('*')), *sorted((ROOT/'build/core/tracking').glob('*')), *sorted((ROOT/'build/browser-extension/preview').rglob('*'))]
    paths += [*sorted((ROOT/'build/core/pomodoro').glob('*')), *sorted((ROOT/'build/core/blocking').glob('*')), ROOT/'build/core/account/client.js', ROOT/'build/core/memory/user-protocol.js', ROOT/'build/core/storage.js']
    # Browser-safe modules are also served by path (not only statically imported).
    paths += [ROOT/'build/core/ui'/f for f in ['theme.js','styles.js','dom.js']]
    # Portal assets are served from disk rather than imported by the Node server.
    paths += sorted((ROOT/'build/core/account/portal').glob('*'))
    paths += [ROOT/'build/core/capture-check'/f for f in ['app.js','native.js','session.js','types.js']]
    return paths

def runtime_paths():
    return runtime_dependency_closure(runtime_entry_paths(),ROOT)

def package_files():
    snapshot=runtime_dependency_snapshot(runtime_entry_paths(),ROOT)
    paths=[]
    paths += [ROOT/'build/tools/enroll-preview.js',ROOT/'build/tools/preview-host-stage.js',ROOT/'platforms/macos/Preview.swift',ROOT/'docs/CAPTURE_PREVIEW.md',ROOT/'docs/TRACKING_API.md',ROOT/'docs/POMODORO.md',ROOT/'docs/SITE_BLOCKING.md']
    paths += [ROOT/'platforms/windows'/f for f in ['Preview.cs','WindowPixels.cs','WindowStream.cs','LatestWindowFrame.cs','PreviewAdmission.cs','PreviewLease.cs','Preview.csproj','ObservationContinuity.cs','preview.manifest']]
    files={path.relative_to(ROOT).as_posix():data for path,data in snapshot.items()}
    files.update({f.relative_to(ROOT).as_posix():f.read_bytes() for f in paths if f.is_file()})
    files['runtime/dependencies.json']=runtime_dependency_receipt(files)
    return files

MAC_EXECUTABLES={'runtime/node','runtime/SpindlePreview','runtime/SpindleFixture'}

def parse_args(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--dotnet',help='windows-x64 only')
    p.add_argument('--windows-native-cache',type=Path,help='windows-x64 only: Windows-host build from pinned verified archives; see build_windows_preview.py')
    p.add_argument('--restore-config',help='Explicit public-only NuGet.Config required with --dotnet; never adopt user feeds')
    p.add_argument('--macos-native-cache',type=Path,help='macos-arm64 only: precompiled helper cache from tools/build_macos_preview.py on a Mac')
    p.add_argument('--target',choices=['windows-x64','macos-arm64'],action='append',help='Repeat to select platforms; defaults to both')
    p.add_argument('--output',type=Path,default=ROOT/'.local/capture-preview/packages');a=p.parse_args(argv)
    a.targets=list(dict.fromkeys(a.target or ['macos-arm64','windows-x64']));windows='windows-x64' in a.targets;mac='macos-arm64' in a.targets
    if windows and bool(a.dotnet)==bool(a.windows_native_cache):p.error('windows-x64 needs exactly one of --dotnet or --windows-native-cache')
    if not windows and (a.dotnet or a.windows_native_cache or a.restore_config):p.error('Windows inputs apply only to --target windows-x64')
    if a.dotnet and not a.restore_config:p.error('--restore-config is required with --dotnet')
    if a.windows_native_cache and a.restore_config:p.error('--restore-config applies only to --dotnet')
    # An ordinary Mac download is never source-only; source checkouts compile via the launcher instead.
    if mac and not a.macos_native_cache:p.error('macos-arm64 needs --macos-native-cache DIR from tools/build_macos_preview.py on a Mac')
    if not mac and a.macos_native_cache:p.error('--macos-native-cache applies only to --target macos-arm64')
    return a

def load_macos_cache(cache, source, root=ROOT):
    """Verify the producer cache, then return only bytes re-verified from a private snapshot.

    Structural/source-bound only: the producer record is unattested metadata, and
    reuse across revisions is allowed only because the packaged Swift hash matches.
    """
    verify_cache(cache, root, source)
    names=[MAC_BINARY,MAC_FIXTURE,MAC_MANIFEST];data={name:read_regular(Path(cache)/name,MAX_BINARY_BYTES,'CACHE') for name in names}
    (root/'.local').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='macos-cache-snapshot-',dir=root/'.local') as snapshot:
        for name in names:(Path(snapshot)/name).write_bytes(data[name])
        check=verify_cache(snapshot, root, source)
    return {'files':{'runtime/'+name:data[name] for name in names},'check':{k:check[k] for k in ['check','producerSourceRevision','packageSource','reusedAcrossRevisions','inputs','binarySha256']}|{'producerRecord':'unattested-producer-metadata'}}

def target_files(target, base, node, notice, source, native_build, macos_cache=None, native=None, windows_record=False):
    files=dict(base);files['package.json']=b'{"private":true,"type":"module"}\n';mac=target.startswith('macos');files['runtime/node' if mac else 'runtime/node.exe']=node;files['runtime/LICENSE.txt']=notice
    if mac:
        verifier=ROOT/'build/tools/verify-macos-preview.js'
        if not verifier.is_file():raise FileNotFoundError('MISSING_RUNTIME_IMPORT: build/tools/verify-macos-preview.js')
        files.update({f.relative_to(ROOT).as_posix():data for f,data in runtime_dependency_snapshot([verifier]).items()});files.update(macos_cache['files'])
    else:
        files['runtime/SpindlePreview.exe']=(native/'SpindlePreview.exe').read_bytes();files['runtime/SpindleFixture.exe']=files['runtime/SpindlePreview.exe'];files['runtime/SpindlePreview.exe.config']=(native/'SpindlePreview.exe.config').read_bytes();files['runtime/SpindleFixture.exe.config']=files['runtime/SpindlePreview.exe.config']
        if windows_record:files['runtime/native-build.json']=(native/'native-build.json').read_bytes()
    start='Start Spindle Preview.command' if mac else 'Start Spindle Preview.cmd'
    files[start]=(ROOT/('platforms/macos/start-preview.command' if mac else 'platforms/windows/start-preview.cmd')).read_bytes()
    files['Preview Native Host.command' if mac else 'Preview Native Host.cmd']=(b'#!/bin/bash\nset -euo pipefail\nhere=$(cd -- "$(dirname -- "$0")" && pwd)\nexec "$here/runtime/node" "$here/build/core/preview/browser-host.js" "$@"\n' if mac else b'@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0build\\core\\preview\\browser-host.js" %*\r\n')
    files['Enroll Browser.command' if mac else 'Enroll Browser.cmd']=(b'#!/bin/bash\nset -euo pipefail\nhere=$(cd -- "$(dirname -- "$0")" && pwd)\nexec "$here/runtime/node" "$here/build/tools/enroll-preview.js" "$@"\n' if mac else b'@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0build\\tools\\enroll-preview.js" %*\r\n')
    summary=('Mac helper precompiled on a developer Mac (ad-hoc signed per its producer record); the launcher checks it structurally with bundled Node before start. Native execution not established by this package.\nBundled Node and helper; no CLT/SDK/npm/Python needed on Mac.\n' if mac else 'Windows helper built using '+native_build+', native execution not established by this package.\nBundled Node; no npm/Python/SDK needed on Windows.\n')
    files['READ ME FIRST.txt']=('SPINDLE INTEGRATED CAPTURE PREVIEW - NOT NATIVE VALIDATED\nTarget: '+target+'\nSource: '+source+'\n'+summary+'\n'+(ROOT/'docs/CAPTURE_PREVIEW.md').read_text()).encode()
    identity={name:hashlib.sha256(data).hexdigest() for name,data in files.items()};fingerprint=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
    record={'schema':'spindle-preview-package/v1','source':source,'sourceDirty':False,'target':target,'fingerprint':fingerprint,'files':identity,'nativeBuild':'macos-precompiled-cache' if mac else native_build,'nativeExecution':'not-run','installedAcceptance':'not-validated'}
    if mac:record['macosNativeCache']=macos_cache['check']
    files['preview-build.json']=(json.dumps(record,indent=2)+'\n').encode()
    return files

def write_package(out, name, files, timestamp):
    with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as bundle:
        for file,data in files.items():write_zip_entry(bundle,name+'/'+file,data,timestamp,file.endswith('.command') or file in MAC_EXECUTABLES)
    with zipfile.ZipFile(out) as bundle:
        assert bundle.testzip() is None
        for file,data in files.items():assert bundle.read(name+'/'+file)==data
    return name

def main():
    a=parse_args()
    if subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True).strip():raise SystemExit('Commit first: candidates must identify a clean source tree.')
    source=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    macos_cache=None
    if 'macos-arm64' in a.targets:
        # Fail before any build, download or staging; never fall back to a source-only Mac package.
        try:macos_cache=load_macos_cache(a.macos_native_cache,source)
        except CacheError as error:raise SystemExit('MAC_NATIVE_CACHE_INVALID: '+str(error))
    clear_generated_build();subprocess.run(['node',str(ROOT/'node_modules/typescript/bin/tsc')],cwd=ROOT,check=True);subprocess.run(['node','build/tools/build-assets.js'],cwd=ROOT,check=True)
    work=ROOT/'.local/capture-preview';native=work/'windows-runtime';env={**os.environ,'DOTNET_CLI_TELEMETRY_OPTOUT':'1','DOTNET_SKIP_FIRST_TIME_EXPERIENCE':'1','DOTNET_GENERATE_ASPNET_CERTIFICATE':'false','DOTNET_CLI_HOME':str(work/'dotnet-home'),'NUGET_PACKAGES':str(work/'nuget')};native_build=None
    if 'windows-x64' not in a.targets:pass
    elif a.windows_native_cache:
        subprocess.run([sys.executable,str(ROOT/'tools/build_windows_preview.py'),'--cache',str(a.windows_native_cache.resolve()),'--output',str(native)],cwd=ROOT,check=True)
        native_build='windows-roslyn-net48'
    else:
        subprocess.run([a.dotnet,'build','platforms/windows/Preview.csproj','-c','Release','--output',str(native),'-p:BaseIntermediateOutputPath='+str(work/'obj-preview')+'/', '-p:UseSharedCompilation=false','-nodeReuse:false','-p:RestoreConfigFile='+str(Path(a.restore_config).resolve())],cwd=ROOT,env=env,check=True)
        native_build='windows-dotnet-net48' if os.name=='nt' else 'linux-cross-build'
    base=package_files()
    for marker in ('A','B'):base['Invented image '+marker+'.png']=sample_image(marker)
    lock=json.loads((ROOT/'contracts/node-runtime.lock.json').read_text());cache=work/'runtime-cache';cache.mkdir(parents=True,exist_ok=True);a.output.mkdir(parents=True,exist_ok=True)
    timestamp=time.gmtime(int(subprocess.check_output(['git','show','-s','--format=%ct','HEAD'],cwd=ROOT,text=True)))[:6]
    sums=[]
    for target in a.targets:
        runtime=lock['targets'][target];archive=runtime['archive'];path=cache/archive
        if not path.exists():
            with urlopen(lock['baseUrl']+archive,timeout=60) as response:data=response.read(100*1024*1024)
            path.write_bytes(verified_download(data,runtime['sha256']))
        node,notice=extract_runtime(verified_download(path.read_bytes(),runtime['sha256']),archive)
        files=target_files(target,base,node,notice,source,native_build,macos_cache,native,bool(a.windows_native_cache))
        name='SpindleCapturePreview-'+target+'-'+source[:10];out=a.output/(name+'.zip')
        write_package(out,name,files,timestamp)
        sha=hashlib.sha256(out.read_bytes()).hexdigest();sums.append(sha+'  '+out.name);print(out.name,out.stat().st_size,sha,flush=True)
    (a.output/'SHA256SUMS.txt').write_text('\n'.join(sums)+'\n')
if __name__=='__main__':main()
