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
      },
    },
  },
};
