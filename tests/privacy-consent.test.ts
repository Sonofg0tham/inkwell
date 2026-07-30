import { describe, expect, it } from 'vitest';
import {
  CURRENT_DATA_CONSENT_VERSION,
  DEFAULT_SETTINGS,
  settingsSchema,
} from '../lib/settings/schema';

describe('privacy consent settings', () => {
  it('starts new installs with checking gated until the user accepts the disclosure', () => {
    expect(CURRENT_DATA_CONSENT_VERSION).toBe(1);
    expect(DEFAULT_SETTINGS.dataConsentVersion).toBe(0);
    expect(DEFAULT_SETTINGS.cloudAllowedSites).toEqual([]);
  });

  it('normalises stored consent and per-site cloud allowlists', () => {
    const settings = settingsSchema.parse({
      dataConsentVersion: 1,
      cloudAllowedSites: ['mail.example.test'],
    });
    expect(settings.dataConsentVersion).toBe(1);
    expect(settings.cloudAllowedSites).toEqual(['mail.example.test']);
  });
});
