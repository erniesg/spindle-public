// Check-letter values computed with the public NRIC/FIN algorithm on invented digits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {nricCheckLetter,identifierProblem,documentNameProblem} from '../../core/preparation/identifiers.js';
test('NRIC/FIN check letters follow the S/T and F/G tables, with the T/G offset',()=>{
 assert.equal(nricCheckLetter('S1234567D'),'D');
 assert.equal(nricCheckLetter('T1234567J'),'J');
 assert.equal(nricCheckLetter('F1234567N'),'N');
 assert.equal(nricCheckLetter('G1234567X'),'X');
 assert.equal(nricCheckLetter('M1234567K'),undefined,'M-series is format-checked only');
});
test('a misread identifier is refused; valid, joined, spaced and unrelated values pass',()=>{
 assert.equal(identifierProblem('NRIC No','S1234567D'),undefined);
 assert.equal(identifierProblem('NRIC (joint holders)','S1234567D / T1234567J'),undefined);
 assert.equal(identifierProblem('NRIC No','S 1234567 D'),undefined);
 assert.match(identifierProblem('NRIC No','S1234567B')!,/fails the NRIC\/FIN check letter \(expected D/);
 assert.match(identifierProblem('NRIC No','S123456ID')!,/middle seven characters must be digits/);
 assert.match(identifierProblem('Payer details','S1234567D, S1234567B')!,/S1234567B/,'shape alone triggers the check, whatever the label');
 assert.match(identifierProblem('NRIC No','LIM MEI LING')!,/no NRIC\/FIN-shaped identifier/);
 assert.equal(identifierProblem('Address','SINGAPORE'),undefined,'words are not identifiers');
 assert.equal(identifierProblem('Account holder','TAN AH KOW'),undefined);
});
test('names a letter or two from an owner-saved name are flagged; exact, joined and unrelated names pass',()=>{
 const saved=['LIM MEI LING','Tan Ah Kow'];
 assert.equal(documentNameProblem('LIM MEI LING',saved),undefined);
 assert.equal(documentNameProblem('TAN AH KOW / LIM MEI LING',saved),undefined,'joint holders on one line');
 assert.match(documentNameProblem('LIM MBI LING',saved)!,/"LIM MBI LING" is 1 letter away from "LIM MEI LING"/);
 assert.match(documentNameProblem('TAN AH KOW, LIM MEL LIN',saved)!,/2 letters away/,'two letters allowed for longer names');
 assert.match(documentNameProblem('TAN AH KAW',saved)!,/1 letter away from "TAN AH KOW"/,'case-insensitive');
 assert.equal(documentNameProblem('TAN BH KAW',saved),undefined,'short names allow one letter only');
 assert.equal(documentNameProblem('ONG BENG HUAT',saved),undefined);
 assert.equal(documentNameProblem('LIM MBI LING',[]),undefined,'nothing saved, nothing flagged');
});
