/**
 * One-click Telegram linking modal (task 14.12).
 *
 * Opens a dialog, hits POST /api/telegram/init for a fresh code + deep
 * link, shows the user a "Open Telegram" button, and polls
 * /api/telegram/status?code=… every 2s until the bot resolves the code
 * (writing chat_id back). When linked, calls `onLinked(chatId)` so the
 * parent (Settings page) can prefill the agent's telegramChatId field
 * — no manual copy-paste from @userinfobot.
 *
 * Failure modes the dialog handles cleanly:
 *  - 503 from /init     → bot not configured on backend; show fallback msg.
 *  - status.expired     → user took too long; offer "Generate new link".
 *  - dialog closed mid-poll → polling stops via the open/closed effect.
 */

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ApiError, apiClient } from '@/lib/api-client';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

interface InitResponse {
  code: string;
  deepLink: string;
  expiresInSec: number;
}

interface StatusResponse {
  linked: boolean;
  chatId?: string;
  expired?: boolean;
}

interface PendingResponse {
  count: number;
}

const POLL_MS = 2_000;

export interface LinkTelegramDialogProps {
  /** Called when the bot successfully links a chat. */
  onLinked: (chatId: string) => void;
  /** Optional disabled state from the parent. */
  disabled?: boolean;
}

type Phase =
  | 'idle'
  | 'checking'
  | 'has-pending'
  | 'init'
  | 'awaiting'
  | 'linked'
  | 'expired'
  | 'unsupported'
  | 'error';

