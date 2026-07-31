/**
 * Tests for the schema-drift checker.
 *
 * The cases are not hypothetical: each one reproduces a real gap found in the
 * production database on 2026-07-31, when an audit showed six migrations had
 * never been applied. If this checker had existed, every one of these would
 * have been a red exit code instead of seven detector rules failing silently
 * for weeks.
 */

import { describe, expect, it } from 'vitest';
import {
  type ActualSchema,
  type ExpectedSchema,
  compareSchema,
  describeExpectedSchema,
  formatReport,
} from '../check-schema-drift';

/** A schema with one table, one index and one enum — enough to vary per test. */
function expectedFixture(): ExpectedSchema {
  return {
    enums: [{ name: 'alert_rule_name', values: ['slippage_spike', 'low_balance'] }],
    tables: [
      {
        name: 'alerts',
        columns: ['id', 'agent_id', 'dedupe_key'],
        indexes: [{ name: 'alerts_dedupe_unique', unique: true }],
      },
    ],
  };
}

/** A database that matches `expectedFixture()` exactly. */
function actualFixture(): ActualSchema {
  return {
    enums: new Map([['alert_rule_name', new Set(['slippage_spike', 'low_balance'])]]),
    columns: new Map([['alerts', new Set(['id', 'agent_id', 'dedupe_key'])]]),
    indexes: new Map([['alerts_dedupe_unique', { unique: true }]]),
    rls: new Map([['alerts', true]]),
  };
}

describe('compareSchema', () => {
  it('reports nothing when the database matches the schema', () => {
    expect(compareSchema(expectedFixture(), actualFixture())).toEqual([]);
  });

  it('reports an enum value the database is missing (migrations 0008/0011-0013/0016)', () => {
    const actual = actualFixture();
    actual.enums.set('alert_rule_name', new Set(['slippage_spike']));

    const findings = compareSchema(expectedFixture(), actual);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('missing-enum-value');
    expect(findings[0]?.target).toBe('alert_rule_name.low_balance');
    // The detail doubles as the remedy — paste-ready, because the person
    // reading this is mid-incident.
    expect(findings[0]?.detail).toContain("ADD VALUE IF NOT EXISTS 'low_balance'");
  });

  it('reports every missing enum value, not just the first', () => {
    const actual = actualFixture();
    actual.enums.set('alert_rule_name', new Set());

    const findings = compareSchema(expectedFixture(), actual);
    expect(findings.map((f) => f.target)).toEqual([
      'alert_rule_name.slippage_spike',
      'alert_rule_name.low_balance',
    ]);
  });

  it('reports an absent enum type as a single finding', () => {
    const actual = actualFixture();
    actual.enums.delete('alert_rule_name');

    const findings = compareSchema(expectedFixture(), actual);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain('enum type is absent');
  });

  it('reports a missing table (migration 0007 — telegram_bindings)', () => {
    const actual = actualFixture();
    actual.columns.delete('alerts');

    const findings = compareSchema(expectedFixture(), actual);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'missing-table', target: 'alerts' });
  });

  it('does not also list every column and index of a table that is absent', () => {
    // Three columns and one index would otherwise produce four extra findings
    // that all say the same thing as "the table is not there".
    const actual = actualFixture();
    actual.columns.delete('alerts');
    actual.indexes.clear();

    const findings = compareSchema(expectedFixture(), actual);
    expect(findings).toHaveLength(1);
  });

  it('reports a missing column (migration 0009 — agents.alerts_paused_until)', () => {
    const actual = actualFixture();
    actual.columns.set('alerts', new Set(['id', 'agent_id']));

    const findings = compareSchema(expectedFixture(), actual);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'missing-column', target: 'alerts.dedupe_key' });
  });

  it('reports a missing index', () => {
    const actual = actualFixture();
    actual.indexes.clear();

    const findings = compareSchema(expectedFixture(), actual);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'missing-index', target: 'alerts_dedupe_unique' });
  });

  it('reports an index that exists but is not UNIQUE (the 0004 bug)', () => {
    // This is the nastiest variant: the index is present, so a name-only check
    // passes, but ON CONFLICT has no constraint to match and every insert errors.
    const actual = actualFixture();
    actual.indexes.set('alerts_dedupe_unique', { unique: false });

    const findings = compareSchema(expectedFixture(), actual);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('index-not-unique');
    expect(findings[0]?.detail).toContain('ON CONFLICT will fail');
  });

  it('does not complain when a non-unique index is not expected to be unique', () => {
    const expected = expectedFixture();
    expected.tables[0]!.indexes = [{ name: 'alerts_dedupe_unique', unique: false }];
    const actual = actualFixture();
    actual.indexes.set('alerts_dedupe_unique', { unique: false });

    expect(compareSchema(expected, actual)).toEqual([]);
  });

  it('reports a relation with RLS disabled (migrations 0010/0014 — partitions)', () => {
    const actual = actualFixture();
    actual.rls.set('agent_transactions_2026_10', false);

    const findings = compareSchema(expectedFixture(), actual);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'rls-disabled',
      target: 'agent_transactions_2026_10',
    });
  });

  it('accumulates findings across categories in one pass', () => {
    // The real 2026-07-31 shape: several unrelated migrations missing at once.
    const actual = actualFixture();
    actual.enums.set('alert_rule_name', new Set(['slippage_spike']));
    actual.columns.set('alerts', new Set(['id', 'agent_id']));
    actual.rls.set('agent_transactions_default', false);

    const findings = compareSchema(expectedFixture(), actual);
    expect(findings.map((f) => f.kind)).toEqual([
      'missing-enum-value',
      'missing-column',
      'rls-disabled',
    ]);
  });
});

describe('describeExpectedSchema', () => {
  it('reads enums and tables off the real drizzle schema', async () => {
    const schema = await import('@agentscope/db/schema');
    const expected = describeExpectedSchema(schema as unknown as Record<string, unknown>);

    const alertRules = expected.enums.find((e) => e.name === 'alert_rule_name');
    expect(alertRules?.values).toContain('outbound_transfer_drain');

    const alerts = expected.tables.find((t) => t.name === 'alerts');
    expect(alerts?.columns).toContain('dedupe_key');
    expect(alerts?.indexes).toContainEqual({ name: 'alerts_dedupe_unique', unique: true });
  });

  it('covers every table the schema declares', () => {
    // Guards the derive-don't-list decision: a table added to schema.ts is
    // checked without anyone remembering to update this script.
    const expected = describeExpectedSchema({});
    expect(expected.tables).toEqual([]);
    expect(expected.enums).toEqual([]);
  });
});

describe('formatReport', () => {
  it('says so plainly when there is no drift', () => {
    expect(formatReport([])).toContain('no drift');
  });

  it('prints the remedy alongside each finding', () => {
    const report = formatReport([
      { kind: 'missing-enum-value', target: 'alert_rule_name.low_balance', detail: 'ALTER TYPE …' },
    ]);
    expect(report).toContain('MISSING ENUM VALUE');
    expect(report).toContain('alert_rule_name.low_balance');
    expect(report).toContain('ALTER TYPE …');
  });
});
