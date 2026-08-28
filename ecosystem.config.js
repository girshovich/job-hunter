module.exports = {
  apps: [
    {
      name: 'job-hunter',
      script: 'dist/index.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      restart_delay: 5000,
      max_memory_restart: '512M',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      log_file: 'logs/combined.log',
      time: true,
      autorestart: true,
      watch: false,
    },
  ],
};
