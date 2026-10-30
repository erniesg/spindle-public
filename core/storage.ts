import {open} from 'node:fs/promises';

// Node cannot fsync directory handles on Windows (EPERM). Callers still flush
// encrypted files before rename. Windows namespace changes have no directory
// durability barrier here; do not claim survival of abrupt power loss.
export async function syncDirectory(directory:string):Promise<void>{
 if(process.platform==='win32')return;
 const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}
}
