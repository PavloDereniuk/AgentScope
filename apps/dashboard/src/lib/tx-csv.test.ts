import { describe, expect, it } from 'vitest';
import { type TxCsvRow, buildTxCsvFilename, serializeTxRowsToCsv } from './tx-csv';

const baseRow: TxCsvRow = {
  signature: '5vKx7gJp1QZk',
  blockTime: '2026-05-14T12:34:56.000Z',
  programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  success: true,
  solDelta: '-0.001234',
  agentName: 'ElizaTrader',
  feeLamports: 5000,
};

describe('serializeTxRowsToCsv', () => {
  it('emits a header row even when there are no transactions', () => {
    expect(serializeTxRowsToCsv([])).toBe(
      'signature,blockTime,programId,success,solDelta,agentName,feeLamports\r\n',
    );
  });

  it('serializes a clean row without quoting', () => {
    const csv = serializeTxRowsToCsv([baseRow]);
    const [header, row] = csv.trimEnd().split('\r\n');
    expect(header).toBe('signature,blockTime,programId,success,solDelta,agentName,feeLamports');
    expect(row).toBe(
      '5vKx7gJp1QZk,2026-05-14T12:34:56.000Z,JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4,true,-0.001234,ElizaTrader,5000',
    );
  });

  it('quotes cells containing a comma and preserves the comma inside the quotes', () => {
    const csv = serializeTxRowsToCsv([{ ...baseRow, agentName: 'Trader, v2' }]);
    expect(csv).toContain(',"Trader, v2",');
  });

  it('double-escapes embedded quotes (RFC 4180)', () => {
    const csv = serializeTxRowsToCsv([{ ...baseRow, agentName: 'Trader "Prime"' }]);
    expect(csv).toContain(',"Trader ""Prime""",');
  });

  it('quotes cells containing newlines without breaking row boundaries', () => {
    const csv = serializeTxRowsToCsv([{ ...baseRow, agentName: 'Multi\nLine' }]);
    expect(csv).toContain(',"Multi\nLine",');
    // exactly two CRLF row separators: one after the header, one after the data row
    expect(csv.match(/\r\n/g)).toHaveLength(2);
  });

  it('renders failed transactions as success=false', () => {
    const csv = serializeTxRowsToCsv([{ ...baseRow, success: false }]);
    expect(csv).toContain(',false,');
  });
});

describe('buildTxCsvFilename', () => {
  it('slugifies the agent name and stamps the UTC date', () => {
    const now = new Date('2026-05-14T23:59:59.000Z');
    expect(buildTxCsvFilename('ElizaTrader', now)).toBe('transactions-elizatrader-2026-05-14.csv');
  });

  it('collapses non-alphanumerics to single dashes', () => {
    const now = new Date('2026-05-14T00:00:00.000Z');
    expect(buildTxCsvFilename('Eliza · Trader v2', now)).toBe(
      'transactions-eliza-trader-v2-2026-05-14.csv',
    );
  });

  it('falls back to "agent" when the name has no alphanumerics', () => {
    const now = new Date('2026-05-14T00:00:00.000Z');
    expect(buildTxCsvFilename('!!!', now)).toBe('transactions-agent-2026-05-14.csv');
  });
});
