import type { Task } from '../agent/contracts.js';
/** Read-only projections of the shared Task; never persisted or used by the runtime. */
export type TaskSummary = Pick<Task,'id'|'requestedOutcome'|'status'>;
export type TaskView = Pick<Task,'id'|'requestedOutcome'|'status'|'checklist'|'nextAction'|'blocker'|'run'|'budget'|'generation'|'recovery'|'applicationRevision'>;
