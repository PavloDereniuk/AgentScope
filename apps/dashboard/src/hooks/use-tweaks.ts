import { useCallback, useEffect, useState } from 'react';

export const PALETTES = ['green', 'violet', 'cyan', 'amber', 'mono'] as const;
export const FONTS = ['geist', 'ibm', 'inter'] as const;
export const DENSITIES = ['compact', 'normal', 'roomy'] as const;

export type Palette = (typeof PALETTES)[number];
export type Font = (typeof FONTS)[number];
export type Density = (typeof DENSITIES)[number];

export interface TweaksState {
  palette: Palette;
  font: Font;
  density: Density;
}

const DEFAULT_STATE: TweaksState = {
  palette: 'green',
  font: 'geist',
  density: 'normal',
};

const STORAGE_KEY = 'as_tweaks';

/**
 * Read + persist theme tweaks (accent palette, font stack, density).
 *
 * Values are projected onto `<html data-palette data-font data-density>` so
 * the CSS variable swappers in index.css apply instantly — no restyled
 * components needed. Persistence lives in localStorage under `as_tweaks`
 * so the choice survives reloads.
 */
export function useTweaks() {
  const [state, setState] = useState<TweaksState>(() => readInitialState());

  useEffect(() => {
    applyToDocument(state);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage may be disabled (private mode); tweaks still work for the session.
    }
  }, [state]);

  const setPalette = useCallback(
    (palette: Palette) => setState((prev) => ({ ...prev, palette })),
    [],
  );
  const setFont = useCallback((font: Font) => setState((prev) => ({ ...prev, font })), []);
  const setDensity = useCallback(
    (density: Density) => setState((prev) => ({ ...prev, density })),
    [],
  );
  const reset = useCallback(() => setState(DEFAULT_STATE), []);

  return { state, setPalette, setFont, setDensity, reset };
}

function readInitialState(): TweaksState {
  if (typeof window === 'undefined') return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<TweaksState>;
    return {
      palette: PALETTES.includes(parsed.palette as Palette)
        ? (parsed.palette as Palette)
        : DEFAULT_STATE.palette,
      font: FONTS.includes(parsed.font as Font) ? (parsed.font as Font) : DEFAULT_STATE.font,
      density: DENSITIES.includes(parsed.density as Density)
        ? (parsed.density as Density)
        : DEFAULT_STATE.density,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function applyToDocument(state: TweaksState): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.palette = state.palette;
  root.dataset.font = state.font;
  // `normal` is the default: leaving the attribute unset avoids competing
  // with the base :root density values declared in index.css.
  if (state.density === 'normal') {
    delete root.dataset.density;
  } else {
    root.dataset.density = state.density;
  }
}
