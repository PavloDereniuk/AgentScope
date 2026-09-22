/**
 * CSV serializer for the grant milestone proof bundle (admin panel, G.1).
 * Pure function, no DOM — the download wiring lives in the admin route.
 * Same RFC 4180-ish escape semantics as tx-csv.ts; the sponsor opens this
 * in a spreadsheet, so the header names are the snake_case column names the
 * grant doc's proof query uses rather than the API's camelCase.
 */

export interface MilestoneCsvRow {
  builderHash: string;
  registeredAt: string;
  agentsCount: number;
  firstTxAt: string | null;
  lastTxAt: string | null;
  tx14d: number;
  alertsDelivered30d: number;
  lastAlertDeliveredAt: string | null;
  lastActiveAt: string | null;
  connected: boolean;
  active: boolean;
}

const HEADER = [
  'builder_hash',
  'registered_at',
  'agents_count',
  'first_tx_at',
  'last_tx_at',
  'tx_14d',
  'alerts_delivered_30d',
  'last_alert_delivered_at',
  'last_active_at',
  'connected_m1',
  'active_by_grant_definition',
] as const;

function escapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function serializeMilestoneRowsToCsv(rows: readonly MilestoneCsvRow[]): string {
  const lines: string[] = [HEADER.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.builderHash,
        row.registeredAt,
        String(row.agentsCount),
        row.firstTxAt ?? '',
        row.lastTxAt ?? '',
        String(row.tx14d),
        String(row.alertsDelivered30d),
        row.lastAlertDeliveredAt ?? '',
        row.lastActiveAt ?? '',
        row.connected ? 'true' : 'false',
        row.active ? 'true' : 'false',
      ]
        .map(escapeCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function buildMilestoneCsvFilename(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `milestone-proof-${yyyy}-${mm}-${dd}.csv`;
}
