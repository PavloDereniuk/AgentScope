/**
 * Public read-only demo agent view (C.0b).
 *
 * Two routes in one file:
 *   /share          — fetches /public/demo to resolve the agentId,
 *                     then navigates to /share/:id (shareable URL).
 *   /share/:id      — renders the sanitized demo agent view.
 *
 * No Privy auth required. Sticky "Sign in" banner persists until the
 * user navigates to the auth'd dashboard.
 */

import { Kpi, KpiRow } from '@/components/Kpi';
import { resolveApiUrl } from '@/lib/api-url';
import { cn } from '@/lib/utils';
import { formatAlertSummary, formatRuleTitle } from '@agentscope/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Types matching the public API responses
// ---------------------------------------------------------------------------

interface PublicAgent {
  id: string;
  name: string;
  walletPubkey: string;
  framework: string;
  agentType: string;
  status: 'live' | 'stale' | 'failed';
  tags: string[];
  createdAt: string;
  lastSeenAt: string | null;
}

interface PublicOverview {
  agent: PublicAgent;
  recentTxCount: number;
  solDelta24h: string;
  successRate24h: number | null;
  lastAlert: PublicAlert | null;
}

interface PublicTx {
  id: number;
  signature: string;
  blockTime: string;
  programId: string;
  instructionName: string | null;
  solDelta: string;
  success: boolean;
  feeLamports: number;
}

interface PublicAlert {
  id: string;
  severity: string;
  ruleName: string;
  payload: Record<string, unknown>;
  triggeredAt: string;
}

