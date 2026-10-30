import type { ChildProcess } from 'node:child_process';

// Own only the currently opened run-owned fixture; old exit/error events may arrive later.
export class FixtureOwner {
  private child:ChildProcess|null=null;
  constructor(private launch:()=>ChildProcess,private failed:()=>void){}
  open(){
    if(this.child)return;
    const child=this.launch();this.child=child;
    child.on('error',()=>{if(this.child===child){this.child=null;this.failed();}});
    child.on('exit',()=>{if(this.child===child)this.child=null;});
  }
  stop(){const child=this.child;this.child=null;child?.kill();}
}
