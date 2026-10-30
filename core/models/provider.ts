import { createHash } from 'node:crypto';
export type Provider = 'nebius' | 'nvidia';
export interface ModelDeclaration {
  provider: Provider; id: string; text: boolean; jsonObject: boolean;
  inputContextTokens: number; maxOutputTokens: number; jsonSchema?: boolean;
  // false disables and true requests provider-side reasoning (chat_template_kwargs.enable_thinking) for hybrid reasoning models.
  thinking?: boolean;
  // Operator-verified token-only vision accounting; no guessed per-image prices.
  images?: { inputTokensUpperBound: number; accounting: 'input-tokens' };
  pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number; verifiedAt: string; source: string };
}
export interface Usage { inputTokens: number; outputTokens: number }
export type FailureCode = 'INVALID_BUDGET' | 'BUDGET_DENIED' | 'BUDGET_ACCOUNTING_ERROR' | 'INVALID_MODEL' | 'UNSUPPORTED_CAPABILITY' | 'INVALID_MODEL_BOUNDS' | 'UNVERIFIED_PRICING' | 'MALFORMED_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'REQUEST_BOUND' | 'STALE_REQUEST' | 'REQUEST_TOO_LARGE' | 'REQUEST_CONTEXT_BOUND' | 'CREDENTIAL_UNAVAILABLE' | 'PROVIDER_UNAVAILABLE' | 'STALE_RESULT' | 'TIMEOUT_OR_CANCELLED' | 'AGENT_PROVIDER_TIMEOUT' | 'INVALID_CONSENT' | 'REMOTE_DISABLED' | 'QUERY_BOUND' | 'INVALID_SUMMARY' | 'INVALID_SUGGESTION' | 'LOCAL_STATE_UNAVAILABLE' | 'FIELDS_DENIED' | 'INVALID_TARGET' | 'INVALID_PROPOSAL';
export class ModelError extends Error { constructor(readonly code: FailureCode) { super(code); } }
const fail = (code: FailureCode): never => { throw new ModelError(code); };
const integer = (n: number, max: number) => Number.isSafeInteger(n) && n >= 0 && n <= max;

