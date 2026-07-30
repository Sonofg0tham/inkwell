import { z } from 'zod';

// Constant storage keys
export const METADATA_KEY = 'inkwell_documents_metadata';
export const CONTENT_KEY_PREFIX = 'doc_content_';

// Zod validation schemas
export const documentMetadataSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  snippet: z.string(),
  updatedAt: z.number(),
  createdAt: z.number(),
  inTrash: z.boolean(),
});

export const documentDataSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  content: z.string(),
  updatedAt: z.number(),
  createdAt: z.number(),
  inTrash: z.boolean(),
});

export const documentMetadataListSchema = z.array(documentMetadataSchema);

/** How much room the documents are taking, for the settings screen. */
export async function getStorageUsage(): Promise<{ bytes: number; quota: number | null }> {
  try {
    const bytes = await chrome.storage.local.getBytesInUse(null);
    // With unlimitedStorage the reported QUOTA_BYTES no longer binds, so it is
    // shown as informational rather than as a limit.
    const quota = (chrome.storage.local as { QUOTA_BYTES?: number }).QUOTA_BYTES ?? null;
    return { bytes, quota };
  } catch {
    return { bytes: 0, quota: null };
  }
}

// TypeScript Types
export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;
export type DocumentData = z.infer<typeof documentDataSchema>;

/**
 * Generate a clean text preview snippet from document content.
 * Collapses whitespace, removes line breaks, and caps length at 120 chars.
 */
export function generateSnippet(content: string): string {
  const clean = content
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= 120) return clean;
  return clean.slice(0, 117) + '...';
}

/**
 * List document metadata, sorted by `updatedAt` descending.
 * Prevents UI crashes by catching and filtering out corrupted records.
 */
export async function listDocuments(filter: 'active' | 'trash' | 'all' = 'active'): Promise<DocumentMetadata[]> {
  const data = await chrome.storage.local.get(METADATA_KEY);
  const raw = data[METADATA_KEY];
  const list: DocumentMetadata[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = documentMetadataSchema.safeParse(item);
      if (parsed.success) {
        list.push(parsed.data);
      }
    }
  }

  // Sort descending by last modified time
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);

  if (filter === 'active') {
    return sorted.filter(doc => !doc.inTrash);
  }
  if (filter === 'trash') {
    return sorted.filter(doc => doc.inTrash);
  }
  return sorted;
}

/**
 * Fetch a single document's full data (including content) by ID.
 * Returns null if the document does not exist or fails validation.
 */
export async function getDocument(id: string): Promise<DocumentData | null> {
  const key = `${CONTENT_KEY_PREFIX}${id}`;
  const data = await chrome.storage.local.get(key);
  const raw = data[key];
  if (!raw) return null;

  const parsed = documentDataSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Helper sequence for atomic metadata index writes to prevent race conditions.
 */
let metadataWriteQueue: Promise<any> = Promise.resolve();

async function enqueueMetadataUpdate<T>(updateFn: () => Promise<T>): Promise<T> {
  const nextPromise = metadataWriteQueue.then(updateFn);
  metadataWriteQueue = nextPromise.catch((err) => {
    console.error('Error during queued metadata update:', err);
  });
  return nextPromise;
}

/**
 * Create a new document with an optional title and content.
 * Generates UUID, timestamps, saves content key, and inserts metadata index record.
 */
export async function createDocument(title: string, content: string): Promise<DocumentData> {
  return enqueueMetadataUpdate(async () => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const cleanTitle = title.trim() || 'Untitled Document';
    const snippet = generateSnippet(content);

    const docData: DocumentData = {
      id,
      title: cleanTitle,
      content,
      createdAt: now,
      updatedAt: now,
      inTrash: false,
    };

    const metadata: DocumentMetadata = {
      id,
      title: cleanTitle,
      snippet,
      createdAt: now,
      updatedAt: now,
      inTrash: false,
    };

    // 1. Write document content
    await chrome.storage.local.set({ [`${CONTENT_KEY_PREFIX}${id}`]: docData });

    // 2. Safely update metadata list
    const index = await listDocuments('all');
    index.push(metadata);
    await chrome.storage.local.set({ [METADATA_KEY]: index });

    return docData;
  });
}

