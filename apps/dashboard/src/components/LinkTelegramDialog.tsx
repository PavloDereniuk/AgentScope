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

const POLL_MS = 2_000;

export interface LinkTelegramDialogProps {
  /** Called when the bot successfully links a chat. */
  onLinked: (chatId: string) => void;
  /** Optional disabled state from the parent. */
  disabled?: boolean;
}

type Phase = 'idle' | 'init' | 'awaiting' | 'linked' | 'expired' | 'unsupported' | 'error';

export function LinkTelegramDialog({ onLinked, disabled }: LinkTelegramDialogProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [link, setLink] = useState<InitResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Track whether the dialog is still open so an in-flight poll/init can
  // bail out without dispatching state to an unmounted modal.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // (Re)issue a code whenever the dialog transitions from closed → open.
  useEffect(() => {
    if (!open) {
      // Reset everything so a re-open starts clean (no stale "linked"
      // state from a prior session leaking the next user's flow).
      setPhase('idle');
      setLink(null);
      setErrorMsg(null);
      return;
    }

    let cancelled = false;
    setPhase('init');
    setErrorMsg(null);

    apiClient
      .post<InitResponse>('/api/telegram/init', {})
      .then((data) => {
        if (cancelled || !openRef.current) return;
        setLink(data);
        setPhase('awaiting');
      })
      .catch((err: unknown) => {
        if (cancelled || !openRef.current) return;
        if (err instanceof ApiError && err.status === 503) {
          setPhase('unsupported');
          return;
        }
        setPhase('error');
        setErrorMsg(err instanceof Error ? err.message : 'failed to issue link');
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

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
    // Re-trigger the open-effect by toggling phase back to init, and
    // fire a fresh /init request directly.
    setPhase('init');
    setErrorMsg(null);
    apiClient
      .post<InitResponse>('/api/telegram/init', {})
      .then((data) => {
        if (!openRef.current) return;
        setLink(data);
        setPhase('awaiting');
      })
      .catch((err: unknown) => {
        if (!openRef.current) return;
        setPhase('error');
        setErrorMsg(err instanceof Error ? err.message : 'failed to issue link');
      });
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
