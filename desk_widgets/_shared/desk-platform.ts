// THE one file in this shared library (and in any widget that depends on
// it) allowed to mention "Desk" by name. Implements `SharedPlatform` (see
// `platform.ts`, same directory) against a live Desk runtime's own
// Bridge API (`window.desk`) -- see tempui-custom-widgets.md's "The Desk
// Bridge API" for the full reference this implements against. Nothing
// in here is specific to any one widget; it's registered below as the
// global `sharedPlatform` singleton both `layer-stack.ts` and
// `layered-map.ts` (and any future widget sharing this code) actually
// call, by listing this file in their own `tsconfig.json`'s `"files"`
// array (after `platform.ts`, before the widget's own file).
//
// A deployment with no Desk runtime behind it supplies its own
// alternate implementation of `SharedPlatform` (its own file, swapped in
// for this one in the dependent widget's `tsconfig.json`) instead of
// editing this file or any widget's own code.
//
// Plain global TypeScript -- no `import`/`export`, same concatenation
// convention as every other file in this shared library (see
// `platform.ts`'s own header comment).

// Only the Bridge members this module actually calls -- see
// tempui-custom-widgets.md's "The Desk Bridge API" for the full list.
interface Window {
  desk?: {
    self: {
      getLocalStorage(): Promise<{ data: Record<string, unknown> }>;
      setLocalStorage(data: Record<string, unknown>): Promise<{ ok: boolean }>;
    };
    state: {
      get(key: string): Promise<{ value: unknown; edit: unknown }>;
      set(key: string, value: unknown, edit?: unknown): Promise<{ ok: boolean }>;
    };
    events: {
      subscribe(names: string[]): Promise<{ ok: boolean }>;
      onMessage(callback: (name: string, payload: unknown, senderInstanceId: string) => void): void;
    };
  };
}

class DeskPlatform implements SharedPlatform {
  // `desk.events.subscribe`/`onMessage` is wired up lazily, the first
  // time anything actually registers a change handler -- a widget that
  // never watches anything live never needs to touch `desk.events` at
  // all. Every subsequent `onSharedValueChanged`/`onServiceUrlChanged`
  // call just adds to these two registries; one shared `onMessage`
  // dispatcher (below) fans a single incoming `desk.state.changed` event
  // out to whichever of them actually matches.
  private watching = false;
  private valueChangeHandlers: ((key: string, value: unknown) => void)[] = [];
  private serviceUrlHandlers = new Map<string, ((url: string | null) => void)[]>();

  // Each map-data service's own base URL lives in shared state under
  // this key convention, published by Desk itself once that hmsvc is up
  // -- see tempui-hmsvc.md for the full `desk.hmsvc.<name>` shape
  // (`{status, url}`). This is the one place that convention is known;
  // everything else in this class (and every widget calling it) only
  // ever deals in plain service names.
  private serviceStateKey(serviceName: string): string {
    return `desk.hmsvc.${serviceName}`;
  }

  private extractServiceUrl(value: unknown): string | null {
    const v = value as { status: string; url: string | null } | null;
    return v && v.url ? v.url.replace(/\/+$/, '') : null;
  }

  async getServiceUrl(serviceName: string): Promise<string | null> {
    const desk = window.desk;
    if (!desk) return null;
    const { value } = await desk.state.get(this.serviceStateKey(serviceName));
    return this.extractServiceUrl(value);
  }

  onServiceUrlChanged(serviceName: string, handler: (url: string | null) => void): void {
    const key = this.serviceStateKey(serviceName);
    const handlers = this.serviceUrlHandlers.get(key) ?? [];
    handlers.push(handler);
    this.serviceUrlHandlers.set(key, handlers);
    this.ensureWatching();
  }

  async getSharedValue(key: string): Promise<unknown> {
    const desk = window.desk;
    if (!desk) return undefined;
    const { value } = await desk.state.get(key);
    return value;
  }

  async setSharedValue(key: string, value: unknown): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    await desk.state.set(key, value);
  }

  onSharedValueChanged(handler: (key: string, value: unknown) => void): void {
    this.valueChangeHandlers.push(handler);
    this.ensureWatching();
  }

  async getLocalData(): Promise<Record<string, unknown>> {
    const desk = window.desk;
    if (!desk) return {};
    const { data } = await desk.self.getLocalStorage();
    return data;
  }

  async setLocalData(data: Record<string, unknown>): Promise<void> {
    const desk = window.desk;
    if (!desk) return;
    await desk.self.setLocalStorage(data);
  }

  private ensureWatching(): void {
    if (this.watching) return;
    this.watching = true;
    const desk = window.desk;
    if (!desk) return;
    desk.events.subscribe(['desk.state.changed']).catch((err) => {
      console.warn('watching shared platform state failed to start:', err);
    });
    desk.events.onMessage((name, payload) => {
      if (name !== 'desk.state.changed') return;
      const p = payload as { key?: unknown; value?: unknown } | null;
      if (!p || typeof p.key !== 'string') return;
      const serviceHandlers = this.serviceUrlHandlers.get(p.key);
      if (serviceHandlers) {
        const url = this.extractServiceUrl(p.value);
        for (const h of serviceHandlers) h(url);
      }
      for (const h of this.valueChangeHandlers) h(p.key as string, p.value);
    });
  }
}

const sharedPlatform: SharedPlatform = new DeskPlatform();
