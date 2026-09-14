import { describe, expect, it } from 'vitest';

import { aliasesFor } from './service.js';

describe('count alias resolution', () => {
  it('maps everyday plurals onto detector class names', () => {
    expect(aliasesFor('people')).toEqual(['person']);
    expect(aliasesFor('vehicles')).toContain('bus');
    expect(aliasesFor('buses')).toEqual(['bus']);
    expect(aliasesFor('trucks')).toEqual(['truck']);
  });

  it('falls back to the singular word for unknown classes', () => {
    expect(aliasesFor('forklifts')).toEqual(['forklift']);
  });
});
