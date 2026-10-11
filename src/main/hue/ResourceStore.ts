import type Clip from "@shared/hueTypes";

/**
 * Local mirror of the bridge's resources, kept current from the event stream.
 *
 * Update events carry *partial* resources. Objects are merged deeply, arrays
 * are replaced whole, and an explicit `null` replaces the old value. That last
 * rule matters: aiohue kept a field's previous value when an event carried
 * null, so a released entertainment area still looked occupied.
 */
export class ResourceStore {
  private readonly _byId = new Map<string, Clip.Resource>();
  private _revision = 0;

  /**
   * Increments on every change; cheap to compare for "did anything change".
   */
  public get revision(): number {
    return this._revision;
  }

  public get size(): number {
    return this._byId.size;
  }

  /**
   * Replace everything with a full resource listing.
   */
  public reset(resources: Clip.Resource[]): void {
    this._byId.clear();
    for (const resource of resources) this._byId.set(resource.id, resource);
    this._revision++;
  }

  public clear(): void {
    if (this._byId.size === 0) return;
    this._byId.clear();
    this._revision++;
  }

  /**
   * Apply a batch from the event stream.
   * @returns Whether anything changed.
   */
  public apply(events: Clip.Event[]): boolean {
    let changed = false;
    for (const event of events) {
      for (const item of event.data ?? []) {
        if (!item?.id) continue;
        if (event.type === "add") {
          this._byId.set(item.id, item);
          changed = true;
        }
        else if (event.type === "update") {
          const existing = this._byId.get(item.id);
          // An update for something we have never seen is still worth keeping.
          this._byId.set(item.id, existing ? deepMerge(existing, item) as Clip.Resource : item);
          changed = true;
        }
        else if (event.type === "delete") {
          changed = this._byId.delete(item.id) || changed;
        }
      }
    }
    if (changed) this._revision++;
    return changed;
  }

  public get<T extends Clip.Resource = Clip.Resource>(id: string | undefined): T | undefined {
    return id ? this._byId.get(id) as T | undefined : undefined;
  }

  public all<T extends Clip.Resource = Clip.Resource>(type: string): T[] {
    const out: T[] = [];
    for (const resource of this._byId.values()) {
      if (resource.type === type) out.push(resource as T);
    }
    return out;
  }
}

/**
 * Merge `patch` into a copy of `base`: objects recurse, everything else
 * (arrays, primitives, null) replaces.
 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default ResourceStore;