export function LinkTelegramDialog({ onLinked, disabled }: LinkTelegramDialogProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [link, setLink] = useState<InitResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  // Track whether the dialog is still open so an in-flight poll/init can
  // bail out without dispatching state to an unmounted modal.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // On open: check /pending first so a re-opened dialog doesn't silently
  // spawn yet another binding row when the user already has live ones.
  // Zero pending → auto-issue a fresh code (unchanged UX). Non-zero →
  // stop on 'has-pending' and let the user explicitly confirm before
  // paying the DB-write + new-code cost.
  useEffect(() => {
    if (!open) {
      // Reset everything so a re-open starts clean (no stale "linked"
      // state from a prior session leaking the next user's flow).
      setPhase('idle');
      setLink(null);
      setErrorMsg(null);
      setPendingCount(0);
      return;
    }

    let cancelled = false;
    setPhase('checking');
    setErrorMsg(null);

    apiClient
      .get<PendingResponse>('/api/telegram/pending')
      .then((res) => {
        if (cancelled || !openRef.current) return;
        if (res.count > 0) {
          setPendingCount(res.count);
          setPhase('has-pending');
          return;
        }
        issueLink({ cancelledRef: () => cancelled });
      })
      .catch(() => {
        // Pending check is a best-effort guard — if it fails (network
        // blip, 5xx), fall back to the old behaviour and issue a code
        // straight away rather than blocking the user on a diagnostic.
        if (cancelled || !openRef.current) return;
        issueLink({ cancelledRef: () => cancelled });
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  function issueLink({ cancelledRef }: { cancelledRef?: () => boolean } = {}) {
    setPhase('init');
    setErrorMsg(null);
    apiClient
      .post<InitResponse>('/api/telegram/init', {})
      .then((data) => {
        if (cancelledRef?.() || !openRef.current) return;
        setLink(data);
        setPhase('awaiting');
      })
      .catch((err: unknown) => {
        if (cancelledRef?.() || !openRef.current) return;
        if (err instanceof ApiError && err.status === 503) {
          setPhase('unsupported');
          return;
        }
        setPhase('error');
        setErrorMsg(err instanceof Error ? err.message : 'failed to issue link');
      });
  }

  // Poll /status while we're awaiting the bot. Stops on link/expire/close.
  useEffect(() => {
    if (phase !== 'awaiting' || !link) return;

    let cancelled = false;
    const tick = async () => {
      if (cancelled || !openRef.current) return;
      try {
        const res = await apiClient.get<StatusResponse>(
          `/api/telegram/status?code=${encodeURIComponent(link.code)}`,
        );
        if (cancelled || !openRef.current) return;
        if (res.linked && res.chatId) {
          setPhase('linked');
          onLinked(res.chatId);
          toast.success('Telegram linked. Save settings to finish.');
          // Auto-close after the success state is visible for a beat —
          // gives the user a moment to confirm the chat_id appeared.
          setTimeout(() => {
            if (openRef.current) setOpen(false);
          }, 1_200);
          return;
        }
        if (res.expired) {
          setPhase('expired');
          return;
        }
      } catch (err: unknown) {
        if (cancelled || !openRef.current) return;
        // Soft-fail polling errors — keep retrying. A single network blip
        // shouldn't break the flow when the bot might still resolve any
        // moment now.
        // eslint-disable-next-line no-console
        console.warn('telegram status poll failed', err);
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [phase, link, onLinked]);

  function regenerate() {
    // User explicitly asked for a new code — skip the /pending guard
    // (they already saw the has-pending screen or the previous one
    // expired).
    issueLink();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2 font-mono text-[10.5px] text-fg-2 hover:border-fg-3 hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Link Telegram
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link Telegram</DialogTitle>
          <DialogDescription>
            One click to connect this agent to your personal Telegram chat.
          </DialogDescription>
        </DialogHeader>

        {phase === 'checking' ? (
          <p className="font-mono text-[12px] text-fg-3">Checking for pending links…</p>
        ) : null}

        {phase === 'has-pending' ? (
          <div className="space-y-3">
            <p className="text-[13px] text-fg-2">
              You already have{' '}
              <span className="font-mono text-fg">
                {pendingCount} pending link{pendingCount === 1 ? '' : 's'}
              </span>{' '}
              (≤ 10 min old). Open Telegram and tap any previous{' '}
              <span className="font-mono text-fg">Start</span> to complete, or generate a new one —
              the old codes stay valid until they expire.
            </p>
            <Button type="button" onClick={regenerate} className="w-full">
              Generate new link anyway
            </Button>
          </div>
        ) : null}

        {phase === 'init' ? (
          <p className="font-mono text-[12px] text-fg-3">Generating link…</p>
        ) : null}

        {phase === 'awaiting' && link ? (
          <div className="space-y-3">
            <p className="text-[13px] text-fg-2">
              1. Open the link below in Telegram.
              <br />
              2. Tap <span className="font-mono text-fg">Start</span> — the bot will reply{' '}
              <span className="font-mono text-fg">Linked.</span>
              <br />
              3. This dialog will auto-close.
            </p>
            <Button
              type="button"
              onClick={() => window.open(link.deepLink, '_blank', 'noopener,noreferrer')}
              className="w-full"
            >
              Open Telegram
            </Button>
            <div className="rounded-md border border-line bg-surface-2 px-2.5 py-1.5">
              <p className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-fg-3">
                or copy the link
              </p>
              <code className="mt-1 block break-all font-mono text-[11px] text-fg-2">
                {link.deepLink}
              </code>
            </div>
            <p className="font-mono text-[11px] text-fg-3">
              Waiting for bot response… The link expires in {Math.round(link.expiresInSec / 60)}{' '}
              min.
            </p>
          </div>
        ) : null}

        {phase === 'linked' ? (
          <p className="font-mono text-[12px] text-accent">Linked. Closing…</p>
        ) : null}

        {phase === 'expired' ? (
          <div className="space-y-2">
            <p className="text-[13px] text-fg-2">This link expired before the bot saw it.</p>
            <Button type="button" onClick={regenerate} className="w-full">
              Generate new link
            </Button>
          </div>
        ) : null}

        {phase === 'unsupported' ? (
          <p className="text-[13px] text-fg-2">
            Telegram bot is not configured on the server. Paste your chat_id manually using the
            field below the dialog.
          </p>
        ) : null}

        {phase === 'error' ? (
          <div className="space-y-2">
            <p className="text-[13px] text-crit">
              {errorMsg ?? 'Something went wrong issuing the link.'}
            </p>
            <Button type="button" variant="ghost" onClick={regenerate} className="w-full">
              Try again
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
