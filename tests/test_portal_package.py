"""Actual standalone package assets/HTTP, not installed Mac or native acceptance."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from package_preview import package_files

class PortalPackageTests(unittest.TestCase):
    def test_portal_browser_graph_is_served_from_self_contained_payload(self):
        files=package_files()
        for name in ['app.js','tracking.js','pomodoro.js','blocking.js','application.js','build.json']:
            self.assertIn('build/core/account/portal/'+name,files)
        scratch=Path(os.environ.get('RUCKSACK_SCRATCH_ROOT',Path.home()/'.local/state/rucksack/scratch/spindle-package-tests'))
        scratch.mkdir(parents=True,exist_ok=True)
        # Outside the repository, so imports cannot borrow its node_modules.
        with tempfile.TemporaryDirectory(prefix='portal-payload-',dir=scratch) as temporary:
            payload=Path(temporary)
            for name,data in files.items():
                target=payload/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
            (payload/'package.json').write_text('{"type":"module","private":true}\n')
            code="""
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=process.argv[2];
const {startTrackingServer}=await import(pathToFileURL(root+'/build/core/tracking/server.js'));
const server=await startTrackingServer(root+'/invented-account',Buffer.alloc(32,59));
try{
 const paths=['/portal','/portal/styles.css','/portal/build','/portal/code/account/portal/app.js','/portal/code/account/portal/tracking.js','/portal/code/account/portal/pomodoro.js','/portal/code/account/portal/blocking.js','/portal/code/account/portal/application.js','/portal/code/account/client.js','/portal/code/pomodoro/client.js','/portal/code/pomodoro/protocol.js'];
 for(const path of paths){const response=await fetch(server.origin+path);assert.equal(response.status,200,path);assert.ok((await response.text()).length>0,path);}
 assert.equal((await fetch(server.origin+'/portal/code/tracking/server.js')).status,404);
 console.log('Standalone portal asset closure PASS; no repository dependency borrowing or native effects');
}finally{await server.close();}
// Invented signed provider fixture in the extracted payload; no WorkOS network effects.
const {generateKeyPair,exportJWK,SignJWT}=await import(pathToFileURL(root+'/node_modules/jose/dist/webapi/index.js'));
const {createServer}=await import('node:net');
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
const port=listener.address().port;await new Promise(r=>listener.close(r));
const origin='http://127.0.0.1:'+port;
const config={clientId:'client_package',issuer:'https://api.workos.com/user_management/client_fixture',jwksUri:'https://api.workos.com/sso/jwks/client_fixture',webRedirectUri:origin+'/auth/workos/callback'};
const keys=await generateKeyPair('RS256'),jwk=await exportJWK(keys.publicKey),now=Math.floor(Date.now()/1000);
const token=await new SignJWT({iss:config.issuer,sub:'user_package',sid:'session_package',client_id:config.clientId,iat:now,exp:now+300}).setProtectedHeader({alg:'RS256',kid:'package'}).sign(keys.privateKey);
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=String(input);
 if(url===config.jwksUri)return Response.json({keys:[{...jwk,kid:'package',alg:'RS256',use:'sig'}]});
 if(url==='https://api.workos.com/user_management/authenticate')return Response.json({access_token:token});
 if(url.startsWith('https://api.workos.com'))throw Error('unexpected provider endpoint');
 return original(input,init);
};
let configured;
try{
 configured=await startTrackingServer(root+'/invented-workos',Buffer.alloc(32,60),port,undefined,undefined,undefined,undefined,config);
 assert.equal((await original(origin+'/auth/workos/config')).status,200);
 const signed=await original(origin+'/auth/workos/native',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:'invented-code',codeVerifier:'v'.repeat(43)})});
 assert.equal(signed.status,200,await signed.text());
 console.log('Standalone configured WorkOS signed fixture PASS');
}finally{await configured?.close();globalThis.fetch=original;}
"""
            env=dict(os.environ);env.pop('NODE_PATH',None)
            result=subprocess.run(['node','--input-type=module','-e',code,'portal-package',str(payload)],cwd=payload,env=env,capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr)

if __name__=='__main__':unittest.main()
