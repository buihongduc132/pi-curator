/**
 * ecosystem.config.cjs — pm2 process definition for the curator janitor.
 *
 * One janitor per project, namespaced `pi-curator:<project>`. Stateless: can
 * be killed/restarted freely without affecting live curators (REQ-LC-08).
 *
 * Deploy:
 *   pm2 start ecosystem.config.cjs --name pi-curator-janitor-<project>
 *   pm2 save
 *
 * The janitor uses tsx to run the .ts entry (no separate build step needed).
 */

/** @type {import('pm2').AppConfig} */
module.exports = {
  apps: [
    {
      name: "pi-curator-janitor-<project>",
      // Replace <project> with the project slug per deployment. The janitor
      // is per-project because it sweeps that project's pids/forks dirs.
      script: "./node_modules/.bin/tsx",
      args: "src/janitor/pi-curator-janitor.ts",
      cwd: __dirname,
      // Namespace groups this janitor's processes under `pi-curator:<project>`.
      // (pm2 namespaces are typically the name prefix before the first `-`.)
      namespace: "pi-curator:<project>",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
      // Janitor ticks every 5m by default; the script reads interval-ms.
      env_janitor_interval_ms: undefined,
      error_file: "./logs/janitor-error.log",
      out_file: "./logs/janitor-out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
