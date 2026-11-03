# Plan 3 — tests de liquidité des wFIAT et comparaison des frais

Nov 3, 2026 · @Noé

## 1. Objectif et livrables

Ces tests mesurent, sur Celo mainnet et en lecture seule, ce que chaque wFIAT permet réellement, pour remplacer les hypothèses des plans 1 et 2 par des chiffres. Ils prolongent le [plan 1, architecture](https://claude.ai/artifact/UzRLuEXJqFC54fhgfCCEpo) et le [plan 2, extensions](https://claude.ai/artifact/H46bBps7mqHjxnaXaueMBb).

**Ce que les tests doivent décider**

1. Le niveau de chaque pays (Complet, Partiel, Hors périmètre) pour les six wFIAT.
2. Le plafond par paiement de chaque route, selon la profondeur observée.
3. Les sources de prix à intégrer au solveur : Uniswap, Mento, Textile, ou Cruce.
4. Le go ou no-go de E4 (Textile RFQ) et de E9 (bridge), et la priorité de E5 (autres pays).
5. Les pourcentages de frais que l'on peut afficher à l'écran sans exagérer.

**Livrables**

- `coverage-matrix.json` : un fichier de données lu par le solveur, qui calcule le niveau de chaque pays. Aucun pays n'est codé en dur.
- Un rapport de frais : coût total mesuré par route et par taille, à côté des références classiques sourcées.
- Une section README « Couverture et frais » générée depuis ces données.
- Une mise à jour des priorités du plan 2.

## 2. Méthode commune

Toutes les mesures se font en lecture seule sur Celo mainnet (chaîne 42220), avec un script reproductible qui enregistre le bloc et l'heure de chaque cotation.

**Tokens et paires**

- Les six wFIAT : wARS, wBRL, wMXN, wCOP, wCLP, wPEN (18 décimales).
- Actifs de référence : USDT, USDC, USA₮ (6 décimales). Les adresses viennent de la page Stablecoin Contracts de la doc Celo et sont vérifiées on-chain.
- Paires : chaque wFIAT contre chaque actif de référence (18 paires), puis chaque paire wFIAT contre wFIAT (15 paires), en direct ou via un saut par USDT ou USDC. Priorité aux 18 premières : les payeurs détiennent surtout de l'USDT et de l'USDC (voir section 9), les routes wFIAT contre wFIAT passent en second.

**Tailles de test :** 5, 50, 500 et 5 000 USD équivalents, dans les deux sens (achat et vente du wFIAT). La taille est convertie en unités du token avec le taux de référence du moment.

**Sources de prix à interroger**

- **Uniswap V3 sur Celo :** la factory pour trouver les pools aux paliers de frais 0,01 %, 0,05 %, 0,3 % et 1 %, puis le QuoterV2 en cotation « sortie exacte », comme dans le solveur.
- **Mento :** routes entre les stablecoins Mento (liste à découvrir on-chain).
- **Textile RFQ :** devis fermes pour wARS et wBRL, avec la clé d'API.
- **Contrôle croisé :** un service public de données de pools (type GeckoTerminal ou DefiLlama, à vérifier) pour repérer des pools ou d'autres DEX que la factory n'aurait pas listés.

**Taux de référence :** un taux de change externe par monnaie. Pour l'Argentine, plusieurs taux coexistent (officiel, MEP, parallèle) : on note celui utilisé et on compare aussi à la parité 1 pour 1 du wARS avec le peso.

**Règles de sécurité**

- Aucune clé privée dans les scripts, aucune transaction envoyée, sauf pour T8 et T12, faits à la main avec de petits montants depuis le wallet de l'agent.
- Chaque résultat enregistre : bloc, horodatage, source, adresse du pool, palier de frais, taille, montant reçu, glissement, taux de référence utilisé.
- Trois passages à des heures différentes (nuit, matin, soir) pour mesurer la variabilité.

## 3. Matrice des tests

Douze tests : huit se font en lecture seule par des sous-agents (T11 d'abord en simulation), quatre demandent une action humaine (clé, wallet ou ouverture de liens).

| Test | Question | Méthode | Sortie | Décision liée |
| --- | --- | --- | --- | --- |
| T1 Découverte des pools | Quels pools Uniswap existent pour chaque wFIAT, à quels paliers de frais ? | `getPool` de la factory pour 18 paires × 4 paliers, plus contrôle croisé | Liste des pools avec adresse et liquidité | Niveau de chaque pays |
| T2 Profondeur et glissement | Jusqu'à quelle taille le glissement reste-t-il sous 1 % ? | QuoterV2 aux 4 tailles, 2 sens, 3 passages | Courbe taille contre glissement par pool | Plafond par paiement |
| T3 Routes à deux sauts et wFIAT contre wFIAT | Combien coûte un wBRL vers wARS via USDT ? Quelles paires sont possibles ? | Cotations via USDT et USDC pour les 15 paires | Coût total par paire | Corridors à présenter (AR vers BR, autres) |
| T4 Mento | Mento offre-t-il des routes utiles (BRL, COP, autres) et à quel prix ? | Découverte on-chain des routes, cotations aux 4 tailles | Table de routes Mento | Ajouter ou non une source Mento au solveur |
| T5 Textile RFQ | Les devis Textile battent-ils Uniswap sur wARS et wBRL ? | Devis fermes aux 4 tailles avec la clé d'API (humain) | Écart de prix Textile contre Uniswap | Go ou no-go de E4 |
| T6 Cruce (optionnel) | Cruce expose-t-il des routes, dont wCOP, que nous n'avons pas ? | Cotations du SDK en lecture seule | Routes et prix comparés | Source externe optionnelle, prudence avec un tiers |
| T7 Écart au taux de référence | Chaque pool est-il à son prix juste ? | Prix du pool contre taux externe, par pays | Écart en % par pool | Seuil de la garde de prix (2 % par défaut) |
| T8 Mode de tirage par token | Quels tokens acceptent EIP-3009, EIP-2612 ou Permit2 ? | Lecture des contrats, puis transaction d'essai minuscule (humain) | Tableau token contre mode | Modes à implémenter, repli |
| T9 Rampes Ripio par pays | Entrée et sortie sont-elles disponibles pour chaque pays ? | Ouverture manuelle des liens `country=XX`, relevé des tokens et limites affichés (humain) | Tableau pays contre rampe | Parcours de retrait, bouton « payer en pesos » |
| T10 Bridge Ripio | Quelles routes, frais fixes et plafonds journaliers ? | Lecture on-chain de `routeConfigs` | Routes, frais, plafonds | Go ou no-go de E9 |
| T11 Coût en gas | Combien coûte un `pay` selon la route ? | Simulation sur fork, puis mesure sur mainnet : 1 jambe, 2 jambes, 2 sauts | Gas et coût en USD | Budget de gas du relayeur |
| T12 Paiements d'essai mainnet | Quel est le coût total réel de bout en bout ? | Petits paiements (0,5 à 5 $) par route retenue depuis le wallet de l'agent (humain) | Coût total mesuré, hashs enregistrés | Frais affichables, page de preuves |

## 4. Matrice de couverture à remplir

Deux tableaux à remplir avec les résultats : la liquidité sur Celo, puis l'accès aux autres sources et aux rampes. « Annoncé » signale une information issue des équipes Celo, Textile ou Ripio, pas encore mesurée par nous.

**Liquidité sur Celo (T1, T2, T7)**

| Pays | Token | Pool contre USDT | Pool contre USDC | Glissement à 50 $ | Glissement à 500 $ | Glissement à 5 000 $ | Plafond par paiement |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Argentine | wARS | Annoncé, palier 0,01 %, liquidité faible | À mesurer | À mesurer | À mesurer | À mesurer | À définir |
| Brésil | wBRL | Annoncé, palier 0,01 %, liquidité faible | À mesurer | À mesurer | À mesurer | À mesurer | À définir |
| Mexique | wMXN | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À définir |
| Colombie | wCOP | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À définir |
| Chili | wCLP | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À définir |
| Pérou | wPEN | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À définir |

**Accès, sources alternatives et niveau (T3 à T6, T9, T10)**

| Pays | Mento | Textile RFQ | Rampe d'entrée | Rampe de sortie | Bridge Ripio | Niveau retenu |
| --- | --- | --- | --- | --- | --- | --- |
| Argentine | À mesurer | Annoncé (wARS) | Annoncée publique | Annoncée publique | À mesurer | À décider |
| Brésil | À mesurer | Annoncé (wBRL) | À tester | À tester | À mesurer | À décider |
| Mexique | À mesurer | Non annoncé | À tester | À tester | À mesurer | À décider |
| Colombie | À mesurer | Non annoncé | Annoncée publique | Annoncée publique | À mesurer | À décider |
| Chili | À mesurer | Non annoncé | À tester | À tester | À mesurer | À décider |
| Pérou | À mesurer | Non annoncé | À tester | À tester | À mesurer | À décider |

## 5. Seuils de décision

Les seuils transforment les mesures en un niveau par pays, lu ensuite par le solveur dans `coverage-matrix.json`. Ils sont posés avant les mesures pour ne pas les ajuster après coup.

| Niveau | Condition (par token wFIAT) | Ce que Cobrá affiche |
| --- | --- | --- |
| Complet | Pool direct ou route à 2 sauts avec un glissement ≤ 1 % à 50 $ et ≤ 3 % à 500 $, déviation au taux de référence ≤ 2 %, mode de prélèvement vérifié (T8), au moins un paiement réel réussi (T12) | Le pays est proposé comme règlement par défaut |
| Partiel | Glissement ≤ 3 % à 50 $ seulement, ou mode de prélèvement non vérifié, ou aucune rampe de sortie testée | Le pays est proposé avec un plafond par paiement et un avertissement |
| Hors périmètre | Pas de pool exploitable, glissement > 3 % à 50 $, ou déviation > 2 % non expliquée | Le pays est annoncé « bientôt », sans devis |

**Plafond par paiement.** Le plafond est la plus grande taille testée (5, 50, 500 ou 5 000 $) dont le glissement reste sous le seuil du niveau. Il est écrit dans la matrice et appliqué par le solveur avant tout devis.

**Règles de lecture**

- La garde de prix du solveur (2 % contre le taux externe) reste la protection finale, quel que soit le niveau.
- Un niveau ne monte que sur une mesure répétée à deux moments différents de la journée, pour écarter une liquidité passagère.
- Si seules deux paires sont Complet, la démo et le message d'accueil se concentrent sur ces deux pays, et les autres restent visibles comme « bientôt ».

## 6. Comparaison des frais

Objectif : un chiffre honnête, en pourcentage du montant, comparable entre Cobrá et les moyens de paiement que le commerçant utilise déjà. Les références ci-dessous viennent de sources publiques, certaines anciennes ou générales : elles servent d'ordre de grandeur et sont à dater dans le rapport final.

**Formule du coût total pour un paiement**

Coût total (%) = frais de réseau (gaz converti dans le token du payeur) + frais de swap (palier du pool) + glissement mesuré + écart au taux de référence + frais de service Cobrá (0 à ce stade) + éventuelle rampe de sortie, le tout divisé par le montant payé. Le coût est calculé pour les tailles 5, 50, 500 et 5 000 $, car les frais fixes pèsent surtout sur les petits montants.

**Références à comparer**

| Moyen de paiement | Ordre de grandeur pour le commerçant ou le payeur | Source et réserve |
| --- | --- | --- |
| Pix (Brésil) | environ 0,22 % en moyenne côté commerçant | BIS ; moyenne, varie selon le prestataire |
| Carte de débit (Brésil) | plus de 1 % | BIS |
| Carte de crédit (Brésil) | jusqu'à 2,2 % | BIS |
| Cartes, petit commerçant | 2,5 à 3,5 % | sources sectorielles, non datées |
| Argentine, encaissement en ligne | environ 3 % | source non datée |
| Colombie, prestataire de paiement | 3,29 % + 300 COP | Rapyd ; tarif public |
| Carte étrangère, payeur | 1 à 3 % de frais + marge de change | émetteurs de cartes ; varie |
| Brésil, taxe IOF sur le change | jusqu'à 3,5 % | source d'un fournisseur crypto ; à vérifier avant publication |
| Virement SWIFT | 35 à 50 $ fixes + 2 à 4 % de marge | banques ; varie |
| Envoi d'argent (transfert de fonds) | 6,4 % dans le monde, 5,9 % Amérique latine et Caraïbes | Banque mondiale, T4 2023 |

**Frais mesurés pour Cobrá (à remplir par T2, T7, T11)**

| Paire (payeur → commerçant) | Taille | Gaz | Swap + glissement | Écart au taux | Total mesuré | Meilleure référence du pays | Écart |
| --- | --- | --- | --- | --- | --- | --- | --- |
| USDT → wARS | 50 $ | À mesurer | À mesurer | À mesurer | À mesurer | À définir | À calculer |
| USDT → wBRL | 50 $ | À mesurer | À mesurer | À mesurer | À mesurer | Pix ≈ 0,22 % | À calculer |
| USDC → wMXN | 50 $ | À mesurer | À mesurer | À mesurer | À mesurer | À définir | À calculer |
| USDC → wCOP | 50 $ | À mesurer | À mesurer | À mesurer | À mesurer | 3,29 % + 300 COP | À calculer |
| wBRL → wARS (deux sauts) | 50 $ | À mesurer | À mesurer | À mesurer | À mesurer | SWIFT ou carte étrangère | À calculer |
| Toute paire retenue | 5, 500, 5 000 $ | À mesurer | À mesurer | À mesurer | À mesurer | À définir | À calculer |

**Lecture honnête**

- Contre le Pix, Cobrá ne gagnera pas au Brésil pour un payeur local : la valeur est pour le payeur qui détient du stablecoin ou une autre wFIAT, face à une carte étrangère, un virement ou un envoi d'argent.
- Le rapport doit dire clairement pour quelles paires et quelles tailles Cobrá est moins cher, égal ou plus cher, sans choisir seulement les cas favorables.
- Les frais de rampe (T9) sont affichés à part, car ils dépendent du prestataire et du pays, pas du routeur.

## 7. Briefs et planning

Les sous-agents tournent la nuit en lecture seule ; les tâches humaines sont regroupées en une session courte. Tout doit être rendu avant mercredi midi pour laisser la fin de semaine à la construction du plan 2.

**Planning**

| Moment | Qui | Tests | Sortie attendue |
| --- | --- | --- | --- |
| Nuit du 3 au 4 nov. | Sous-agent A | T1, T2 | `pools.json` : pools trouvés, paliers, liquidité, glissement aux 4 tailles |
| Nuit du 3 au 4 nov. | Sous-agent B | T3, T10, T11 (simulation) | routes à 2 sauts, `routeConfigs` du bridge, coût de gaz simulé |
| Mardi 3 nov., en journée | Vous | T5 (demande de clé Textile), T9 (rampes AR, CO, BR), T8 (une transaction par token) | clé demandée, captures des rampes, tableau des modes de prélèvement |
| Nuit du 4 au 5 nov. | Sous-agent C | T4, T7, T6 si la clé ou le temps le permettent | déviation au taux de référence, devis Mento et Textile |
| Mercredi 4 nov., matin | Sous-agent D | assemblage de `coverage-matrix.json` et du rapport de frais | matrice, rapport, tableau de la section 6 rempli |
| Mercredi 4 nov., midi | Vous | relecture, décision des niveaux (section 5), T12 sur les paires Complet | niveaux figés |
| Jeudi 5 nov., 13 h Paris | Vous | heures de bureau : poser les questions restées ouvertes (clé Textile, rampe BR, liquidité wARS) | réponses notées dans le rapport |

**Brief type pour chaque sous-agent**

- Objectif en une phrase et fichier de sortie nommé.
- Lecture seule : aucune clé privée, aucune signature, aucun envoi de transaction. Seules des lectures de chaîne (RPC, `eth_call`, devis) sont permises.
- Adresses des tokens à revérifier sur Celoscan avant usage, jamais reprises d'un dépôt tiers sans contrôle.
- Chaque mesure est horodatée, avec le bloc, la source et la requête utilisée, pour pouvoir la rejouer.
- Si une source est inaccessible ou une valeur incohérente (déviation > 5 %), le sous-agent l'écrit tel quel dans la sortie et passe au test suivant, sans corriger de lui-même.
- Arrêt après deux tentatives échouées sur le même test ; le rapport liste ce qui manque.

**Tâches humaines**

- T5 : demander la clé de l'API Textile RFQ (docs.textilecredit.com) ; sans clé, le test est marqué non réalisé et la source reste hors de la v1.
- T8 : une petite transaction par token pour confirmer le mode de prélèvement (EIP-3009, Permit2 ou approbation) ; la transaction doit porter le code d'attribution `celo_502e1bea2794`.
- T9 : ouvrir les liens de rampe Ripio pour chaque pays et noter ce qui fonctionne, sans aller jusqu'au paiement si la vérification d'identité est requise.
- T12 : paiements réels de quelques dollars seulement, signalés comme tels dans le README.

## 8. Risques, limites et effet sur les plans 1 et 2

**Risques**

| Risque | Effet | Réponse |
| --- | --- | --- |
| Liquidité très faible sur la plupart des paires wFIAT | Peu de pays en niveau Complet | Annoncer honnêtement la couverture réelle ; concentrer la démo sur les pays Complet ; les autres en « bientôt » |
| Mesure instantanée non représentative | Niveau faux, devis échoués en démo | Deux mesures à des moments différents ; plafond par paiement ; garde de prix du solveur |
| Clé Textile non obtenue | Source RFQ absente | Test marqué non réalisé ; l'extension E4 du plan 2 reste en bonus |
| Rampe BR, MX, CL, PE non disponible | Pas d'entrée ni de sortie en monnaie locale | Le pays reste utilisable pour un payeur qui détient déjà le token ; l'indiquer clairement |
| Références de frais anciennes ou générales | Comparaison contestable | Dater chaque source ; afficher des fourchettes ; ne pas présenter un gain là où il n'y en a pas |
| Soldes de test insuffisants pour wMXN, wCOP, wCLP, wPEN | T8 et T12 impossibles sur ces pays | Les marquer non vérifiés ; au plus Partiel tant qu'aucun paiement réel n'a réussi |

**Limites de ce plan**

- Les mesures disent ce qui est possible aujourd'hui, pas ce qui le sera dans une semaine : la liquidité peut changer.
- Un devis n'est pas un paiement : seul T12 prouve qu'une paire fonctionne de bout en bout.
- Les chiffres de frais comparés sont des ordres de grandeur ; ils ne remplacent pas un tarif signé par un prestataire.

**Effet sur le plan 1 (architecture)**

- Le solveur lit `coverage-matrix.json` pour les niveaux et les plafonds, au lieu d'une liste de pays codée en dur.
- Les routes à 2 sauts sont activées seulement si T3 les valide ; la limite de 3 étapes reste inchangée.
- Aucun changement de contrat n'est nécessaire : les tests sont en lecture seule. La décision sur la conversion (option D) reste indépendante.

**Effet sur le plan 2 (extensions)**

- E5 (Mexique, Colombie, Chili, Pérou) ne se fait que pour les pays au moins Partiel dans la matrice.
- E4 (essai Textile) dépend du résultat de T5.
- E9 (bridge Ripio) est priorité plus haute si T10 montre une route ouverte sans plafond bloquant.
- La page de preuve (E2) peut afficher le tableau de couverture et la comparaison de frais mesurée.

## 9. Demande réelle : ce que les utilisateurs veulent vraiment

Les tests disent ce qui est possible, pas ce qui est voulu. Ce retour vient d'Emiliano (commerçants argentins) : il est utile mais vient d'une seule personne et d'un seul pays, donc à confirmer avec d'autres.

**Ce que dit le terrain (Argentine)**

- La plupart des utilisateurs de crypto détiennent des dollars numériques, surtout USDT, puis USDC, pour se protéger de l'inflation.
- Le wARS est récent et presque personne n'en détient : c'est un rail de paiement, pas une réserve de valeur.
- Son projet part du payeur sans crypto, qui paie en pesos depuis sa banque via la rampe Ripio ; le commerçant reçoit du wARS, qu'il garde ou change en dollars ensuite.

**Ce qui en découle pour Cobrá**

| Sujet | Hypothèse retenue | À vérifier |
| --- | --- | --- |
| Entrée principale | USDT ou USDC vers wFIAT du commerçant | Même réponse chez des Brésiliens, Colombiens, Mexicains |
| Payeur avec un autre wFIAT | Cas marginal, routes à deux sauts en priorité basse | Si le seul usage est un voyageur ou un commerçant transfrontalier |
| Commerçant argentin | Il a besoin de pesos pour ses dépenses, donc le wARS n'est qu'un règlement de court terme | Peut-il sortir en pesos simplement (T9) ? |
| Commerçant brésilien | Le Pix est instantané et peu cher, donc l'intérêt de wBRL est faible hors payeur étranger | Qui paierait en crypto un commerçant brésilien ? |
| Valeur de Cobrá | Prix affiché en monnaie locale, paiement avec ce que le payeur détient, règlement au choix du commerçant | Le commerçant préfère-t-il pesos ou dollars ? |

**Réglage de règlement par commerçant**

Le commerçant fixe ses prix en monnaie locale puis choisit ce qu'il reçoit : wFIAT local ou dollar numérique (USDT ou USDC). Le wFIAT devient une option de règlement, pas une obligation. Le routeur gère déjà ce cas : le token de réception est un paramètre de la facture.

**Test auprès des commerçants et testeurs**

- Question à poser : « Avec une sortie en pesos disponible, préférez-vous recevoir des pesos (wFIAT) ou des dollars ? »
- Question aux payeurs : « Quel token détenez-vous, et quel prix voulez-vous voir affiché ? »
- Les réponses, avec le pays et le nombre de répondants, vont dans le rapport et décident du règlement par défaut.

**Effet sur les priorités et le message**

- Les tests T1, T2 et T7 sur les paires USDT ou USDC vers wARS et wBRL passent avant T3 (wFIAT contre wFIAT).
- T9 (rampe de sortie en pesos) gagne en importance : sans sortie simple, le commerçant préfèrera les dollars.
- Le README présente le wFIAT comme un rail et dit franchement que la demande de détention est faible. La couverture affichée reste celle des mesures, pas celle de l'ambition.
- Positionnement face au projet d'Emiliano : le sien sert le payeur sans crypto, Cobrá sert celui qui en a déjà. Un test croisé est possible, avec un de ses utilisateurs qui paie une facture Cobrá.
- Plan 2 : ajouter le réglage « pesos ou dollars » et la formulation « rail, pas réserve de valeur » à la liste des extensions.