// Application-session budget, not a billing API or the autonomous task's persistent budget record.
// Failed/missing-usage calls retain their full reservation. There are no automatic retries.
export interface BudgetAccount {
  // A selected task call ceiling must be checked atomically with reservation.
  reserve(usd:number,maximumCalls?:number):number; settle(id:number,usd:number):void; stop():void;
  snapshot():{limitUsd:number;accountedUsd:number;calls:number;exhausted:boolean};
}
export class CallBudget implements BudgetAccount {
  #charged = 0;
  #reservations = new Map<number, number>();
  #next = 0;
  #exhausted = false;
  #limitUnits: number;
  #maximumCalls: number;
  constructor(limitUsd: number, maximumCalls: number) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > 1000 || !integer(maximumCalls, 100) || maximumCalls === 0) fail('INVALID_BUDGET');
    this.#limitUnits = Math.floor(limitUsd * 1e9); this.#maximumCalls = maximumCalls;
  }
  reserve(usd: number,maximumCalls=this.#maximumCalls) {
    const units = Math.ceil(usd * 1e9);
    if (!integer(maximumCalls,100) || maximumCalls<1 || this.#exhausted || !Number.isSafeInteger(units) || units < 0 || this.#next >= Math.min(this.#maximumCalls,maximumCalls) || this.#charged + units > this.#limitUnits) fail('BUDGET_DENIED');
    const id = ++this.#next; this.#charged += units; this.#reservations.set(id, units); return id;
  }
  settle(id: number, usd: number) {
    const reservation = this.#reservations.get(id);
    if (reservation === undefined) return fail('BUDGET_ACCOUNTING_ERROR');
    this.#reservations.delete(id);
    const units = Math.ceil(usd * 1e9);
    if (!Number.isSafeInteger(units) || units < 0 || units > reservation) { this.#exhausted = true; fail('BUDGET_ACCOUNTING_ERROR'); }
    this.#charged += units - reservation;
  }
  stop() { this.#exhausted = true; }
  snapshot() { return { limitUsd: this.#limitUnits / 1e9, accountedUsd: this.#charged / 1e9, calls: this.#next, exhausted: this.#exhausted }; }
}
const endpoints: Record<Provider, string> = {
  nebius: 'https://api.tokenfactory.nebius.com/v1/chat/completions',
  nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
};
export function validateModel(model: ModelDeclaration) {
  if (!['nebius', 'nvidia'].includes(model.provider) || typeof model.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(model.id)) fail('INVALID_MODEL');
  if (model.text !== true || model.jsonObject !== true || model.jsonSchema !== undefined && typeof model.jsonSchema !== 'boolean' || model.thinking !== undefined && typeof model.thinking !== 'boolean') fail('UNSUPPORTED_CAPABILITY');
  // The control is verified only on Nebius; elsewhere refuse rather than silently drop it.
  if (model.thinking !== undefined && model.provider !== 'nebius') fail('UNSUPPORTED_CAPABILITY');
  if (!integer(model.inputContextTokens, 2_000_000) || model.inputContextTokens < 1024 || !integer(model.maxOutputTokens, 16384) || model.maxOutputTokens < 64) fail('INVALID_MODEL_BOUNDS');
  if (model.images && (model.images.accounting !== 'input-tokens' || !integer(model.images.inputTokensUpperBound, model.inputContextTokens - 1024) || model.images.inputTokensUpperBound < 1)) fail('UNSUPPORTED_CAPABILITY');
  const p = model.pricing;
  if (![p.inputUsdPerMillion, p.outputUsdPerMillion].every(n => Number.isFinite(n) && n >= 0) || !Number.isFinite(Date.parse(p.verifiedAt))) fail('UNVERIFIED_PRICING');
  let url: URL;
  try { url = new URL(p.source); } catch { return fail('UNVERIFIED_PRICING'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('UNVERIFIED_PRICING');
}
/** Request fields implied by the declaration; empty unless reasoning is explicitly set. */
export function modelRequestOptions(model: ModelDeclaration): { chat_template_kwargs?: { enable_thinking: boolean } } {
  return model.thinking === undefined ? {} : { chat_template_kwargs: { enable_thinking: model.thinking } };
}
export function worstCaseUsd(model: ModelDeclaration, outputTokens: number) {
  validateModel(model);
  // Reserve the entire declared input context, not a guessed character/token ratio, plus 2x margin.
  return 2 * (model.inputContextTokens * model.pricing.inputUsdPerMillion + outputTokens * model.pricing.outputUsdPerMillion) / 1_000_000;
}
export function validateImage(image:string) {
  if (typeof image !== 'string' || image.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) fail('REQUEST_BOUND');
  const png=Buffer.from(image,'base64');
  if (png.length < 33 || png.length > 2_000_000 || png.toString('base64') !== image || png.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || png.toString('ascii',12,16) !== 'IHDR' || png.readUInt32BE(16)<1 || png.readUInt32BE(16)>8192 || png.readUInt32BE(20)<1 || png.readUInt32BE(20)>8192 || png.readUInt32BE(16)*png.readUInt32BE(20)>33_554_432) fail('REQUEST_BOUND');
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return fail('TIMEOUT_OR_CANCELLED');
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new ModelError('TIMEOUT_OR_CANCELLED'));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return fail('MALFORMED_RESPONSE');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await withAbort(reader.read(), signal); if (result.done) break;
      size += result.value.byteLength;
      if (size > 65536) { void reader.cancel().catch(() => {}); return fail('RESPONSE_TOO_LARGE'); }
      chunks.push(result.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail('MALFORMED_RESPONSE'); }
}
export interface Completion { value: unknown; usage: Usage | null; model: string; promptDigest: string; configDigest: string }
export class TextProvider {
  #model: ModelDeclaration;
  get model() { return structuredClone(this.#model); }
  constructor(model: ModelDeclaration, readonly budget: BudgetAccount, private readonly credential: () => Promise<string>, private readonly transport: typeof fetch = fetch) {
    validateModel(model); this.#model = structuredClone(model);
  }
  async complete(system: string, data: unknown, options: { current: () => boolean; signal?: AbortSignal; outputTokens?: number; timeoutMs?: number; image?: string; schema?: Record<string,unknown> }): Promise<Completion> {
    const outputTokens = options.outputTokens ?? 256, timeoutMs = options.timeoutMs ?? 10000;
    if (!integer(outputTokens, Math.min(16384, this.model.maxOutputTokens)) || outputTokens < 1 || !integer(timeoutMs, 120000) || timeoutMs < 1) return fail('REQUEST_BOUND');
    if (!options.current() || options.signal?.aborted) return fail('STALE_REQUEST');
    if(options.schema&&!this.#model.jsonSchema)return fail('UNSUPPORTED_CAPABILITY');
    const responseFormat=options.schema?{type:'json_schema',json_schema:{name:'spindle_labels',strict:true,schema:options.schema}}:{type:'json_object'};
    const text=JSON.stringify({ untrustedData: data });
    if (options.image !== undefined) {
      if (!this.#model.images) return fail('UNSUPPORTED_CAPABILITY');
      validateImage(options.image);
    }
    const content=options.image === undefined ? text : [{type:'text',text},{type:'image_url',image_url:{url:`data:image/png;base64,${options.image}`}}];
    const messages = [{ role: 'system', content: system }, { role: 'user', content }];
    const wire = modelRequestOptions(this.#model);
    const body = JSON.stringify({ model: this.model.id, messages, temperature: 0, max_tokens: outputTokens, response_format: responseFormat, stream: false, ...wire });
    // Preserve the text bound independently of the separately bounded PNG.
    const textBody=JSON.stringify({model:this.model.id,messages:[{role:'system',content:system},{role:'user',content:text}],temperature:0,max_tokens:outputTokens,response_format:responseFormat,stream:false,...wire});
    if (Buffer.byteLength(textBody) > 8192 || Buffer.byteLength(body) > 2_810_000) return fail('REQUEST_TOO_LARGE');
    const imageTokens=options.image === undefined ? 0 : this.#model.images!.inputTokensUpperBound;
    if (Buffer.byteLength(system) + Buffer.byteLength(JSON.stringify(data)) + 1024 + imageTokens > this.#model.inputContextTokens) return fail('REQUEST_CONTEXT_BOUND');
    const reservation = this.budget.reserve(worstCaseUsd(this.model, outputTokens));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const signal = options.signal ? AbortSignal.any([deadline.signal, options.signal]) : deadline.signal;
    try {
      const key = await withAbort(this.credential(), signal);
      if (!key || key.length > 8192 || /[\r\n]/.test(key)) return fail('CREDENTIAL_UNAVAILABLE');
      if (!options.current() || signal.aborted) return fail('STALE_REQUEST');
      let response!: Response;
      // Explicit overload/rate rejections (429/503/529) were not processed: retry twice with backoff in the same reservation.
      for (let attempt = 0; ; attempt++) {
        response = await withAbort(this.transport(endpoints[this.#model.provider], { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }), signal);
        if (![429, 503, 529].includes(response.status) || attempt >= 2) break;
        void response.body?.cancel().catch(() => {});
        await withAbort(new Promise(resolve => setTimeout(resolve, attempt ? 6000 : 2000)), signal);
      }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return fail('PROVIDER_UNAVAILABLE'); }
      const parsed = await boundedJson(response, signal);
      if (!options.current() || signal.aborted) return fail('STALE_RESULT');
      if (!object(parsed) || !Array.isArray(parsed.choices) || parsed.choices.length !== 1 || !object(parsed.choices[0]) || parsed.choices[0].finish_reason !== 'stop') return fail('MALFORMED_RESPONSE');
      const message = parsed.choices[0].message;
      if (!object(message) || message.role !== 'assistant' || typeof message.content !== 'string' || message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0) || message.function_call != null || message.content.length > 8192) return fail('MALFORMED_RESPONSE');
      let value: unknown;
      try { value = JSON.parse(message.content); } catch { return fail('MALFORMED_RESPONSE'); }
      let usage: Usage | null = null;
      if (object(parsed.usage) && (typeof parsed.usage.prompt_tokens !== 'number' || typeof parsed.usage.completion_tokens !== 'number' || !integer(parsed.usage.prompt_tokens, this.#model.inputContextTokens) || !integer(parsed.usage.completion_tokens, outputTokens))) {
        this.budget.stop(); return fail('BUDGET_ACCOUNTING_ERROR');
      }
      if (object(parsed.usage) && typeof parsed.usage.prompt_tokens === 'number' && typeof parsed.usage.completion_tokens === 'number' && integer(parsed.usage.prompt_tokens, this.model.inputContextTokens) && integer(parsed.usage.completion_tokens, outputTokens)) {
        usage = { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens };
        this.budget.settle(reservation, (usage.inputTokens * this.model.pricing.inputUsdPerMillion + usage.outputTokens * this.model.pricing.outputUsdPerMillion) / 1_000_000);
      }
      return { value, usage, model: this.model.id, promptDigest: createHash('sha256').update(system).digest('hex'), configDigest: createHash('sha256').update(JSON.stringify(this.model)).digest('hex') };
    } catch (error) {
      if (error instanceof ModelError) throw error;
      // Keep the underlying (local) cause for diagnostics; never provider bodies or credentials.
      const wrapped = new ModelError(signal.aborted ? 'TIMEOUT_OR_CANCELLED' : 'PROVIDER_UNAVAILABLE');
      (wrapped as ModelError & { detail?: string }).detail = String(error instanceof Error ? error.message : error).replace(/Bearer\s+\S+/g, 'Bearer …').slice(0, 160);
      throw wrapped;
    } finally { clearTimeout(timer); }
  }
}
