import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { FileText, Hash, Search, Sparkles } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface SearchHit {
  type: 'agent' | 'tx' | 'trace';
  id: string;
  label: string;
  hint: string;
}
interface SearchResponse {
  q: string;
  results: SearchHit[];
}

const DEBOUNCE_MS = 150;

/**
 * Global ⌘K (or Ctrl+K on Windows/Linux) command palette. Live-searches
 * across agents, transactions, and reasoning traces via /api/search;
 * arrows navigate the result list, Enter routes to the selection,
 * Escape closes.
 *
 * Mounted once at the app root so the shortcut works on every route.
 * The palette is not rendered inside a route boundary — it has no
 * authenticated-only content until the user opens it, and the /search
 * endpoint already rejects unauth'd requests with 401.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Global shortcut — ⌘K on macOS, Ctrl+K elsewhere. We check e.key === 'k'
  // and the platform modifier so Ctrl+K in Chrome (which focuses the
  // omnibox on macOS) doesn't double-fire, and so IMEs composing a key
  // don't accidentally open the palette.
  useEffect(() => {
    function onKeydown(e: globalThis.KeyboardEvent) {
      const mod = navigator.platform.toLowerCase().includes('mac') ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, []);

  // Debounce the query so we don't spam /api/search on every keystroke.
  // 150ms is below the threshold users notice but above the time a
  // deliberate typer spends on a single character.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q]);

  // Reset the input when the palette opens so a stale query doesn't
  // surface on the next invocation. Focus is driven via ref rather than
  // the `autoFocus` attribute to keep biome's a11y rule happy — same
  // effect, explicit intent.
  useEffect(() => {
    if (open) {
      setQ('');
      setDebounced('');
      setHighlighted(0);
      // Wait a frame so the Dialog's portal is mounted and the input
      // exists in the DOM before we call focus().
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const searchQuery = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => apiClient.get<SearchResponse>(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length > 0,
    staleTime: 30_000,
  });

  const results = useMemo(() => searchQuery.data?.results ?? [], [searchQuery.data]);

  // Clamp the highlight cursor whenever the result list shrinks, so a
  // stale index never drives navigation off the end of the array.
  useEffect(() => {
    if (highlighted >= results.length) setHighlighted(0);
  }, [results.length, highlighted]);

  function go(hit: SearchHit) {
    const path =
      hit.type === 'agent'
        ? `/agents/${hit.id}`
        : hit.type === 'tx'
          ? `/agents?tx=${encodeURIComponent(hit.id)}`
          : `/reasoning?trace=${encodeURIComponent(hit.id)}`;
    setOpen(false);
    navigate(path);
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      const hit = results[highlighted];
      if (hit) {
        e.preventDefault();
        go(hit);
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Command Palette</DialogTitle>
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-3">
          <Search className="h-4 w-4 shrink-0 text-fg-3" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search agents, transactions, traces…"
            className="flex-1 bg-transparent font-mono text-[13px] text-fg outline-none placeholder:text-fg-3"
          />
          <kbd className="hidden rounded border border-line bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-fg-3 sm:inline-block">
            esc
          </kbd>
        </div>

        <div className="max-h-[360px] overflow-y-auto">
          {debounced.length === 0 ? (
            <EmptyHint />
          ) : searchQuery.isLoading ? (
            <RowMessage text="Searching…" />
          ) : results.length === 0 ? (
            <RowMessage text={`No matches for "${debounced}"`} />
          ) : (
            <div className="py-1">
              {results.map((hit, i) => (
                <button
                  key={`${hit.type}-${hit.id}`}
                  type="button"
                  aria-pressed={i === highlighted}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => go(hit)}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-2.5 text-left',
                    i === highlighted ? 'bg-surface-3' : 'hover:bg-surface-3',
                  )}
                >
                  <TypeIcon type={hit.type} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12.5px] text-fg">{hit.label}</div>
                    <div className="truncate font-mono text-[11px] text-fg-3">{hit.hint}</div>
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                    {hit.type}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-4 py-2 font-mono text-[10px] text-fg-3">
          <Shortcut keys={['↑', '↓']} label="navigate" />
          <Shortcut keys={['↵']} label="open" />
          <Shortcut keys={['esc']} label="close" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TypeIcon({ type }: { type: SearchHit['type'] }) {
  const Icon = type === 'agent' ? Sparkles : type === 'tx' ? Hash : FileText;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-fg-2" />;
}

function RowMessage({ text }: { text: string }) {
  return <div className="px-4 py-8 text-center font-mono text-[11.5px] text-fg-3">{text}</div>;
}

function EmptyHint() {
  return (
    <div className="px-4 py-6 font-mono text-[11.5px] text-fg-3">
      <p>Type to search across agents, transactions, and reasoning traces.</p>
      <p className="mt-2 text-[10.5px]">Ownership is enforced — you only see what you own.</p>
    </div>
  );
}

function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="rounded border border-line bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-fg-2"
        >
          {k}
        </kbd>
      ))}
      <span className="text-fg-3">{label}</span>
    </span>
  );
}
