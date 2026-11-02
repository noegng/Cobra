# @cobra/worker (VPS)

One process: relayer (`@cobra/relayer`, the only signer), indexer, expiry, reminders and daily close.

## Run
```sh
pnpm --filter @cobra/worker start        # reads env, exits 78 on invalid config
```
Required env: `DATABASE_URL RPC_URL ROUTER_ADDRESS ROUTER_DEPLOY_BLOCK PUBLIC_BASE_URL TELEGRAM_BOT_TOKEN RELAYER_PRIVATE_KEY ATTRIBUTION_CODE`.
Optional: `OPERATOR_TELEGRAM_CHAT_ID` (alerts: low gas, broadcast errors, any `level=alert` log), `ATTRIBUTION_WALLET_CODE`
(switches to an ERC-8021 Schema 2 app+wallet tag), `KILL_SWITCH=true`, `REF_RATES='{"ARS":0.0006}'` (overrides the cap FX rates),
`RELAYER_MIN_BALANCE_CELO` (default 0.5), `RELAYER_POLL_MS` (default 2000).

## Deploy (systemd)
1. `useradd -r -m -d /opt/cobra cobra`, clone the repo to `/opt/cobra`, run `pnpm install --frozen-lockfile`.
2. Create `/etc/cobra/worker.env` (`root:cobra`, `0640`) with the variables above. This is the ONLY place the key exists.
3. `cp apps/worker/deploy/cobra-worker.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now cobra-worker`.
4. Logs: `journalctl -u cobra-worker -f` (JSON lines). Emergency stop: `KILL_SWITCH=true` + restart, or set the DB flag `kill_switch` to `{"enabled":true}` (no restart needed).

Gas is paid in CELO. Keep the relayer wallet funded; an alert fires below `RELAYER_MIN_BALANCE_CELO`.
