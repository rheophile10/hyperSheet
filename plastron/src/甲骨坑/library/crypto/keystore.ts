// ============================================================================
// crypto/keystore — the runtime split, behind ONE key-handle type.
//
// crypto.subtle OPERATIONS are cross-runtime (Bun + browser, identical). What
// is NOT cross-runtime is where the *live, non-extractable* private CryptoKey
// is held:
//   - browser → IndexedDB (a CryptoKey survives structuredClone into IDB; the
//     bytes are NEVER readable by JS — it can only be USED in place).
//   - Bun/CLI → a module-scope Map (an in-process keystore). Bun has no IDB; a
//     file keystore would force extractable keys (defeating the model), so the
//     CLI keystore is process-lifetime by design. Persisting Bun keys is the
//     wallet-blob path (Tier 2/3), not this hot keystore.
//
// Both backends store the SAME thing — a `KeyEntry` whose private CryptoKey is
// non-extractable — and expose the SAME `KeyStore` interface, so the operation
// verbs (sign / decrypt / unwrap) never branch on runtime. The graph only ever
// holds a `CryptoKeyHandle` (id + public material); the private key is resolved
// from the store at the effect site, mirroring SecretHandle.
// ============================================================================

// ── WebCrypto, structurally narrowed (tsconfig lib has no DOM) ──────────────
// Same narrowing approach as unsafe-wallet: we describe only what we call so
// the library stays DOM-lib-free yet runs against the real crypto.subtle.
export interface CryptoKeyLike { readonly type: string; readonly extractable: boolean; readonly usages: string[] }
export interface KeyPairLike { privateKey: CryptoKeyLike; publicKey: CryptoKeyLike }
// crypto.subtle takes a BufferSource (ArrayBuffer | typed array). We only ever
// pass Uint8Array / ArrayBuffer; widen to that so the file needs no DOM lib.
type Bytes = ArrayBuffer | Uint8Array;
export interface SubtleLike {
  generateKey(alg: unknown, extractable: boolean, usages: string[]): Promise<KeyPairLike | CryptoKeyLike>;
  exportKey(format: string, key: CryptoKeyLike): Promise<ArrayBuffer | unknown>;
  importKey(format: string, key: Bytes, alg: unknown, extractable: boolean, usages: string[]): Promise<CryptoKeyLike>;
  sign(alg: unknown, key: CryptoKeyLike, data: Bytes): Promise<ArrayBuffer>;
  verify(alg: unknown, key: CryptoKeyLike, sig: Bytes, data: Bytes): Promise<boolean>;
  encrypt(alg: unknown, key: CryptoKeyLike, data: Bytes): Promise<ArrayBuffer>;
  decrypt(alg: unknown, key: CryptoKeyLike, data: Bytes): Promise<ArrayBuffer>;
  deriveKey(alg: unknown, base: CryptoKeyLike, derived: unknown, extractable: boolean, usages: string[]): Promise<CryptoKeyLike>;
}
export interface CryptoLike { subtle: SubtleLike; getRandomValues<T extends ArrayBufferView>(a: T): T; randomUUID?: () => string }

export const cryptoHost = (): CryptoLike => {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c?.subtle) throw new Error("crypto: WebCrypto (crypto.subtle) unavailable in this host");
  return c;
};

// ── the live key entry the store holds (NEVER leaves the store as bytes) ────
// kind distinguishes a signing identity (Ed25519) from a key-agreement identity
// (ECDH P-256). publicKeyB64 is the EXTRACTABLE public half — graph-safe, the
// only part that ever becomes a cel value.
export type KeyKind = "sign" | "ecdh";
export interface KeyEntry {
  id: string;
  kind: KeyKind;
  /** non-extractable private CryptoKey — usable, never readable. */
  privateKey: CryptoKeyLike;
  /** the public CryptoKey (extractable) — kept live for derive/verify. */
  publicKey: CryptoKeyLike;
  /** base64 of the exported public key (raw for Ed25519, spki for ECDH). */
  publicKeyB64: string;
  createdAt: number;
}

