// Executed only after ordinary-profile, allowed-origin, active-tab and focused-window checks.
// It checks focus again before reading any text. No input.value, editable or hidden subtree read.
export function visibleText(browserAction=false): {text:string;document:string}|null {
  // A manual browser action can focus Chrome's toolbar, not the renderer. Only
  // that caller may rely on its separately revalidated active-tab/window proof.
  if(document.visibilityState!=='visible'||!browserAction&&!document.hasFocus())return null;
  const lines:string[]=[];let size=0,nodes=0;
  const walk=(element:Element)=>{
    if(++nodes>2000||size>=4096)return;
    if(element.matches('input,textarea,select,button,script,style,noscript,iframe,object,embed,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],[role="textbox"]'))return;
    const style=getComputedStyle(element);
    if(style.display==='none'||style.visibility!=='visible'||style.opacity==='0'||style.filter!=='none'||!['','none'].includes(style.getPropertyValue('mask-image'))||!['','none'].includes(style.getPropertyValue('-webkit-mask-image'))||/rgba\([^)]*,\s*0(?:\.0+)?\)/.test(style.color)||!['','none'].includes(style.getPropertyValue('-webkit-text-security')))return;
    const rect=element.getBoundingClientRect();
    if(rect.width<=0||rect.height<=0||rect.bottom<=0||rect.right<=0||rect.top>=innerHeight||rect.left>=innerWidth||style.clipPath!=='none'||style.transform!=='none')return;
    let left=0,top=0,right=innerWidth,bottom=innerHeight;
    for(let parent:Element|null=element;parent;parent=parent.parentElement){const s=getComputedStyle(parent),r=parent.getBoundingClientRect();if(s.overflowX!=='visible'){left=Math.max(left,r.left);right=Math.min(right,r.right);}if(s.overflowY!=='visible'){top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);}}
    if(right<=left||bottom<=top)return;
    for(const node of element.childNodes){
      if(size>=4096)break;
      if(node.nodeType===Node.TEXT_NODE){const range=document.createRange();range.selectNodeContents(node);const boxes=Array.from(range.getClientRects());if(!boxes.length||boxes.some(r=>r.width<=0||r.height<=0||r.left<left||r.top<top||r.right>right||r.bottom>bottom))continue;const value=(node.textContent??'').trim();if(value){const part=value.slice(0,4096-size);lines.push(part);size+=part.length+1;}}
      else if(node instanceof Element)walk(node);
    }
  };
  if(document.body)walk(document.body);
  if(!browserAction&&!document.hasFocus()||document.visibilityState!=='visible')return null;
  // Per-document nonpersistent token, not URL/title or a page-controlled ID.
  return {text:lines.join('\n').slice(0,4096),document:String(performance.timeOrigin)};
}
