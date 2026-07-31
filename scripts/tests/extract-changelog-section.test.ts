import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractChangelogSection,
  listChangelogVersions,
  normalizeVersion,
} from '../extract-changelog-section.js';

const SAMPLE = [
  '# Changelog',
  '',
  'All notable changes to this project will be documented in this file.',
  '',
  '## [Unreleased]',
  '',
  '### Changed',
  '- something not released yet',
  '',
  '## [0.5.5] - 2026-07-28',
  '',
  'Intro paragraph.',
  '',
  '### Added',
  '- a rule',
  '',
  '## [0.5.2] - 2026-07-14',
  '',
  '### Added',
  '- a parser',
  '',
  '## [0.5.3] - 2026-07-07',
  '',
  '### Added',
  '- an earlier release with a higher number',
  '',
  '[Unreleased]: https://github.com/PavloDereniuk/AgentScope/compare/v0.5.5...HEAD',
  '[0.5.5]: https://github.com/PavloDereniuk/AgentScope/releases/tag/v0.5.5',
  '',
].join('\n');

describe('normalizeVersion', () => {
  it('strips the tag prefix', () => {
    expect(normalizeVersion('v0.5.5')).toBe('0.5.5');
  });

  it('leaves a bare version untouched', () => {
    expect(normalizeVersion('0.5.5')).toBe('0.5.5');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeVersion('  v0.5.5\n')).toBe('0.5.5');
  });

  it('keeps roadmap-style suffixes', () => {
    expect(normalizeVersion('v0.5.0-admin')).toBe('0.5.0-admin');
  });
});

describe('extractChangelogSection', () => {
  it('returns the body without the heading', () => {
    const section = extractChangelogSection(SAMPLE, 'v0.5.5');
    expect(section).toBe(['Intro paragraph.', '', '### Added', '- a rule'].join('\n'));
  });

  it('stops at the next release heading', () => {
    expect(extractChangelogSection(SAMPLE, 'v0.5.5')).not.toContain('a parser');
  });

  it('accepts a bare version as well as a tag', () => {
    expect(extractChangelogSection(SAMPLE, '0.5.5')).toBe(
      extractChangelogSection(SAMPLE, 'v0.5.5'),
    );
  });

  it('matches by version, not by document order', () => {
    // 0.5.2 sits above 0.5.3 in the real changelog — released later, numbered lower.
    expect(extractChangelogSection(SAMPLE, 'v0.5.2')).toContain('a parser');
    expect(extractChangelogSection(SAMPLE, 'v0.5.3')).toContain('an earlier release');
  });

  it('strips trailing link-reference definitions from the last section', () => {
    const section = extractChangelogSection(SAMPLE, 'v0.5.3');
    expect(section).toBe(['### Added', '- an earlier release with a higher number'].join('\n'));
    expect(section).not.toContain('https://github.com');
  });

  it('returns null for a version with no section', () => {
    expect(extractChangelogSection(SAMPLE, 'v0.4.4')).toBeNull();
  });

  it('never resolves the Unreleased heading', () => {
    expect(extractChangelogSection(SAMPLE, 'Unreleased')).toBeNull();
    expect(extractChangelogSection(SAMPLE, 'unreleased')).toBeNull();
  });

  it('does not partial-match a longer version', () => {
    expect(extractChangelogSection(SAMPLE, 'v0.5')).toBeNull();
  });

  it('handles a changelog whose last section has no trailing newline', () => {
    const tight = '## [1.0.0] - 2026-01-01\n\n### Added\n- thing';
    expect(extractChangelogSection(tight, 'v1.0.0')).toBe('### Added\n- thing');
  });
});

describe('listChangelogVersions', () => {
  it('lists released versions in document order, excluding Unreleased', () => {
    expect(listChangelogVersions(SAMPLE)).toEqual(['0.5.5', '0.5.2', '0.5.3']);
  });
});

describe('against the real CHANGELOG.md', () => {
  const changelog = readFileSync(join(import.meta.dirname, '..', '..', 'CHANGELOG.md'), 'utf8');

  it('extracts a non-empty section for the latest release', () => {
    const versions = listChangelogVersions(changelog);
    expect(versions.length).toBeGreaterThan(0);
    const latest = versions[0] as string;
    const section = extractChangelogSection(changelog, latest);
    expect(section).toBeTruthy();
    expect(section).not.toContain('## [');
  });

  it('extracts the oldest section without dragging in the link definitions', () => {
    const versions = listChangelogVersions(changelog);
    const oldest = versions[versions.length - 1] as string;
    const section = extractChangelogSection(changelog, oldest) ?? '';
    expect(section).toBeTruthy();
    expect(section).not.toMatch(/^\[[^\]]+\]:\s*http/m);
  });
});
