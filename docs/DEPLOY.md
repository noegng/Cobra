# Mise en ligne de Cobrá — guide pas à pas

Ordre imposé par les dépendances : **base → wallet de l'agent → routeur → web (Vercel) → ERC-8004 → Telegram → worker (VPS) → vérification → premier paiement**.
Après chaque étape, `pnpm verify:deploy` dit ce qui est en place (lecture seule, aucune clé, aucune transaction).

> **Règle d'or :** `RELAYER_PRIVATE_KEY` n'existe que sur ta machine au moment du déploiement et dans `/etc/cobra/worker.env` sur le VPS. Jamais sur Vercel, jamais dans le dépôt, jamais dans `.env.verify`.
> Toute transaction de l'agent porte le tag ERC-8021 `celo_502e1bea2794` (déjà câblé : déploiement, enregistrement, `pay`).

## 0. Prérequis (une fois)

```sh
echo 'export PATH="$HOME/.foundry/bin:/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
cd ~/Developer/GitHub/Cobrá && pnpm install && (cd contracts && forge build)
```

Comptes à avoir : Neon (ou Supabase), Vercel, un VPS Linux, Telegram (@BotFather), WalletConnect Cloud (project id), clé API Anthropic, un domaine en HTTPS (le domaine Vercel `xxx.vercel.app` suffit).

Prépare un fichier **local, non commité** `.env.verify` (déjà ignoré par `.gitignore`) que tu complètes au fil des étapes — il ne contient **aucune clé privée** :

```sh
RPC_URL=https://forno.celo.org
ROUTER_ADDRESS=
ROUTER_DEPLOY_BLOCK=
ROUTER_DEPLOY_TX=
AGENT_ADDRESS=
AGENT_ID=
PUBLIC_BASE_URL=
TELEGRAM_BOT_TOKEN=
DATABASE_URL=
```

Vérification à tout moment : `pnpm verify:deploy --env .env.verify` (code de sortie 1 si un contrôle échoue).

## 1. Base Postgres

1. Projet Neon déjà lié (`.neon`, `neon.ts` ; projet `mute-cherry-78776891`, branche `production`). Dans la console Neon, copie l'URL **avec pooling** (`...-pooler...`, `sslmode=require`) → `DATABASE_URL` (Vercel, worker), et l'URL **directe** (sans `-pooler`) pour les migrations uniquement. Ne lance pas `neon env pull` : il écrirait ces URLs dans le `.env` racine.
2. Applique les migrations (sur une connexion directe ; sans `DATABASE_URL_UNPOOLED`, le script retombe sur `DATABASE_URL`) :
   ```sh
   DATABASE_URL_UNPOOLED='postgres://…' pnpm --filter @cobra/db migrate     # URL directe (sans -pooler) → "migrations applied"
   ```
