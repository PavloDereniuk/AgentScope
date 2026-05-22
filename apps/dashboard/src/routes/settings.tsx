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
import { formatPausedUntil } from '@/lib/format-paused';
import { cn } from '@/lib/utils';
import {
  ALERT_RULE_NAMES,
  type AlertRuleName,
  type AlertRuleThresholds,
  PAUSE_FOREVER,
  isAlertsPaused,
  isPausedForever,
  isRulePaused,
} from '@agentscope/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Copy, Loader2, PauseCircle, Play, Save, Trash2 } from 'lucide-react';
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
  alertsPausedUntil: string | null;
  ingestToken?: string;
  alertRules: AlertRuleThresholds | null;
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
  // Tracks unsaved edits to delivery-channel fields (telegramChatId,
  // webhookUrl). The test-alert endpoint reads from the DB, not the form,
  // so firing it with a dirty form would test stale state. Cleared on save
  // and on agent switch.
  const [notificationsDirty, setNotificationsDirty] = useState(false);
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
      setNotificationsDirty(false);
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

  // Epic 18 — Pause/resume notifications. Posts the new `alertsPausedUntil`
  // value through the same PATCH endpoint as the rest of the settings form
  // but commits immediately (no "Save changes" press required) — the pause
  // state is a discrete user action, not a free-form edit.
  const pauseMutation = useMutation({
    mutationFn: (alertsPausedUntil: string | null) =>
      apiClient.patch<{ agent: AgentRow }>(`/api/agents/${selectedId}`, { alertsPausedUntil }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent', selectedId] });
      toast.success(variables === null ? 'Notifications resumed.' : 'Notifications paused.');
    },
    onError: (err) => {
      toast.error(`Failed: ${(err as Error).message}`);
    },
  });

  // Epic 18.3 — Per-rule pause. PATCH the whole `alertRules` jsonb because
  // the API treats the field atomically; the caller composes the next
  // `pausedUntil` map by merging the change with the current `selected`
  // row, so threshold values never get clobbered. Commits immediately.
  const perRulePauseMutation = useMutation({
    mutationFn: (alertRules: AlertRuleThresholds) =>
      apiClient.patch<{ agent: AgentRow }>(`/api/agents/${selectedId}`, { alertRules }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent', selectedId] });
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
    setNotificationsDirty(false);
    mutation.reset();
  }, [selectedId]);

  /**
   * Set or clear the pausedUntil entry for one rule and PATCH the result.
   * Merges with the current `selected.alertRules` so thresholds are
   * preserved. An empty pausedUntil map is acceptable — the detector
   * treats missing keys and empty maps identically (`?.[ruleName]` is
   * undefined in both cases), so we don't bother stripping the field.
   */
  function updateRulePause(ruleName: AlertRuleName, untilIso: string | null) {
    const current = selected?.alertRules ?? {};
    const nextMap: Partial<Record<AlertRuleName, string>> = { ...(current.pausedUntil ?? {}) };
    if (untilIso === null) {
      delete nextMap[ruleName];
    } else {
      nextMap[ruleName] = untilIso;
    }
    const next: AlertRuleThresholds = { ...current, pausedUntil: nextMap };
    perRulePauseMutation.mutate(next, {
      onSuccess: () =>
        toast.success(untilIso === null ? `Resumed ${ruleName}.` : `Paused ${ruleName}.`),
    });
  }

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
    // The matching reset timer lives in the useEffect below so it's torn
    // down with the component instead of leaking a setState-after-unmount.
  }

  // Auto-reset copy state after 1.4 s. Effect cleanup cancels the timer if
  // the user re-clicks (state already 'copied' → effect re-runs) or
  // unmounts the page mid-flight, sidestepping the unmount warning.
  useEffect(() => {
    if (copyState === 'idle') return;
    const id = window.setTimeout(() => setCopyState('idle'), 1400);
    return () => window.clearTimeout(id);
  }, [copyState]);

  return (
    <div className="p-7">
      <form key={selectedId} onSubmit={handleSubmit}>
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
                <PauseControls
                  selectedId={selectedId}
                  alertsPausedUntil={selected?.alertsPausedUntil ?? null}
                  onUpdate={(v) => pauseMutation.mutate(v)}
                  isPending={pauseMutation.isPending}
                />
                <PerRulePauseControls
                  selectedId={selectedId}
                  alertRules={selected?.alertRules ?? null}
                  onUpdate={updateRulePause}
                  isPending={perRulePauseMutation.isPending}
                />
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
                          setNotificationsDirty(true);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => testAlertMutation.mutate()}
                        disabled={!selectedId || testAlertMutation.isPending || notificationsDirty}
                        title={
                          notificationsDirty
                            ? 'Save changes first — test alert reads from the saved settings.'
                            : undefined
                        }
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
                      onChange={() => setNotificationsDirty(true)}
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
                      onChange={() => setNotificationsDirty(true)}
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

