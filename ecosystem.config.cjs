// PM2 process config — `pm2 start ecosystem.config.cjs` from backend/.
module.exports = {
  apps: [
    {
      name: 'tressurer',
      script: 'index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
