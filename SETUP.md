# pi-curator — Janitor Setup

The janitor is a pm2-managed process that sweeps dead curators and GCs old
fork files. One janitor per project, namespaced `pi-curator:<project>`.

## Install

### 1. Ensure pm2 is available

```bash
npm install -g pm2
pm2 startup   # one-time OS integration
```

### 2. Configure per-project

From the project root (the same directory where `<project>/.pi-curator/curators.json` lives):

```bash
# Copy the ecosystem template into the project
cp node_modules/@buihongduc132/pi-curator/src/janitor/ecosystem.config.cjs \
   ./pi-curator-janitor.ecosystem.cjs
```

Edit the copy:

- Replace `<project>` with your project slug (e.g. `pi-plugins`, `noco-mesh-infra`).
- Adjust `cwd` if needed (must be the project root).
- Set `env_janitor_interval_ms` to override the default 5m tick interval.

### 3. Start the janitor

```bash
pm2 start ./pi-curator-janitor.ecosystem.cjs --name pi-curator-janitor-<project>
pm2 save
```

Verify:

```bash
pm2 list
pm2 logs pi-curator-janitor-<project>
```

### 4. (Optional) one-shot debug tick

For debugging without pm2:

```bash
npx tsx node_modules/@buihongduc132/pi-curator/src/janitor/pi-curator-janitor.ts --once
```

This runs one tick, logs the result, and exits.

## What the janitor does

Per tick (default 5m, REQ-LC-08):

1. **Sweep dead curators** — for each curator claim file at
   `~/.pi-curator/pids/<mainSessionId>/<curator>.json`:
   - If `liveness === "dead"` (heartbeat age > `deadSec` OR pid gone):
     SIGTERM the pid (best-effort), then move the claim file to the archive
     directory (`~/.pi-curator/archive/<mainSessionId>/<curator>-<ts>.json`).
   - `stale` curators are left alone (they may recover).
   - `live` curators are skipped.

2. **GC old forks** — for each fork JSONL file in `~/.pi-curator/forks/`:
   - If older than `forkTTL` (default 24h): unlink.

## Janitor config (per-project)

The janitor reads **project** config (NOT global) at
`<project>/.pi-curator/curators.json`:

```jsonc
{
  "janitor": {
    "enabled": true,       // default true
    "interval": "5m",      // tick interval (duration string)
    "staleSec": 30,        // must match persona defaults
    "deadSec": 120,
    "forkTTL": "24h"       // fork file retention
  }
}
```

## Statelessness

The janitor is **stateless** (REQ-LC-08): killing/restarting it never affects
any live curator. It reads the claim files on each tick and acts on what it
sees. No in-memory state to lose.

## Logs

- pm2 stdout: `./logs/janitor-out.log` (one line per tick: `swept: N, forksDeleted: M, live: K`).
- pm2 stderr: `./logs/janitor-error.log` (per-tick errors, collected, never thrown).

## Uninstall

```bash
pm2 delete pi-curator-janitor-<project>
pm2 save
rm ./pi-curator-janitor.ecosystem.cjs
```

The janitor's archive directory (`~/.pi-curator/archive/`) is preserved for
post-mortem review. To purge:

```bash
rm -rf ~/.pi-curator/archive
```
