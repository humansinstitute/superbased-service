module.exports = {
  apps: [
    {
      name: 'flux-adaptor',
      cwd: '/Users/mini/code/superbased/flux_adaptor',
      script: 'bun',
      args: 'start',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
  ],
};
