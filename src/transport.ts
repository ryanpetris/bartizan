import type { API, Event } from './shared';

export type Request = { id: number; method: string; args: unknown[] };
export type Response = { id: number; result?: unknown; error?: string };
export type Message = Response | { event: Event };
export interface Transport {
  request(request: Request): Promise<Response>;
  onEvent(callback: (event: Event) => void): () => void;
}
/** Both transports validate the envelope here; each operation validates its arguments in the backend. */
export async function dispatch(input: unknown, invoke: (method: string, args: unknown[]) => unknown): Promise<Response> {
  const request = input as Request | null;
  if (!request || !Number.isSafeInteger(request.id) || typeof request.method !== 'string' || request.method.length > 64 || !Array.isArray(request.args) || request.args.length > 8) throw new Error('Invalid request');
  try { return { id: request.id, result: await invoke(request.method, request.args) }; }
  catch (error) { return { id: request.id, error: error instanceof Error ? error.message : String(error) }; }
}
