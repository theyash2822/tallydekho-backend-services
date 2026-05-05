module.exports = {
  apps: [
    {
      name: 'tallydekho-backend',
      script: 'src/server.js',
      interpreter: 'node',
      cwd: '/Users/mac/.openclaw/workspace/td-backend',

      // Auto-restart on crash
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 3000,

      // Watch — disabled (use PM2 restart on deploy instead)
      watch: false,

      // Logs
      out_file: '/Users/mac/.openclaw/workspace/td-backend/logs/backend.log',
      error_file: '/Users/mac/.openclaw/workspace/td-backend/logs/backend-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // Environment
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
};
