export interface SourceRef {
 id: string; provider: 'gmail'|'drive'|'filesystem'|'web'|'user'; accountId?: string;
 providerId?: string; providerVersion?: string; originalUrl?: string; mimeType: string;
 sha256: string; snapshotArtifactId: string; retrievedAt: string;
}
export interface ArtifactRef {
 id: string; mimeType: string; sha256: string; bytes: number; relativePath: string;
 createdAt: string; derivedFrom: string[]; operationId?: string; version: number;
}
export interface EvidenceRef { id: string; sourceId: string; sourceVersion: string; artifactId: string; spanIds?: string[] }
