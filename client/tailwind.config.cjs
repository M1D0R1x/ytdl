module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0a',
        neon: '#00ff88',
        cyan: '#00d4ff',
        magenta: '#ff0080',
      },
      fontFamily: { mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'monospace'] },
      boxShadow: {
        neon: '0 0 20px rgba(0,255,136,0.55), inset 0 0 12px rgba(0,255,136,0.15)',
        cyan: '0 0 20px rgba(0,212,255,0.55)',
      },
    },
  },
  plugins: [],
};
