export type SendToWebView = (data: object) => void;
export type BridgeHandler = (
  msg: Record<string, unknown>
) => void | Promise<void>;
export type BridgeHandlerMap = Record<string, BridgeHandler>;

const handlers = new Map<string, BridgeHandler>();

export function registerHandlers(
  map: BridgeHandlerMap
): void {
  for (const [type, handler] of Object.entries(map)) {
    if (__DEV__ && handlers.has(type)) {
      console.warn(`[bridge] handler "${type}" is being overwritten`);
    }
    handlers.set(type, handler);
  }
}

export function clearHandlers(): void {
  handlers.clear();
}

export async function dispatch(
  raw: string
): Promise<void> {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.warn('[bridge] invalid JSON:', raw);
    return;
  }
  if (!msg || typeof msg !== 'object' || !('type' in msg) || typeof (msg as any).type !== 'string') {
    console.warn('[bridge] malformed message:', msg);
    return;
  }
  const typed = msg as { type: string } & Record<string, unknown>;
  const handler = handlers.get(typed.type);
  if (!handler) {
    console.warn(`[bridge] unknown message type: ${typed.type}`);
    return;
  }
  await handler(typed);
}