/**
 * Update an existing document's title, content, and/or trash state.
 * Throws an error if the document is not found.
 */
export async function updateDocument(
  id: string,
  updates: Partial<Pick<DocumentData, 'title' | 'content' | 'inTrash'>>
): Promise<DocumentData> {
  return enqueueMetadataUpdate(async () => {
    const current = await getDocument(id);
    if (!current) {
      throw new Error(`Document with ID ${id} not found.`);
    }

    const now = Date.now();
    const updatedTitle = updates.title !== undefined ? (updates.title.trim() || 'Untitled Document') : current.title;
    const updatedContent = updates.content !== undefined ? updates.content : current.content;
    const updatedInTrash = updates.inTrash !== undefined ? updates.inTrash : current.inTrash;
    const updatedSnippet = generateSnippet(updatedContent);

    const updatedDocData: DocumentData = {
      ...current,
      title: updatedTitle,
      content: updatedContent,
      inTrash: updatedInTrash,
      updatedAt: now,
    };

    // 1. Save document content
    await chrome.storage.local.set({ [`${CONTENT_KEY_PREFIX}${id}`]: updatedDocData });

    // 2. Safely update metadata record
    const index = await listDocuments('all');
    const metaIndex = index.findIndex(doc => doc.id === id);

    const updatedMetadata: DocumentMetadata = {
      id,
      title: updatedTitle,
      snippet: updatedSnippet,
      createdAt: current.createdAt,
      updatedAt: now,
      inTrash: updatedInTrash,
    };

    if (metaIndex !== -1) {
      index[metaIndex] = updatedMetadata;
    } else {
      index.push(updatedMetadata);
    }
    await chrome.storage.local.set({ [METADATA_KEY]: index });

    return updatedDocData;
  });
}

/**
 * Move document to trash.
 */
export async function moveDocumentToTrash(id: string): Promise<DocumentData> {
  return updateDocument(id, { inTrash: true });
}

/**
 * Restore document from trash.
 */
export async function restoreDocumentFromTrash(id: string): Promise<DocumentData> {
  return updateDocument(id, { inTrash: false });
}

/**
 * Permanently delete a document's content key and metadata.
 */
export async function deleteDocumentPermanently(id: string): Promise<void> {
  return enqueueMetadataUpdate(async () => {
    // 1. Safely remove from metadata
    const index = await listDocuments('all');
    const filteredIndex = index.filter(doc => doc.id !== id);
    await chrome.storage.local.set({ [METADATA_KEY]: filteredIndex });

    // 2. Remove document content key
    await chrome.storage.local.remove(`${CONTENT_KEY_PREFIX}${id}`);
  });
}

/**
 * Permanently delete all documents marked as inTrash.
 */
export async function emptyTrash(): Promise<void> {
  return enqueueMetadataUpdate(async () => {
    const index = await listDocuments('all');
    const trashDocs = index.filter(doc => doc.inTrash);
    const trashIds = trashDocs.map(doc => doc.id);

    if (trashIds.length === 0) return;

    const activeDocs = index.filter(doc => !doc.inTrash);
    await chrome.storage.local.set({ [METADATA_KEY]: activeDocs });

    const keysToRemove = trashIds.map(id => `${CONTENT_KEY_PREFIX}${id}`);
    await chrome.storage.local.remove(keysToRemove);
  });
}

/**
 * Compatibility wrappers for existing dashboard endpoints.
 */
export async function moveToTrash(id: string): Promise<DocumentData> {
  return moveDocumentToTrash(id);
}

export async function restoreFromTrash(id: string): Promise<DocumentData> {
  return restoreDocumentFromTrash(id);
}

export async function getDocumentsMetadata(): Promise<DocumentMetadata[]> {
  return listDocuments('all');
}

export async function deleteDocument(id: string): Promise<void> {
  return deleteDocumentPermanently(id);
}
