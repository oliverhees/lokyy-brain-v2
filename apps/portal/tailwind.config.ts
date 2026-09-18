import type { Config } from 'tailwindcss';

// Colours come only from the shared design tokens (apps/web/src/theme/tokens.css) and the portal's
// semantic aliases in src/client/theme.css — no raw colour values in components.
export default {
  content: ['./index.html', './src/client/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--portal-canvas)',
        surface: 'var(--portal-surface)',
        subtle: 'var(--bg-2)',
        strong: 'var(--bg-3)',
        input: 'var(--input-bg)',
        line: 'var(--hairline)',
        control: 'var(--portal-control-border)',
        'line-soft': 'var(--hairline-soft)',
        fg: 'var(--text-high)',
        muted: 'var(--text-mid)',
        accent: 'var(--portal-accent)',
        'accent-fg': 'var(--accent-fg)',
        'accent-soft': 'var(--accent-soft)',
        link: 'var(--portal-link)',
        danger: 'var(--portal-danger)',
        'danger-soft': 'var(--portal-danger-soft)',
        success: 'var(--portal-success)',
        'success-soft': 'var(--portal-success-soft)',
        warn: 'var(--portal-warn)',
        'warn-soft': 'var(--warn-soft)',
        focus: 'var(--portal-focus)',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
