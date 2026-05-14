/**
 * CSV serializer for the agent-detail Transactions list. Pure function,
 * no DOM — Blob/download wiring lives in the route component. Kept here
 * so the escape semantics (RFC 4180-ish: quote anything containing `,`,
 * `"`, or any line terminator; double-up embedded quotes) are unit-tested
 * without React.
 */

export interface TxCsvRow {
  signature: string;
  blockTime: string;
  programId: string;
  success: boolean;
  solDelta: string;
  agentName: string;
  feeLamports: number;
}

const HEADER = [
  'signature',
  'blockTime',
  'programId',
  'success',
  'solDelta',
  'agentName',
  'feeLamports',
] as const;

function escapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function serializeTxRowsToCsv(rows: readonly TxCsvRow[]): string {
  const lines: string[] = [HEADER.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.signature,
        row.blockTime,
        row.programId,
        row.success ? 'true' : 'false',
        row.solDelta,
        row.agentName,
        String(row.feeLamports),
      ]
        .map(escapeCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function buildTxCsvFilename(agentName: string, now: Date = new Date()): string {
  const slug =
    agentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent';
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `transactions-${slug}-${yyyy}-${mm}-${dd}.csv`;
}
