import type { z } from 'zod';
import type { Channel } from '../shared/api';

export interface SenderEvent { senderFrame?: { url: string; parent: unknown } | null }
export interface IpcMainLike {
  handle(channel: string, listener: (event: SenderEvent, payload: unknown) => unknown): void;
}
export interface Handler {
  schema: z.ZodType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(input: any): unknown;
}

export function registerHandlers(
  ipc: IpcMainLike,
  handlers: Record<Channel, Handler>,
  isTrusted: (event: SenderEvent) => boolean,
): void {
  for (const [channel, handler] of Object.entries(handlers) as [Channel, Handler][]) {
    ipc.handle(channel, async (event, payload) => {
      try {
        let trusted = false;
        try {
          trusted = isTrusted(event);
        } catch {
          trusted = false;
        }
        if (!trusted) return { ok: false, error: 'Untrusted sender' };
        const parsed = handler.schema.safeParse(payload === undefined ? {} : payload);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return { ok: false, error: `Invalid input for ${channel}: ${issue.path.join('.') || '(root)'} ${issue.message}` };
        }
        const value = await handler.run(parsed.data);
        try {
          structuredClone(value);
        } catch {
          return { ok: false, error: 'Result could not be sent to the window' };
        }
        return { ok: true, value };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }
}
