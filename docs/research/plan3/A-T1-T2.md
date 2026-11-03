# Plan 3 — A : découverte des pools (T1) et profondeur / slippage (T2)

**Attention : une seule passe (passe 1), à un seul instant** — bloc Celo 81 824 715, 3 nov. 2026. Lecture seule (eth_call, API publiques). Données brutes : `docs/research/plan3/pools.json`. Les passes 2 et 3 restent à faire.

Les 9 adresses de tokens ont été revérifiées en chaîne (symbol/decimals : 6 décimales pour USDC/USD₮/USAT, 18 pour les wFIAT).

## T1 — Pools Uniswap V3 (factory `0xAfE2…`, 18 paires × 4 paliers de frais = 72 appels `getPool`)

Seuls **2 pools** existent, tous deux wFIAT/USD₮ au palier 0,01 % (100). Aucun pool avec USDC ni USAT, aucun autre palier.

| wFIAT | Pool | Liquidité (stable dans le pool) | Prix du pool | Référence FX | Écart |
|---|---|---|---|---|---|
| wARS | `0x5D8e…2391` | ~28 485 USD₮ (+128,9 M wARS) | 1 656,33 ARS/USD | 1 657,24 (dolarapi « cripto ») | -0,05 % |
| wBRL | `0x01c3…A40F` | **~23 USD₮** (+147 084 wBRL, ~27 k$) | 5,3197 BRL/USD | 5,499 (AwesomeAPI) | **-3,26 %** |
| wMXN, wCOP, wCLP, wPEN | aucun | – | – | – | – |

Sources FX : ARS = taux « cripto » (dolarapi.com), pas l'officiel ; BRL = AwesomeAPI (mid) ; MXN/COP/CLP/PEN = open.er-api.com (mid-market). Elles servent uniquement à comparer ; les tailles de test utilisent le prix du pool.

**Recoupement GeckoTerminal** (réseau `celo`, accessible) : retrouve les 2 pools V3 (wARS : reserve 106 k$, vol. 24 h 115,6 k$ ; wBRL : 23,7 $, vol. 0). Il révèle en plus deux pools **Uniswap V4** que le scan de la factory V3 ne voit pas : wARS/USDC 0,3 % (reserve 142,7 k$, vol. 24 h 994 $) et wBRL/USDC 0,3 % (559 k$, vol. 24 h 1 377 $). Ils ne sont pas testés ici (le QuoterV2 V3 ne les couvre pas) ; à examiner. Aucun pool trouvé pour wMXN, wCOP, wCLP, wPEN (wPEN : après une réponse 429, nouvel essai OK, « no pools returned »).

## T2 — Slippage (QuoterV2, coût total = frais + impact de prix, vs prix spot slot0)

Frais du pool : 0,01 % pour les deux. Coûts en % ; « achat » = le payeur donne du USD₮, le marchand reçoit du wFIAT (cas du solver, exact-output inclus).

**wARS / USD₮ (0,01 %)**

| Taille | Achat exact-in | Achat exact-out | Vente exact-in | Impact (achat) |
|---|---|---|---|---|
| 5 $ | 0,010 | 0,010 | 0,010 | 0,000 |
| 50 $ | 0,013 | 0,013 | 0,013 | 0,003 |
| 500 $ | 0,040 | 0,040 | 0,040 | 0,030 |
| 5 000 $ | 0,305 | 0,306 | 0,306 | 0,295 |

**wBRL / USD₮ (0,01 %)**

| Taille | Achat exact-in | Achat exact-out | Vente exact-in | Impact (achat) |
|---|---|---|---|---|
| 5 $ | 0,011 | 0,011 | inutilisable | 0,001 |
| 50 $ | 0,023 | 0,023 | inutilisable | 0,013 |
| 500 $ | 0,136 | 0,136 | inutilisable | 0,126 |
| 5 000 $ | 1,257 | 1,273 | inutilisable | 1,247 |

Plus grande taille testée avec coût total ≤ 1 % / ≤ 3 % (achat, grille 5/50/500/5000) :
- **wARS** : 5 000 $ / 5 000 $ (plafond de la grille, probablement plus haut).
- **wBRL** : 500 $ / 5 000 $ (à 5 000 $ : 1,26 %). Entre 500 et 5 000 $ non testé.
- **wMXN, wCOP, wCLP, wPEN** : aucun pool V3, donc 0.

Gas estimé par le QuoterV2 : ~92 k à 114 k par swap (wARS, wBRL achat), pic anormal de 17,2 M sur la vente wBRL.

## Anomalies
- **wBRL, sens vente** : le pool ne contient que ~23 $ de USD₮. Le QuoterV2 ne revert pas, il exécute un remplissage partiel absurde (coût « 6 849 215 % » dès 5 $, gas 17 M). Marqué `unusable: true` dans le JSON. Seul le sens achat (le payeur donne du USD₮, le pool paie du wBRL) a une vraie profondeur.
- **wBRL, prix** : le pool est 3,26 % sous la référence (> seuil à surveiller), cohérent avec un pool très peu approvisionné et sans volume (24 h = 0). À noter : un garde-fou de prix du solver tolérant moins de 3 % rejetterait wBRL.
- Aucun revert « classique » ; les écarts sont enregistrés tels quels.

## Ce qui manque
- Passes 2 et 3 à d'autres moments (volatilité, ré-équilibrage des pools).
- Pools Uniswap V4 (wARS/USDC, wBRL/USDC) non quotés (hors QuoterV2 V3).
- Tailles intermédiaires au-delà de 5 000 $ pour wARS, et entre 500 et 5 000 $ pour wBRL.
- Pas de source FX pour ARS « officiel / MEP » (seul le taux cripto est utilisé).

Relancer une passe : `pnpm exec tsx scripts/research/plan3/pools-t1-t2.ts --pass 2` (depuis la racine du dépôt, PATH Node 24).
