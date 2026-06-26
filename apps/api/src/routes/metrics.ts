/**
 * B.5 — Prometheus /metrics endpoint.
 *
 * Returns platform-wide counters and gauges in the Prometheus text
 * exposition format (version 0.0.4). No authentication — designed for
 * an internal Prometheus scraper on the same private network. Self-hosters
 * point their Prometheus `static_configs` at `<api-host>/metrics`.
 *
 * Implemented as a plain string builder — zero new dependencies.
 *
 * Metrics exposed:
 *   agentscope_tx_total{agent,user}         counter  txs ingested, per agent
 *   agentscope_alerts_total{rule,severity}  counter  alerts fired, by rule × severity
 *   agentscope_reasoning_spans_total        counter  OTel spans ingested
 *   agentscope_ingest_lag_seconds           gauge    seconds since last tx block_time
 */

import type { Database } from '@agentscope/db';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

/** Escape a label value per Prometheus text format spec. */
function escLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(pairs: Record<string, string>): string {
  const parts = Object.entries(pairs).map(([k, v]) => `${k}="${escLabel(v)}"`);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

/**
 * Drivers disagree on `db.execute()` result shape — postgres-js returns an
 * array-like RowList, pglite returns `{rows}`. Normalize to a plain array.
 */
function unwrapRows<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  return (raw as { rows?: T[] }).rows ?? [];
}

export function createMetricsRouter(db: Database) {
  const router = new Hono();

  router.get('/metrics', async (c) => {
    const [txRows, alertRows, spanRow, lagRow] = await Promise.all([
      db.execute(sql`
        select agent_id, user_id, cast(count(*) as int) as n
        from agent_transactions
        inner join agents on agents.id = agent_transactions.agent_id
        group by agent_id, user_id
      `),
      db.execute(sql`
        select rule_name, severity, cast(count(*) as int) as n
        from alerts
        group by rule_name, severity
      `),
      db.execute(sql`select cast(count(*) as int) as n from reasoning_logs`),
      db.execute(sql`
        select extract(epoch from (now() - max(block_time))) as lag_seconds
        from agent_transactions
      `),
    ]);

    const txs = unwrapRows<{ agent_id: string; user_id: string; n: number | string }>(txRows);
    const alertCounts = unwrapRows<{
      rule_name: string;
      severity: string;
      n: number | string;
    }>(alertRows);
    const spanCount = Number(unwrapRows<{ n: number | string }>(spanRow)[0]?.n ?? 0);
    const lagRaw = unwrapRows<{ lag_seconds: number | string | null }>(lagRow)[0];
    const lagSeconds = lagRaw?.lag_seconds == null ? null : Math.max(0, Number(lagRaw.lag_seconds));

    const lines: string[] = [];

    // agentscope_tx_total
    lines.push('# HELP agentscope_tx_total Total transactions ingested per agent.');
    lines.push('# TYPE agentscope_tx_total counter');
    for (const row of txs) {
      lines.push(
        `agentscope_tx_total${labels({ agent: row.agent_id, user: row.user_id })} ${Number(row.n)}`,
      );
    }

    // agentscope_alerts_total
    lines.push('# HELP agentscope_alerts_total Total alerts fired by rule and severity.');
    lines.push('# TYPE agentscope_alerts_total counter');
    for (const row of alertCounts) {
      lines.push(
        `agentscope_alerts_total${labels({ rule: row.rule_name, severity: row.severity })} ${Number(row.n)}`,
      );
    }

    // agentscope_reasoning_spans_total
    lines.push('# HELP agentscope_reasoning_spans_total Total OTel reasoning spans ingested.');
    lines.push('# TYPE agentscope_reasoning_spans_total counter');
    lines.push(`agentscope_reasoning_spans_total ${spanCount}`);

    // agentscope_ingest_lag_seconds
    lines.push(
      '# HELP agentscope_ingest_lag_seconds Seconds elapsed since the last transaction was ingested.',
    );
    lines.push('# TYPE agentscope_ingest_lag_seconds gauge');
    if (lagSeconds !== null) {
      lines.push(`agentscope_ingest_lag_seconds ${lagSeconds.toFixed(3)}`);
    }

    // Prometheus requires a trailing newline.
    const body = `${lines.join('\n')}\n`;

    return c.text(body, 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  return router;
}
