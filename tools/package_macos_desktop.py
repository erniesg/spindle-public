#!/usr/bin/env python3
"""VM-owned Mac test delivery: prepare build inputs; verify returned real Mac app; write final ZIP.
Prepare is BUILD INPUT ONLY, never an installer. Finalize requires the real Mac build receipt.
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, time, zipfile
from pathlib import Path
from urllib.request import urlopen
from package_preview import package_files,clear_generated_build
from package_capture_check import verified_download,extract_runtime,write_zip_entry
from preview_sample import sample_image
from build_macos_preview import git,validate_macho,verify_cache
from build_macos_desktop import files
ROOT=Path(__file__).resolve().parents[1]
def sha(b):return hashlib.sha256(b).hexdigest()
def source():
    if git(ROOT,'status','--porcelain','--untracked-files=all'):raise ValueError('SOURCE_DIRTY')
    return git(ROOT,'rev-parse','HEAD')
def prepare(output):
    revision=source()
    if output.exists():raise ValueError('OUTPUT_EXISTS')
    clear_generated_build();subprocess.run(['node','node_modules/typescript/bin/tsc'],cwd=ROOT,check=True);subprocess.run(['node','build/tools/build-assets.js'],cwd=ROOT,check=True)
    lock=json.loads((ROOT/'contracts/node-runtime.lock.json').read_text());runtime=lock['targets']['macos-arm64'];archive=runtime['archive']
    cache=ROOT/'.local/capture-preview/runtime-cache';cache.mkdir(parents=True,exist_ok=True);path=cache/archive
    if not path.exists():
        with urlopen(lock['baseUrl']+archive,timeout=60) as response:data=response.read(100*1024*1024)
        path.write_bytes(verified_download(data,runtime['sha256']))
    node,notice=extract_runtime(verified_download(path.read_bytes(),runtime['sha256']),archive)
    base=package_files();base.update({'package.json':b'{"private":true,"type":"module"}\n','runtime/node':node,'runtime/LICENSE.txt':notice})
    resources=output/'resources';resources.mkdir(parents=True)
    for name,data in base.items():
        target=resources/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
        if name=='runtime/node':target.chmod(0o755)
    record={'schema':'spindle-desktop-build-input/v1','source':revision,'sourceTree':git(ROOT,'rev-parse','HEAD^{tree}'),'kind':'BUILD INPUT ONLY; no desktop executable; not a test installer','files':files(resources)}
    (output/'desktop-payload.json').write_text(json.dumps(record,indent=2)+'\n');return record

def finalize(built,payload,output):
    revision=source();app=built/'Spindle.app';receipt=json.loads((built/'desktop-build.json').read_text());inputs=json.loads((payload/'desktop-payload.json').read_text())
    if any(p.is_symlink() for p in built.rglob('*')):raise ValueError('APP_SYMLINK')
    if receipt.get('schema')!='spindle-desktop-build/v1' or receipt.get('source')!=revision or receipt.get('sourceTree')!=git(ROOT,'rev-parse','HEAD^{tree}') or receipt.get('codesignVerified') is not True or receipt.get('files')!=files(app):raise ValueError('MAC_BUILD_RECEIPT_MISMATCH')
    if inputs.get('source')!=revision or inputs.get('files')!=files(payload/'resources'):raise ValueError('VM_PAYLOAD_MISMATCH')
    resources=app/'Contents/Resources';record=json.loads((resources/'preview-build.json').read_text())
    if record.get('source')!=revision or record.get('sourceDirty') is not False:raise ValueError('APP_SOURCE_MISMATCH')
    actual=files(resources);actual.pop('preview-build.json',None)
    if record.get('files')!=actual or record.get('fingerprint')!=sha(json.dumps(actual,sort_keys=True).encode()):raise ValueError('APP_RESOURCE_MISMATCH')
    if any(sha((resources/p).read_bytes())!=h for p,h in inputs['files'].items()):raise ValueError('APP_VM_PAYLOAD_CHANGED')
    for p,h in receipt.get('inputs',{}).items():
        if p not in ['platforms/macos/DesktopApp.swift','platforms/macos/Spindle.Info.plist','platforms/macos/Preview.swift'] or sha((ROOT/p).read_bytes())!=h:raise ValueError('NATIVE_SOURCE_MISMATCH')
    if len(receipt.get('inputs',{}))!=3:raise ValueError('NATIVE_SOURCE_MISSING')
    if (app/'Contents/Info.plist').read_bytes()!=(ROOT/'platforms/macos/Spindle.Info.plist').read_bytes():raise ValueError('APP_IDENTITY_MISMATCH')
    validate_macho((app/'Contents/MacOS/Spindle').read_bytes())
    # Existing helper verifier requires exactly its three producer files, not bundled Node.
    import tempfile
    with tempfile.TemporaryDirectory() as temp:
        for name in ['SpindlePreview','SpindleFixture','macos-native-build.json']:shutil.copyfile(resources/'runtime'/name,Path(temp)/name)
        verify_cache(Path(temp),ROOT,revision)
    output.mkdir(parents=True,exist_ok=True);name='Spindle-Mac-test-'+revision[:10];destination=output/(name+'.zip')
    timestamp=time.gmtime(int(git(ROOT,'show','-s','--format=%ct','HEAD')))[:6]
    content={('Spindle.app/'+p):f.read_bytes() for p in files(app) for f in [app/p]}
    for p in sorted((resources/'build/browser-extension/preview').rglob('*')):
        if p.is_file():content['Chrome Extension/'+p.relative_to(resources/'build/browser-extension/preview').as_posix()]=p.read_bytes()
    for marker in ['A','B']:content['Invented image '+marker+'.png']=sample_image(marker)
    # Verbatim build receipt stays private: compiler commands contain Mac home paths.
    content['INSTALL-TEST.txt']=(ROOT/'docs/MAC_TEST_INSTALL.txt').read_bytes()
    with zipfile.ZipFile(destination,'w',compression=zipfile.ZIP_DEFLATED) as bundle:
        for p,data in content.items():write_zip_entry(bundle,name+'/'+p,data,timestamp,p in ['Spindle.app/Contents/MacOS/Spindle','Spindle.app/Contents/Resources/runtime/node','Spindle.app/Contents/Resources/runtime/SpindlePreview','Spindle.app/Contents/Resources/runtime/SpindleFixture'])
    with zipfile.ZipFile(destination) as bundle:
        if bundle.testzip() is not None:raise ValueError('ZIP_CORRUPT')
        for p,data in content.items():
            if bundle.read(name+'/'+p)!=data:raise ValueError('ZIP_READBACK_MISMATCH')
    checksum=sha(destination.read_bytes());(output/'SHA256SUMS.txt').write_text(checksum+'  '+destination.name+'\n')
    print(json.dumps({'zip':str(destination),'sha256':checksum,'source':revision,'nativeExecution':receipt.get('nativeExecution'),'installedAcceptance':'not-validated','privatePublication':'not-uploaded'}));return destination

def main():
    p=argparse.ArgumentParser(description=__doc__);s=p.add_subparsers(dest='action',required=True)
    a=s.add_parser('prepare');a.add_argument('--output',required=True,type=Path)
    a=s.add_parser('finalize');a.add_argument('--built',required=True,type=Path);a.add_argument('--payload',required=True,type=Path);a.add_argument('--output',required=True,type=Path)
    a=p.parse_args()
    if a.action=='prepare':r=prepare(a.output.resolve());print(json.dumps({k:v for k,v in r.items() if k!='files'},indent=2))
    else:finalize(a.built.resolve(),a.payload.resolve(),a.output.resolve())
if __name__=='__main__':main()
