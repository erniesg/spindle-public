#!/usr/bin/env python3
"""Mac BUILD AGENT only: compile both native components, assemble and ad-hoc sign Spindle.app.
Never runs the app/collector, grants permissions or changes Gatekeeper. Recipient needs none of these tools.
"""
import argparse, hashlib, json, os, shutil, subprocess, tempfile
from pathlib import Path
from build_macos_preview import build as build_preview, git, tool_output, validate_macho
ROOT=Path(__file__).resolve().parents[1]
def sha(data):return hashlib.sha256(data).hexdigest()
def files(root):return {p.relative_to(root).as_posix():sha(p.read_bytes()) for p in sorted(root.rglob('*')) if p.is_file()}
def checked_payload(payload, revision):
    record=json.loads((payload/'desktop-payload.json').read_text());resources=payload/'resources'
    if record.get('schema')!='spindle-desktop-build-input/v1' or record.get('source')!=revision or record.get('files')!=files(resources):raise ValueError('DESKTOP_PAYLOAD_MISMATCH')
    if any(p.is_symlink() for p in payload.rglob('*')):raise ValueError('DESKTOP_PAYLOAD_SYMLINK')
    return resources,record

def build(payload,output):
    if os.uname().sysname!='Darwin':raise ValueError('MAC_BUILD_HOST_REQUIRED')
    if git(ROOT,'status','--porcelain','--untracked-files=all'):raise ValueError('SOURCE_DIRTY')
    revision=git(ROOT,'rev-parse','HEAD');tree=git(ROOT,'rev-parse','HEAD^{tree}')
    resources,inputs=checked_payload(payload,revision)
    if output.exists():raise ValueError('OUTPUT_EXISTS')
    sdk=tool_output(['/usr/bin/xcrun','--sdk','macosx','--show-sdk-version'])
    if int(sdk.split('.')[0])<15:raise ValueError('MAC_SDK_15_REQUIRED')
    compiler=tool_output(['/usr/bin/xcrun','swiftc','--version']).splitlines()[0]
    output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='spindle-desktop-',dir=output.parent) as temp:
        work=Path(temp);app=work/'Spindle.app';contents=app/'Contents';runtime=contents/'Resources'
        shutil.copytree(resources,runtime);(contents/'MacOS').mkdir()
        shutil.copyfile(ROOT/'platforms/macos/Spindle.Info.plist',contents/'Info.plist')
        preview=work/'preview-cache';native=build_preview(preview,ROOT)
        for p in preview.iterdir():shutil.copy2(p,runtime/'runtime'/p.name)
        executable=contents/'MacOS/Spindle'
        command=['/usr/bin/xcrun','swiftc','-swift-version','5','-O','-parse-as-library','-target','arm64-apple-macos15.0',str(ROOT/'platforms/macos/DesktopApp.swift'),'-o',str(executable)]
        for framework in ['AppKit','WebKit','Foundation']:command+=['-framework',framework]
        subprocess.run(command,check=True)
        for name in ['node','SpindlePreview','SpindleFixture']:os.chmod(runtime/'runtime'/name,0o755)
        os.chmod(executable,0o755)
        identity=files(runtime)
        fingerprint=sha(json.dumps(identity,sort_keys=True).encode())
        record={'schema':'spindle-preview-package/v1','source':revision,'sourceDirty':False,'target':'macos-arm64','fingerprint':fingerprint,'files':identity,'nativeBuild':'macos-desktop-and-preview','nativeExecution':'not-run','installedAcceptance':'not-validated','macosNativeCache':{'producerSourceRevision':native['sourceRevision'],'inputs':native['inputs'],'binarySha256':native['binarySha256']}}
        (runtime/'preview-build.json').write_text(json.dumps(record,indent=2)+'\n')
        # Sign only the outer app. Never re-sign the official bundled Node or helper.
        subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(app)],check=True)
        subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],check=True)
        validate_macho(executable.read_bytes())
        if any(sha((runtime/p).read_bytes())!=h for p,h in inputs['files'].items()):raise ValueError('VM_PAYLOAD_CHANGED')
        if git(ROOT,'rev-parse','HEAD')!=revision or git(ROOT,'status','--porcelain','--untracked-files=all'):raise ValueError('SOURCE_CHANGED')
        receipt={'schema':'spindle-desktop-build/v1','source':revision,'sourceTree':tree,'inputs':{p:sha((ROOT/p).read_bytes()) for p in ['platforms/macos/DesktopApp.swift','platforms/macos/Spindle.Info.plist','platforms/macos/Preview.swift']},'sdk':sdk,'compiler':compiler,'commands':[command,['/usr/bin/codesign','--force','--sign','-','Spindle.app'],['/usr/bin/codesign','--verify','--deep','--strict','Spindle.app']],'codesignVerified':True,'signing':'ad-hoc; not notarized','files':files(app),'nativeExecution':'not-run','installedAcceptance':'not-validated'}
        output.mkdir();shutil.move(app,output/'Spindle.app');(output/'desktop-build.json').write_text(json.dumps(receipt,indent=2)+'\n')
    return receipt

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--payload',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    receipt=build(a.payload.resolve(),a.output.resolve());print(json.dumps({k:v for k,v in receipt.items() if k!='files'},indent=2))
if __name__=='__main__':main()
