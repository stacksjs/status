/**
 * Crosswind (utility CSS) config.
 * @see https://github.com/cwcss/crosswind
 *
 * `theme.extend` is deep-merged onto Crosswind's defaults, so the standard
 * palette (red-500, etc.) stays intact — these just add the app's design-system
 * tokens as named utilities, mapped to the CSS variables defined in
 * resources/views/partials/app-head.stx. Prefer these over `[var(--…)]`
 * arbitrary values: `bg-surface`, `border-subtle`, `text-muted`, `text-success`,
 * `font-display`, `rounded-card`, and so on.
 */
export default {
  content: [
    './resources/views/**/*.{stx,html}',
    './resources/**/*.{stx,html}',
    './storage/framework/defaults/resources/views/**/*.{stx,html}',
    './storage/framework/defaults/resources/components/**/*.{stx,html}',
    './storage/framework/core/error-handling/src/views/**/*.{stx,html}',
  ],
  preflight: true,
  minify: false,
  theme: {
    extend: {
      colors: {
        // Surfaces & text
        canvas: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        fg: 'var(--fg)',
        muted: 'var(--muted)',
        // Borders — a subtle default and a stronger one (border-subtle / border-strong)
        subtle: 'var(--border)',
        strong: 'var(--border-strong)',
        // Brand accent
        accent: 'var(--accent)',
        'accent-fg': 'var(--accent-fg)',
        'accent-soft': 'var(--accent-soft)',
        // Status
        success: 'var(--success)',
        'success-soft': 'var(--success-soft)',
        amber: 'var(--amber)',
        'amber-soft': 'var(--amber-soft)',
        danger: 'var(--danger)',
        'danger-soft': 'var(--danger-soft)',
      },
      fontFamily: {
        display: ['var(--font-display)'],
        body: ['var(--font-body)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        card: 'var(--radius)',
        'card-sm': 'var(--radius-sm)',
      },
    },
  },
}
