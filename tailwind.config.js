/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: '#1e1e2e',
          fg: '#cdd6f4',
          cursor: '#f5e0dc',
          selection: '#585b70'
        }
      },
      fontFamily: {
        mono: ['"Cascadia Code"', '"Fira Code"', 'Menlo', 'Monaco', '"Courier New"', 'monospace']
      }
    }
  },
  plugins: []
}
