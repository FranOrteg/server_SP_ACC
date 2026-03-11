module.exports = {
  apps: [{
    name: 'Skylab_CloudAdmin_Server',
    script: './bin/www',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    node_args: '--max-old-space-size=4096', // permite heap de 4GB para uploads grandes
    max_memory_restart: '4G',       // margen amplio; multipart limita el pico real a ~200 MB
    kill_timeout: 30000,             // 30s de gracia para que termine operaciones en curso
    listen_timeout: 10000,
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