/**
 * Pause / resume the notification pipeline for one agent. Hits PATCH
 * directly (independent of the form's Save button) since the user-facing
 * affordance is a discrete action, not a free-form edit.
 *
 * "Forever" maps to the PAUSE_FOREVER ISO sentinel (year 9999) so the
 * column can stay a single nullable timestamp — see packages/shared/pause.ts.
 */
function PauseControls({
  selectedId,
  alertsPausedUntil,
  onUpdate,
  isPending,
}: {
  selectedId: string;
  alertsPausedUntil: string | null;
  onUpdate: (alertsPausedUntil: string | null) => void;
  isPending: boolean;
}) {
  const now = new Date();
  const paused = isAlertsPaused(alertsPausedUntil, now);
  const forever = isPausedForever(alertsPausedUntil);

  const presets = [
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
    { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  ] as const;

  const btnBase = cn(
    'inline-flex h-6 items-center gap-1 rounded-sm border border-line px-2',
    'font-mono text-[10.5px] text-fg-2 hover:border-fg-3 hover:text-fg',
    'disabled:opacity-50 disabled:cursor-not-allowed',
  );

  if (paused && alertsPausedUntil) {
    const until = new Date(alertsPausedUntil);
    const display = formatPausedUntil(alertsPausedUntil, now);
    return (
      <div className="rounded-[5px] border border-[color:color-mix(in_oklch,var(--warn)_35%,var(--line))] bg-[color:color-mix(in_oklch,var(--warn)_8%,transparent)] px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <PauseCircle className="h-3.5 w-3.5 text-warn" />
            <span className="font-mono text-[11.5px] text-warn">
              Notifications paused
              {forever ? ' indefinitely' : ` · resumes in ${display}`}
            </span>
          </div>
          <button
            type="button"
            disabled={isPending || !selectedId}
            onClick={() => onUpdate(null)}
            className={btnBase}
          >
            {isPending ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <Play className="h-2.5 w-2.5" />
            )}
            Resume now
          </button>
        </div>
        {!forever ? (
          <p className="mt-1.5 font-mono text-[11px] text-fg-3">
            Until {until.toLocaleString()}. Alerts still appear in the feed but are not delivered.
          </p>
        ) : (
          <p className="mt-1.5 font-mono text-[11px] text-fg-3">
            Alerts still appear in the feed but are not delivered until you resume.
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <FieldLabel hint="alerts still appear in feed when paused">Pause notifications</FieldLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] text-fg-3">For:</span>
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            disabled={isPending || !selectedId}
            onClick={() => onUpdate(new Date(Date.now() + p.ms).toISOString())}
            className={btnBase}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          disabled={isPending || !selectedId}
          onClick={() => onUpdate(PAUSE_FOREVER)}
          className={btnBase}
        >
          Forever
        </button>
        {isPending ? <Loader2 className="ml-1 h-3 w-3 animate-spin text-fg-3" /> : null}
      </div>
    </div>
  );
}

/**
 * Per-rule pause control. Each row: rule label · status pill · inline
 * action. Active rules expose a native `<select>` whose options are the
 * same presets as the global pause (1h / 24h / 7d / Forever); paused
 * rules expose a "Resume" button that clears the entry. PATCH fires
 * immediately on selection — like global pause, this is a discrete user
 * action, not a free-form edit.
 *
 * Native `<select>` over a custom dropdown to avoid pulling in a new
 * UI dep post Week-1 freeze; we reset its value after each pick so the
 * placeholder ("Pause…") sticks around for repeated use.
 */
function PerRulePauseControls({
  selectedId,
  alertRules,
  onUpdate,
  isPending,
}: {
  selectedId: string;
  alertRules: AlertRuleThresholds | null;
  onUpdate: (ruleName: AlertRuleName, untilIso: string | null) => void;
  isPending: boolean;
}) {
  const now = new Date();

  function presetIso(label: string): string {
    if (label === 'forever') return PAUSE_FOREVER;
    const ms =
      label === '1h'
        ? 60 * 60 * 1000
        : label === '24h'
          ? 24 * 60 * 60 * 1000
          : label === '7d'
            ? 7 * 24 * 60 * 60 * 1000
            : 0;
    return new Date(Date.now() + ms).toISOString();
  }

  return (
    <div>
      <FieldLabel hint="silence specific rules without muting the agent">Per-rule pause</FieldLabel>
      <div className="overflow-hidden rounded-[5px] border border-line bg-surface-2">
        {ALERT_RULE_NAMES.map((ruleName, idx) => {
          const paused = isRulePaused(alertRules, ruleName, now);
          const untilIso = paused ? (alertRules?.pausedUntil?.[ruleName] ?? null) : null;
          const display = formatPausedUntil(untilIso, now);
          return (
            <div
              key={ruleName}
              className={cn(
                'flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5',
                idx > 0 ? 'border-t border-line' : '',
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="font-mono text-[12px] text-fg">{RULE_LABELS[ruleName]}</span>
                {paused ? (
                  <span
                    title={untilIso ?? undefined}
                    className="inline-flex items-center gap-1 rounded-sm border border-[color:color-mix(in_oklch,var(--warn)_22%,var(--line))] bg-[color:color-mix(in_oklch,var(--warn)_5%,transparent)] px-1.5 py-px font-mono text-[10px] text-warn"
                  >
                    paused · {display || '—'}
                  </span>
                ) : (
                  <span className="font-mono text-[10.5px] tracking-[0.04em] text-fg-3">
                    active
                  </span>
                )}
              </div>
              {paused ? (
                <button
                  type="button"
                  disabled={isPending || !selectedId}
                  onClick={() => onUpdate(ruleName, null)}
                  className={cn(
                    'inline-flex h-5 items-center gap-1 rounded-sm border border-line px-1.5',
                    'font-mono text-[10px] text-fg-2 hover:border-fg-3 hover:text-fg',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                >
                  <Play className="h-2.5 w-2.5" />
                  Resume
                </button>
              ) : (
                <select
                  // Re-mount on every render of "active" state so the placeholder
                  // option is always pre-selected — without this the previous
                  // pick would stay visible after toast.
                  key={`pick-${ruleName}-${untilIso ?? 'none'}`}
                  defaultValue=""
                  disabled={isPending || !selectedId}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (!val) return;
                    onUpdate(ruleName, presetIso(val));
                    e.currentTarget.value = '';
                  }}
                  className={cn(
                    'h-5 cursor-pointer rounded-sm border border-line bg-transparent px-1.5',
                    'font-mono text-[10px] text-fg-2 hover:border-fg-3 hover:text-fg',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                >
                  <option value="">Pause…</option>
                  <option value="1h">1 hour</option>
                  <option value="24h">24 hours</option>
                  <option value="7d">7 days</option>
                  <option value="forever">Forever</option>
                </select>
              )}
            </div>
          );
        })}
      </div>
      {isPending ? (
        <p className="mt-1.5 inline-flex items-center gap-1 font-mono text-[10.5px] text-fg-3">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          saving…
        </p>
      ) : null}
    </div>
  );
}

/**
 * Human labels for the 8 alert rule names. Keys match `AlertRuleName`
 * exactly so the rule list iterates `ALERT_RULE_NAMES` (single source
 * of truth from shared) and TS guarantees we never miss a rule.
 */
const RULE_LABELS: Record<AlertRuleName, string> = {
  slippage_spike: 'Slippage spike',
  gas_spike: 'Gas spike',
  drawdown: 'Drawdown',
  error_rate: 'Error rate',
  stale_agent: 'Stale agent',
  decision_swap_mismatch: 'Decision/swap mismatch',
  stale_oracle: 'Stale oracle',
  ghost_execution: 'Ghost execution',
  slippage_sandwich: 'MEV sandwich',
};

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
