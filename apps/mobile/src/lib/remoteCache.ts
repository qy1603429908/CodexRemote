import type { RemoteMessage, RemoteThread } from '../types/protocol';

export interface CachedHistoryState {
  nextCursor: string | null;
  backwardsCursor: string | null;
  hasMore: boolean;
  loaded: boolean;
}

export interface RemoteCacheSnapshot {
  schema: 4;
  savedAt: number;
  serverId?: string;
  syncVersion?: string;
  syncCursor: number;
  threadIndexVersion: number;
  selectedThreadId: string | null;
  threads: RemoteThread[];
  messagesByThread: Record<string, RemoteMessage[]>;
  historyByThread: Record<string, CachedHistoryState>;
}

const DB_NAME = 'codex-mobile-remote-cache';
const STORE_NAME = 'snapshots';
const FALLBACK_PREFIX = 'codex-mobile.remote-cache.v4.';
const FALLBACK_ROOT_PREFIX = 'codex-mobile.remote-cache.';
const MAX_THREADS_WITH_MESSAGES = 24;
const MAX_MESSAGES_PER_THREAD = 500;

export function cacheScope(serverUrl: string, token: string): string {
  const input = `${serverUrl.trim().replace(/\/+$/, '').toLowerCase()}\n${token}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function messagesForThread(threadId: string, messages: RemoteMessage[]): RemoteMessage[] {
  return messages.filter((message) => message.threadId === threadId);
}

export function sanitizeMessagesByThread(messagesByThread: Record<string, RemoteMessage[]>): Record<string, RemoteMessage[]> {
  return Object.fromEntries(
    Object.entries(messagesByThread).map(([threadId, messages]) => [threadId, messagesForThread(threadId, messages)]),
  );
}

export function sanitizeRemoteCache(snapshot: RemoteCacheSnapshot): RemoteCacheSnapshot {
  return { ...snapshot, messagesByThread: sanitizeMessagesByThread(snapshot.messagesByThread) };
}

export function compactCache(snapshot: RemoteCacheSnapshot): RemoteCacheSnapshot {
  const sanitized = sanitizeRemoteCache(snapshot);
  const newestThreadIds = sanitized.threads
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_THREADS_WITH_MESSAGES)
    .map((thread) => thread.id);
  if (sanitized.selectedThreadId && !newestThreadIds.includes(sanitized.selectedThreadId)) {
    newestThreadIds.unshift(sanitized.selectedThreadId);
  }
  const allowed = new Set(newestThreadIds);
  const messagesByThread: Record<string, RemoteMessage[]> = {};
  for (const [threadId, messages] of Object.entries(sanitized.messagesByThread)) {
    if (!allowed.has(threadId)) continue;
    messagesByThread[threadId] = messages
      .slice(-MAX_MESSAGES_PER_THREAD)
      .map(({ detail: _detail, ...message }) => message);
  }
  const historyByThread = Object.fromEntries(
    Object.entries(sanitized.historyByThread).filter(([threadId]) => allowed.has(threadId)),
  );
  return { ...sanitized, messagesByThread, historyByThread };
}

export async function loadRemoteCache(scope: string): Promise<RemoteCacheSnapshot | null> {
  try {
    const database = await openDatabase();
    if (database) {
      const value = await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(scope);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return validSnapshot(value) ? sanitizeRemoteCache(value) : null;
    }
  } catch {
    // Fall back to localStorage below.
  }
  try {
    const raw = globalThis.localStorage?.getItem(`${FALLBACK_PREFIX}${scope}`);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return validSnapshot(value) ? sanitizeRemoteCache(value) : null;
  } catch {
    return null;
  }
}

export async function clearRemoteCache(scope?: string): Promise<void> {
  const failures: string[] = [];
  try {
    const database = await openDatabase();
    if (database) {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        if (scope) store.delete(scope);
        else store.clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'IndexedDB cache cleanup failed');
  }
  try {
    const storage = globalThis.localStorage;
    if (storage) {
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(FALLBACK_ROOT_PREFIX)) continue;
        if (!scope || key.endsWith(`.${scope}`)) keys.push(key);
      }
      keys.forEach((key) => storage.removeItem(key));
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'localStorage cache cleanup failed');
  }
  if (failures.length > 0) {
    throw new Error(`无法完全清除本地缓存：${failures.join('；')}`);
  }
}

export async function saveRemoteCache(scope: string, snapshot: RemoteCacheSnapshot): Promise<void> {
  const compacted = compactCache(snapshot);
  try {
    const database = await openDatabase();
    if (database) {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(compacted, scope);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      return;
    }
  } catch {
    // Fall back to localStorage below.
  }
  try {
    globalThis.localStorage?.setItem(`${FALLBACK_PREFIX}${scope}`, JSON.stringify(compacted));
  } catch {
    // A cache failure must never block the live connection.
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function validSnapshot(value: unknown): value is RemoteCacheSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<RemoteCacheSnapshot>;
  return snapshot.schema === 4
    && typeof snapshot.savedAt === 'number'
    && typeof snapshot.syncCursor === 'number'
    && typeof snapshot.threadIndexVersion === 'number'
    && Array.isArray(snapshot.threads)
    && Boolean(snapshot.messagesByThread && typeof snapshot.messagesByThread === 'object')
    && Boolean(snapshot.historyByThread && typeof snapshot.historyByThread === 'object');
}
