// Type shim for the `eventsource` npm package.
// `eventsource@2.x` is a runtime-only package without bundled types; @types/eventsource is deprecated.
// Note: the package exports the EventSource class as the **default** (function) export,
// not as a named property. Use `import EventSource from 'eventsource'`.

declare module 'eventsource' {
  export const CONNECTING: 0;
  export const OPEN: 1;
  export const CLOSED: 2;

  export interface EventSourceInit {
    withCredentials?: boolean;
    headers?: Record<string, string>;
  }

  export class EventSource {
    constructor(url: string, options?: EventSourceInit);
    addEventListener(type: string, listener: (ev: MessageEvent | any) => void): void;
    removeEventListener(type: string, listener: (ev: MessageEvent | any) => void): void;
    close(): void;
    onopen: ((ev: Event) => void) | null;
    onmessage: ((ev: MessageEvent) => void) | null;
    onerror: ((ev: Event) => void) | null;
    readonly readyState: number;
    readonly url: string;
    readonly withCredentials: boolean;
  }

  export interface MessageEvent {
    data: string | any;
    type?: string;
    lastEventId?: string;
    origin?: string;
  }

  export default EventSource;
}
