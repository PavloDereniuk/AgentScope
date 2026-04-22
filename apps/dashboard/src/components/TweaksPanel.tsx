import {
  DENSITIES,
  type Density,
  FONTS,
  type Font,
  PALETTES,
  type Palette,
  useTweaks,
} from '@/hooks/use-tweaks';
import { cn } from '@/lib/utils';
import { Sliders, X } from 'lucide-react';
import { useState } from 'react';

const PALETTE_SWATCH: Record<Palette, string> = {
  green: 'oklch(82% 0.18 135)',
  violet: 'oklch(72% 0.2 295)',
  cyan: 'oklch(82% 0.15 210)',
  amber: 'oklch(82% 0.16 75)',
  mono: 'oklch(96% 0.005 260)',
};

const FONT_LABEL: Record<Font, string> = {
  geist: 'Geist',
  ibm: 'IBM',
  inter: 'Inter',
};

/**
 * Floating tweaks panel — runtime theme switcher pinned to the bottom-right.
 * Visible across all dashboard routes (mounted once in App). The toggle icon
 * lives inside the panel itself rather than in the TopBar so the feature is
 * self-contained: closing the panel is symmetric with opening it.
 */
export function TweaksPanel() {
  const [open, setOpen] = useState(false);
  const { state, setPalette, setFont, setDensity, reset } = useTweaks();

  return (
    <>
      {!open ? (
        <button
          type="button"
          aria-label="Open theme tweaks"
          onClick={() => setOpen(true)}
          className={cn(
            'fixed bottom-4 right-4 z-[90] grid h-9 w-9 place-items-center rounded-full',
            'border border-line bg-surface-2 text-fg-2 shadow-[0_10px_40px_-10px_oklch(0%_0_0_/_0.7)]',
            'hover:border-fg-3 hover:text-fg transition-colors',
          )}
        >
          <Sliders className="h-4 w-4" />
        </button>
      ) : null}

      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: <dialog> would pull full modal semantics + focus trap we don't want for a floating inline panel
        <div
          role="dialog"
          aria-label="Theme tweaks"
          className={cn(
            'fixed bottom-4 right-4 z-[90] w-[240px] rounded-lg border border-line bg-surface-2 p-3.5',
            'font-mono text-[11px] shadow-[0_20px_60px_-10px_oklch(0%_0_0_/_0.6)]',
          )}
        >
          <div className="mb-3 flex items-center gap-2 font-sans text-[12px] font-semibold text-fg">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span>Tweaks</span>
            <button
              type="button"
              aria-label="Close tweaks"
              onClick={() => setOpen(false)}
              className="ml-auto text-fg-3 hover:text-fg"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <Group label="Accent">
            <div className="mt-1 grid grid-cols-5 gap-1">
              {PALETTES.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-label={`Palette ${p}`}
                  onClick={() => setPalette(p)}
                  className={cn(
                    'h-5 rounded-sm border-2 transition-[border-color]',
                    state.palette === p ? 'border-fg' : 'border-transparent',
                  )}
                  style={{ background: PALETTE_SWATCH[p] }}
                />
              ))}
            </div>
          </Group>

          <Group label="Font">
            <div className="mt-1 grid grid-cols-3 gap-1">
              {FONTS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFont(f)}
                  className={cn(
                    'rounded-sm border px-1 py-1.5 text-[10px] uppercase tracking-[0.04em]',
                    state.font === f
                      ? 'border-accent text-accent bg-[color:color-mix(in_oklch,var(--accent)_10%,transparent)]'
                      : 'border-line text-fg-2 bg-surface hover:border-fg-3 hover:text-fg',
                  )}
                >
                  {FONT_LABEL[f]}
                </button>
              ))}
            </div>
          </Group>

          <Group label="Density">
            <div className="mt-1 grid grid-cols-3 gap-1">
              {DENSITIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDensity(d)}
                  className={cn(
                    'rounded-sm border px-1 py-1.5 text-[10px] uppercase tracking-[0.04em]',
                    state.density === d
                      ? 'border-accent text-accent bg-[color:color-mix(in_oklch,var(--accent)_10%,transparent)]'
                      : 'border-line text-fg-2 bg-surface hover:border-fg-3 hover:text-fg',
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
          </Group>

          <button
            type="button"
            onClick={reset}
            className="mt-1 w-full rounded-sm border border-line bg-surface px-1 py-1.5 text-[10px] uppercase tracking-[0.04em] text-fg-3 hover:border-fg-3 hover:text-fg"
          >
            Reset
          </button>
        </div>
      ) : null}
    </>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-[9.5px] uppercase tracking-[0.1em] text-fg-3">{label}</div>
      {children}
    </div>
  );
}

function _typeGuard(density: Density, font: Font, palette: Palette) {
  // Compile-time exhaustiveness — helps catch missing swatches if the
  // enum literal unions expand. Not called at runtime.
  return { density, font, palette };
}
void _typeGuard;
