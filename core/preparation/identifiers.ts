// Deterministic checks for identifiers whose format carries its own check digit, so a plausible
// OCR misread (I/1, O/0, B/8) is refused before it reaches a form instead of being trusted.
const weights=[2,7,6,5,4,3,2];
/** Singapore NRIC/FIN check letter for S/T/F/G prefixes; undefined for M (format-only) and anything else. */
export function nricCheckLetter(id:string):string|undefined{
 const m=/^([STFG])(\d{7})[A-Z]$/.exec(id);if(!m)return undefined;
 const prefix=m[1]!,sum=[...m[2]!].reduce((s,d,i)=>s+Number(d)*weights[i]!,0)+(prefix==='T'||prefix==='G'?4:0);
 return (prefix==='S'||prefix==='T'?'JZIHGFEDCBA':'XWUTRQPNMLK')[sum%11];
}
const nricLabel=/\b(?:NRIC|FIN|IC\s*No)\b/i;
// Mostly digits in the middle, so words such as SINGAPORE are not mistaken for identifiers.
const nricLike={test:(t:string)=>/^[STFGM][0-9A-Z]{7}[A-Z]$/.test(t)&&(t.slice(1,8).match(/\d/g)?.length??0)>=5};
/** Why a recorded value cannot be an identifier its label or shape claims; undefined when it passes or does not apply. */
export function identifierProblem(label:string,value:string):string|undefined{
 const tokens=value.toUpperCase().split(/[\s,;\/&]+/).filter(Boolean);
 const joined=value.toUpperCase().replace(/[\s-]/g,'');
 // Printed IDs are sometimes spaced ("S 2734271 Z"); under an NRIC/FIN label read the value as one token too.
 const candidates=[...new Set([...tokens.filter(t=>nricLike.test(t)),...(nricLabel.test(label)&&nricLike.test(joined)?[joined]:[])])];
 for(const t of candidates){
  if(!/^[STFGM]\d{7}[A-Z]$/.test(t))return `"${t}" is not a valid NRIC/FIN: the middle seven characters must be digits (a likely I/1 or O/0 misread)`;
  const expected=nricCheckLetter(t);
  if(expected&&expected!==t[8])return `"${t}" fails the NRIC/FIN check letter (expected ${expected} for these digits), so at least one character is misread`;
 }
 if(nricLabel.test(label)&&!candidates.length)return `the value for an NRIC/FIN field contains no NRIC/FIN-shaped identifier (letter, seven digits, letter)`;
 return undefined;
}
const letters=(v:string)=>v.toUpperCase().split(/[^\p{L}]+/u).filter(Boolean);
function distance(a:string,b:string){let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(row[j]!+1,next[j-1]!+1,row[j-1]!+(a[i-1]===b[j-1]?0:1));row=next;}return row[b.length]!;}
/** Owner-saved names that a recorded value nearly, but not exactly, contains: a smudged letter
 * (dot-matrix E read as B) that two readers of the same model can agree on. Exact matches pass. */
export function documentNameProblem(value:string,known:readonly string[]):string|undefined{
 const words=letters(value),names=known.map(letters).filter(n=>n.length),exact=new Set(names.map(n=>n.join(' ')));
 for(const name of names){
  const target=name.join(' '),allowed=target.replace(/ /g,'').length>=10?2:1;
  for(let i=0;i+name.length<=words.length;i++){
   const window=words.slice(i,i+name.length).join(' ');if(exact.has(window))continue;
   const d=distance(window,target);
   if(d>0&&d<=allowed)return `"${window}" is ${d} letter${d>1?'s':''} away from "${target}", a name the owner saved in Account settings, so it is probably misread`;
  }
 }
 return undefined;
}
