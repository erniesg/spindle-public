import type {AccountClient} from '../client.js';
/** One authenticated shell owns identity, navigation and cancellation. Views use existing APIs only. */
export interface PortalContext {
 root:HTMLElement;
 client:AccountClient;
 /** Aborted on sign-out, identity change or navigation; stale replies must not paint another view. */
 signal:AbortSignal;
 onError(error:unknown):void;
}
export type PortalView=(context:PortalContext)=>(()=>void);
