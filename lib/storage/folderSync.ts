// Writes documents to a real folder on disk, chosen by the user.
//
// Why this instead of a Google Drive API integration: Drive requires the
// developer's own OAuth client from a Google Cloud project, a published
// extension ID, and sends every document through Google's servers. Pointing
// Inkwell at the user's existing Drive (or OneDrive, or Dropbox) folder gives
// the same result — files synced to the cloud — with no account, no token, and
// no third party in the middle. Documents stay plain .md files the user owns.

const DB_NAME = 'inkwell-fs';
const STORE = 'handles';
const HANDLE_KEY = 'sync-folder';

export function isFolderSyncSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Prompts for a folder. Must be called from a user gesture. */
export async function chooseSyncFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFolderSyncSupported()) return null;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await idbSet(HANDLE_KEY, handle);
    return handle;
  } catch {
    return null; // user cancelled
  }
}

/**
 * The previously chosen folder, or null. `prompt` may only be true inside a
 * user gesture — Chrome drops the permission grant between sessions and
 * re-asking without a gesture throws.
 */
export async function getSyncFolder(prompt = false): Promise<FileSystemDirectoryHandle | null> {
  const handle = await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY).catch(() => null);
  if (!handle) return null;
  try {
    const opts = { mode: 'readwrite' as const };
    let state = await handle.queryPermission(opts);
    if (state === 'prompt' && prompt) state = await handle.requestPermission(opts);
    return state === 'granted' ? handle : null;
  } catch {
    return null;
  }
}

export async function forgetSyncFolder(): Promise<void> {
  await idbDelete(HANDLE_KEY).catch(() => {});
}

export function syncFilename(title: string, id: string): string {
  const base = title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  // The id suffix keeps two same-titled documents from overwriting each other.
  return `${base || 'Untitled'} (${id.slice(0, 8)}).md`;
}

export interface SyncableDoc {
  id: string;
  title: string;
  content: string;
}

export interface SyncResult {
  written: number;
  failed: number;
}

/** Writes every document to the folder as Markdown. Overwrites by filename. */
export async function syncDocumentsToFolder(
  handle: FileSystemDirectoryHandle,
  docs: SyncableDoc[],
  onProgress?: (done: number, total: number) => void,
): Promise<SyncResult> {
  let written = 0;
  let failed = 0;
  for (const [index, doc] of docs.entries()) {
    try {
      const fileHandle = await handle.getFileHandle(syncFilename(doc.title, doc.id), { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(`# ${doc.title}\n\n${doc.content}\n`);
      await writable.close();
      written++;
    } catch {
      failed++;
    }
    onProgress?.(index + 1, docs.length);
  }
  return { written, failed };
}
