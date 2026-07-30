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

describe('Adversarial & Stress Tests for Document Storage Layer', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
  });

  // ==========================================
  // SECTION 1: CONCURRENCY & RACE CONDITIONS
  // ==========================================

  it('CONC-1: Concurrent updates to different fields of the same document do not result in lost updates', async () => {
    const doc = await createDocument('Original Title', 'Original Content');

    // Run two updates concurrently: one changes the title, the other changes the content.
    // Under serialized atomic execution, no updates are lost.
    await Promise.all([
      updateDocument(doc.id, { title: 'Updated Title' }),
      updateDocument(doc.id, { content: 'Updated Content' })
    ]);

    const fetched = await getDocument(doc.id);
    expect(fetched).not.toBeNull();

    // Because operations are serialized and run atomically, no updates are lost.
    expect(fetched!.title).toBe('Updated Title');
    expect(fetched!.content).toBe('Updated Content');
  });

  it('CONC-2: Concurrent update and delete does not lead to orphaned metadata index entry', async () => {
    const doc = await createDocument('Original Title', 'Original Content');

    // We run update and delete concurrently.
    // Under serialized atomic execution, if delete runs first, update will throw an error because the document is not found.
    // We catch any error to ensure the test does not crash, and then verify the final state is consistent.
    await Promise.all([
      updateDocument(doc.id, { title: 'New Title' }).catch(() => {}),
      deleteDocumentPermanently(doc.id)
    ]);

    const fetched = await getDocument(doc.id);
    const list = await listDocuments('all');
    const inMetadata = list.some(d => d.id === doc.id);

    const isCorrupted = (fetched === null && inMetadata) || (fetched !== null && !inMetadata);

    // Because operations are serialized, there is no corruption or inconsistency.
    expect(isCorrupted).toBe(false);
  });

  it('CONC-3: Concurrent createDocument calls are queued correctly for metadata but write content immediately', async () => {
    // Run multiple creations concurrently.
    const promises = Array.from({ length: 10 }, (_, i) =>
      createDocument(`Doc ${i}`, `Content ${i}`)
    );
    const createdDocs = await Promise.all(promises);

    const list = await listDocuments('all');
    expect(list).toHaveLength(10);

    for (const doc of createdDocs) {
      const fetched = await getDocument(doc.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe(doc.title);
    }
  });

  // ==========================================
  // SECTION 2: LARGE DATA & STRESS TESTS
  // ==========================================

  it('STRESS-1: Handles writing and reading extremely large document content', async () => {
    const largeContent = 'a'.repeat(5 * 1024 * 1024); // 5 MB of text
    const title = 'Large Document';

    const doc = await createDocument(title, largeContent);
    expect(doc.content.length).toBe(5 * 1024 * 1024);

    const fetched = await getDocument(doc.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe(largeContent);

    const list = await listDocuments('all');
    const meta = list.find(d => d.id === doc.id);
    expect(meta).toBeDefined();
    expect(meta!.snippet.length).toBe(120); // capped snippet
  });

  it('STRESS-2: Snippet generation collapses massive whitespace correctly and stays within boundaries', async () => {
    const contentWithMassiveWhitespace = 'Start' + ' '.repeat(10000) + 'End';
    const doc = await createDocument('Whitespace Doc', contentWithMassiveWhitespace);

    expect(doc.title).toBe('Whitespace Doc');

    const list = await listDocuments('all');
    expect(list[0]!.snippet).toBe('Start End');
  });

  it('STRESS-3: Creating many documents sequentially works without memory leak or queue block', async () => {
    const count = 100;
    for (let i = 0; i < count; i++) {
      await createDocument(`Doc ${i}`, `Content ${i}`);
    }
    const list = await listDocuments('all');
    expect(list).toHaveLength(count);
  });

  // ==========================================
  // SECTION 3: EDGE CASE INPUTS & VALIDATION
  // ==========================================

  it('EDGE-1: Handles special characters, HTML/script tags, emojis, and Zalgo text safely', async () => {
    const specialTitle = '📁 <script>alert("XSS")</script> \u0000 Zalgo: H̶e̶l̶l̶o̶ ̶W̶o̶r̶l̶d̶ 🇮🇹';
    const specialContent = '<div>HTML Content</div>\n\r\t\0\x1b[31mTerminalColors\x1b[0m';

    const doc = await createDocument(specialTitle, specialContent);
    expect(doc.title).toBe(specialTitle); // Title is preserved exactly
    expect(doc.content).toBe(specialContent); // Content is preserved exactly

    const fetched = await getDocument(doc.id);
    expect(fetched).toEqual(doc);
  });

  it('EDGE-2: Single corrupted metadata record in array does not invalidate the entire document list', async () => {
    // Create one valid document first
    const doc = await createDocument('Valid Doc', 'Valid Content');

    // Manually corrupt the metadata in storage by writing an invalid record (e.g. numeric ID, missing fields)
    mockStorage[METADATA_KEY] = [
      {
        id: doc.id,
        title: 'Valid Doc',
        snippet: 'Valid Content',
        updatedAt: doc.updatedAt,
        createdAt: doc.createdAt,
        inTrash: false
      },
      {
        id: 12345, // invalid UUID/type
        title: 'Corrupted Doc',
        snippet: 'Corrupt',
        updatedAt: 'not-a-timestamp', // invalid type
        createdAt: Date.now(),
        inTrash: 'not-a-boolean' // invalid type
      }
    ];

    // With individual parsing, we filter out the corrupted item and retain valid documents
    const list = await listDocuments('all');
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe('Valid Doc');
  });

  // ==========================================
  // SECTION 4: STORAGE FAILURES & ERRS
  // ==========================================

  it('FAIL-1: Bubbles up storage quota exceeded error from set call', async () => {
    const originalSet = chrome.storage.local.set;
    chrome.storage.local.set = vi.fn().mockRejectedValue(new Error('QUOTA_BYTES_EXCEEDED'));

    await expect(createDocument('Title', 'Content')).rejects.toThrow('QUOTA_BYTES_EXCEEDED');

    // Restore mock
    chrome.storage.local.set = originalSet;
  });
});
