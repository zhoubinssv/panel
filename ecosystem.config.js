module.exports = {
  apps: [{
    name: 'vless-panel',
    script: 'src/app.js',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'data/logs/error.log',
    out_file: 'data/logs/out.log',
    merge_logs: true
  }]
};
