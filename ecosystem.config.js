// ecosystem.config.js
// PM2 process manager config
// PM2 keeps your Node server alive, restarts on crash, and manages logs

module.exports = {
  apps: [
    {
      name:         "plivo-server",
      script:       "src/server.js",
      instances:    1,          // 1 instance — WebSocket sessions are in-memory
                                // If you need scale, move sessions to Redis first
      exec_mode:    "fork",
      watch:        false,       // don't watch files in production
      max_memory_restart: "512M",

      // Environment variables — these OVERRIDE .env file
      // In production, set real values here or in the .env file on EC2
      env_production: {
        NODE_ENV: "production",
        PORT:     8080,
      },

      // Auto restart on crash
      autorestart:    true,
      restart_delay:  2000,    // wait 2s before restarting after crash
      max_restarts:   10,      // stop restarting after 10 consecutive crashes
      min_uptime:     "10s",   // consider stable if up for 10s

      // Log config
      out_file:    "/var/log/plivo-server/out.log",
      error_file:  "/var/log/plivo-server/error.log",
      merge_logs:  true,
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS",

      // Graceful shutdown — PM2 sends SIGINT, server has 10s to clean up
      kill_timeout:   10000,
      listen_timeout: 8000,
    },
  ],
};
