# Plan 3 - sous-agent C : Mento (T4), écart au taux de référence (T7), Cruce (T6)

Lecture seule, Celo 42220, bloc 81 824 824 (2026-11-03 ~17:06 UTC). Données brutes : `docs/research/plan3/mento-fx.json`. Script : `scripts/research/plan3/c-mento-fx.ts`.

## T4 - Mento

Adresses vérifiées on-chain : Broker `0x777A8255cA72412f0d706dc03C9D1987306B4CaD` (un seul fournisseur : BiPoolManager `0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901`, dont `broker()` renvoie bien le Broker). Oracle : SortedOracles `0xefB84935239dAcdecF7c5bA76d8dE40b077B7b33`. Source des adresses : docs.mento.org / github.com/mento-protocol/mento-core, puis contrôle par `getExchangeProviders()`, `broker()`, `symbol()` et `decimals()`.

Le BiPoolManager liste **10 échanges, tous contre USDm** (jamais contre USDC ou USDT) : GHSm, XOFm, ZARm, AUDm, CADm, PHPm, BRLm, NGNm, KESm, COPm. Tous à 18 décimales. Pas de MXNm, CLPm, PENm ni ARSm.

Pertinents pour la LatAm :
- BRLm `0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787` : spread 0,30 %.
- COPm `0x8A567e2aE79CA692Bd748aB832081C45de4041eA` : spread 0,30 %.

Cotations `Broker.getAmountOut` (USDm vers local) à 5, 50, 500 et 5000 USD :

| Route | Prix obtenu (local par USD) | Taux oracle Mento | Aller-retour (perte) |
| --- | --- | --- | --- |
| USDm -> BRLm | 5,4815 | 5,498 | 0,599 % |
| USDm -> COPm | 3242,07 | 3251,8 | 0,599 % |

- Le prix est **identique aux 4 tailles** : pool à somme constante au prix de l'oracle, moins le spread. Pas de glissement mesurable jusqu'à 5000 USD, car les réserves virtuelles sont de 10 M USDm contre 55 M BRLm (ou 32 541 M COPm).
- Frais réel = le spread (0,30 %), donc 0,6 % pour un aller-retour.
- Plafonds de flux net (`tradingLimitsConfig`, limite globale, drapeau 4, unités de jeton) : BRLm 224 479 USDm net / 1 119 363 BRLm net ; COPm 28 457 USDm net / 91 177 148 COPm net. Je n'ai pas lu l'état courant (`tradingLimitsState`) : la marge restante est inconnue.
- Cotation en USDC ou USDT : non faite en un saut, aucun échange Mento n'a USDC/USDT. Il faudrait passer par le pool Uniswap USDm/USDC ou USDm/USDT (0,01 %, liquidité minuscule pour USDm/USDC : ~206 USDC selon le rapport on-chain).
- `getAmountIn` non interrogé : même formule inversée, `getAmountOut` suffit pour le comparatif.

**Mento atteint-il un wFIAT Ripio ? Non.** BRLm et COPm sont des jetons Mento distincts des wBRL/wCOP de Ripio. Aucun échange Mento ne contient de wFIAT. Seul Uniswap (wARS et wBRL contre USDT) y mène.

**Remplacer ou compléter ?**
- Colombie : COPm est la **seule** voie on-chain à prix correct pour la Colombie aujourd'hui (wCOP n'a aucun pool). Mais le commerçant recevrait du COPm, pas du wCOP : complément utile si le produit accepte un règlement en COPm, pas un remplacement du wCOP.
- Brésil : BRLm à 5,4815 (+0,8 % par rapport au taux er-api 5,4375, +0,3 % par rapport à l'oracle) est **meilleur** que le pool wBRL/USDT (5,3197, soit -2,2 % à -3,2 % pour le payeur). Même réserve : ce n'est pas du wBRL.
- Argentine, Mexique, Chili, Pérou : rien chez Mento.

## T7 - Écart des pools au taux de référence

Seuls **2 pools** existent sur 24 paires x 4 paliers de frais : wARS/USDT (0,01 %) et wBRL/USDT (0,01 %). Aucun pool pour wMXN, wCOP, wCLP, wPEN, ni contre USDC, USAT ou USDm. Prix tiré de `slot0` (wFIAT par USD).

| Pool | Prix pool | Référence | Valeur | Écart |
| --- | --- | --- | --- | --- |
| wARS/USDT | 1656,33 | dólar cripto (dolarapi) | 1657,24 | -0,05 % |
| | | CriptoYa USDT/ARS (médiane) | 1654,56 | +0,14 % |
| | | MEP (dolarapi bolsa) | 1569,9 | **+5,5 % (>5 %)** |
| | | blue | 1555 | **+6,5 % (>5 %)** |
| | | officiel (dolarapi) | 1545 | **+7,2 % (>5 %)** |
| | | open.er-api (officiel) | 1544,65 | **+7,2 % (>5 %)** |
| wBRL/USDT | 5,3197 | open.er-api | 5,4375 | **-2,2 % (>2 %)** |
| | | AwesomeAPI | 5,4978 | **-3,2 % (>2 %)** |
| | | oracle Mento (1/BRLm) | 5,4980 | **-3,2 % (>2 %)** |

Sens des écarts : un prix pool inférieur à la référence signifie que le payeur reçoit moins de wFIAT par USD, donc un wFIAT surévalué dans le pool.

Références horodatées dans le JSON (`t7Refs`, 2026-11-03 ~17:05 UTC) : dolarapi.com (oficial, bolsa, cripto, blue), criptoya.com/api/usdt/ars/1, open.er-api.com/v6/latest/USD, economia.awesomeapi.com.br. Pour MXN, COP, CLP et PEN les références sont dans le JSON mais il n'y a pas de pool à comparer.

Parité 1:1 du peso : 1 wARS vaut 1/1656 USD dans le pool, soit le dólar cripto à 0,05 % près ; contre l'officiel, wARS est surévalué de 7,2 %. Donc la parité du wARS est avec le cours cripto, pas avec l'officiel.

Conclusion sur la garde de prix de 2 % : ARS passe seulement avec la référence cripto (conforme à `fx.ts`). BRL dépasse déjà 2 % avec les trois références, donc la garde de 2 % bloque ou frôle le wBRL ; à trancher par l'humain (seuil, ou réf. différente). Les deux pools ont une faible liquidité (68,8e18 et 0,91e18 de liquidité L).

## T6 - Cruce

**Non fait : aucune source publique trouvée.** Deux recherches web (« Cruce Celo FX », « Cruce x402 FX router SDK ») n'ont rien donné sur un produit nommé Cruce. Le seul indice vient de notre doc d'architecture : « Cruce : routeur FX en SDK, payé en x402 ». cruce.xyz répond mais c'est un site GoDaddy sans contenu exploitable ; cruce.finance et api.cruce.finance ne répondent pas. Aucun contrat, API de devis ni route wCOP vérifiable. Sans SDK ni clé, pas de test (et je n'installe pas de SDK tiers). Question ouverte : l'URL ou le dépôt exact de Cruce (donnée par le hackathon ?).

## Anomalies et manques
- Oracle Mento exprimé en USD par unité locale (BRL : 0,1819), inversé dans le JSON (`mento_oracle`).
- L'état des plafonds Mento (`tradingLimitsState`) n'est pas lu.
- Pas de référence non-ARS/BRL avec pool, donc T7 se limite à 2 pools.
- Le flag 5 % pour wARS dépend entièrement du choix de référence (officiel ou cripto).
