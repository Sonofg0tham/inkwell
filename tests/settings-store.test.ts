import { beforeEach, describe, expect, it } from 'vitest';
import { setupChromeMock } from './helpers/chrome-mock';
import { DEFAULT_SETTINGS } from '../lib/settings/schema';
import {
  addPersonalDictionaryWord,
  clearPersonalDictionary,
  loadSettings,
  removePersonalDictionaryWord,
  saveSettings,
} from '../lib/settings/store';

setupChromeMock();

describe('personal dictionary storage', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    await saveSettings({ ...DEFAULT_SETTINGS, personalDictionary: ['Inkwell'] });
  });

  it('adds a safe word once, case-insensitively', async () => {
    await expect(addPersonalDictionaryWord('  Recieve  ')).resolves.toBe(true);
    await expect(addPersonalDictionaryWord('recieve')).resolves.toBe(false);
    expect((await loadSettings()).personalDictionary).toEqual(['Inkwell', 'Recieve']);
  });

  it.each(['', '<script>', 'two words', 'x'.repeat(81)])('rejects unsafe dictionary entry %j', async (word) => {
    await expect(addPersonalDictionaryWord(word)).resolves.toBe(false);
    expect((await loadSettings()).personalDictionary).toEqual(['Inkwell']);
  });

  it('removes one word case-insensitively and reports whether it existed', async () => {
    await addPersonalDictionaryWord('Colourise');

    await expect(removePersonalDictionaryWord('colourise')).resolves.toBe(true);
    await expect(removePersonalDictionaryWord('colourise')).resolves.toBe(false);
    expect((await loadSettings()).personalDictionary).toEqual(['Inkwell']);
  });

  it('clears all personal dictionary entries', async () => {
    await addPersonalDictionaryWord('Colourise');

    await clearPersonalDictionary();

    expect((await loadSettings()).personalDictionary).toEqual([]);
  });
});
