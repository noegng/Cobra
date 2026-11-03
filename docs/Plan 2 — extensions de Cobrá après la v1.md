# Plan 2 — extensions de Cobrá après la v1

Nov 2, 2026 · @Noé

## 1. Objectif et déclencheur

Ce plan ajoute des extensions à Cobrá une fois la v1 terminée, avec un seul but : renforcer les cinq critères du track LatAm par des preuves que le jury peut voir. Il prolonge le [plan 1, architecture globale](https://claude.ai/artifact/UzRLuEXJqFC54fhgfCCEpo).

**Déclencheur : à cocher avant de commencer**

- [ ] Un paiement réel de bout en bout sur Celo mainnet, en wARS ou wBRL, avec son hash.
- [ ] Au moins un commerçant pilote a créé une facture et reçu un paiement.
- [ ] Tests verts du routeur, du solveur et du relayeur, README à jour.
- [ ] ERC-8004, ERC-8021, plafonds et kill switch vérifiés.

Si un point manque jeudi 5 novembre au soir, on corrige la v1 avant toute extension. Seule E2 (page de preuves) reste autorisée.

**Règles**

- Chaque extension vise au moins un des cinq critères et se livre derrière un drapeau d'activation, sans casser la v1.
- Gel des fonctionnalités samedi 7 novembre. Après : corrections, preuves et livrables seulement.
- Chaque extension a un test d'acceptation écrit avant le code.
- Les sous-agents n'ont jamais accès aux clés (règles de la section 10 du plan 1).

**Les cinq critères fixés par Ripio**

1. Fonctionne sur mainnet avec un vrai wFIAT.
2. Usage réel de wFIAT et de la pile Celo.
3. Agent autonome et utile.
4. UX utilisable par une vraie personne.
5. Impact clair pour l'Amérique latine.

## 2. Matrice effort et impact

Trois extensions rapportent beaucoup pour peu d'effort et passent en premier : la page de preuves, la facture x402 et les autres pays.

&#91;embedded content: matrice effort et impact · 9 extensions\]

E3 et E4 ont un impact fort mais un effort élevé : on n'en développe qu'une, E3. E7 est à éviter tant que la v1 n'est pas prête.

## 3. Extensions

Neuf extensions, chacune rattachée à un critère, avec un effort estimé en jours de travail avec sous-agents, à réviser une fois la v1 terminée.

| Extension | Critère renforcé | Effort (jours) | Dépend de | Test d'acceptation |
| --- | --- | --- | --- | --- |
| E1 Facture x402 | 2 Pile Celo, 3 Agent | 1 | API de factures v1 | Une commande x402 depuis un agent paie une facture en wARS via le facilitateur Celo, la facture passe à `paid` |
| E2 Page de preuves publique | 1, 4, 5 | 0,5 à 1 | Indexeur v1 | Chaque chiffre affiché renvoie à une transaction Celoscan, la page marche sans connexion |
| E3 Trésorerie automatique | 3 Agent, 5 Impact | 2 à 3 | Relayeur, solveur, indexeur | Avec la règle « garder 30 % en USD », l'agent propose une conversion groupée au seuil, le commerçant confirme en un tap, la transaction est taguée |
| E4 Textile RFQ | 1, 2 | 0,5 d'essai, puis 2 | Clé d'API Textile | Le solveur affiche un devis Textile à côté d'Uniswap pour la même facture. L'exécution n'est lancée que si l'essai montre un meilleur prix et un chemin clair |
| E5 Autres pays (MX, CO, CL, PE) | 5 Impact | 1 | Config devises, source de taux | Une facture en MXN est payée avec du wMXN, les autres devises se règlent en direct ou en stablecoin USD avec un message clair |
| E6 Notes vocales et catalogue | 4 UX | 0,5 à 1 | Bot v1 | Une note vocale crée la facture après confirmation, cinq produits fréquents se facturent en un tap |
| E7 Wallet à passkey | 4 UX, 5 Impact | 3 ou plus | Choix d'un fournisseur de smart account | Un commerçant sans wallet en crée un par passkey et reçoit un paiement |
| E8 Réputation ERC-8004 | 2 Pile Celo | 0,5 | Identité enregistrée | Après un paiement, le payeur peut laisser un avis dans le registre. Aucun avis automatique de l'agent sur lui-même |
| E9 Bridge des wFIAT depuis d'autres chaînes | 2 Pile Celo, 5 Impact | 1 | Routes du bridge lues on-chain, approbation ERC-20 | Un payeur qui détient du wARS sur Base ou World Chain le dépose dans le bridge depuis la page puis paie sur Celo, les frais fixes de la route et le plafond journalier sont affichés |

**Notes techniques**

- **E1 :** utiliser le facilitateur Celo (`https://api.x402.celo.org`), car un facilitateur tiers ne compte pas pour le sous-track USA₮. Pour les wFIAT : méthode de transfert Permit2 et sponsorisation du gas EIP-2612. Le prix s'exprime avec l'adresse de l'actif et en unités de base (18 décimales), pas avec le raccourci en dollars. Vérifier actif, montant et `payTo` avant de livrer la valeur. Après les crédits gratuits, le règlement coûte le gas plus 0,3 %.
- **E3 :** les fonds restent dans le wallet du commerçant, l'agent ne peut donc rien convertir seul. Version retenue : l'agent propose, le commerçant signe en un tap. Une délégation limitée par clé de session est hors plan.
- **E4 :** obtenir la clé d'API auprès de l'équipe Textile dès maintenant, car la demande prend du temps. Documentation : docs.textilecredit.com.
- **E7 :** dépendance nouvelle à évaluer, à ne lancer que si tout le reste est fini.

**Point de vigilance sur E1 :** le score est rattaché au wallet unique de l'agent, et le facilitateur x402 envoie lui-même la transaction. Si `payTo` est le wallet du commerçant, ces paiements ne rapportent rien au classement : E1 sert alors à démontrer l'usage de la pile Celo. Pour qu'ils comptent, `payTo` devrait être le wallet de l'agent, ce qui change le modèle (l'agent encaisse puis reverse). À trancher avant de lancer E1, et à demander aux organisateurs jeudi.

**Notes sur E9 :** le bridge de Ripio est un pont cross-chain des wFIAT, sans sandbox ni testnet. Les routes actives se lisent on-chain (`routeConfigs`), car les tables de la page ne s'affichent pas. Chaque route a des frais fixes, et un plafond journalier de création s'applique. Le payeur a besoin de gas sur la chaîne d'origine : c'est une friction, d'où la priorité faible.

## 4. Séquence d'exécution

L'ordre suit le rapport impact sur effort : preuves et x402 d'abord, trésorerie ensuite, et les extensions risquées seulement si tout est vert.

| Moment | Extensions | Sortie attendue |
| --- | --- | --- |
| Mercredi 4 nov, soir | Vérifier le déclencheur, demander la clé Textile. Nuit 3 : E2 puis E1 | Page de preuves v0, facture x402 testée sur mainnet avec un petit montant |
| Jeudi 5 nov | Office hours à 13 h (Paris). Nuit 4 : E5 puis E6 | Quatre pays de plus, notes vocales et catalogue |
| Vendredi 6 nov | Nuit 5 : E3 en version « l'agent propose, le commerçant signe », essai E4 en lecture seule | Trésorerie avec conversion groupée, comparaison de prix Textile |
| Samedi 7 nov | Gel des fonctionnalités. Nuit 6 : corrections, mise à jour de E2, README, vidéo | Dépôt prêt à soumettre |

**Priorité décroissante :** E2, E1, E5, E3, E6, E4 (essai seulement), E8, E9, E7. E7, E8 et E9 ne se lancent que si tout le reste est vert vendredi à midi.

**Règles d'arrêt**

- Plus de nouvelle extension après vendredi 6 novembre, 12 h.
- Une extension qui dépasse 1,5 fois son estimation est coupée et son drapeau reste désactivé.
- Entre E3 et E4, on ne garde que E3 en développement complet : E4 reste un essai de comparaison de prix.
- Si la v1 casse après une fusion, on revient à la dernière version verte avant de continuer.

## 5. Briefs pour sous-agents

Chaque sous-agent reçoit un brief court avec ses fichiers autorisés, ses interdits et ses tests écrits d'avance : c'est ce qui permet de lancer plusieurs nuits en parallèle sans collision.

**Modèle de brief**

```markdown
Extension : <identifiant et nom>
Objectif : <une phrase>
Contexte : <liens vers le plan 1 et les interfaces gelées>
Fichiers autorisés : <dossiers que l'agent peut modifier>
Interdits : clés privées, contrat déployé, dépendances non listées, mainnet en écriture
Drapeau d'activation : <nom de la variable, désactivé par défaut>
Tests d'acceptation (à écrire d'abord) : <liste>
Livrable : branche dédiée, tests verts, section de README
Rapport de nuit : fait, à relire, bloqué
```

**Exemple E1, facture x402**

- Objectif : exposer chaque facture comme ressource payante x402, avec `payTo` égal au wallet du commerçant.
- Emplacement : le worker Express, car les paquets x402 documentés ciblent Express et Hono.
- Tests : configuration du prix (adresse de l'actif, 18 décimales) et règlement de bout en bout sur Celo Sepolia avec USDC, les wFIAT n'existant pas sur testnet. Le test avec wARS sur mainnet est fait à la main avec un petit montant.
- Interdits : facilitateur tiers, modification du routeur.
- Drapeau : `X402_ENABLED`.

**Exemple E2, page de preuves**

- Objectif : page publique `/proof` qui liste transactions Celoscan, payeurs distincts, volume en wFIAT, économie moyenne face à la route naïve, identité ERC-8004 de l'agent.
- Règle : aucun chiffre saisi à la main, tout vient de la base alimentée par l'indexeur.
- Tests : jeu de données fictif, vérification que chaque nombre affiché a un lien de transaction.
- Drapeau : aucun, la page est en lecture seule.

**Exemple E3, trésorerie**

- Objectif : moteur de politique qui, à partir des soldes du commerçant (lecture seule) et de sa règle, produit une proposition de conversion groupée via le solveur, envoyée par Telegram avec un bouton vers la page de signature.
- Tests : simulateur de pools, propriété « la proposition ne dépasse jamais le plafond », économie face à des conversions unitaires.
- Interdits : aucune signature de l'agent sur les fonds du commerçant.
- Drapeau : `TREASURY_ENABLED`.

## 6. Grille d'auto-évaluation des cinq critères

Un critère n'est considéré comme prêt que si sa preuve est cliquable depuis le README ou la page de preuves. À remplir chaque matin après la revue de nuit.

| Critère | Preuve visible par le jury | Extension liée | État |
| --- | --- | --- | --- |
| 1 Mainnet avec un vrai wFIAT | Hashs de paiements en wARS ou wBRL sur Celoscan, listés dans le README et la page de preuves | E2 | À faire |
| 2 Usage réel de wFIAT et de la pile Celo | Règlement en wFIAT, identité ERC-8004, tag ERC-8021, EIP-3009 et Permit2, Uniswap sur Celo, facture x402 | E1, E4, E8 | À faire |
| 3 Agent autonome et utile | Journal des décisions : route choisie, économie réalisée, rappels, clôture, propositions de trésorerie | E3 | À faire |
| 4 UX utilisable par une vraie personne | Vidéo de 90 secondes, parcours testé sur téléphone, retours des pilotes, espagnol et portugais | E6, E7 | À faire |
| 5 Impact clair pour l'Amérique latine | Nombre de commerçants, payeurs indépendants, volume, économie moyenne, un témoignage, pays couverts | E2, E5 | À faire |

**États possibles :** À faire, En cours, Prêt (preuve vérifiée par un autre agent ou par toi).

**Outil du hackathon pour s'auto-évaluer :** la commande `npx loopshouse add agents-on-open-rails` installe le CLI et le skill de l'événement dans ton agent codeur (Node 20.12 ou plus, connexion dans le navigateur, à faire par toi). Le skill permet de chercher des idées, d'interroger les docs des sponsors, de gérer la soumission et de s'évaluer face aux critères : à lancer chaque matin pour remplir cette grille. Les sous-agents de nuit ne modifient jamais la soumission.

## 7. Risques et décisions ouvertes

Le danger principal est que les extensions grignotent le temps de la v1 : les drapeaux d'activation et les règles d'arrêt de la section 4 servent à l'éviter.

| Risque | Parade |
| --- | --- |
| Dérive du périmètre | Règles d'arrêt, drapeaux, priorité fixe E2, E1, E5, E3 |
| Coût x402 après les crédits gratuits (gas plus 0,3 %) | Facilitateur Celo, volume de démo faible, crédits gratuits annoncés par le hackathon (20 règlements par clé vendeur) |
| Trésorerie qui exigerait un droit sur les fonds du commerçant | Version « l'agent propose, le commerçant signe » |
| Clé Textile tardive, exécution non atomique | Essai en lecture seule, exécution seulement si le chemin est clair |
| Nouvelle dépendance pour les passkeys | Ne pas lancer E7 sans temps de marge |
| Chiffres de preuve contestables | Page alimentée uniquement par la chaîne, provenance des payeurs affichée, aucun wallet financé par nous présenté comme indépendant |

**Décisions à prendre**

- [ ] Jeudi soir : go ou no-go pour E3 (trésorerie), selon l'état de la v1.
- [ ] Demander la clé d'API Textile maintenant, même si E4 reste un simple essai.
- [ ] Créer la clé vendeur du facilitateur Celo (signature de wallet, sans gas) pour E1.
- [ ] Langues de la vidéo de démo : espagnol seul, ou espagnol et portugais.

**Question aux organisateurs jeudi 5 novembre, 13 h Paris :** les factures exposées en x402 et payées au wallet du commerçant comptent-elles par l'adresse `payTo`, comme annoncé pour les transactions x402 ?

## 8. Contraintes de la plateforme et réponses de conception

Ces points viennent de la page d'inscription, de Ripio et du groupe Telegram : ils bornent le plan 2 sans changer l'architecture du plan 1.

**Wallet unique de l'agent**

- Le score est rattaché à un seul wallet pour tout l'événement. C'est un mécanisme de comptage du hackathon, pas un modèle de produit (hypothèse : la page ne donne pas leur raisonnement).
- L'architecture n'en dépend pas : les fonds des commerçants vont toujours à leurs adresses, et le relayeur ne fait que soumettre des transactions signées par d'autres. En production : plusieurs relayeurs, voire un relayage ouvert à tous.
- Conséquence pour le score : seules les transactions envoyées par le wallet de l'agent comptent. Une conversion que le commerçant signerait et enverrait lui-même (E3 sous cette forme) ne serait pas créditée. Pour que E3 compte, le commerçant signe une intention et le relayeur l'exécute, ce qui demande une fonction de conversion dans le routeur. Un contrat immuable ne se modifie pas après déploiement : la décision se prend avant le routeur v1.

**Ripio : aucun compte partenaire n'est nécessaire**

- **Liens de rampe :** `ramp.ripio.com` pour l'entrée et `ramp.ripio.com/off-ramp` pour la sortie, avec pays, chaîne 42220, token, montant et adresse en paramètres. Ripio gère le KYC et aucun onboarding B2B n'est requis.
- **Couverture :** les rampes publiques sont annoncées pour l'Argentine et la Colombie. Le message de Ripio dans le groupe citait aussi le Brésil : à tester le premier jour avec `country=BR` pour la sortie en reais.
- **API de rampe :** Client ID et Client Secret fournis par Ripio, avec KYB pour les entreprises. Inutile ici.
- **Bridge :** appel sans permission au contrat `BridgeDeposit` (approbation ERC-20 et route active), statut public, pas de sandbox. Voir E9.

**Outil du hackathon :** le skill Loops House sert à l'auto-évaluation quotidienne (section 6). La soumission reste un geste manuel.

**Décisions supplémentaires**

- [ ] Protéger E3 : prévoir ou non la fonction de conversion dans le routeur v1.
- [ ] Lancer E9 ou non, sachant que sa priorité est faible.
- [ ] Tester le lien de sortie Ripio avec `country=BR` le premier jour.

**Sources**

- [Ramps by Ripio, llms.txt](https://ramp.ripio.com/llms.txt)
- [Ripio, documentation de l'API Ramp](https://docs.ripio.com/ramps-api/overview/introduction)
- [Ripio Bridge, développeurs](https://bridge.ripio.com/bridge/developers)

## 9. Mise à jour après le plan 3 (passe 1, 3 nov. 2026)

Mesures : `docs/research/plan3/fees-report.md` et `coverage-matrix.json`. Une seule passe : à confirmer à une autre heure avant de figer.

| Extension | Avant | Après le plan 3 | Raison mesurée |
| --- | --- | --- | --- |
| E9 Bridge des wFIAT | bonus | **priorité haute** | Contrat `0x465e…5D47` vérifié et non pausé ; routes ouvertes pour les 6 wFIAT vers Base, Polygon, BSC, Ethereum ; frais fixes ≈ 0,01 $ hors Ethereum ; plafonds journaliers larges pour wARS (30 M) |
| E4 Textile RFQ | essai | en attente | Clé d'API non obtenue (T5) |
| E5 Autres pays | priorité moyenne | **gelé** | Aucun pool wMXN, wCOP, wCLP, wPEN ; Mento n'offre que COPm et BRLm, qui ne sont pas des wFIAT |
| E2 Page de preuves | fait | ajouter la couverture | Afficher le tableau de couverture et les frais mesurés |
| Nouveau : règlement en USD₮ au choix du commerçant | — | priorité haute, petit | USDC/USD₮ est la seule autre route profonde ; répond au retour terrain (section 9 du plan 3) |
| Nouveau : routeur compatible Uniswap V4 | — | après le hackathon | Les pools V4 wARS/USDC (≈ 143 k$) et wBRL/USDC (≈ 559 k$) sont plus profonds, mais CobraRouter est immuable et V3 seulement |

Message de démo : l'Argentine en tête (USD₮/USDC → wARS, 0,08 à 0,36 %), le Brésil avec son avertissement de prix (≈ 3,3 %), les autres pays « bientôt ».
