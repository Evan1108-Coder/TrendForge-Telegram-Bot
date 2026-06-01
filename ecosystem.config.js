module.exports = {
  apps: [{
    name: 'trendforge',
    script: 'src/index.js',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