3. ✅ `verify:deploy` : `[database] migrations` PASS. (`[worker] indexer cursor` restera FAIL jusqu'à l'étape 7, c'est normal.)

## 2. Wallet de l'agent

Un **seul** wallet pour tout l'événement : il déploie le routeur, s'enregistre en ERC-8004 et relaie les paiements.

1. Crée-le toi-même sur ta machine (ex. `cast wallet new`), garde la clé hors du dépôt.
2. Envoie-lui quelques CELO pour le gas (le déploiement estimé ≈ 2,45 M gas ; chaque `pay` ≈ quelques centaines de milliers).
3. Note l'adresse → `AGENT_ADDRESS` dans `.env.verify`.
4. ✅ `[agent] gas balance` PASS (seuil `RELAYER_MIN_BALANCE_CELO`, 0,5 par défaut).

## 3. Déploiement du routeur (tagué ERC-8021)

```sh
pnpm deploy:router                                           # à blanc : chaîne 42220, Permit2 et SwapRouter02 vérifiés, tag affiché
RELAYER_PRIVATE_KEY=0x… pnpm deploy:router --execute         # réel, depuis le wallet de l'agent
```

Le script affiche `hash`, `router`, `block`. Reporte-les : `ROUTER_ADDRESS`, `ROUTER_DEPLOY_BLOCK`, `ROUTER_DEPLOY_TX`.
N'utilise **pas** `forge script --broadcast` : il ne peut pas ajouter le tag, la transaction ne serait jamais créditée.

✅ `[router]` : bytecode, immutables, EIP-712 domain et **deployment tx tagged (ERC-8021)** tous PASS.

## 4. Web sur Vercel (`apps/web`)

1. **Fiche d'agent** (avant le premier déploiement web) :
   ```sh
   pnpm agent:register --base-url https://<domaine> --wallet <AGENT_ADDRESS> --write
   ```
   Écrit `apps/web/public/.well-known/agent-registration.json`. Commit + push.
2. Nouveau projet Vercel sur le dépôt, **Root Directory = `apps/web`** (Vercel détecte le workspace pnpm), framework Next.js.
3. Variables d'environnement (Production) :

   | Variable | Valeur |
   | --- | --- |
   | `DATABASE_URL` | URL Neon (étape 1) |
   | `RPC_URL` | `https://forno.celo.org` |
   | `ROUTER_ADDRESS` | étape 3 |
   | `AGENT_ADDRESS` | étape 2 (affiché sur `/proof`) |
   | `PUBLIC_BASE_URL` | `https://<domaine>` (sans `/` final) |
   | `DASHBOARD_SECRET` | `openssl rand -hex 32` — **la même valeur** devra être connue du bot (il tourne aussi sur Vercel, rien d'autre à faire) |
   | `TELEGRAM_BOT_TOKEN` | étape 6 (tu peux redéployer après) |
   | `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` |
   | `ANTHROPIC_API_KEY` | ta clé |
   | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect Cloud |
   | *(optionnel)* `NEXT_PUBLIC_ATTRIBUTION_CODE` | défaut `celo_502e1bea2794` |
   | *(optionnel)* `COBRA_MODEL`, `GROQ_API_KEY`, `NEXT_PUBLIC_RPC_URL`, `QUOTER_V2_ADDRESS`, `KILL_SWITCH` | voir `.env.example` |

4. Déploie, puis renseigne `PUBLIC_BASE_URL` dans `.env.verify`.
5. ✅ `[web]` : agent card, agent card image, `/proof` page, API + database tous PASS.
   (À ce stade `agent card` peut signaler l'`agentId` manquant : normal avant l'étape 5.)

## 5. Enregistrement ERC-8004

```sh
RELAYER_PRIVATE_KEY=0x… RPC_URL=https://forno.celo.org \
  pnpm agent:register --base-url https://<domaine> --wallet <AGENT_ADDRESS> --execute
```

Le script vérifie que la fiche est en ligne, simule, puis envoie `register(agentURI)` (tagué). Il affiche l'`agentId`.
Puis régénère la fiche avec l'identifiant et redéploie le web :

```sh
pnpm agent:register --base-url https://<domaine> --wallet <AGENT_ADDRESS> --agent-id <N> --write
git add apps/web/public/.well-known/agent-registration.json && git commit -m "Agent card: agentId <N>" && git push
```

Renseigne `AGENT_ID=<N>`, vérifie l'agent sur 8004scan et **saisis l'adresse du wallet dans la soumission Loops House**.
✅ `[agent] ERC-8004 registered` et `ERC-8004 agentId` PASS (propriétaire = wallet de l'agent, URI = la fiche servie).

## 6. Bot Telegram

1. @BotFather → `/newbot` → token → `TELEGRAM_BOT_TOKEN` (Vercel + `.env.verify`), redéploie le web.
2. **Avant** de poser le webhook, récupère ton identifiant de chat opérateur : écris au bot, puis
   `curl -s https://api.telegram.org/bot<TOKEN>/getUpdates` → `message.chat.id` → `OPERATOR_TELEGRAM_CHAT_ID` (pour le worker).
3. Pose le webhook :
   ```sh
   curl -s https://api.telegram.org/bot<TOKEN>/setWebhook \
     -d url=https://<domaine>/api/telegram -d secret_token=<TELEGRAM_WEBHOOK_SECRET>
   ```
4. ✅ `[telegram]` bot token et webhook PASS. Écris `/start` au bot : l'onboarding doit répondre.

## 7. Worker sur le VPS (relayeur + indexeur + rappels + clôture)

```sh
# sur le VPS (Node 24 + pnpm + git installés)
sudo useradd --system --home /opt/cobra cobra
sudo git clone https://github.com/noegng/Cobr-.git /opt/cobra && cd /opt/cobra && sudo pnpm install
sudo mkdir -p /etc/cobra && sudo touch /etc/cobra/worker.env
sudo chown root:cobra /etc/cobra/worker.env && sudo chmod 0640 /etc/cobra/worker.env
sudoedit /etc/cobra/worker.env
```

Contenu de `/etc/cobra/worker.env` :

```sh
DATABASE_URL=postgres://…
RPC_URL=https://forno.celo.org
ROUTER_ADDRESS=0x…
ROUTER_DEPLOY_BLOCK=…
PUBLIC_BASE_URL=https://<domaine>
TELEGRAM_BOT_TOKEN=…
RELAYER_PRIVATE_KEY=0x…          # SEUL endroit où la clé vit en permanence
OPERATOR_TELEGRAM_CHAT_ID=…      # alertes : gas bas, paiements non appariés
# optionnels : ATTRIBUTION_CODE (défaut celo_502e1bea2794), RELAYER_MIN_BALANCE_CELO, REF_RATES, RELAYER_POLL_MS,
#   GAS_GRANT_CELO (défaut 0.05, 0 = désactivé, max 0.1), GAS_GRANT_DAILY_MAX (défaut 20)
```

```sh
sudo cp /opt/cobra/apps/worker/deploy/cobra-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cobra-worker
journalctl -u cobra-worker -f     # attendre "worker_started" avec relayer = AGENT_ADDRESS et chainId 42220
```

Le worker refuse de démarrer (code 78, pas de boucle de redémarrage) si une variable manque ou si le RPC n'est pas sur la chaîne 42220.
✅ `[worker] indexer cursor` PASS (mis à jour il y a moins de 10 min) et `relay queue` PASS.

## 8. Vérification complète

```sh
pnpm verify:deploy --env .env.verify
```

Objectif : **aucun FAIL**. Un WARN `indexer cursor idle` est acceptable tant qu'il n'y a aucun trafic.

## 9. Premier paiement réel (déclencheur du Plan 2)

1. Dans le bot : onboarding Argentine → wARS, adresse de réception = **ton wallet commerçant**.
2. `cobrar 100 prueba` → QR + lien `/pay/<id>`.
3. Ouvre le lien sur ton téléphone avec un **autre wallet** que l'adresse commerçant (le relayeur refuse les auto-paiements, protection WS7-1), qui détient un peu d'USDC ou d'USD₮ : une signature, sans gas.
4. Contrôles : notification « pagado » dans Telegram, transaction sur Celoscan avec le tag, ligne sur `/proof`, `[worker] relay queue` PASS.
5. Note le hash dans le README (tableau « Deployed addresses and proof transactions »).

## Exploitation

- **Kill switch** (arrête tout envoi sans redéploiement) :
  ```sql
  insert into flags (key, value) values ('kill_switch', '{"enabled": true}')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  ```
  Ou `KILL_SWITCH=true` dans `/etc/cobra/worker.env` puis `sudo systemctl restart cobra-worker` (toute valeur autre que false/0/off/no l'active).
- **Plafonds** (défauts : 200 $ par paiement, 2 000 $/jour au total, 500 $/jour par commerçant et par payeur) :
  ```sql
  insert into flags (key, value) values ('caps', '{"perPaymentUsd":200,"perDayUsd":2000,"perMerchantDayUsd":500,"perPayerDayUsd":500}')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  ```
- **Mise à jour du worker** : `cd /opt/cobra && sudo git pull && sudo pnpm install && sudo systemctl restart cobra-worker`.
- **Rotation de la clé du relayeur** : impossible sans changer de wallet d'agent (un seul wallet pour l'événement) → kill switch d'abord, puis demander aux organisateurs.
