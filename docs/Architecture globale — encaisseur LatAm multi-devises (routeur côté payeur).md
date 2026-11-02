# Architecture globale — encaisseur LatAm multi-devises (routeur côté payeur)

Nov 2, 2026 · @Noé

## 1. Objectif et positionnement

Cobrá permet à un commerçant d'Amérique latine d'encaisser dans sa monnaie locale quand le client paie avec n'importe quel stablecoin qu'il détient, en un seul geste et sans gas.

- **Cible :** PME (kiosques, salons, restaurants) et particuliers qui veulent payer en crypto sur place. Track visé : Stable Agents LatAm (Ripio et Celo).
- **Promesse commerçant :** il fixe son prix en pesos ou en reais et reçoit exactement ce montant en wFIAT, sans gérer de conversion.
- **Promesse payeur :** une page web, une signature, aucun CELO nécessaire. Un agent choisit avec quels actifs payer pour minimiser le coût total.

| Projet existant (d'après leurs présentations) | Ce qu'il couvre | Ce qu'on ajoute |
| --- | --- | --- |
| sme-treasury-agent (Emiliano) | Encaissement PME en Argentine, payeur en pesos via lien Ripio | Plusieurs pays, payeur crypto, paiement atomique, transactions de l'agent taguées |
| Arbolito | Changeur de rue numérique pour particuliers, dans MiniPay et Telegram | Côté commerçant : facture, rapprochement, clôture de caisse |
| Earmark | Collectes de groupe et factures | Encaissement au point de vente |
| Cruce | Routeur FX en SDK, payé en x402 | Conversion intégrée au paiement, pas une brique à câbler |

**Périmètre v1**

- Facture en monnaie locale, paiement avec 1 à 3 actifs, règlement en wFIAT, bot Telegram, page payeur, relayeur, routeur Solidity.
- Argentine et Brésil en conversion complète (pools wARS/USDT et wBRL/USDT). Mexique, Colombie, Chili et Pérou : règlement direct en wFIAT si le payeur en détient, sinon en stablecoin USD.

**Hors périmètre**

- Custody de fonds, KYC propre, off-ramp propre (liens Ripio préremplis), WhatsApp Business API, endpoint x402 par facture, Textile RFQ (extension prévue).

## 2. Vue d'ensemble

Un payeur signe une fois, un relayeur exécute, un routeur paie le commerçant : tout le reste sert à préparer ou à constater ce paiement.

&#91;embedded content: architecture · 7 étapes d'un paiement\]

1. Le commerçant écrit « cobrar 4500 café » : le bot et l'agent créent la facture dans la base.
2. Le payeur scanne le QR et ouvre la page, qui lit la facture et calcule le plan de paiement.
3. Il signe une seule fois, et la page transmet la signature au relayeur.
4. Le relayeur envoie `pay` au routeur, avec le tag ERC-8021 et le gas sponsorisé.
5. Le routeur échange chez Uniswap V3 si besoin et verse le montant exact au wallet du commerçant.
6. L'indexeur lit l'événement `Paid` et met la base à jour.
7. Le bot prévient le commerçant.

## 3. Parcours utilisateur

Le commerçant encaisse en une phrase, le payeur règle en une signature, et personne ne manipule de gas ni de clé.

**Onboarding commerçant (environ 60 secondes, Telegram)**

1. `/start` : la langue (es, pt, en) est détectée.
2. Choix du pays et de la devise de règlement (wARS, wBRL, wMXN, wCOP, wCLP, wPEN).
3. Adresse de réception : coller une adresse ou la prouver en signant un message. Le système ne crée aucun wallet à la place du commerçant.
4. Confirmation et QR de caisse statique (le payeur saisit le montant).

**Créer une facture**

1. Le commerçant écrit « cobrar 4500 café » (note vocale en option).
2. L'agent crée la facture : montant, devise, référence, expiration à 10 minutes.
3. Le bot renvoie un QR et un lien `/pay/<id>`, plus un bouton de partage WhatsApp (lien `wa.me`).
4. Dès que l'événement `Paid` est confirmé sur la chaîne, le bot notifie : montant, référence, reçu.

**Payer (côté client)**

1. Scan du QR : la page s'ouvre dans le navigateur ou dans un wallet mobile.
2. Connexion du wallet (WalletConnect ou wallet intégré).
3. La page affiche le prix en monnaie locale et le plan de l'agent, par exemple « 1,47 USDC, frais 0,02 », avec le détail des actifs utilisés.
4. Une signature, sans gas. La page montre le reçu avec le lien Celoscan.
5. Sans crypto : le bouton « Payer en pesos » ouvre un lien de rampe Ripio prérempli (pays, chaîne 42220, token, montant, adresse du commerçant). Ce flux contourne le routeur.

**Fin de journée et retrait**

- Clôture de caisse à 21 h : total, nombre de ventes, export CSV pour le comptable.
- Retrait vers la banque : lien de rampe Ripio off-ramp prérempli avec le solde disponible.

**Frictions évitées par conception :** aucune application à installer, aucun changement de réseau, aucun CELO à posséder, aucune adresse à copier côté payeur, aucun calcul de conversion côté commerçant.

## 4. Smart contract routeur

Un contrat immuable, sans propriétaire ni custody, tire les tokens du payeur, les convertit et verse exactement le montant facturé au commerçant, ou annule toute la transaction.

**Esquisse d'interface (à finaliser avec les tests)**

```solidity
enum PullKind { EIP3009, PERMIT2, ALLOWANCE }

struct Leg {
  address token;      // actif tiré chez le payeur
  uint256 amountIn;   // montant exact tiré
  PullKind kind;      // mécanisme de tirage
  bytes pullData;     // signature, nonce, deadline selon le mode
  bytes path;         // chemin Uniswap V3, vide si token == tokenOut
}

struct Invoice {
  bytes32 id;
  address merchant;
  address tokenOut;   // wFIAT ou stablecoin de règlement
  uint256 amountOut;  // montant exact versé au commerçant
  uint256 deadline;
}

function pay(Invoice calldata inv, address payer, Leg[] calldata legs) external;
event Paid(bytes32 indexed invoiceId, address indexed payer,
           address indexed merchant, address tokenOut, uint256 amountOut);
```

**Modes de tirage**

| Mode | Tokens | Gas du payeur | Remarque |
| --- | --- | --- | --- |
| EIP-3009 | USDC, USD₮, USA₮ | Aucun | Signature `receiveWithAuthorization`, le routeur est le destinataire, le nonce lie la signature à l'intention de paiement |
| Permit2 | wFIAT et autres ERC-20 | Aucun après la première approbation | `permitWitnessTransferFrom` avec l'intention en témoin. Première approbation de Permit2 sans gas via EIP-2612 pour les wFIAT (à vérifier token par token) |
| Allowance | Tout ERC-20 | Oui, en stablecoin via fee abstraction | Repli si le wallet ne sait pas signer de données typées |

**Logique de `pay`**

1. Vérifier l'échéance et que la facture n'est pas déjà payée (`paid[id]`), puis la marquer.
2. Tirer chaque jambe vers le routeur selon son mode.
3. Si `token == tokenOut`, compter directement. Sinon swap via le routeur Uniswap V3 codé en dur, avec un chemin qui commence par `token` et finit par `tokenOut`.
4. Exiger que la somme obtenue soit au moins `amountOut`, sinon annuler.
5. Verser exactement `amountOut` au commerçant, rendre l'excédent et les entrées inutilisées au payeur.
6. Émettre `Paid`.

**Invariants à tester**

- Le solde du routeur est nul après chaque appel.
- Le commerçant reçoit exactement `amountOut` ou rien.
- Le payeur ne dépense jamais plus que la somme des montants signés.
- Aucune facture ne peut être payée deux fois.
- Pas de propriétaire, pas de mise à jour, pas de frais, pas de pause. Paramètres immuables au constructeur : Permit2 et routeur Uniswap.

**Tests (Foundry, fork de Celo mainnet) :** même token, une jambe avec swap, deux jambes, glissement trop grand, facture expirée, rejeu, token malveillant (réentrance), token avec frais de transfert, tests d'invariants. Un second agent relit le contrat avec une checklist de sécurité avant tout test sur mainnet.

**Adresses à vérifier on-chain avant déploiement :** Permit2, routeur et quoter Uniswap V3 sur Celo, USDC, USD₮, USA₮. Les wFIAT ont 18 décimales, les stablecoins USD 6 : le solveur normalise. D'après la doc du repo d'Emiliano, wARS = `0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d` et wBRL = `0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0`, à recontrôler sur Celoscan.

## 5. Relayeur, signatures et identité de l'agent

Le relayeur est le seul composant qui détient une clé : il soumet les transactions `pay`, paie le gas, et porte l'identité ERC-8004 et le tag ERC-8021 de l'agent.

**Flux d'un paiement**

1. Le payeur signe l'intention (commerçant, montant, devise, échéance, jambes).
2. La page envoie les signatures au backend.
3. Le backend revalide : devis encore valide, plafonds, facture ouverte.
4. Le relayeur envoie `pay`, attend les confirmations, puis l'indexeur met la facture à jour.

**Ce que le relayeur ne peut pas faire :** changer le destinataire, le montant ou la devise. Les signatures les verrouillent. Il peut seulement exécuter l'intention telle quelle ou ne pas l'exécuter.

**Gas sponsorisé :** il est payé par le wallet de l'agent. Les règles précisent que le gas sponsorisé ne compte pas comme contribution et que les flux gasless ne sont pas pénalisés. On le décrit dans la soumission.

**Identité et attribution**

- **ERC-8004 :** le wallet du relayeur est enregistré comme identité de l'agent sur Celo mainnet, avant la date limite (de préférence dès le premier jour), avec un fichier d'enregistrement servi en HTTPS.
- **ERC-8021 :** le client wallet utilise `withAttribution(code)` de `@celo/attribution-tags`, avec le code obtenu à la création de la soumission. Le tag n'est pas rétroactif : il est en place avant la première transaction.
- Dans le mode Allowance, la page ajoute le suffixe aux transactions envoyées par le payeur, mais seules les transactions du wallet de l'agent sont créditées : ce mode reste un repli.

**Clés et garde-fous**

- Clé privée uniquement sur le VPS, jamais sur Vercel ni dans le repo. Wallet dédié avec un solde minimal de gas, sans fonds de commerçant.
- Liste blanche d'un seul contrat cible (le routeur), plafond par paiement et par jour, alerte Telegram si le solde est bas.
- Kill switch : un drapeau en base arrête tout envoi de transaction sans redéploiement.
- Idempotence : un seul `pay` par facture, gestion du nonce et reprises avec le même nonce.

## 6. Moteur de routage (solveur)

Le solveur est un module TypeScript déterministe : pour une facture et un portefeuille donnés, il renvoie le plan de paiement au coût total minimal, avec un minimum garanti côté commerçant.

**Entrées**

- Soldes du payeur sur les tokens supportés, normalisés par leurs décimales.
- Facture : `tokenOut`, `amountOut`, échéance.
- Cotations Uniswap V3 sur Celo (QuoterV2, `quoteExactOutput`), directes et en deux sauts via USDT.
- Préférences du payeur : actifs à ne pas toucher, glissement maximal.
- Taux de change de référence externe (ARS/USD, BRL/USD) pour contrôler le prix.

**Algorithme**

1. Candidats : une jambe unique par actif détenu. Si l'actif est déjà `tokenOut`, le coût de conversion est nul.
2. Pour chaque candidat au solde suffisant : montant requis = cotation exacte + marge de glissement.
3. Coût du plan = (valeur USD entrée − valeur USD sortie) / valeur sortie, soit spread, frais de pool et impact de prix.
4. Si aucune jambe seule ne suffit, ou si un partage coûte moins : combinaison de 2 à 3 jambes, en remplissant d'abord par l'actif au coût marginal le plus bas, borné par la profondeur du pool.
5. Plan retenu = coût minimal après pénalité de préférence. Maximum 3 jambes : chaque jambe ajoute une signature pour le payeur.
6. Sortie : jambes, `minOut`, expiration du devis (60 secondes), coût en pourcentage, économie face à la route naïve.

**Route naïve de référence :** payer avec l'actif au plus gros solde par le chemin direct. L'économie (coût naïf moins coût du plan) est affichée au payeur et enregistrée par transaction : c'est la preuve mesurable de l'optimisation.

**Garde-fous de prix**

- Refus si le prix implicite s'écarte du taux externe de plus de 2 % (seuil réglable) : les pools sont petits et manipulables.
- Plafond par paiement en v1 (par exemple l'équivalent de 200 USD), ajusté à la profondeur observée.
- Sans route valable, le solveur propose le paiement direct en wFIAT ou le lien Ripio plutôt que d'échouer en silence.

**Tests :** développement piloté par les tests avec un simulateur de pools, test de propriété (le plan ne coûte jamais plus que la meilleure jambe seule), puis rejeu de cotations réelles pour mesurer l'économie.

**Extension hors v1 :** décider quand convertir la trésorerie d'un commerçant selon un régime de volatilité (piste inspirée de la détection de régime par HMM).

## 7. Agent IA du produit

Le modèle comprend et explique, le code calcule et exécute : aucun montant ni aucune route ne passe par le jugement du modèle.

**Une identité, trois rôles.** L'agent enregistré en ERC-8004 regroupe l'assistant conversationnel Telegram, le planificateur (solveur) et l'exécuteur (relayeur). Tout ce qu'il signe on-chain porte le même tag.

**Rôle du modèle (Claude via le SDK IA de Vercel, appel d'outils)**

- Comprendre une demande libre du commerçant (texte, note vocale transcrite) et la transformer en appel d'outil.
- Expliquer un résultat : qui a payé, pourquoi un plan a été choisi, comment retirer.
- Résumer la journée et répondre « ¿quién me debe? ».
- Répondre dans la langue du commerçant (es, pt, en).

**Outils (arguments validés par un schéma, montants lus par un parseur déterministe)**

| Outil | Effet | Touche aux fonds ? |
| --- | --- | --- |
| `create_invoice` | Crée une facture et son lien | Non |
| `list_invoices` | Liste par statut ou client | Non |
| `invoice_status` | État d'une facture, lien Celoscan | Non |
| `cancel_invoice` | Annule une facture ouverte | Non |
| `daily_summary` | Total, nombre, export CSV | Non |
| `withdraw_link` | Lien de rampe Ripio off-ramp prérempli | Non |
| `set_preferences` | Devise de règlement, langue, adresse (avec signature) | Non |

Aucun outil ne déplace de fonds : les seuls mouvements sont les paiements signés par les payeurs et exécutés par le routeur.

**Parseur de montants :** lit `4.500,50`, `4500.5`, `$4 500` selon la locale et renvoie une chaîne décimale. Le modèle ne fait jamais d'arithmétique.

**Autonomie visible pour les juges**

- Le planificateur choisit seul la route et les actifs, l'exécuteur soumet la transaction, l'indexeur confirme et le bot notifie, sans intervention humaine après la signature du payeur.
- Rappels de factures impayées avec un lien de partage, expiration automatique, clôture de caisse quotidienne.

**Limites :** répond seulement sur les factures et paiements du commerçant, ne donne aucun conseil financier, ne demande jamais de clé privée ni de phrase secrète.

## 8. Stack technique et hébergement

TypeScript partout sauf le contrat, avec une séparation nette : le web public n'a aucune clé, seul le worker sur ton VPS signe.

| Couche | Choix | Rôle |
| --- | --- | --- |
| Contrat | Solidity et Foundry | Routeur, tests sur fork de Celo mainnet |
| Web payeur et tableau de bord | Next.js (App Router) sur Vercel | Page `/pay/<id>`, tableau de bord commerçant, API |
| Wallets | wagmi, viem, WalletConnect | Connexion, signatures EIP-712 |
| Bot | grammY (Telegram) | Onboarding et facturation, webhook sur Vercel |
| Agent | SDK IA de Vercel avec Claude (Sonnet ou Haiku) | Compréhension, explications, outils validés par schéma |
| Voix (option) | Transcription par API (par exemple Whisper sur Groq) | Notes vocales du commerçant |
| Données | Postgres (Neon ou Supabase) avec Drizzle | Commerçants, factures, paiements |
| Worker | Node 24 sur le VPS (systemd) | Relayeur, indexeur, rappels, clôture |
| RPC | Forno public, ou Chainstack (trois mois de plan Growth offerts aux équipes avec le code CELOBUILDERS, optionnel) | Lecture et envoi de transactions |
| Cotations | QuoterV2 d'Uniswap V3, API de taux de change | Solveur et garde-fous de prix |
| Attribution et identité | `@celo/attribution-tags`, registre ERC-8004 | Tag sur chaque transaction, identité de l'agent |

**Pourquoi pas Rust :** aucun gain mesurable ici (le goulot est le réseau, pas le CPU) et le temps est court.

**Variables d'environnement principales :** `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `RPC_URL`, `ROUTER_ADDRESS`, `ATTRIBUTION_CODE`, `WALLETCONNECT_PROJECT_ID`, `FX_API_KEY`, `KILL_SWITCH`. La clé `RELAYER_PRIVATE_KEY` n'existe que sur le VPS.

**Hébergement :** Vercel pour le web et les webhooks, VPS pour le worker qui doit tourner 24 h sur 24, base Postgres gérée.

## 9. Données, états et rapprochement

La chaîne est la source de vérité : la base ne garde que ce qu'il faut pour afficher, notifier et exporter, et l'événement `Paid` règle le rapprochement sans astuce sur les montants.

**Tables**

| Table | Contenu |
| --- | --- |
| `merchants` | id, identifiant Telegram, pays, token de règlement, adresse de réception, langue |
| `invoices` | id (bytes32), commerçant, prix local, devise, `tokenOut`, `amountOut`, référence, description, statut, expiration |
| `payments` | id de facture, hash de transaction, payeur, jambes (JSON), coût en %, économie en %, bloc, date |
| `quotes` | devis temporaires par facture et payeur, avec expiration |
| `chain_cursor` | dernier bloc indexé |
| `flags` | kill switch et plafonds |

**Cycle de vie d'une facture**

| État | Entrée | Sortie |
| --- | --- | --- |
| `open` | Création par le commerçant | `submitted`, `expired`, `cancelled` |
| `submitted` | Le relayeur a envoyé `pay` | `paid`, ou retour à `open` si la transaction échoue |
| `paid` | `Paid` confirmé sur la chaîne | Final |
| `expired` | Échéance dépassée sans paiement | Final |
| `cancelled` | Annulation par le commerçant | Final |

**Indexation :** un indexeur lit les journaux `Paid` du routeur par plages de blocs, avec un nombre de confirmations réglable, et met la base à jour par écritures idempotentes sur l'identifiant de facture. Un redémarrage reprend au dernier bloc enregistré.

**Rapprochement :** une facture a un identifiant unique lié au paiement dans l'événement. Il n'y a ni centimes artificiels ni appariement par montant. Les factures du QR statique sont créées au moment du scan.

**Données personnelles :** pas de nom ni de téléphone côté payeur, seulement son adresse publique. Le commerçant est identifié par son identifiant Telegram.

## 10. Sécurité et garde-fous

Le risque principal est un bug du routeur ou une clé de relayeur volée : l'architecture limite les deux par construction (aucune custody, un seul contrat autorisé, plafonds, kill switch).

| Menace | Parade |
| --- | --- |
| Bug dans le routeur | Pas de custody, tests sur fork et d'invariants, relecture par un second agent, petits montants et plafond par paiement |
| Manipulation de prix sur un pool peu profond | `minOut` imposé par le contrat, écart maximal de 2 % face au taux externe, plafond par paiement |
| Vol de la clé du relayeur | Clé seulement sur le VPS, solde de gas minimal, liste blanche d'un contrat, kill switch, rotation possible |
| Relayeur malveillant | Il ne peut pas changer destinataire, montant ou devise : les signatures les verrouillent |
| Faux lien de paiement (hameçonnage) | Domaine unique, page affichant commerçant, montant et adresse de réception avant la signature |
| Double paiement ou rejeu | `paid[id]` dans le contrat, expiration des devis |
| Spam de factures | Limites par commerçant et par minute |
| Injection de prompt par un message | Aucun outil ne touche aux fonds, arguments validés par schéma, aucun secret dans le prompt |

**Règles pour les sous-agents de nuit**

1. Aucun accès aux clés privées ni aux fichiers d'environnement de production.
2. Mainnet en lecture seule. Toute transaction mainnet passe par le module `signer` (plafonds, liste blanche) et est déclenchée par toi.
3. Une branche (worktree) par sous-agent, coordonnée par ton hackathon-agent-board. Aucune fusion sans tests verts.
4. Les types et interfaces partagés sont figés avant la première nuit pour éviter les collisions.
5. Chaque agent écrit un rapport de nuit : fait, à relire, bloqué.
6. Un agent relecteur distinct examine le contrat et tout le code qui manipule de l'argent.
7. Dépendances nouvelles seulement justifiées, versions épinglées, détection de secrets avant chaque commit.

## 11. Conformité aux règles du hackathon

Un projet sans identité ERC-8004 est invalide, et une transaction sans tag ERC-8021 ne peut pas être rattrapée : ces deux points passent avant tout le reste. Date limite : lundi 9 novembre, 09:00 GMT (10:00 à Paris).

**Avant la première transaction**

- [ ] Créer la soumission sur Loops House pour obtenir le code `celo_…` (modifiable ensuite).
- [ ] Créer le wallet dédié de l'agent et l'enregistrer en ERC-8004 sur Celo mainnet, puis vérifier l'agent sur 8004scan.
- [ ] Brancher `@celo/attribution-tags` sur le client du relayeur et sur la page payeur.
- [ ] Renseigner l'adresse du wallet de l'agent dans la soumission.

**Contraintes confirmées par la page d'inscription**

- **Code d'attribution :** `celo_502e1bea2794`, à placer dans `ATTRIBUTION_CODE` et dans la construction du client wallet, avant toute transaction. Cela inclut le déploiement du routeur et les approbations : sans tag, une transaction n'est jamais créditée, sans rattrapage possible.
- **Un seul wallet d'agent pour tout l'événement :** le score lui est rattaché. On saisit son adresse à la soumission ou depuis le bouton Celo du playground. Le routeur est déployé depuis ce wallet.
- **Conséquence de conception :** les paiements doivent partir du wallet de l'agent, c'est le chemin relayeur. Le mode Allowance, où le payeur envoie la transaction, n'est pas crédité à l'agent et reste un repli.
- **Gas :** en CELO ou en stablecoin (fee abstraction), ce qui permet de ne tenir qu'un solde de stablecoin sur le wallet de l'agent.
- **Mainnet uniquement :** chaîne 42220, l'activité testnet ne compte pas. Les tests de développement se font sur un fork local de mainnet, les preuves par de petites transactions réelles.
- **RPC :** Forno public est gratuit et suffit pour commencer. Si le trafic de l'agent dépasse sa limite, Chainstack offre trois mois de plan Growth avec le code CELOBUILDERS (il ne liste que Celo mainnet : le testnet reste sur le Forno Sepolia).

**Exigences du projet**

- [ ] Celo mainnet uniquement (des références testnet dans le repo sont tolérées).
- [ ] Usage réel de wFIAT (wARS ou wBRL) en règlement.
- [ ] Repo GitHub public dès l'inscription, accessible au jugement, code écrit pendant le hackathon : nouveau dépôt, pas de fichiers copiés d'un autre projet.
- [ ] Interface utilisable par une personne réelle (page web et bot).

**À déclarer dans la soumission**

- Le gas sponsorisé par le relayeur (il ne compte pas comme contribution, les flux gasless ne sont pas pénalisés).
- L'origine des utilisateurs et du volume. Un utilisateur indépendant est un wallet que tu n'as ni créé ni financé en premier et qui avait une activité Celo avant le hackathon. Des outils d'audit repèrent déjà les payeurs financés par le vendeur.
- Les démos faites avec tes propres wallets et les petits montants réels, précisés dans le README (un admin du groupe confirme que c'est accepté).

**Livrables de soumission :** README (architecture, adresses, transactions de preuve, limites connues), vidéo courte, lien du dépôt. Viser une soumission dimanche 8 novembre au soir.

**Gestion de la soumission :** le skill Loops House (`npx loopshouse add agents-on-open-rails`) permet aussi de créer et modifier la soumission depuis le repo. Cette action reste manuelle : aucun sous-agent de nuit n'y a accès.

## 12. Plan de construction, du 2 au 9 novembre

Huit chantiers (WS0 à WS7), menés en parallèle, des interfaces figées dès ce soir, et six nuits de construction avant une soumission dimanche 8 novembre au soir.

| Chantier | Mission | Livrable testé | Dépend de |
| --- | --- | --- | --- |
| WS0 Fondations (toi, avec moi) | Soumission, wallet de l'agent, ERC-8004, tag ERC-8021, dépôt public, monorepo, types partagés, CI | Première transaction taguée sur mainnet, interfaces gelées | Rien |
| WS1 Contrat routeur | Solidity, Foundry, fork de Celo, invariants | Contrat déployé avec plafonds, tests verts | WS0 |
| WS2 Solveur | Module pur, simulateur de pools, test de propriété | Plan optimal et économie chiffrée sur cotations réelles | Types de WS0 |
| WS3 Relayeur | Constructeurs de signatures, envoi de `pay`, kill switch, plafonds | Paiement bout en bout sur mainnet avec un petit montant | WS1, WS2 |
| WS4 Bot et agent | grammY, outils, parseur de montants, langues, notes vocales en option | Facture créée par message, notification de paiement | Types de WS0, WS6 |
| WS5 Page payeur et tableau de bord | Connexion, devis, signature, reçu, vue commerçant | Parcours complet sur téléphone | WS2, WS3 |
| WS6 Données et indexeur | Schéma, indexeur `Paid`, états de facture | Statuts à jour après chaque paiement | ABI de WS1 |
| WS7 Relecture et livrables | Agent relecteur, checklist de sécurité, README, vidéo | Rapport de relecture, dépôt prêt à soumettre | Tous |

&#91;embedded content: calendrier · 7 chantiers, 5 jalons\]

Les pilotes commencent mercredi, en parallèle de la construction : les utilisateurs indépendants sont ce qui prend le plus de temps à obtenir.

**Protocole de chaque nuit**

1. Le soir : pour chaque sous-agent, une tâche et un critère d'acceptation (les tests à faire passer).
2. Lancement sur des branches séparées via le board d'agents, sans accès aux clés.
3. Le matin : lecture des rapports, exécution des tests, relecture, fusion.
4. Ce qui touche à l'argent passe toujours par l'agent relecteur avant toute transaction mainnet.

**Tâches qui ne se délèguent pas :** inscription, création et financement des wallets, décisions de plafonds, contact des commerçants pilotes, questions aux organisateurs, vérification finale de la soumission.

## 13. Risques, points à vérifier et décisions ouvertes

Le risque le plus dur n'est pas technique : ce sont les vrais utilisateurs indépendants, à recruter dès mercredi, en parallèle de la construction.

| Risque | Impact | Parade ou repli |
| --- | --- | --- |
| Pas assez d'utilisateurs indépendants | Élevé | Pilotes avec des commerçants argentins et brésiliens, tests croisés avec d'autres builders, démo vidéo en espagnol et portugais |
| Wallets mobiles sans signature de données typées (MiniPay à vérifier) | Moyen | Mode Allowance en repli, page web dans un navigateur de wallet, lien depuis Telegram |
| Liquidité faible des pools wARS et wBRL | Moyen | Plafond par paiement, paiement direct en wFIAT, Textile RFQ en extension |
| Bug du contrat | Élevé | Section 10 : pas de custody, tests de fork et d'invariants, relecture, petits montants |
| Support variable d'EIP-3009 ou d'EIP-2612 selon les tokens | Moyen | Test token par token dès le premier jour, repli sur Permit2 ou Allowance |
| Temps limité (solo, cours, candidatures) | Moyen | Argentine et Brésil d'abord, une jambe avant le partage multi-actifs, extensions en dernière priorité |
| Emiliano reprend sa phase 2 (paiements fournisseurs Brésil) | Faible à moyen | Notre angle diffère (payeur crypto, routeur) ; lui proposer une association ou un test croisé |
| Les règles de tag ou de comptage changent | Moyen | Suivre le groupe Telegram, adresse du wallet de l'agent renseignée partout |

**À vérifier (premier jour)**

- [ ] Adresses on-chain de Permit2, du routeur et du quoter Uniswap V3, et des tokens USDC, USD₮, USA₮, wARS, wBRL.
- [ ] `receiveWithAuthorization` (EIP-3009) sur USDC, USD₮ et USA₮, et permit EIP-2612 sur les wFIAT.
- [ ] Profondeur réelle des pools wARS/USDT et wBRL/USDT à 50, 500 et 5 000 USD.
- [ ] Les wFIAT comme monnaie de gas (non confirmé).
- [ ] Source de taux ARS/USD et BRL/USD fiable et gratuite.
- [ ] Signature de données typées dans les wallets mobiles les plus courants.

**Questions pour les office hours de jeudi 5 novembre, 13 h à Paris**

1. Un projet d'encaissement commerçant avec routeur on-chain est-il bien dans le track LatAm ?
2. Quelle est la règle exacte des utilisateurs indépendants, et un test croisé entre builders compte-t-il ?
3. Comment la requête de scoring compte-t-elle les paiements exécutés par un relayeur via un contrat (tag sur la transaction du relayeur, adresse du payeur) ?
4. Le gas sponsorisé par le relayeur est-il accepté comme décrit ?

**Décisions à prendre**

- [ ] Nom du projet : Cobrá, retenu le 2 novembre. Reste à vérifier le domaine, le bot Telegram, GitHub, npm et les marques (classe 36).
- [ ] Pays de lancement : Argentine et Brésil confirmés ?
- [ ] Adresse collée par le commerçant en v1 (recommandé) ou wallet à passkey.
- [ ] Note vocale en v1 ou en extension.
- [ ] Plafond par paiement en v1.
- [ ] Contacter Emiliano pour une association ou un test croisé.
