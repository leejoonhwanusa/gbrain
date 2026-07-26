import { describe, expect, test } from 'bun:test';
import { resolveEmbeddingMaxChars } from '../../src/core/ai/gateway.ts';

describe('resolveEmbeddingMaxChars', () => {
  test('defaults to the existing 8000-char ceiling', () => {
    expect(resolveEmbeddingMaxChars(undefined)).toBe(8000);
    expect(resolveEmbeddingMaxChars('not-a-number')).toBe(8000);
  });

  test('honors a smaller local-server input ceiling', () => {
    expect(resolveEmbeddingMaxChars('512')).toBe(512);
  });

  test('never expands beyond the hard gateway ceiling', () => {
    expect(resolveEmbeddingMaxChars('999999')).toBe(8000);
    expect(resolveEmbeddingMaxChars('0')).toBe(8000);
  });
});
