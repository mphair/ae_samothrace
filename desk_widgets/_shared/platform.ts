// Platform abstraction `layer-stack.ts` and `layered-map.ts` (and any
// future widget sharing this code) depend on. Declares ONLY the
// capability surface widget code is allowed to call -- no runtime logic,
// and no reference to any specific host environment by name. See
// `desk-platform.ts` (same directory) for the one implementation of this
// interface backed by a live Desk runtime; a deployment with no Desk
// runtime behind it (e.g. a static webpage) supplies its own alternate
// implementation of this exact interface instead, with no change needed
// here or in any widget's own code. That alternate implementation is the
// ONLY other file allowed to name a specific host environment the way
// `desk-platform.ts` does -- this file and every widget that calls into
// it stay host-agnostic on purpose.
//
// Plain global TypeScript -- no `import`/`export` anywhere in this file,
// on purpose. Every file a widget's own `tsconfig.json` lists under
// `"files"` compiles and concatenates into one script (same convention
// `desk_widgets/samothrace-map`'s own multi-file `tsconfig.json` already
// uses) -- an interface-only file like this one compiles to an
// effectively empty `.js`, contributing nothing to that concatenated
// output beyond making the type available to every other file in the
// same build.

/**
 * The tile-serving hmsvcs a raster layer's own tile IMAGES can come
 * from (today's two; extend as more are added). Deliberately a closed
 * union, not a plain `string`, so widget code can only ever name one
 * of these, never hold or construct a URL itself -- see
 * `resolveTileUrl`'s own comment below.
 */
type TileServiceName = 'samothrace-tiles' | 'samothrace-tiles-static';

/**
 * The capability surface a widget needs from its host environment: a
 * shared, cross-instance key/value store with change notifications; a
 * way to resolve a named map-data service's current base URL; a way to
 * resolve one raster tile's actual image URL without the widget ever
 * knowing a URL-template/versioning convention of its own; and
 * per-instance persisted storage that survives a reload.
 */
interface SharedPlatform {
  /**
   * Current base URL (no trailing slash) of the named map-data service,
   * or `null` if it isn't up / known yet. For non-image data only
   * (`/layers` catalogs, GeoJSON) -- a raster layer's own tile
   * *images* must go through `resolveTileUrl` below instead, never
   * build a `/tiles/...` URL from this directly.
   */
  getServiceUrl(serviceName: string): Promise<string | null>;

  /**
   * Resolves one raster tile's actual image URL -- going through the
   * named tile service's own version/override manifest, so a
   * published tile's bytes can be corrected or re-baked (a new
   * version, or a one-off per-tile override) without ever changing
   * what an already-cached tile URL points to. Widget code provides
   * only a service name, a layer id, and zoom/tx/ty -- never a URL,
   * never a URL-template or versioning convention of its own; those
   * live entirely behind this one call.
   */
  resolveTileUrl(service: TileServiceName, layerId: string, zoom: number, tx: number, ty: number): Promise<string>;

  /**
   * Registers a handler that fires whenever the named service's own base
   * URL changes (e.g. it restarted and published a new one). Call
   * `getServiceUrl` again from inside the handler to get the new value.
   */
  onServiceUrlChanged(serviceName: string, handler: (url: string | null) => void): void;

  /** Reads one shared, durable, cross-instance key's current value. */
  getSharedValue(key: string): Promise<unknown>;

  /** Writes one shared, durable, cross-instance key's value. */
  setSharedValue(key: string, value: unknown): Promise<void>;

  /**
   * Registers a handler that fires whenever ANY shared key's value
   * changes (including this instance's own writes, same as every other
   * instance watching it) -- the handler is responsible for filtering by
   * the key(s) it actually cares about.
   */
  onSharedValueChanged(handler: (key: string, value: unknown) => void): void;

  /**
   * This widget INSTANCE's own persisted data (survives a reload of just
   * this instance). `{}` for a brand-new instance with nothing saved yet.
   */
  getLocalData(): Promise<Record<string, unknown>>;

  /** Persists this widget instance's own data (survives a reload). */
  setLocalData(data: Record<string, unknown>): Promise<void>;
}
