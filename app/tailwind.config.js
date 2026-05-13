/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Legacy short names — kept so existing components don't break
        // while migrating to the `baru-*` token system. Map to new
        // values so visuals stay consistent.
        bg: '#0a0a0a',
        panel: '#121212',
        border: '#1f1f1f',
        accent: '#f43f5e',
        muted: '#71717a',

        // ── Quiet Precision tokens (ported from Baru-YTB) ───────────
        // Same system, with Baru-Manga's rose accent instead of violet.
        baru: {
          // Surfaces, layered tonally instead of via shadows.
          bg: '#0A0A0A',          // canvas / Level 0
          fg: '#E7E0ED',          // primary text (on-surface)
          dim: '#CBC3D7',         // secondary text
          muted: '#71717A',       // placeholder / tertiary
          panel: '#121212',       // Level 1 — sidebar, cards
          'panel-2': '#1A1A1A',   // Level 2 — popovers, modals, focused inputs
          'panel-3': '#211E27',   // Level 3 — interactive surfaces (chips, rows)
          edge: '#1F1F1F',        // 1px borders between surfaces
          'edge-bright': '#2A2A2A', // floating element borders

          // Accent: rose (kept from Baru-Manga). Replaces Baru-YTB's violet.
          rose: '#F43F5E',
          'rose-hover': '#E11D48',
          'rose-soft': '#FDA4AF',  // for inverse-primary, dim hint text

          // Status palette — slightly desaturated per Calm Tech.
          ok: '#10B981',
          warn: '#F59E0B',
          err: '#EF4444',
        },
      },
      fontFamily: {
        // Geometric sans for all UI.
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        // Monospace for timestamps, IDs, license keys, file paths.
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      fontSize: {
        'display-lg': ['32px', { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '600' }],
        'heading-md': ['20px', { lineHeight: '1.4', letterSpacing: '-0.01em', fontWeight: '500' }],
        'label-xs':   ['12px', { lineHeight: '1.2', letterSpacing: '0.06em',  fontWeight: '500' }],
      },
      borderRadius: {
        // Soft, disciplined corners — never bubbly.
        'baru-sm': '4px',
        'baru-md': '6px',
        'baru-lg': '8px',
        'baru-xl': '12px',
      },
      boxShadow: {
        // Subtle rose glow on primary CTAs.
        'rose-glow':  '0 0 0 1px rgba(244,63,94,0.15), 0 8px 24px -8px rgba(244,63,94,0.35)',
        // Floating modals + popovers.
        'panel-float': '0 12px 32px -8px rgba(0,0,0,0.6)',
      },
    }
  },
  plugins: []
}
