// Pixel consent includes visible edited fields; this probe reads no field values.
// Embedded documents remain unsupported: they have separate source identities.
export function pixelDocument(toolbarGesture=false): {revision:number;width:number;height:number}|null {
  // Focus is checked by the caller through Chrome window/tab APIs; the toolbar
  // may hold keyboard focus during the explicit browser action.
  if(document.visibilityState!=='visible'||!toolbarGesture&&!document.hasFocus())return null;
  const width=Math.ceil(innerWidth*devicePixelRatio),height=Math.ceil(innerHeight*devicePixelRatio);
  if(width<1||height<1||width>2560||height>1600)return null;
  const scope=globalThis as typeof globalThis & {__spindlePixelRevision?:{revision:number;observer:MutationObserver}};
  let state=scope.__spindlePixelRevision;
  if(!state){
    state={revision:0,observer:new MutationObserver(records=>{if(scope.__spindlePixelRevision)scope.__spindlePixelRevision.revision+=records.length;})};
    state.observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});scope.__spindlePixelRevision=state;
    for(const kind of ['input','change','scroll','resize'])addEventListener(kind,()=>{if(scope.__spindlePixelRevision)scope.__spindlePixelRevision.revision++;},{capture:true,passive:true});
  }
  state.revision+=state.observer.takeRecords().length;
  const roots:Node[]=[document];let count=0;
  while(roots.length){
   const walker=document.createTreeWalker(roots.pop()!,NodeFilter.SHOW_ELEMENT);let node:Node|null;
   while((node=walker.nextNode())){
    if(++count>2000)return null;
    const element=node as Element;
    if(element.matches('iframe,frame,object,embed'))return null;
    if(element instanceof HTMLElement){
      if(typeof chrome==='undefined'||typeof chrome.dom?.openOrClosedShadowRoot!=='function')return null;
      const shadow=chrome.dom.openOrClosedShadowRoot(element);if(shadow){roots.push(shadow);state.observer.observe(shadow,{subtree:true,childList:true,attributes:true,characterData:true});}
    }
   }
  }
  return {revision:state.revision,width,height};
}
