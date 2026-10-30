import type { Task } from '../agent/contracts.js';
export type TaskNamespace = Pick<Task['sourceEvent'],'workspaceId'|'accountId'>;
export interface PreparationNotice { id:number; taskId:string; kind:Task['status']; revision?:number; deepLink:string }
export const preparationCopy: Record<Task['status'],string> = {
 working:'Preparation is in progress.', ready:'Preparation needs review.', blocked:'Preparation needs your attention.', cancelled:'Preparation was cancelled.'
};
