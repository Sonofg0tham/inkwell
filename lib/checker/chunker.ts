import { fnvHash } from './hash';

export interface Chunk {
  text: string;
  /** Offset of this chunk's first character in the whole document text. */
  docOffset: number;
  hash: string;
}

const MAX_CHUNK_CHARS = 1200;
const MIN_CHUNK_CHARS = 12;
const HAS_LETTER = /\p{L}/u;

/** Regroups sentences greedily into pieces of at most MAX_CHUNK_CHARS. */
function splitLongParagraph(text: string, docOffset: number, dialect: string): Chunk[] {
  let sentences: Array<{ segment: string; index: number }>;
  try {
    const segmenter = new Intl.Segmenter(dialect, { granularity: 'sentence' });
    sentences = Array.from(segmenter.segment(text), (s) => ({ segment: s.segment, index: s.index }));
  } catch {
    sentences = [{ segment: text, index: 0 }];
  }

  const chunks: Chunk[] = [];
  let pieceStart = 0;
  let pieceEnd = 0;
  const flush = () => {
    if (pieceEnd > pieceStart) {
      const piece = text.slice(pieceStart, pieceEnd);
      chunks.push({ text: piece, docOffset: docOffset + pieceStart, hash: fnvHash(piece) });
    }
  };
  for (const s of sentences) {
    const sentenceEnd = s.index + s.segment.length;
    if (sentenceEnd - pieceStart > MAX_CHUNK_CHARS && pieceEnd > pieceStart) {
      flush();
      pieceStart = s.index;
    }
    pieceEnd = sentenceEnd;
  }
  flush();
  return chunks;
}

/**
 * Splits document text into paragraph chunks (further split at sentence
 * boundaries when long). Skips chunks that are too short or letterless.
 * Synchronous by design — hashing must work on plain-http pages too.
 */
export function chunkText(text: string, dialect: string): Chunk[] {
  const chunks: Chunk[] = [];
  const re = /[^\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const para = m[0];
    if (para.length < MIN_CHUNK_CHARS || !HAS_LETTER.test(para)) continue;
    if (para.length <= MAX_CHUNK_CHARS) {
      chunks.push({ text: para, docOffset: m.index, hash: fnvHash(para) });
    } else {
      chunks.push(...splitLongParagraph(para, m.index, dialect));
    }
  }
  return chunks;
}
