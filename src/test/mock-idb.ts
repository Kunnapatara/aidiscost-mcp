/**
 * Minimal in-memory IndexedDB mock for Node.js test environment.
 * Complies with IDBFactory, IDBOpenDBRequest, IDBDatabase, IDBTransaction, IDBObjectStore API
 * used by AuditStore.
 */

type RecordMap = Map<string, any>;

class MockIDBRequest {
  result: any = undefined;
  error: any = null;
  onsuccess: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;

  _triggerSuccess(res: any) {
    this.result = res;
    setTimeout(() => {
      if (this.onsuccess) this.onsuccess({ target: this });
    }, 0);
  }

  _triggerError(err: any) {
    this.error = err;
    setTimeout(() => {
      if (this.onerror) this.onerror({ target: this });
    }, 0);
  }
}

class MockIDBOpenDBRequest extends MockIDBRequest {
  onupgradeneeded: ((e: any) => void) | null = null;
  onblocked: ((e: any) => void) | null = null;
}

class MockIDBObjectStore {
  constructor(
    public name: string,
    public keyPath: string,
    private records: RecordMap
  ) {}

  createIndex(indexName: string, keyPath: string, options?: any) {
    // no-op for mock index
  }

  put(value: any): MockIDBRequest {
    const req = new MockIDBRequest();
    setTimeout(() => {
      const key = value[this.keyPath];
      if (!key) {
        req._triggerError(new Error(`Missing keyPath: ${this.keyPath}`));
      } else {
        // deep clone to simulate IndexedDB structured clone
        this.records.set(key, JSON.parse(JSON.stringify(value)));
        req._triggerSuccess(key);
      }
    }, 0);
    return req;
  }

  get(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    setTimeout(() => {
      const val = this.records.get(key);
      req._triggerSuccess(val ? JSON.parse(JSON.stringify(val)) : undefined);
    }, 0);
    return req;
  }

  getAll(): MockIDBRequest {
    const req = new MockIDBRequest();
    setTimeout(() => {
      const vals = Array.from(this.records.values()).map(v => JSON.parse(JSON.stringify(v)));
      req._triggerSuccess(vals);
    }, 0);
    return req;
  }

  delete(key: string): MockIDBRequest {
    const req = new MockIDBRequest();
    setTimeout(() => {
      this.records.delete(key);
      req._triggerSuccess(undefined);
    }, 0);
    return req;
  }

  clear(): MockIDBRequest {
    const req = new MockIDBRequest();
    setTimeout(() => {
      this.records.clear();
      req._triggerSuccess(undefined);
    }, 0);
    return req;
  }
}

class MockIDBTransaction {
  oncomplete: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onabort: ((e: any) => void) | null = null;

  constructor(private db: MockIDBDatabase, public mode: string) {}

  objectStore(name: string): MockIDBObjectStore {
    const store = this.db._getStore(name);
    if (!store) {
      throw new Error(`NotFoundError: The specified object store was not found: ${name}`);
    }
    return store;
  }
}

class MockIDBDatabase {
  public objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  private stores = new Map<string, MockIDBObjectStore>();
  private storeRecords = new Map<string, RecordMap>();

  createObjectStore(name: string, options: { keyPath: string }) {
    let records = this.storeRecords.get(name);
    if (!records) {
      records = new Map();
      this.storeRecords.set(name, records);
    }
    const store = new MockIDBObjectStore(name, options.keyPath, records);
    this.stores.set(name, store);
    return store;
  }

  _getStore(name: string): MockIDBObjectStore | undefined {
    return this.stores.get(name);
  }

  transaction(storeName: string | string[], mode: 'readonly' | 'readwrite'): MockIDBTransaction {
    return new MockIDBTransaction(this, mode);
  }
}

export function createMockIndexedDB(): IDBFactory {
  const databases = new Map<string, MockIDBDatabase>();

  return {
    open(name: string, version?: number): MockIDBOpenDBRequest {
      const req = new MockIDBOpenDBRequest();
      setTimeout(() => {
        let db = databases.get(name);
        const isNew = !db;
        if (!db) {
          db = new MockIDBDatabase();
          databases.set(name, db);
        }

        req.result = db;
        if (isNew && req.onupgradeneeded) {
          req.onupgradeneeded({ target: req, result: db } as any);
        }
        req._triggerSuccess(db);
      }, 0);
      return req as any;
    },
    deleteDatabase(name: string): MockIDBOpenDBRequest {
      const req = new MockIDBOpenDBRequest();
      setTimeout(() => {
        databases.delete(name);
        req._triggerSuccess(undefined);
      }, 0);
      return req as any;
    },
    cmp(a: any, b: any) {
      return a < b ? -1 : a > b ? 1 : 0;
    },
    databases() {
      return Promise.resolve([]);
    },
  } as unknown as IDBFactory;
}
