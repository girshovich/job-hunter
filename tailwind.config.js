/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.ejs',
    './src/**/*.js',
    './src/**/*.ts',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#EFF6FF',
          500: '#3B82F6',
          600: '#2563EB',
          700: '#1D4ED8',
        },
        // Action-success green (Run / Apply / Applied). Matches --jh-sb-green used by .jh-btn-success.
        success: {
          600: '#1E9E5A',
          700: '#178049',
        },
      },
    },
  },
};
