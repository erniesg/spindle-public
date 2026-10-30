import type {MemoryKind} from './user-protocol.js';
/** Deliberately bounded source/value grounding, not a general semantic or authorship classifier.
 * Unknown paraphrases/context fail closed. The same declaration families apply to both source kinds.
 */
export function admitLearning(source:string,value:{kind:MemoryKind;value:string;quote:string;key?:string},contentStart=0):string {
 const fail=():never=>{throw Error('UNSUPPORTED_LEARNING_DECLARATION');};
 const normalize=(s:string)=>s.trim().replace(/\.$/,'').replace(/\s+/g,' ').toLowerCase();
 // Quoted/reported content is not an eligible speaker declaration. Do not strip delimiters first.
 if(/["“”‘`]|(?<!\p{L})['’]|['’](?!\p{L})/u.test(source)||/\b(says?|said|wrote|quoted?|quoting|according to|told)\b/i.test(source))fail();
 // Explicit sensitive/authority/uncertain content is outside these declaration families.
 // These signals do NOT claim detection of every possible secret or covert instruction.
 const excluded=/\b(password|passcode|secret|credential|token|bearer|bank|routing|ssn|pin|consent|permission|authorize\w*|upload|ignore|execute|maybe|might|perhaps|uncertain|unsure|unless|if|not|never)\b|api[ _-]?key|private[ _-]?key|account[ _-]?number|social security|grant (?:access|authority)|\d{8,}/i;
 if(excluded.test(source)||excluded.test(value.value)||excluded.test((value.key??'').replace(/[_-]/g,' ')))fail();
 if(/(?<!\p{L})\p{L}+['’]s\s+(?:note|email|message|letter|document|words)\b/iu.test(source)||/\b(?:email|letter|note|message|memo)\s+(?:from|by)\b|\b(?:forwarded|original)\s+(?:message|email)|^\s*(?:from|sender|to|cc|bcc|subject|sent)\s*:/im.test(source))fail();
 // The trusted ingress supplies an activity body offset, never the model. Conversations use the
 // whole turn. Require the WHOLE field, not a chosen line/sentence with omitted qualifications.
 if(!Number.isSafeInteger(contentStart)||contentStart<0||contentStart>source.length||contentStart>0&&source[contentStart-1]!=='\n')fail();
 // A trusted field boundary is not an authorship certificate for a labelled enclosing speaker.
 if(source.slice(0,contentStart).split('\n').some(line=>/[:：]$/.test(line.trimEnd())))fail();
 const quote=value.quote;if(!source.includes(quote)||normalize(source.slice(contentStart))!==normalize(quote))fail();
 const text=quote.trim().replace(/\.$/,'').replace(/\s+/g,' ');if(/[.!?;:]/.test(text))fail();
 const projections:string[]=[];let persistedValue=value.value,m:RegExpMatchArray|null;
 if(value.kind==='preference'&&(m=text.match(/^(?:(For [^,]+),\s*)?I (prefer|like|dislike) (.+)$/i))){
  const predicate=m[2].toLowerCase()+'s '+m[3];projections.push(m[3],text,m[1]?predicate+' '+m[1]:predicate);
  // Accept the whole grounded object, but never persist it without its source predicate/scope.
  persistedValue=source.slice(contentStart).trim().replace(/\.$/,'').replace(/\s+/g,' ').trim()+'.';
  if(m[1])projections.push(m[1]+', '+predicate);
 }else if(value.kind==='fact'&&(m=text.match(/^I am (.+)$/i)))projections.push('Is '+m[1],m[1],text);
 else if(value.kind==='fact'&&(m=text.match(/^I (work|live|study|use|have) (.+)$/i))){const verb=m[1].toLowerCase();projections.push((verb==='have'?'has':verb==='study'?'studies':verb+'s')+' '+m[2],text);}
 else if(value.kind==='goal'&&(m=text.match(/^I am ((?:drafting|working on|preparing|planning|learning|studying|building|writing) .+)$/i)))projections.push(m[1],'Is '+m[1],text);
 else if(value.kind==='goal'&&(m=text.match(/^My goal is (.+)$/i)))projections.push('Goal is '+m[1],m[1],text);
 else if(value.kind==='goal'&&(m=text.match(/^I want to (.+)$/i)))projections.push('Wants to '+m[1],text);
 if(!projections.some(p=>normalize(p)===normalize(value.value)))fail();
 return persistedValue;
}