interface PublicSpan {
  spanId: string;
  parentSpanId: string | null;
  spanName: string;
  startTime: string;
  endTime: string;
  attributes: Record<string, unknown>;
  traceId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function publicFetch<T>(path: string): Promise<T> {
  const res = await fetch(resolveApiUrl(path), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const SPAN_ATTR_KEYS: Record<string, string[]> = {
  price_oracle_check: ['sol.price_usd', 'oracle.source', 'oracle.confidence'],
  slippage_evaluation: [
    'slippage.estimated_pct',
    'slippage.threshold_pct',
    'slippage.acceptable',
    'route.hops',
  ],
  swap_execution_decision: ['decision', 'confidence', 'market.condition'],
};

function SpanDuration({ startTime, endTime }: { startTime: string; endTime: string }) {
  const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  return <span className="font-mono text-[10px] text-fg-3">{ms >= 0 ? `${ms}ms` : '—'}</span>;
}

function SpanTree({ spans }: { spans: PublicSpan[] }) {
  if (spans.length === 0) return null;
  return (
    <tr>
      <td colSpan={3} className="px-0 pb-1 pt-0">
        <div className="mx-4 mb-1 overflow-hidden rounded border border-line bg-bg-3">
          {spans.map((span, idx) => {
            const attrKeys =
              SPAN_ATTR_KEYS[span.spanName] ?? Object.keys(span.attributes).slice(0, 4);
            const relevantAttrs = attrKeys
              .map((k) => [k, span.attributes[k]] as [string, unknown])
              .filter(([, v]) => v !== undefined);
            return (
              <div
                key={span.spanId}
                className={cn(
                  'px-4 py-2',
                  idx < spans.length - 1 && 'border-b border-line',
                  span.parentSpanId !== null && 'pl-8',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-fg-2">{span.spanName}</span>
                  <SpanDuration startTime={span.startTime} endTime={span.endTime} />
                </div>
                {relevantAttrs.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                    {relevantAttrs.map(([k, v]) => (
                      <span key={k} className="font-mono text-[10px] text-fg-3">
                        <span className="text-fg-2">{k.split('.').pop()}</span>{' '}
                        <span className="text-accent">
                          {typeof v === 'boolean' ? String(v) : String(v)}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </td>
    </tr>
  );
}

function SignInBanner() {
  const dashboardUrl = import.meta.env.VITE_DASHBOARD_URL ?? '';
  const loginHref = dashboardUrl ? `${dashboardUrl}/` : '/';
  return (
    <div className="sticky top-0 z-50 flex items-center justify-between gap-3 border-b border-[color:color-mix(in_oklch,var(--accent)_30%,var(--line))] bg-[color-mix(in_oklch,var(--accent)_6%,var(--bg))] px-5 py-2.5">
      <p className="font-mono text-[11px] text-fg-2">
        <span className="text-accent">● live demo</span>
        {' — '}This is a read-only view of a monitored Solana AI agent.
      </p>
      <a
        href={loginHref}
        className="flex shrink-0 items-center gap-1.5 rounded border border-line bg-bg-2 px-3 py-1.5 font-mono text-[11px] text-fg transition-colors hover:border-accent hover:text-accent"
      >
        <LogIn className="h-3 w-3" aria-hidden />
        Sign in to monitor your own
      </a>
    </div>
  );
}

function StatusBadge({ status }: { status: 'live' | 'stale' | 'failed' }) {
  const styles =
    status === 'live'
      ? 'text-accent border-[color:var(--accent-dim)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)]'
      : status === 'stale'
        ? 'text-warn border-[color:color-mix(in_oklch,var(--warn)_35%,var(--line))]'
        : 'text-crit border-[color:color-mix(in_oklch,var(--crit)_35%,var(--line))]';
  const dot =
    status === 'live'
      ? 'bg-accent shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_25%,transparent)]'
      : status === 'stale'
        ? 'bg-warn'
        : 'bg-crit';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em]',
        styles,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {status}
    </span>
  );
}

function TagBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-line bg-bg-3 px-2 py-0.5 font-mono text-[10px] text-fg-3">
      {children}
    </span>
  );
}

function SeverityDot({ severity }: { severity: string }) {
  const cls = severity === 'critical' ? 'bg-crit' : severity === 'warning' ? 'bg-warn' : 'bg-info';
  return <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0 mt-[3px]', cls)} />;
}

// ---------------------------------------------------------------------------
// /share/:id — actual render
// ---------------------------------------------------------------------------

export function ShareAgentPage() {
  const { id } = useParams<{ id: string }>();
  const [expandedSig, setExpandedSig] = useState<string | null>(null);

  const {
    data: overviewData,
    isLoading: overviewLoading,
    error: overviewError,
  } = useQuery({
    queryKey: ['public-agent-overview', id],
    queryFn: () => publicFetch<PublicOverview>(`/public/agents/${id}/overview`),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });

  const { data: txData } = useQuery({
    queryKey: ['public-agent-tx', id],
    queryFn: () =>
      publicFetch<{ transactions: PublicTx[]; nextCursor: string | null }>(
        `/public/agents/${id}/transactions?limit=20`,
      ),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });

  const { data: alertsData } = useQuery({
    queryKey: ['public-agent-alerts', id],
    queryFn: () => publicFetch<{ alerts: PublicAlert[] }>(`/public/agents/${id}/alerts`),
    enabled: Boolean(id),
    refetchInterval: 60_000,
  });

  const { data: spansData } = useQuery({
    queryKey: ['public-agent-spans', id, expandedSig],
    queryFn: () =>
      publicFetch<{ spans: PublicSpan[] }>(
        `/public/agents/${id}/transactions/${expandedSig}/spans`,
      ),
    enabled: Boolean(id) && expandedSig !== null,
    staleTime: 5 * 60 * 1000,
  });

  if (overviewLoading) {
    return (
      <div className="flex min-h-screen flex-col bg-bg">
        <SignInBanner />
        <div className="p-7">
          <p className="font-mono text-xs text-fg-3">Loading demo agent…</p>
        </div>
      </div>
    );
  }

  if (overviewError || !overviewData) {
    return (
      <div className="flex min-h-screen flex-col bg-bg">
        <SignInBanner />
        <div className="p-7 space-y-3">
          <p className="font-mono text-xs text-crit">Demo agent unavailable.</p>
          <a href="/" className="font-mono text-xs text-accent hover:underline">
            ← Back to AgentScope
          </a>
        </div>
      </div>
    );
  }

  const { agent, recentTxCount, solDelta24h, successRate24h } = overviewData;
  const transactions = txData?.transactions ?? [];
  const alerts = alertsData?.alerts ?? [];

  const solNum = Number(solDelta24h);
  const solFormatted = Number.isFinite(solNum) ? solNum.toFixed(4) : '—';
  const solKind = solNum > 0 ? 'pos' : solNum < 0 ? 'neg' : 'dim';

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <SignInBanner />

      <div className="mx-auto w-full max-w-4xl px-5 py-8">
        {/* Header */}
        <div className="mb-7 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-fg-3">
              Live agent demo
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
              <StatusBadge status={agent.status} />
              <TagBadge>{agent.framework}</TagBadge>
              <TagBadge>{agent.agentType}</TagBadge>
            </div>
            <div className="mt-2 flex items-center gap-2 font-mono text-[11px] text-fg-3">
              <span title={agent.walletPubkey}>
                {agent.walletPubkey.slice(0, 8)}…{agent.walletPubkey.slice(-8)}
              </span>
              <a
                href={`https://solscan.io/account/${agent.walletPubkey}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-fg"
              >
                <ExternalLink className="h-3 w-3" aria-label="View on Solscan" />
              </a>
            </div>
          </div>
        </div>

        {/* KPIs */}
        <div className="mb-7 rounded-md border border-line bg-bg-2">
          <KpiRow>
            <Kpi label="TX 24 h" value={recentTxCount} />
            <Kpi
              label="Success"
              value={successRate24h !== null ? `${(successRate24h * 100).toFixed(0)}%` : '—'}
            />
            <Kpi
              label="SOL delta 24 h"
              value={`${solNum >= 0 ? '+' : ''}${solFormatted}`}
              deltaKind={solKind}
            />
            <Kpi
              label="Last seen"
              value={agent.lastSeenAt ? formatTime(agent.lastSeenAt) : 'never'}
              variant="sm"
            />
          </KpiRow>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Recent transactions */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.1em] text-fg-3">
                Recent transactions
              </h2>
              <span className="font-mono text-[10px] text-fg-3">
                {transactions.length > 0 ? `${transactions.length} shown` : ''}
              </span>
            </div>
            <div className="rounded-md border border-line bg-bg-2">
              {transactions.length === 0 ? (
                <p className="px-4 py-8 text-center font-mono text-xs text-fg-3">
                  No transactions yet.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="px-4 py-2.5 text-left font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                        Time
                      </th>
                      <th className="px-4 py-2.5 text-left font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                        Instruction
                      </th>
                      <th className="px-4 py-2.5 text-right font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                        SOL Δ
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((tx) => {
                      const delta = Number(tx.solDelta);
                      const isJupiter =
                        tx.instructionName === 'route' ||
                        tx.instructionName === 'sharedAccountsRoute';
                      const isExpanded = expandedSig === tx.signature;
                      const currentSpans = isExpanded && spansData ? spansData.spans : [];
                      return (
                        <>
                          <tr
                            key={tx.id}
                            className={cn(
                              'border-b border-line last:border-b-0',
                              isJupiter && 'cursor-pointer hover:bg-bg-3',
                              isExpanded && 'bg-bg-3',
                            )}
                            onClick={
                              isJupiter
                                ? () => setExpandedSig(isExpanded ? null : tx.signature)
                                : undefined
                            }
                            onKeyDown={
                              isJupiter
                                ? (e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      setExpandedSig(isExpanded ? null : tx.signature);
                                    }
                                  }
                                : undefined
                            }
                            tabIndex={isJupiter ? 0 : undefined}
                          >
                            <td className="px-4 py-2.5 font-mono text-[11px] text-fg-3">
                              {formatTime(tx.blockTime)}
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    'h-1.5 w-1.5 shrink-0 rounded-full',
                                    tx.success ? 'bg-accent' : 'bg-crit',
                                  )}
                                />
                                <span className="font-mono text-[11px] text-fg-2">
                                  {tx.instructionName ?? 'unknown'}
                                </span>
                                {isJupiter && (
                                  <span className="ml-auto text-fg-3">
                                    {isExpanded ? (
                                      <ChevronDown className="h-3 w-3" />
                                    ) : (
                                      <ChevronRight className="h-3 w-3" />
                                    )}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <a
                                href={`https://solscan.io/tx/${tx.signature}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={cn(
                                  'font-mono text-[11px] hover:underline',
                                  delta > 0 ? 'text-accent' : delta < 0 ? 'text-crit' : 'text-fg-3',
                                )}
                                title={tx.signature}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {delta > 0 ? '+' : ''}
                                {Number.isFinite(delta) ? delta.toFixed(4) : '0'}
                              </a>
                            </td>
                          </tr>
                          {isExpanded && <SpanTree spans={currentSpans} />}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {/* Recent alerts */}
          <section>
            <div className="mb-3">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.1em] text-fg-3">
                Recent alerts
              </h2>
            </div>
            <div className="rounded-md border border-line bg-bg-2">
              {alerts.length === 0 ? (
                <p className="px-4 py-8 text-center font-mono text-xs text-fg-3">
                  No alerts fired.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {alerts.map((alert) => (
                    <li key={alert.id} className="flex items-start gap-3 px-4 py-3">
                      <SeverityDot severity={alert.severity} />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[11px] text-fg">
                          {formatRuleTitle(alert.ruleName as Parameters<typeof formatRuleTitle>[0])}
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] text-fg-3">
                          {formatAlertSummary(
                            alert.ruleName as Parameters<typeof formatAlertSummary>[0],
                            alert.payload,
                          )}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-[10px] text-fg-3">
                        {formatDate(alert.triggeredAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="mt-8 border-t border-line pt-6 text-center">
          <p className="font-mono text-[11px] text-fg-3">
            Powered by{' '}
            <a href="https://agentscopehq.dev" className="text-accent hover:underline">
              AgentScope
            </a>
            {' — '}observability for on-chain AI agents.{' '}
            <Link to="/" className="text-fg-2 hover:text-fg">
              Sign in to monitor your own →
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// /share — resolve demo ID and redirect
// ---------------------------------------------------------------------------

export function ShareRedirectPage() {
  const navigate = useNavigate();

  const { data, error } = useQuery({
    queryKey: ['public-demo'],
    queryFn: () => publicFetch<{ agentId: string }>('/public/demo'),
    retry: false,
  });

  useEffect(() => {
    if (data?.agentId) {
      navigate(`/share/${data.agentId}`, { replace: true });
    }
  }, [data, navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col bg-bg">
        <SignInBanner />
        <div className="p-7">
          <p className="font-mono text-xs text-fg-3">Live demo is not available yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <SignInBanner />
      <div className="p-7">
        <p className="font-mono text-xs text-fg-3">Loading demo…</p>
      </div>
    </div>
  );
}
