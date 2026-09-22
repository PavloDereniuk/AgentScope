import { describe, expect, it } from 'vitest';
import {
  type MilestoneCsvRow,
  buildMilestoneCsvFilename,
  serializeMilestoneRowsToCsv,
} from './milestone-csv';

const HEADER =
  'builder_hash,registered_at,agents_count,first_tx_at,last_tx_at,tx_14d,alerts_delivered_30d,last_alert_delivered_at,last_active_at,connected_m1,active_by_grant_definition';

const activeRow: MilestoneCsvRow = {
  builderHash: 'a1b2c3d4e5f6',
  registeredAt: '2026-08-01T10:00:00Z',
  agentsCount: 2,
  firstTxAt: '2026-08-02T10:00:00Z',
  lastTxAt: '2026-09-20T10:00:00Z',
  tx14d: 7,
  alertsDelivered30d: 1,
  lastAlertDeliveredAt: '2026-09-10T10:00:00Z',
  lastActiveAt: '2026-09-20T10:00:00Z',
  connected: true,
  active: true,
};

describe('serializeMilestoneRowsToCsv', () => {
  it('emits only the header when there are no builders', () => {
    expect(serializeMilestoneRowsToCsv([])).toBe(`${HEADER}\r\n`);
  });

  it('serializes an active builder with booleans as true/false', () => {
    const [header, row] = serializeMilestoneRowsToCsv([activeRow]).trimEnd().split('\r\n');
    expect(header).toBe(HEADER);
    expect(row).toBe(
      'a1b2c3d4e5f6,2026-08-01T10:00:00Z,2,2026-08-02T10:00:00Z,2026-09-20T10:00:00Z,7,1,2026-09-10T10:00:00Z,2026-09-20T10:00:00Z,true,true',
    );
  });

  it('renders null timestamps as empty cells so the column count never shifts', () => {
    const dormant: MilestoneCsvRow = {
      ...activeRow,
      firstTxAt: null,
      lastTxAt: null,
      tx14d: 0,
      alertsDelivered30d: 0,
      lastAlertDeliveredAt: null,
      lastActiveAt: null,
      connected: false,
      active: false,
    };
    const [, row] = serializeMilestoneRowsToCsv([dormant]).trimEnd().split('\r\n');
    expect(row).toBe('a1b2c3d4e5f6,2026-08-01T10:00:00Z,2,,,0,0,,,false,false');
    expect(row?.split(',').length).toBe(HEADER.split(',').length);
  });

  it('quotes a cell that contains a comma or a quote (RFC 4180)', () => {
    const csv = serializeMilestoneRowsToCsv([{ ...activeRow, builderHash: 'x,"y"' }]);
    expect(csv).toContain('"x,""y"""');
  });
});

describe('buildMilestoneCsvFilename', () => {
  it('dates the file in UTC', () => {
    expect(buildMilestoneCsvFilename(new Date('2026-09-22T23:30:00Z'))).toBe(
      'milestone-proof-2026-09-22.csv',
    );
  });
});