// ── the storage adapter seam ────────────────────────────────────────────────
export interface KeyStore {
  readonly backend: "bun-memory" | "indexeddb";
  put(entry: KeyEntry): Promise<void>;
  get(id: string): Promise<KeyEntry | undefined>;
  has(id: string): Promise<boolean>;
  list(): Promise<KeyEntry[]>;
  delete(id: string): Promise<void>;
}

// ── Bun / CLI adapter — an in-process Map (process-lifetime) ────────────────
// The CLI keystore deliberately does NOT serialize to disk: a non-extractable
// CryptoKey cannot be written out without making it extractable, which would
// break the handle model. Cross-restart persistence is the wallet-blob path
// (Tier 2/3), not this store.
class BunMemoryKeyStore implements KeyStore {
  readonly backend = "bun-memory" as const;
  private map = new Map<string, KeyEntry>();
  async put(entry: KeyEntry): Promise<void> { this.map.set(entry.id, entry); }
  async get(id: string): Promise<KeyEntry | undefined> { return this.map.get(id); }
  async has(id: string): Promise<boolean> { return this.map.has(id); }
  async list(): Promise<KeyEntry[]> { return [...this.map.values()]; }
  async delete(id: string): Promise<void> { this.map.delete(id); }
}

// ── browser adapter — IndexedDB (a CryptoKey round-trips through IDB and the
//    private bytes stay unreadable; only USE-in-place is possible). ──────────
// Structurally narrowed: we describe just the IDB surface we touch so the file
// compiles under the DOM-free tsconfig and runs unchanged in a real browser.
interface IDBReq<T> { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null }
interface IDBStore {
  put(v: unknown): IDBReq<unknown>; get(k: string): IDBReq<unknown>;
  getAll(): IDBReq<unknown[]>; delete(k: string): IDBReq<unknown>; count(k: string): IDBReq<number>;
}
interface IDBTxn { objectStore(name: string): IDBStore }
interface IDBDatabase {
  transaction(stores: string, mode: string): IDBTxn;
  objectStoreNames: { contains(n: string): boolean };
  createObjectStore(n: string, o: unknown): unknown;
}
interface IDBOpenReq extends IDBReq<IDBDatabase> { onupgradeneeded: (() => void) | null }
interface IDBFactory { open(name: string, version: number): IDBOpenReq }

const STORE = "keys";
class IndexedDbKeyStore implements KeyStore {
  readonly backend = "indexeddb" as const;
  private dbName: string;
  private dbp: Promise<IDBDatabase> | null = null;
  constructor(dbName = "plastron-crypto") { this.dbName = dbName; }
  private idb(): IDBFactory {
    const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!f) throw new Error("crypto: IndexedDB unavailable (browser keystore needs it)");
    return f;
  }
  private db(): Promise<IDBDatabase> {
    if (this.dbp) return this.dbp;
    this.dbp = new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.idb().open(this.dbName, 1);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }
  private run<T>(mode: string, fn: (s: IDBStore) => IDBReq<T>): Promise<T> {
    return this.db().then((db) => new Promise<T>((resolve, reject) => {
      const r = fn(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  // The stored row carries the live CryptoKeys (IDB structured-clones them; the
  // non-extractable private key survives as an opaque, use-only handle).
  async put(entry: KeyEntry): Promise<void> { await this.run("readwrite", (s) => s.put(entry)); }
  async get(id: string): Promise<KeyEntry | undefined> { return (await this.run<unknown>("readonly", (s) => s.get(id))) as KeyEntry | undefined; }
  async has(id: string): Promise<boolean> { return (await this.run<number>("readonly", (s) => s.count(id))) > 0; }
  async list(): Promise<KeyEntry[]> { return (await this.run<unknown[]>("readonly", (s) => s.getAll())) as KeyEntry[]; }
  async delete(id: string): Promise<void> { await this.run("readwrite", (s) => s.delete(id)); }
}

// ── pick the adapter for this runtime (one seam, callers never branch) ──────
let store: KeyStore | null = null;
export const getKeyStore = (): KeyStore => {
  if (store) return store;
  const hasIDB = !!(globalThis as { indexedDB?: unknown }).indexedDB;
  store = hasIDB ? new IndexedDbKeyStore() : new BunMemoryKeyStore();
  return store;
};
/** test hook — swap the adapter (e.g. force the memory store). */
export const setKeyStore = (s: KeyStore): void => { store = s; };
