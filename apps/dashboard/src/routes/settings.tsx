import { LinkTelegramDialog } from '@/components/LinkTelegramDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Copy, Loader2, Save, Trash2 } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

interface AgentRow {
  id: string;
  name: string;
  walletPubkey: string;
  webhookUrl: string | null;
  telegramChatId: string | null;
  ingestToken?: string;
  alertRules: {
    slippagePctThreshold?: number;
    gasMultThreshold?: number;
    drawdownPctThreshold?: number;
    errorRatePctThreshold?: number;
    staleMinutesThreshold?: number;
  } | null;
  recentTxCount24h?: number;
  solDelta24h?: string;
  successRate24h?: number | null;
}

interface AgentDetailResponse {
  agent: AgentRow;
}

/** Regex mirrors shared/src/schemas.ts telegramChatIdSchema. */
const TELEGRAM_CHAT_ID_RE = /^-?\d{1,32}$/;

export function SettingsPage() {
  const [selectedId, setSelectedId] = useState<string>('');
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [telegramChatIdError, setTelegramChatIdError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  // Ref to the chat_id input so LinkTelegramDialog can prefill it without
  // promoting the field to controlled state (the rest of the form is
  // FormData-driven and converting one field would force converting all).
  const telegramChatIdInputRef = useRef<HTMLInputElement | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: list } = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiClient.get<{ agents: AgentRow[] }>('/api/agents'),
  });
  const agents = list?.agents ?? [];

  useEffect(() => {
    if (!selectedId && agents.length > 0 && agents[0]) {
      setSelectedId(agents[0].id);
    }
  }, [agents, selectedId]);

  // Detail fetch brings the ingestToken into the page cache.
  const { data: detail } = useQuery({
    queryKey: ['agent', selectedId],
    queryFn: () => apiClient.get<AgentDetailResponse>(`/api/agents/${selectedId}`),
    enabled: Boolean(selectedId),
  });
  const selected = detail?.agent;

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiClient.patch<{ agent: AgentRow }>(`/api/agents/${selectedId}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent', selectedId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiClient.delete(`/api/agents/${selectedId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setDeleteOpen(false);
      navigate('/agents');
    },
  });

  // 13.8 — Smoke-test the notification pipeline. Posts to the test-alert
  // endpoint and reports the result via sonner toast. Delivery runs through
  // the same router the detector uses so a green toast means "Telegram
  // credentials work and the bot can reach this chat".
  const testAlertMutation = useMutation({
    mutationFn: () =>
      apiClient.post<{ ok: boolean; delivered: boolean; channel?: string }>(
        `/api/agents/${selectedId}/test-alert`,
        {},
      ),
    onSuccess: (data) => {
      // Non-2xx (503 unconfigured / 502 downstream failure) throws
      // ApiError and flows into onError below — this branch only fires
      // when the backend actually handed the message to the channel.
      const channel = data.channel ?? 'telegram';
      toast.success(`Test alert sent via ${channel} — check your inbox.`);
    },
    onError: (err) => {
      toast.error(`Failed: ${(err as Error).message}`);
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally only depend on selectedId
  useEffect(() => {
    if (!selectedId) return;
    setWebhookError(null);
    setTelegramChatIdError(null);
    mutation.reset();
  }, [selectedId]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    const webhookInput = (fd.get('webhookUrl') as string) || '';
    let webhookUrl: string | null = null;
    if (webhookInput.trim().length > 0) {
      try {
        const parsed = new URL(webhookInput);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setWebhookError('Webhook URL must use http:// or https://');
          return;
        }
        webhookUrl = parsed.toString();
      } catch {
        setWebhookError('Webhook URL is not a valid URL');
        return;
      }
    }
    setWebhookError(null);

    const telegramChatIdInput = ((fd.get('telegramChatId') as string) || '').trim();
    let telegramChatId: string | null = null;
    if (telegramChatIdInput.length > 0) {
      if (!TELEGRAM_CHAT_ID_RE.test(telegramChatIdInput)) {
        setTelegramChatIdError('Chat ID must be numeric (e.g. 123456789 or -100123456789)');
        return;
      }
      telegramChatId = telegramChatIdInput;
    }
    setTelegramChatIdError(null);

    const alertRules: Record<string, number> = {};
    const fields = [
      'slippagePctThreshold',
      'gasMultThreshold',
      'drawdownPctThreshold',
      'errorRatePctThreshold',
      'staleMinutesThreshold',
    ] as const;
    for (const field of fields) {
      const val = fd.get(field) as string;
      const num = Number(val);
      if (val && !Number.isNaN(num) && num > 0) alertRules[field] = num;
    }

    const body: Record<string, unknown> = { webhookUrl, telegramChatId };
    if (Object.keys(alertRules).length > 0) body.alertRules = alertRules;
    mutation.mutate(body);
  }

  async function copyToken() {
    if (!selected?.ingestToken) return;
    try {
      await navigator.clipboard.writeText(selected.ingestToken);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    window.setTimeout(() => setCopyState('idle'), 1400);
  }

  return (
    <div className="p-7">
      <form onSubmit={handleSubmit}>
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <p className="mt-1.5 text-[13px] text-fg-3">
              Per-agent alert thresholds, webhooks & ingest tokens.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={mutation.isPending || !selectedId}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-[5px] bg-accent px-2.5',
                'font-mono text-[11.5px] font-medium tracking-tight',
                'text-[color:var(--primary-foreground)] transition-[filter] hover:brightness-110',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {mutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              <span>Save changes</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 max-[960px]:grid-cols-1">
          <div className="flex flex-col gap-4">
            <Card title="Agent" meta="select to configure">
              <div className="px-4 py-4">
                <FieldLabel>Active agent</FieldLabel>
                <div className="flex items-center rounded-[5px] border border-line bg-surface-2 px-2.5 py-1.5">
                  <select
                    value={selectedId}
                    onChange={(e) => setSelectedId(e.target.value)}
                    className="w-full cursor-pointer bg-transparent font-mono text-[12.5px] text-fg outline-none"
                  >
                    {agents.length === 0 ? <option value="">no agents</option> : null}
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} — {a.walletPubkey.slice(0, 8)}…
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </Card>

            <Card title="Anomaly Thresholds" meta="overrides global defaults">
              <div className="grid gap-3.5 px-4 py-4">
                <ThresholdInput
                  name="slippagePctThreshold"
                  label="Slippage spike"
                  hint="fires at ≥ value · critical at 5× threshold"
                  suffix="%"
                  step="0.1"
                  defaultValue={selected?.alertRules?.slippagePctThreshold}
                />
                <ThresholdInput
                  name="gasMultThreshold"
                  label="Gas spike"
                  hint="multiple of 24h median fee"
                  suffix="×"
                  step="0.5"
                  defaultValue={selected?.alertRules?.gasMultThreshold}
                />
                <ThresholdInput
                  name="errorRatePctThreshold"
                  label="Error rate (1h)"
                  hint="% failed tx in rolling window"
                  suffix="%"
                  step="1"
                  defaultValue={selected?.alertRules?.errorRatePctThreshold}
                />
                <ThresholdInput
                  name="drawdownPctThreshold"
                  label="Drawdown (1h)"
                  hint="% PnL loss"
                  suffix="%"
                  step="1"
                  defaultValue={selected?.alertRules?.drawdownPctThreshold}
                />
                <ThresholdInput
                  name="staleMinutesThreshold"
                  label="Stale agent"
                  hint="minutes of inactivity"
                  suffix="min"
                  step="1"
                  defaultValue={selected?.alertRules?.staleMinutesThreshold}
                />
              </div>
            </Card>
          </div>

          <div className="flex flex-col gap-4">
            <Card title="Ingest Token" meta="secret · rotate if leaked">
              <div className="px-4 py-4">
                <FieldLabel>OTLP agent.token</FieldLabel>
                <div className="flex items-center gap-2 rounded-[5px] border border-line bg-surface-2 px-2.5 py-1.5">
                  <input
                    value={selected?.ingestToken ?? ''}
                    readOnly
                    className="flex-1 bg-transparent font-mono text-[11.5px] text-fg outline-none"
                  />
                  <button
                    type="button"
                    onClick={copyToken}
                    disabled={!selected?.ingestToken}
                    className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] text-fg-2 hover:border-fg-3 hover:text-fg disabled:opacity-50"
                  >
                    <Copy className="h-2.5 w-2.5" />
                    {copyState === 'copied' ? 'copied' : copyState === 'error' ? 'failed' : 'copy'}
                  </button>
                </div>
                <p className="mt-2.5 font-mono text-[11px] text-fg-3">
                  Set as <span className="text-accent">agent.token</span> resource attribute in your
                  OTel SDK.
                </p>
              </div>
            </Card>

            <Card title="Notifications" meta="delivery channels">
              <div className="grid gap-3.5 px-4 py-4">
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <FieldLabel>Telegram chat ID</FieldLabel>
                    <div className="flex items-center gap-1.5">
                      <LinkTelegramDialog
                        disabled={!selectedId}
                        onLinked={(chatId) => {
                          if (telegramChatIdInputRef.current) {
                            telegramChatIdInputRef.current.value = chatId;
                          }
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => testAlertMutation.mutate()}
                        disabled={!selectedId || testAlertMutation.isPending}
                        className={cn(
                          'inline-flex h-6 items-center gap-1.5 rounded-sm border border-line px-2',
                          'font-mono text-[10.5px] text-fg-2 hover:border-fg-3 hover:text-fg',
                          'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                      >
                        {testAlertMutation.isPending ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : (
                          <Bell className="h-2.5 w-2.5" />
                        )}
                        Send test alert
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center rounded-[5px] border border-line bg-surface-2 px-2.5 py-1.5">
                    <input
                      ref={telegramChatIdInputRef}
                      name="telegramChatId"
                      type="text"
                      inputMode="numeric"
                      placeholder="123456789"
                      defaultValue={selected?.telegramChatId ?? ''}
                      className="w-full bg-transparent font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-3"
                    />
                  </div>
                  <p className="mt-2 font-mono text-[11px] text-fg-3">
                    One-click: tap <span className="font-mono text-fg">Link Telegram</span>. Manual:
                    message{' '}
                    <a
                      href="https://t.me/userinfobot"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      @userinfobot
                    </a>{' '}
                    and paste the numeric id.
                  </p>
                </div>
                <div>
                  <FieldLabel>Webhook URL</FieldLabel>
                  <div className="flex items-center rounded-[5px] border border-line bg-surface-2 px-2.5 py-1.5">
                    <input
                      name="webhookUrl"
                      type="url"
                      placeholder="https://example.com/webhook"
                      defaultValue={selected?.webhookUrl ?? ''}
                      className="w-full bg-transparent font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-3"
                    />
                  </div>
                  <p className="mt-2 font-mono text-[11px] text-fg-3">
                    When set, takes precedence over Telegram. Accepts Discord/Slack incoming
                    webhooks or any POST-JSON endpoint.
                  </p>
                </div>
                <div>
                  <FieldLabel hint="post-MVP">Discord webhook</FieldLabel>
                  <div className="flex items-center rounded-[5px] border border-line bg-surface-2 px-2.5 py-1.5 opacity-50">
                    <input
                      disabled
                      placeholder="https://discord.com/api/webhooks/…"
                      className="w-full bg-transparent font-mono text-[12.5px] outline-none placeholder:text-fg-3"
                    />
                  </div>
                </div>
                <div>
                  <FieldLabel hint="post-MVP">Slack webhook</FieldLabel>
                  <div className="flex items-center rounded-[5px] border border-line bg-surface-2 px-2.5 py-1.5 opacity-50">
                    <input
                      disabled
                      placeholder="https://hooks.slack.com/services/…"
                      className="w-full bg-transparent font-mono text-[12.5px] outline-none placeholder:text-fg-3"
                    />
                  </div>
                </div>
              </div>
            </Card>

            <Card title="Danger Zone" meta="irreversible">
              <div className="px-4 py-4">
                <p className="mb-3 text-[13px] text-fg-2">
                  Delete <span className="font-mono text-fg">{selected?.name ?? '—'}</span> and
                  cascade all transactions, reasoning logs and alerts. This action cannot be undone.
                </p>
                <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                  <DialogTrigger asChild>
                    <button
                      type="button"
                      disabled={!selectedId}
                      className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded-[5px] border px-2.5',
                        'font-mono text-[11.5px] font-medium text-crit',
                        'border-[color:color-mix(in_oklch,var(--crit)_35%,var(--line))] bg-surface-2',
                        'hover:bg-[color:color-mix(in_oklch,var(--crit)_12%,var(--bg-2))]',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                      )}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete agent
                    </button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Delete agent</DialogTitle>
                      <DialogDescription>
                        This will permanently delete <strong>{selected?.name}</strong> and all
                        related data.
                      </DialogDescription>
                    </DialogHeader>
                    {deleteMutation.isError ? (
                      <p className="font-mono text-xs text-crit">
                        {(deleteMutation.error as Error).message}
                      </p>
                    ) : null}
                    <DialogFooter>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          deleteMutation.reset();
                          setDeleteOpen(false);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate()}
                      >
                        {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </Card>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3 text-[12px]">
          {webhookError ? <p className="text-crit">{webhookError}</p> : null}
          {telegramChatIdError ? <p className="text-crit">{telegramChatIdError}</p> : null}
          {mutation.error ? <p className="text-crit">{(mutation.error as Error).message}</p> : null}
          {mutation.isSuccess ? <p className="text-accent">Settings saved.</p> : null}
        </div>
      </form>
    </div>
  );
}

function Card({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface-2">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-2">{title}</span>
        {meta ? (
          <span className="font-mono text-[10.5px] tracking-[0.04em] text-fg-3">{meta}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 flex justify-between font-mono text-[10.5px] uppercase tracking-[0.08em] text-fg-3">
      <span>{children}</span>
      {hint ? (
        <span className="normal-case tracking-normal text-[11px] text-fg-3">{hint}</span>
      ) : null}
    </div>
  );
}

function ThresholdInput({
  name,
  label,
  hint,
  suffix,
  step,
  defaultValue,
}: {
  name: string;
  label: string;
  hint: string;
  suffix: string;
  step: string;
  defaultValue?: number | undefined;
}) {
  return (
    <div>
      <FieldLabel hint={hint}>{label}</FieldLabel>
      <div className="flex items-center gap-2 rounded-[5px] border border-line bg-surface-2 px-2.5 py-1.5">
        <input
          name={name}
          type="number"
          step={step}
          defaultValue={defaultValue ?? ''}
          className="flex-1 bg-transparent font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-3"
        />
        <span className="font-mono text-[11px] text-fg-3">{suffix}</span>
      </div>
    </div>
  );
}
