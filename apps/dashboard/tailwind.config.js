/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'Geist', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'Geist Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        /* Shadcn aliases — resolved via var(--X) because --background etc.
           are full oklch() color values, not bare HSL triples. */
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--primary-foreground)',
          dim: 'var(--accent-dim)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        /* AgentScope OKLCH palette (dashboard-specific utilities:
           bg-surface, bg-surface-2, text-fg-2, border-line etc.). */
        surface: {
          DEFAULT: 'var(--bg)',
          2: 'var(--bg-2)',
          3: 'var(--bg-3)',
          4: 'var(--bg-4)',
        },
        fg: {
          DEFAULT: 'var(--fg)',
          2: 'var(--fg-2)',
          3: 'var(--fg-3)',
        },
        line: {
          DEFAULT: 'var(--line)',
          soft: 'var(--line-soft)',
        },
        warn: 'var(--warn)',
        crit: 'var(--crit)',
        info: 'var(--info)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      spacing: {
        row: 'var(--row)',
        pad: 'var(--pad)',
      },
      keyframes: {
        'accent-pulse': {
          '0%': {
            boxShadow: '0 0 0 0 color-mix(in oklch, var(--accent) 60%, transparent)',
          },
          '100%': {
            boxShadow: '0 0 0 8px color-mix(in oklch, var(--accent) 0%, transparent)',
          },
        },
      },
      animation: {
        'accent-pulse': 'accent-pulse 1.8s ease-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
