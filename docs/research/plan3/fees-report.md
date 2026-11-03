# Plan 3 — couverture et frais mesurés (passe 1)

3 novembre 2026, Celo mainnet, blocs 81 824 715 à 81 825 001. **Une seule passe, à un seul moment** : les passes 2 et 3 (autres heures) restent à faire avant de figer un niveau (règle de la section 5 du plan 3). Données : `coverage-matrix.json`, `pools.json`, `routes-bridge-gas.json`, `mento-fx.json` ; détails dans `A-T1-T2.md`, `B-T3-T10-T11.md`, `C-T4-T7-T6.md`.

## 1. Ce que les tests décident

| Décision du plan 3 | Résultat de la passe 1 |
| --- | --- |
| Niveau par pays | **Argentine : Partiel**, Complet dès que T8 et T12 sont faits et qu'une 2e passe confirme. **Brésil : Partiel proposé** (achat de wBRL seulement, ≈ 3,3 % au-dessus du marché, plafond 500 $). **Mexique, Colombie : Partiel « paiement direct »** (même wFIAT ou achat en pesos via Ripio, T9). **Chili, Pérou : paiement direct seulement** (ni pool ni rampe). |
| Plafond par paiement | wARS : 5 000 $ (plus grande taille testée, 0,31 %) ; wBRL : 500 $ (au-delà, l'écart dépasse la garde de 350 pb) ; le plafond de l'application (200 $ par défaut) s'applique avant. Autres : 0. |
| Sources de prix | Uniswap V3 au palier 0,01 % uniquement. Mento : utile seulement pour BRLm/COPm, qui ne sont pas des wFIAT. Textile : non testé (clé). Cruce : introuvable. |
| E4 Textile | En attente de la clé (T5). |
| E9 Bridge Ripio | **Go technique** : contrat `0x465e…5D47` vérifié, non pausé, routes ouvertes pour les 6 wFIAT entre Celo, Base, Polygon, BSC et Ethereum, frais fixes minimes hors Ethereum. |
| E5 Autres pays | **MX et CO possibles sans conversion** : aucun pool, mais paiement direct dans la même wFIAT et rampe Ripio sur Celo (T9). CL et PE : pas de rampe. |

## 2. Liquidité observée

- Seuls **2 pools Uniswap V3** existent pour les wFIAT, tous deux contre USD₮ au palier 0,01 % : wARS (≈ 28 500 USD₮ dans le pool) et wBRL (≈ 23 USD₮ seulement, en face de 147 000 wBRL).
- Aucun pool wFIAT contre USDC ou USA₮ : un payeur en USDC passe par USD₮ (deux sauts, environ +0,01 point de frais).
- **Uniswap V4** a des pools plus profonds (wARS/USDC ≈ 143 k$, wBRL/USDC ≈ 559 k$, palier 0,3 %), mais le routeur Cobrá, immuable, ne parle qu'à Uniswap V3 (SwapRouter02).
- wBRL : prix du pool 2,2 à 3,3 % sous toutes les références et vente impossible. Le solveur accepte le BRL jusqu'à 350 pb (choix documenté dans le README) : avec AwesomeAPI (−3,26 %), il reste 0,1 à 0,2 point de marge, donc un faible mouvement suffit à bloquer les devis.
- wARS : prix du pool à −0,05 % du « dólar cripto », mais +5,5 % du MEP et +7,2 % de l'officiel. Le wARS suit le dollar crypto, pas le taux officiel.

## 3. Coût total mesuré pour Cobrá

Formule : gaz (payé par le relayeur, converti en USD) + frais du pool + impact de prix + écart au taux de référence (dólar cripto pour l'Argentine). Frais de service Cobrá : 0. Rampe de sortie : non incluse (T9 non fait).

Gaz de `pay` sur fork, + 70 k de gaz intrinsèque et calldata estimés, à 202,5 gwei et 1 CELO = 0,0733 $ : **≈ 0,0066 $** pour une jambe simple, **≈ 0,0081 $** avec deux sauts. Le payeur ne paie que l'approbation Permit2 initiale (≈ 50 k gaz, moins de 0,001 $).

| Paire (payeur → commerçant) | 5 $ | 50 $ | 500 $ | 5 000 $ | Dont gaz à 50 $ |
| --- | --- | --- | --- | --- | --- |
| USD₮ → wARS | 0,19 % | 0,08 % | 0,09 % | 0,36 % | 0,013 % |
| USDC → wARS (via USD₮) | 0,23 % | 0,09 % | 0,10 % | 0,38 % | 0,016 % |
| USD₮ → wBRL | 3,40 % | 3,30 % | 3,40 % | 4,53 % (refusé, > 350 pb) | 0,013 % |
| wBRL → wARS, toute vente de wBRL | impossible (pool à sec côté USD₮) | impossible | impossible | impossible | — |
| USDC → wMXN, wCOP, wCLP, wPEN | pas de route | pas de route | pas de route | pas de route | — |

Pour wBRL, presque tout le coût vient de l'**écart de prix du pool** (3,26 % contre AwesomeAPI), pas du swap (0,02 % à 50 $).

## 4. Comparaison honnête

| Moyen de paiement (Argentine) | Ordre de grandeur | Source et réserve |
| --- | --- | --- |
| Encaissement en ligne | ≈ 3 % | source non datée (plan 3, section 6) |
| Cartes, petit commerçant | 2,5 à 3,5 % | sources sectorielles non datées |
| Carte étrangère, payeur | 1 à 3 % + marge de change | émetteurs, variable |
| Envoi d'argent, Amérique latine | 5,9 % | Banque mondiale, T4 2023 |
| **Cobrá USD₮ → wARS** | **0,08 à 0,36 %** (0,19 % à 5 $) | mesuré, passe 1 |

**Lecture honnête**

- Pour un payeur qui **détient déjà de l'USD₮ ou de l'USDC**, Cobrá est nettement moins cher que les moyens classiques en Argentine, sur toutes les tailles testées.
- Ce chiffre n'inclut pas la rampe : un payeur sans crypto doit d'abord acheter des dollars numériques, et le commerçant qui veut des pesos doit sortir (T9).
- Le gain dépend d'un seul pool (≈ 28 500 USD₮) : la liquidité peut bouger, d'où le plafond et la garde de prix.
- Au Brésil, Cobrá (≈ 3,3 %) est plus cher que le Pix (≈ 0,22 %) et que la carte de débit, à peu près au niveau d'une carte de crédit (jusqu'à 2,2 %) ou d'une carte étrangère : il ne se justifie que pour un payeur étranger qui détient des dollars numériques.

## 5. Effet sur les plans

- **Démo et message** : centrer sur l'Argentine (USD₮/USDC → wARS). Le Brésil peut être montré avec son avertissement de prix ; les autres pays sont affichés « bientôt », sans devis.
- **Solveur** : garder `feeTiers: [100]` (déjà le cas côté web). La lecture de `coverage-matrix.json` par le solveur reste à brancher.
- **Plan 2** : E9 (bridge) passe devant E5 ; E5 attend des pools ; un routeur compatible Uniswap V4 serait la piste pour wBRL, mais c'est un nouveau contrat, hors délai.
- **Règlement en dollars** (plan 3, section 9) : la seule autre route profonde est USDC/USD₮, donc proposer USD₮ comme règlement au commerçant ne coûte presque rien.

## 6. Reste à faire

- Passes 2 et 3 : `pnpm exec tsx scripts/research/plan3/pools-t1-t2.ts --pass 2` (nuit), puis `--pass 3` (matin).
- Humain : T5 (clé Textile), T8 et T12 (premier paiement réel en USD₮ → wARS), T9 (rampes Ripio AR, CO, BR).
- Non couverts : pools Uniswap V4, plafond restant des limites Mento (`tradingLimitsState`), rôles du contrat de mint du bridge.

## 7. Mise à jour T9 (rampes Ripio, test manuel du 3 nov.)

`ramp.ripio.com` avec `country`, `chain=42220`, `token`, `amount` : **Argentine, Brésil, Mexique et Colombie** proposent Celo, et chaque wFIAT est sélectionnable. Chili et Pérou ne sont pas proposés. Test arrêté avant le paiement : KYC, frais et limites non vérifiés. La page de paiement et la commande de retrait du bot utilisent maintenant ces liens préremplis.
