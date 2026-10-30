export type NativeFailure='HOST_NOT_FOUND'|'HOST_FORBIDDEN'|'HOST_LAUNCH_FAILED'|'HOST_EXITED'|'HOST_PROTOCOL_ERROR'|'HOST_DISCONNECTED';
const codes:NativeFailure[]=['HOST_NOT_FOUND','HOST_FORBIDDEN','HOST_LAUNCH_FAILED','HOST_EXITED','HOST_PROTOCOL_ERROR','HOST_DISCONNECTED'];

const known:[string,NativeFailure][]=[
 ['Specified native messaging host not found.','HOST_NOT_FOUND'],
 ['Access to the specified native messaging host is forbidden.','HOST_FORBIDDEN'],
 ['Failed to start native messaging host.','HOST_LAUNCH_FAILED'],
 ['Native host has exited.','HOST_EXITED'],
 ['Error when communicating with the native messaging host.','HOST_PROTOCOL_ERROR'],
];

export function nativeFailure(message:unknown):NativeFailure{
 if(typeof message==='string')for(const [text,code] of known)if(message.includes(text))return code;
 return 'HOST_DISCONNECTED';
}

export function isNativeFailure(value:unknown):value is NativeFailure{return typeof value==='string'&&codes.includes(value as NativeFailure);}
