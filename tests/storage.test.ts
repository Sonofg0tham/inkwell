import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  getDocument,
  updateDocument,
  listDocuments,
  deleteDocumentPermanently,
  moveDocumentToTrash,
  restoreDocumentFromTrash,
  emptyTrash,
  METADATA_KEY,
  CONTENT_KEY_PREFIX
} from '../lib/storage/documents';

// Setup mock storage state
let mockStorage: Record<string, any> = {};

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (keys: string | string[] | Record<string, any> | null) => {
        if (keys === null) return { ...mockStorage };
        if (typeof keys === 'string') {
          return { [keys]: mockStorage[keys] };
        }
        if (Array.isArray(keys)) {
          const res: Record<string, any> = {};
          for (const k of keys) {
            res[k] = mockStorage[k];
          }
          return res;
        }
        const res: Record<string, any> = {};
        for (const k of Object.keys(keys)) {
          res[k] = mockStorage[k] !== undefined ? mockStorage[k] : keys[k];
        }
        return res;
      }),
      set: vi.fn(async (items: Record<string, any>) => {
        Object.assign(mockStorage, items);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        const toRemove = Array.isArray(keys) ? keys : [keys];
        for (const k of toRemove) {
          delete mockStorage[k];
        }
      }),
      clear: vi.fn(async () => {
        mockStorage = {};
      }),
    },
  },
});

describe('Document Storage Layer', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
  });

  it('creates and fetches a document', async () => {
    const doc = await createDocument('My First Note', 'Hello, world!');
    expect(doc.id).toBeDefined();
    expect(doc.title).toBe('My First Note');
    expect(doc.content).toBe('Hello, world!');
    expect(doc.inTrash).toBe(false);

    const fetched = await getDocument(doc.id);
    expect(fetched).toEqual(doc);
  });

  it('returns null for a non-existent document', async () => {
    const fetched = await getDocument('non-existent-uuid');
    expect(fetched).toBeNull();
  });

  it('lists active documents separately from trash', async () => {
    const doc1 = await createDocument('Doc 1', 'Content 1');
    const doc2 = await createDocument('Doc 2', 'Content 2');

    let active = await listDocuments('active');
    expect(active).toHaveLength(2);

    await moveDocumentToTrash(doc2.id);

    active = await listDocuments('active');
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(doc1.id);

    const trash = await listDocuments('trash');
    expect(trash).toHaveLength(1);
    expect(trash[0]!.id).toBe(doc2.id);
  });

  it('updates title, content and maintains snippet', async () => {
    const doc = await createDocument('Old Title', 'Old Content that goes on and on.');
    const updated = await updateDocument(doc.id, {
      title: 'New Title',
      content: 'New content is short.'
    });

    expect(updated.title).toBe('New Title');
    expect(updated.content).toBe('New content is short.');

    // Check snippet is updated
    const metadata = (await listDocuments('all'))[0]!;
    expect(metadata.title).toBe('New Title');
    expect(metadata.snippet).toBe('New content is short.');
  });

  it('permanently deletes a document', async () => {
    const doc = await createDocument('Doc', 'Content');
    await deleteDocumentPermanently(doc.id);

    const fetched = await getDocument(doc.id);
    expect(fetched).toBeNull();

    const active = await listDocuments('all');
    expect(active).toHaveLength(0);
  });

  it('empties trash, removing documents permanently', async () => {
    const doc1 = await createDocument('Doc 1', 'Content 1');
    const doc2 = await createDocument('Doc 2', 'Content 2');

    await moveDocumentToTrash(doc2.id);
    await emptyTrash();

    const fetched1 = await getDocument(doc1.id);
    const fetched2 = await getDocument(doc2.id);

    expect(fetched1).not.toBeNull();
    expect(fetched2).toBeNull(); // permanently gone

    const all = await listDocuments('all');
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(doc1.id);
  });

  it('handles corrupted metadata index gracefully', async () => {
    mockStorage[METADATA_KEY] = { corrupted: 'data' };
    const docs = await listDocuments('all');
    expect(docs).toEqual([]);
  });

  it('handles corrupted document content gracefully', async () => {
    const doc = await createDocument('Valid Doc', 'Valid content');
    // Corrupt the title to a number, which violates the Zod schema
    mockStorage[`${CONTENT_KEY_PREFIX}${doc.id}`] = {
      id: doc.id,
      title: 12345, // invalid type
      content: 'Hello',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      inTrash: false
    };
    const fetched = await getDocument(doc.id);
    expect(fetched).toBeNull();
  });

  it('falls back to "Untitled Document" when title is empty or whitespaces only', async () => {
    const doc1 = await createDocument('', 'content');
    const doc2 = await createDocument('   ', 'content');
    expect(doc1.title).toBe('Untitled Document');
    expect(doc2.title).toBe('Untitled Document');
  });

  it('restores document from trash', async () => {
    const doc = await createDocument('Doc', 'Content');
    await moveDocumentToTrash(doc.id);
    let active = await listDocuments('active');
    expect(active).toHaveLength(0);

    await restoreDocumentFromTrash(doc.id);
    active = await listDocuments('active');
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(doc.id);
  });
});
