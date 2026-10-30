// Optional descriptions for application bindings. These schemas grant no authority.
// The app must bind its own permitted reader/target/consent, then call the typed operations.
// TextProvider deliberately rejects model-issued tool calls rather than dispatching them.
export const applicationToolSchemas = [
  { name: 'query_permitted_summary', description: 'Read at most 20 already-permitted summary rows in the user-selected scope. No capture or arbitrary files.', parameters: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['limit'] } },
  { name: 'suggest_visit_labels', description: 'Suggest shared labels for an admitted visit under independent local-processing and remote-field consent. User choices win.', parameters: { type: 'object', additionalProperties: false, properties: { recordingId: { type: 'string', maxLength: 128 }, visitId: { type: 'string', maxLength: 128 } }, required: ['recordingId', 'visitId'] } },
  { name: 'preview_time_limit', description: 'Propose a time-limit preview against a chosen target and sufficient permitted history. Never activates a lock, payment or credit.', parameters: { type: 'object', additionalProperties: false, properties: { targetId: { type: 'string', maxLength: 128 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['targetId', 'limit'] } },
] as const;
