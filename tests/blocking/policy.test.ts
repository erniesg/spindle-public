import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resourceIdentity, matchesHost, eligible } from '../../core/blocking/policy.js';
test('host boundaries and minimal resource identity', () => {
 assert.equal(matchesHost('badexample.test', 'example.test', true), false);
 assert.equal(matchesHost('a.example.test', 'example.test', true), true);
 assert.equal(matchesHost('a.example.test', 'example.test', false), false);
 assert.equal(resourceIdentity('https://u:p@example.test/lesson?tracking=secret#x'), 'https://example.test/lesson');
 assert.notEqual(resourceIdentity('https://youtube.com/watch?v=abc123'), resourceIdentity('https://youtube.com/watch?v=def456'));
});
test('exceptions fail closed on stale policy, resource, purpose, expiry or uncertainty', () => {
 const policy = { version: 2, purpose: 'math' };
 const grant = { version: 2, purpose: 'math', resource: 'https://example.test/a', expires: 200, verdict: 'allow' };
 assert.equal(eligible(policy, grant, grant.resource, 100), true);
 for (const change of [{version:1}, {purpose:'fun'}, {expires:100}, {verdict:'uncertain'}, {resource:'https://example.test/b'}]) {
  assert.equal(eligible(policy, {...grant,...change}, grant.resource, 100), false);
 }
});
