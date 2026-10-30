// The fixture probe's existing protocol only, not the draft production contract.
export type NativeMessage = Record<string, unknown>;
export type NativeCommand = { action: string; epoch?: number; pids?: number[]; target?: string };
export interface NativeProcess {
  readonly pid: number;
  send(value: NativeCommand): void;
  stop(): void;
}
export type NativeLauncher = (root: string, fixture: boolean, onEvent: (event: NativeMessage) => void, onExit: () => void) => NativeProcess;
export interface Visit {
  id: string;
  key: string;
  title: string;
  start: number;
  end: number | null;
  samples: { at: number; text: string }[];
}
export interface Counts { rejected: number; textUpdates: number; evictedVisits: number; unavailable: number }
export interface Stage { helper: string; code: string; permission: boolean | null; fixture: string; diagnostics: Diagnostic[] }
export interface Diagnostic { line: number; column: number; code: string }
export interface BuildIdentity { fingerprint: string; sourceCommit: string; dirty: boolean }
export interface CheckState {
  recording: boolean;
  visits: Visit[];
  counts: Counts;
  stage: Stage;
  sequence: string;
  oracle: { target: string; at: number }[];
  build: string;
  sourceCommit: string;
  platform: string;
  scope: string;
  nativeNow: number;
}
export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object'; }
