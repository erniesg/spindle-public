// Best-effort SPA fence. Local URL observation never polls the shared worker.
(() => {
 let checking=false, stopped=false, last=location.href;
 let expiry:ReturnType<typeof setTimeout>|undefined;
 const timer=setInterval(()=>{if(location.href!==last){last=location.href;void check();}},250);
 const stop=():void=>{stopped=true;clearInterval(timer);clearTimeout(expiry);chrome.runtime.onMessage.removeListener(message);};
 const message=(input:{type?:string}):void=>{if(input.type==='blocking-stop') stop();};
 chrome.runtime.onMessage.addListener(message);
 const check=async():Promise<void>=>{
  if(checking||stopped)return;
  checking=true;
  const resource=location.href;
  try {
   const result=await chrome.runtime.sendMessage({type:'resource-check',resource});
   if(stopped || location.href!==resource)return;
   if(!result?.active){stop();return;}
   if(result.gated){
    document.querySelectorAll('video,audio').forEach(node=>(node as HTMLMediaElement).pause());
    document.documentElement.style.visibility='hidden';location.reload();
   }else if(result.expires){clearTimeout(expiry);expiry=setTimeout(()=>void check(),Math.max(0,result.expires-Date.now()));}
  }catch{if(!stopped && location.href===resource){document.documentElement.style.visibility='hidden';location.reload();}}
  finally{
   checking=false;
   // A URL tick during an awaited check must not consume the only signal for
   // the new resource or apply the previous resource's response to this page.
   if(!stopped && location.href!==resource) void check();
  }
 };
 void check();
})();
