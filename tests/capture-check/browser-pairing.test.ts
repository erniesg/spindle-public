import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingReply, pairingStatus } from '../../browser-extension/preview/pairing.js';
import { nativeFailure } from '../../browser-extension/preview/native-failure.js';

test('pairing reports a sanitized native-host disconnect with a registration action',()=>{
 assert.equal(pairingStatus({failure:'HOST_DISCONNECTED'}),'Pairing failed [HOST_DISCONNECTED]. Re-run Enroll Browser.command, then reload this extension.');
});

test('pairing reports a sanitized native-host timeout with a local-app action',()=>{
 assert.equal(pairingStatus({failure:'HOST_TIMEOUT'}),'Pairing failed [HOST_TIMEOUT]. Keep the local Spindle Preview app running, then try again.');
});

test('pairing reports a rejected code without exposing host error text',()=>{
 assert.equal(pairingStatus({failure:'PAIR_REJECTED',detail:'private native stderr'}),'Pairing failed [PAIR_REJECTED]. Copy the current code from the local app and try again.');
});

test('known Chrome native-host errors map to fixed content-free failure codes',()=>{
 assert.equal(nativeFailure('Specified native messaging host not found.'),'HOST_NOT_FOUND');
 assert.equal(nativeFailure('Access to the specified native messaging host is forbidden.'),'HOST_FORBIDDEN');
 assert.equal(nativeFailure('Failed to start native messaging host.'),'HOST_LAUNCH_FAILED');
 assert.equal(nativeFailure('Native host has exited.'),'HOST_EXITED');
 assert.equal(nativeFailure('Error when communicating with the native messaging host.'),'HOST_PROTOCOL_ERROR');
 assert.equal(nativeFailure('private browser implementation text'),'HOST_DISCONNECTED');
});

test('native-host error codes remain visible without the raw browser error',()=>{
 for(const failure of ['HOST_NOT_FOUND','HOST_FORBIDDEN','HOST_LAUNCH_FAILED','HOST_EXITED','HOST_PROTOCOL_ERROR']){
  const status=pairingStatus({failure,detail:'private browser implementation text'});
  assert.ok(status.includes('['+failure+']'));
  assert.ok(!status.includes('private browser implementation text'));
 }
});

test('worker pairing reply forwards only a recognized native failure',()=>{
 assert.deepEqual(pairingReply({failure:'HOST_NOT_FOUND'}),{ok:false,failure:'HOST_NOT_FOUND'});
 assert.deepEqual(pairingReply({failure:'private browser implementation text'}),{ok:false});
 assert.deepEqual(pairingReply({profileToken:'invented-local-token'}),{ok:true});
});
