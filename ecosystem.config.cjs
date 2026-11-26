// pm2 keeps the hub alive. treekill is off on purpose: agent processes are detached and must
// survive hub restarts; the new hub re-attaches to them.
module.exports = {
  apps: [{
    name: "agora-hub",
    cwd: __dirname,
    script: "node_modules/.bin/tsx",
    args: "server/index.ts",
    interpreter: "none",
    env: { PORT: "4410", HOST: "127.0.0.1" },
    autorestart: true,
    restart_delay: 1500,
    max_restarts: 10000,
    min_uptime: 5000,
    kill_timeout: 4000,
    treekill: false,
    out_file: ".data/hub.out.log",
    error_file: ".data/hub.err.log",
    merge_logs: true,
    time: true,
  }],
};
