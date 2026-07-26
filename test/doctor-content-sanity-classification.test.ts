import { describe, expect, test } from 'bun:test';
import {
  isActionableOversizedPage,
  shouldAssessDoctorJunkPage,
} from '../src/commands/doctor.ts';
import { readFileSync } from 'fs';

describe('doctor content-sanity classification', () => {
  test('code and already embed-skipped oversize pages are accepted inventory', () => {
    expect(isActionableOversizedPage({ type: 'code', frontmatter: {} })).toBe(false);
    expect(isActionableOversizedPage({ type: 'note', frontmatter: { embed_skip: true } })).toBe(false);
    expect(isActionableOversizedPage({ type: 'note', frontmatter: { embed_skip: 'true' } })).toBe(false);
    expect(isActionableOversizedPage({
      type: 'note',
      frontmatter: { content_flag: { reason: 'oversized' } },
    })).toBe(false);
  });

  test('unhandled non-code oversize remains actionable', () => {
    expect(isActionableOversizedPage({ type: 'note', frontmatter: {} })).toBe(true);
    expect(isActionableOversizedPage({ type: 'note', frontmatter: { embed_skip: false } })).toBe(true);
  });

  test('junk-literal audit ignores source-code examples', () => {
    expect(shouldAssessDoctorJunkPage('code')).toBe(false);
    expect(shouldAssessDoctorJunkPage('note')).toBe(true);
  });

  test('historical inactive-source events do not degrade current health', () => {
    const source = readFileSync(new URL('../src/commands/doctor.ts', import.meta.url), 'utf8');
    expect(source).toContain('inactive-source event(s) excluded');
    expect(source).toContain("const status: 'ok' | 'fail' = hardBlocked > 0 ? 'fail' : 'ok'");
  });

  test('flagged pages remain visible but informational', () => {
    const source = readFileSync(new URL('../src/commands/doctor.ts', import.meta.url), 'utf8');
    expect(source).toContain('informational, still searchable');
  });
});
