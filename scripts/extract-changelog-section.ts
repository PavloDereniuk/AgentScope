/**
 * Extract one release section out of CHANGELOG.md (Keep a Changelog 1.1.0).
 *
 * Used by .github/workflows/release.yml: pushing a `v*` tag feeds the matching
 * section into `gh release create --notes-file`, so release notes come from the
 * same source of truth as the changelog instead of being retyped by hand.
 *
 * Pure logic lives in `extractChangelogSection`; the CLI wrapper below only
 * runs when the file is executed directly (so tests can import it freely).
 *
 * Usage: tsx scripts/extract-changelog-section.ts v0.5.5 [path/to/CHANGELOG.md]
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** `v0.5.5` → `0.5.5`; anything without the prefix is returned untouched. */
export function normalizeVersion(tagOrVersion: string): string {
  const trimmed = tagOrVersion.trim();
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

/** Every version that has a `## [x.y.z]` heading, in document order. */
export function listChangelogVersions(changelog: string): string[] {
  const versions: string[] = [];
  for (const line of changelog.split('\n')) {
    const heading = matchVersionHeading(line);
    if (heading) versions.push(heading);
  }
  return versions;
}

/**
 * Body of the `## [version]` section, without the heading itself.
 *
 * Returns `null` when the version has no section — the caller decides whether
 * that is fatal. Sections are matched by exact version, never by position:
 * CHANGELOG.md is not in monotonic version order (0.5.2 was released after
 * 0.5.3 and sits above it).
 *
 * Trailing link-reference definitions (`[0.5.2]: https://…`) are stripped —
 * they live at the very bottom of the file and would otherwise be swallowed
 * into whichever section happens to be last.
 */
export function extractChangelogSection(changelog: string, tagOrVersion: string): string | null {
  const target = normalizeVersion(tagOrVersion);
  const lines = changelog.split('\n');

  const start = lines.findIndex((line) => matchVersionHeading(line) === target);
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const nextHeading = rest.findIndex((line) => line.startsWith('## '));
  const body = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  return stripTrailingLinkDefinitions(body).join('\n').trim();
}

/** `## [0.5.5] - 2026-07-28` → `0.5.5`. Non-version headings → `null`. */
function matchVersionHeading(line: string): string | null {
  const match = /^##\s+\[([^\]]+)\]/.exec(line);
  if (!match?.[1]) return null;
  const version = match[1].trim();
  return version.toLowerCase() === 'unreleased' ? null : version;
}

function stripTrailingLinkDefinitions(body: string[]): string[] {
  const end = [...body];
  while (end.length > 0) {
    const last = end[end.length - 1] ?? '';
    if (last.trim() === '' || /^\[[^\]]+\]:\s*\S+/.test(last)) {
      end.pop();
      continue;
    }
    break;
  }
  return end;
}

function main(argv: string[]): void {
  const [tag, changelogPath = 'CHANGELOG.md'] = argv;
  if (!tag) {
    console.error('Usage: tsx scripts/extract-changelog-section.ts <tag> [changelog-path]');
    process.exit(2);
  }

  const changelog = readFileSync(changelogPath, 'utf8');
  const section = extractChangelogSection(changelog, tag);

  if (section === null || section === '') {
    const known = listChangelogVersions(changelog).join(', ');
    console.error(
      `No CHANGELOG section for "${normalizeVersion(tag)}" in ${changelogPath}.\n` +
        `Add a "## [${normalizeVersion(tag)}] - YYYY-MM-DD" section before tagging.\n` +
        `Sections present: ${known || '(none)'}`,
    );
    process.exit(1);
  }

  process.stdout.write(`${section}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main(process.argv.slice(2));
}
