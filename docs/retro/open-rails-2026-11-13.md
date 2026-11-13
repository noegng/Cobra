# Rétrospective Agents on Open Rails : les gagnants vs Cobrá

Date : 13 nov. 2026, jour de l'annonce des résultats. Cobrá a concouru dans la track **Stable Agents: LatAm (Ripio)** et
n'est pas classé. Ce document analyse les projets primés et en tire des leçons pour la suite de Cobrá et les prochains
hackathons.

Sources : pages projet Loops House et README GitHub des gagnants, lus le 13 nov. (liens en fin de document). Les chiffres
viennent de ces pages : ce sont les déclarations des équipes, que nous n'avons pas revérifiées on-chain.

## Contexte

- Environ 305 inscrits, 105 projets soumis, 5 000 $ de prix répartis sur 4 tracks.
- Grille LatAm (Ripio) : cinq critères à 20 % chacun :
  - mainnet avec un vrai token wFIAT ;
  - usage réel de wFIAT et de la stack Celo ;
  - **autonomie et utilité de l'agent** ;
  - **UX pour un non-crypto** ;
  - **impact LatAm, avec de vrais utilisateurs ou un chemin crédible vers eux**.
- Grille Textile FX : P&L de la stratégie (40 %), volume coté et rempli (30 %), originalité (30 %).

## Les gagnants

### Track LatAm (Ripio)

#### 1er : TesorerIA (1 500 $), « la trésorerie du groupe, sans trésorier »

Solo, Emanuel Ruiz.

