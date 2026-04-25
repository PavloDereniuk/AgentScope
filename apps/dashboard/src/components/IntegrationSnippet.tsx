import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

type Tab = 'elizaos' | 'agent-kit' | 'curl';

const TABS: { id: Tab; label: string }[] = [
  { id: 'elizaos', label: 'ElizaOS' },
  { id: 'agent-kit', label: 'Agent Kit' },
  { id: 'curl', label: 'curl' },
];

interface IntegrationSnippetProps {
  apiUrl: string;
  /**
   * Per-agent ingest token. When omitted (e.g. agents-empty-state) the
   * component renders a placeholder (`process.env.AGENTSCOPE_TOKEN`) plus
   * a banner explaining that the token only exists after registration.
   */
  agentToken?: string | undefined;
  /** Drives header copy + default collapsed state. */
  hasTraffic?: boolean | undefined;
}

const FALLBACK_API_URL = 'https://api.agentscope.example';
const TOKEN_PLACEHOLDER = 'process.env.AGENTSCOPE_TOKEN';

export function IntegrationSnippet({
  apiUrl,
  agentToken,
  hasTraffic = false,
}: IntegrationSnippetProps) {
  // Auto-collapse once traffic arrives — once the user proves the wiring
  // works the snippet is just noise. They can still expand it manually.
  const [open, setOpen] = useState(!hasTraffic);
  const [tab, setTab] = useState<Tab>('elizaos');

  useEffect(() => {
    setOpen(!hasTraffic);
  }, [hasTraffic]);

  const resolvedApi = apiUrl?.trim() ? apiUrl.replace(/\/+$/, '') : FALLBACK_API_URL;
  const tokenLiteral = agentToken ?? TOKEN_PLACEHOLDER;
  const tokenIsPlaceholder = !agentToken;

  const snippet = useMemo(
    () => buildSnippet(tab, resolvedApi, tokenLiteral, tokenIsPlaceholder),
    [tab, resolvedApi, tokenLiteral, tokenIsPlaceholder],
  );

  return (
    <section
      aria-label="Integration snippet"
      className="overflow-hidden rounded-md border border-line bg-surface-2"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 border-b border-line px-4 py-3 text-left transition-colors hover:bg-surface-3"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-2">
          {hasTraffic ? (
            <>
              <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
              Receiving traces
            </>
          ) : (
            <>
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-warn shadow-[0_0_0_3px_color-mix(in_oklch,var(--warn)_25%,transparent)]"
              />
              Start sending data
            </>
          )}
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-fg-3" aria-hidden />
        ) : (
          <ChevronDown className="h-4 w-4 text-fg-3" aria-hidden />
        )}
      </button>

      {open ? (
        <div className="space-y-3 p-4">
          {tokenIsPlaceholder ? (
            <p className="rounded-[5px] border border-line-soft bg-surface px-3 py-2 font-mono text-[11px] text-fg-3">
              Create an agent first to get your ingest token. The snippet below uses{' '}
              <code className="text-fg-2">AGENTSCOPE_TOKEN</code> as a placeholder.
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <div role="tablist" aria-label="Integration framework" className="flex gap-0">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'relative px-3 py-1.5 font-mono text-[11px] tracking-wide transition-colors',
                    tab === t.id ? 'text-fg' : 'text-fg-3 hover:text-fg-2',
                  )}
                >
                  {t.label}
                  {tab === t.id ? (
                    <span
                      aria-hidden
                      className="absolute -bottom-px left-2 right-2 h-[1.5px] bg-accent"
                    />
                  ) : null}
                </button>
              ))}
            </div>
            <CopyButton text={snippet} />
          </div>

          <pre className="overflow-x-auto rounded-[5px] border border-line bg-surface px-3 py-3 font-mono text-[12px] leading-relaxed text-fg-2">
            <code>{snippet}</code>
          </pre>

          {!tokenIsPlaceholder ? (
            <p className="font-mono text-[10.5px] text-fg-3">
              Token shown above is owner-scoped — keep it server-side. Rotate by deleting and
              re-creating the agent.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 1500);
    return () => window.clearTimeout(t);
  }, [state]);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 gap-1.5 px-2.5 font-mono text-[11px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
          toast.success('Copied');
        } catch {
          setState('error');
          toast.error('Copy failed');
        }
      }}
    >
      {state === 'copied' ? (
        <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      {state === 'copied' ? 'Copied' : state === 'error' ? 'Failed' : 'Copy'}
    </Button>
  );
}

function buildSnippet(
  tab: Tab,
  apiUrl: string,
  token: string,
  tokenIsPlaceholder: boolean,
): string {
  // For real tokens, embed them as a string literal. For placeholders we
  // emit a bare process.env reference so the user has to wire env vars
  // themselves — exactly the same pattern QUICKSTART.md teaches.
  const tokenLiteral = tokenIsPlaceholder ? token : JSON.stringify(token);

  switch (tab) {
    case 'elizaos':
      return [
        "import { initAgentScope, wrapActions } from '@agentscopehq/elizaos-plugin';",
        '',
        'const sdk = initAgentScope({',
        `  apiUrl: ${JSON.stringify(apiUrl)},`,
        `  agentToken: ${tokenLiteral},`,
        '});',
        '',
        '// Wrap your plugin actions — every execution becomes a span.',
        'export const myPlugin = {',
        "  name: 'my-plugin',",
        '  actions: wrapActions([tradeAction, analyzeAction]),',
        '};',
        '',
        "process.on('SIGTERM', () => sdk.shutdown());",
      ].join('\n');
    case 'agent-kit':
      return [
        "import { initAgentScope, traced } from '@agentscopehq/agent-kit-sdk';",
        '',
        'const sdk = initAgentScope({',
        `  apiUrl: ${JSON.stringify(apiUrl)},`,
        `  agentToken: ${tokenLiteral},`,
        '});',
        '',
        '// Wrap any async action — nested traced() calls auto-parent.',
        'const sig = await traced(',
        "  'execute_trade',",
        '  () => kit.trade(mint, amountSol * 1e9, "buy"),',
        "  { 'solana.mint': mint, 'trade.amount_sol': amountSol },",
        ');',
        '',
        "process.on('SIGTERM', () => sdk.shutdown());",
      ].join('\n');
    case 'curl': {
      const tokenForCurl = tokenIsPlaceholder ? '$AGENTSCOPE_TOKEN' : token;
      return [
        `curl -X POST ${apiUrl}/v1/traces \\`,
        '  -H "Content-Type: application/json" \\',
        "  -d '{",
        '    "resourceSpans": [{',
        '      "resource": {',
        '        "attributes": [',
        `          { "key": "agent.token", "value": { "stringValue": "${tokenForCurl}" } }`,
        '        ]',
        '      },',
        '      "scopeSpans": [{',
        '        "spans": [{',
        '          "traceId": "5b8aa5a2d2c872e8321cf37308d69df2",',
        '          "spanId": "051581bf3cb55c13",',
        '          "name": "execute_trade",',
        '          "startTimeUnixNano": "1700000000000000000",',
        '          "endTimeUnixNano":   "1700000001000000000",',
        '          "attributes": [',
        '            { "key": "solana.mint", "value": { "stringValue": "So11111111111111111111111111111111111111112" } }',
        '          ]',
        '        }]',
        '      }]',
        '    }]',
        "  }'",
      ].join('\n');
    }
  }
}