- **Utilisateur :** un groupe d'amis argentins qui partage une dépense récurrente en pesos (foot, asado, appartement, voyage).
- **Le parcours :**
  - On rejoint le groupe par un lien d'invitation et une passkey (Safe + ERC-4337, gas sponsorisé par Pimlico) : pas de
    seed phrase, pas de gas.
  - Chacun paie sa cotisation hebdomadaire en wARS (via la rampe d'entrée Ripio) ou en USDT.
  - L'agent convertit l'USDT en wARS sur Uniswap V3, après un contrôle Chainlink USD/ARS à 2 % près.
  - Il rembourse la dépense convenue jusqu'à un **plafond hebdomadaire**. Au-delà, il crée une proposition que le groupe vote.
  - Un membre peut retirer vers sa banque via Ripio.
- **Conception de l'agent :**
  - L'agent qui signe est du **code déterministe, sans LLM**.
  - Le contrat ne l'autorise à payer que les membres, sous le plafond, et il ne peut pas modifier les règles.
  - Un chat LLM existe à côté, mais il ne signe jamais.
  - Il publie un résumé hebdomadaire dont les chiffres correspondent à la chaîne au centime près.
- **Usage réel :**
  - Un vrai groupe de 8 amis, dont fait partie un membre de l'équipe. C'est déclaré, et ses wallets sont exclus des chiffres.
  - 2 fonds actifs, 55 cotisations, ARS 490 k collectés et reversés.
  - Un retrait réel vers une banque via Ripio.
- **Suite annoncée :** coût d'environ 0,10 $ par semaine et par groupe, modèle de frais de 0,25 % sur la prochaine factory,
  objectif de 5 groupes au 31 déc. et 20 au 31 mars.

#### 2e : Adelanto (500 $), « des pesos en trois taps, sans vendre tes dollars »

Solo, Jenny.

- **Utilisateur :** l'épargnant argentin en dollars qui a besoin de pesos (loyer, stock) et ne veut pas vendre.
- **Le parcours :**
  - Dans MiniPay, on bloque de l'USDT et on reçoit des wARS dans la minute.
  - Taux de 22 % à 36 % par an, contre 64,63 % en banque (BCRA). C'est le chiffre d'accroche du pitch.
- **Conception de l'agent :**
  - L'utilisateur écrit ses règles en espagnol (« ne vends jamais mes dollars »). Le contrat `LoanGuard` stocke les plafonds
    avec le hash de la phrase.
  - Ensuite, l'agent rembourse avec les pesos qui arrivent, recharge la garantie à 70 %, met le pool en pause si le prix
    dévie de Binance ou de dolarapi, et envoie des alertes Telegram.
- **Stack Celo, utilisée en profondeur :** ERC-8004, x402 (vente de cotations), buy (RPC payé en USD₮), un serveur MCP,
  5 contrats vérifiés et 528 tests.
- **Usage réel :**
  - 7 prêts, dont **2 par des personnes extérieures à l'équipe**, et une note 5/5 sur ERC-8004.
  - 5 remboursements faits seuls par l'agent.
  - 63 transactions sur 63 portent le tag d'attribution.

### Track Textile FX

#### 1er : Arbolito (750 $), le « changeur de rue » IA

Solo, Olamiye Emmanuel.

- **Le produit :** conversion USD ↔ wARS/wBRL/wCOP en texte ou en vocal (ES/PT/EN), via Telegram et MiniPay.
- **Le routage :** il compare Uniswap et les cotations RFQ Textile. Chaque opération produit un **reçu hashé on-chain**,
  vérifiable par n'importe qui, avec les taux de référence (officiel, MEP, CCL, blue, Western Union).
- **Arbolito Desk :** un filler Textile sur six corridors, avec un LLM « risk officer » qui ne peut que mettre en pause.
  Chiffres : 89 fills depuis 19 wallets, 160 RFQ gagnées.
- **Agent parmi les agents :**
  - il vend ses cotations en x402 ;
  - il loue un navigateur via buy pour lire les taux Western Union ;
  - il a payé d'autres agents 16 fois.
- **Pari stratégique :** inscrit sur **trois tracks** (LatAm, Textile, buy). C'est la brique « desk » qui a gagné Textile.
- **Statut honnête :** sa page admet que les premières opérations étaient celles de l'équipe. Elle annonce 44 conversions
  depuis 10 wallets et une campagne de testeurs en cours.

#### 2e : Skew (250 $), market maker autonome

Solo, Eugene Nnamdi.

- **Le produit :** un market maker qui cote les quatre corridors.
  - Il ajuste le prix selon la toxicité post-fill et la volatilité.
  - Il arbitre contre Uniswap toutes les 3,5 s.
  - Un LLM (Gemini Flash) supervise le risque.
- **Chiffres :** sur cette grille, les chiffres sont le score. 195 $ devenus 277 $ (+34 %), plus de 3 400 transactions
  taguées, plus de 355 000 $ de volume, plus de 153 ordres RFQ externes remplis.
- **Démo :** un dashboard public en direct.

## Comparaison critère par critère (grille LatAm)

| Critère (20 % chacun) | Gagnants | Cobrá au 9 nov. |
| --- | --- | --- |
| Mainnet + vrai wFIAT | Oui | Oui : routeur immuable, merchant payé au montant exact en wARS/wBRL |
| wFIAT + stack Celo | ERC-8004, x402, buy, passkeys/AA, MiniPay, retrait Ripio | ERC-8004, ERC-8021, relayer gasless, Textile RFQ. **Pas de x402, pas de buy, pas de MiniPay** |
| Autonomie de l'agent | L'agent **décide et agit seul** (rembourse, recharge la garantie, convertit, met en pause), avec des garde-fous **dans le contrat** | Le bot crée les factures et le relayer exécute, mais **aucune décision autonome visible** |
| UX non-crypto | Passkey sans seed phrase, ou MiniPay en trois taps | Côté marchand, Telegram est simple. Côté payeur, il faut déjà un wallet crypto (assumé dans « Who it's for ») |
| Impact + vrais utilisateurs | Un cercle réel et nommé (8 amis, 2 emprunteurs externes), chiffres on-chain | **0 marchand, 0 paiement réel**, 4 tests d'équipe. Persona « crypto-native » pertinent mais non prouvé |

Cobrá est solide techniquement (contrat immuable, montant exact, preuve on-chain reproductible avec
`pnpm verify:payments`). Il a perdu sur les **trois critères orientés usage** : autonomie, UX, impact.

## Ce que les gagnants ont en commun

1. **De vrais utilisateurs hors de l'équipe, même très peu.**
   - TesorerIA a gagné avec un seul groupe d'amis, dont fait partie un membre de l'équipe, et le dit ouvertement.
   - Adelanto a 2 emprunteurs externes.
   - Un petit cercle réel bat une architecture complète sans utilisateurs.
2. **Une boucle d'usage récurrente.** Cotisation hebdomadaire, remboursement de prêt, conversions répétées : l'activité
   on-chain s'accumule seule pendant la fenêtre du hackathon. Un paiement marchand ponctuel ne génère rien sans marchand actif.
3. **Un agent qui agit, encadré par le contrat.** Plafonds, listes blanches, pause, règles hashées : l'autonomie devient
   crédible et sûre. Le LLM reste à l'écart de la signature, comme chez nous (règle 5 de `CLAUDE.md`).
4. **Un persona très concret, avec un chiffre de douleur** : « 64,63 % en banque », « le terrain coûte 80 000, le plafond est
   à 60 000 », « +4,4 % vs Western Union ».
5. **Une stack Celo utilisée en largeur** : x402 et buy rapportent des points même en fonction secondaire (Arbolito,
   Adelanto).
6. **Un statut honnête, chiffré et vérifiable**, avec les wallets de l'équipe exclus. Nous l'avions fait aussi, mais avec peu
   à montrer.
7. **Des solos qui livrent beaucoup** (280 à 300 commits). La taille de l'équipe n'a pas joué.
8. **Inscription sur plusieurs tracks** quand une brique s'y prête : Arbolito a gagné Textile avec son desk.

## Leçons pour Cobrá

**Si Cobrá continue :**

- **Premier objectif : un vrai marchand, avant toute nouvelle fonctionnalité.** Un café, un stand en meetup ou un événement
  crypto, avec 10 à 20 vrais paiements. Le pilote Brésil (`docs/pilot/`) va dans ce sens.
- **Rendre l'agent visiblement autonome**, avec un garde-fou on-chain. Pistes :
  - balayage automatique d'une part des recettes wARS vers une épargne en USD (règle définie par le marchand, plafonnée) ;
  - relance automatique des factures impayées ;
  - clôture de caisse quotidienne publiée et vérifiable.
- **Réduire la friction payeur :** MiniPay comme wallet payeur par défaut, et un lien « payer avec MiniPay ».
- **Ajouter x402** à faible coût : vendre la cotation « combien coûte ce QR dans ton token » à d'autres agents.

**Pour les prochains hackathons (NEAR, etc.) :**

- Dès le premier jour, trouver un vrai cercle d'utilisateurs (amis, communauté) et une boucle d'usage récurrente.
- Lire la grille avant de coder : ici, 60 % du score portait sur l'usage, pas sur l'ingénierie.
- Commencer la page de soumission par la douleur chiffrée, le persona nommé et le statut on-chain.

## Liens

- TesorerIA : https://www.loops.house/explore-projects/tesoreria-5a873 · https://github.com/ruizemanuel/TesorerIA
- Adelanto : https://www.loops.house/explore-projects/adelanto-0a81b · https://github.com/Jennycruzy/adelanto
- Arbolito : https://www.loops.house/explore-projects/arbolito-90ed1 · https://github.com/Manuel-dev01/arbolito
- Skew : https://www.loops.house/explore-projects/skew-f0a80 · https://github.com/eugenennamdi/Skew
- Cobrá : https://www.loops.house/explore-projects/cobr-e7e85
