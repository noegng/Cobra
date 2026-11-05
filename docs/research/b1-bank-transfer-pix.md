# B1 — Paiement par virement / Pix vers le commerçant (analyse, 4 nov. 2026)

Analyse seule, aucun code. Sources : `apps/web/lib/ramp.ts`, `packages/indexer/src/reconcile.ts`, docs Ripio
(<https://docs.ripio.com/ramps-api/widget/parameters>, <https://docs.ripio.com/ramps-api/overview/countries/overview.md>,
<https://docs.ripio.com/ramps-api/widget/flows/on-ramp.md>). Tout ce qui n'est pas dans ces pages est marqué **[non vérifié]**.

## 1. Constat clé sur Ripio
- Notre lien actuel (`ramp.ripio.com/?country&chain&token&amount&address`) vient de notes manuelles ; la doc officielle
  décrit un **widget partenaire** (`_addr`, `_net`, `_amount` fiat, `_crypto`, `_la`, `_tracking_session`) qui exige un
  **jeton de session `_to`** (compte partenaire OAuth2). Équivalence des deux non prouvée **[non vérifié]**.
- Widget partenaire : `_addr` est **figé** (lecture seule), SAUF si l'utilisateur a déjà une adresse enregistrée chez Ripio :
  celle-ci l'emporte et `_addr` est ignoré. `_crypto` figé ; `_net` : figé ou non, non précisé. `_amount` = simple
  préremplissage fiat, sans garantie de montant net/brut. Le token doit être activé sur notre compte.
- Pays/rails : AR (virement CVU ou Mercado Pago), BR (**Pix**, un BR Code par ordre avec `expiresAt`), MX (SPEI/CLABE),
  CO (PSE, BRE-B, Nequi). Pas CL/PE. Pix impossible via « On-Ramp Session » (ordre par ordre uniquement).
- KYC : obligatoire pour chaque client (statut COMPLETED, CGU) avant tout ordre : le payeur sans compte Ripio fait un KYC
  complet. Frais : affichés à la confirmation, non documentés. Limites : endpoint `get-transaction-limits`, valeurs non
  lues **[non vérifié]**. Délai de règlement : non documenté **[non vérifié]**. Le BR Code Pix expire (durée non précisée).
- Webhooks partenaire : `ON-RAMP.DEPOSIT.RECEIVED`, puis trade, retrait en cours, retrait terminé ; `metadata.session` porte
  notre `_tracking_session`, et la redirection renvoie `session_id`. **C'est la référence de facture qui manquait.**

## 2. Avantages (confirmés)
Critères 4 et 5 : payeur sans wallet, sans gas, sans signature. Le commerçant reçoit directement des wFIAT.

## 3. Ce que le paiement perd
- Le routeur garantit montant exact, une transaction, lien à la facture (`Paid` avec `invoiceId`). Ici : un simple
  `Transfer` ERC-20, lié à la facture seulement par notre rapprochement.
- Pas de transaction d'agent : pas de tag ERC-8021, pas de crédit agent pour le hackathon.
- Pas de revert possible : un mauvais montant est déjà chez le commerçant.
- Si les frais Ripio sont déduits du montant livré (**[non vérifié]**), le commerçant reçoit moins que la facture.

## 4. Indexeur
Il ne suit que `Paid` du routeur (`reconcile.ts`). Il faudrait un second flux `Transfer(to ∈ commerçants)` pour 4 wFIAT
(ARS/BRL/MXN/COP). `eth_getLogs` filtré par topic `to` (OR sur adresses) : un appel par token et par plage, charge faible
tant que la liste de commerçants est courte. Faux positifs réels (dépôt sans rapport) : ils ne ferment jamais une facture
sans correspondance stricte (section 6). Le `from` des livraisons Ripio est peut-être identifiable **[non vérifié, à
observer sur un achat test]**.

## 5. Comparaison avec l'alternative (destination = payeur, puis paiement Cobrá enchaîné)
| | A. Destination = commerçant | B. Destination = payeur + chaînage |
|---|---|---|
| Wallet payeur | non | **oui** |
| Montant exact, 1 tx, `Paid` | non | oui |
| Tag ERC-8021 / crédit agent | non | oui |
| Rapprochement | heuristique (+ webhook si partenaire) | existant |
| Critère jury 5 (sans wallet) | **fort** | faible |
| Risque fonds | moyen | faible |
| Effort | ~29 h | ~6 h |

## 6. Recommandation
**Go uniquement pour B maintenant** (le lien Ripio existe déjà ; reste l'enchaînement automatique) ; **A : no-go pour le
hackathon** (échéance lun. 9 nov.), à reprendre après, **à condition d'obtenir un compte partenaire Ripio** (jeton `_to`,
`_tracking_session`, webhooks). Sans référence de facture, A repose sur le seul montant : trop fragile pour de l'argent réel.

### Design de rapprochement (si A est construit)
1. Au choix « virement/Pix », créer une `ramp_intent` : `invoiceId`, wFIAT, montant attendu, `trackingId` (UUID passé en
   `_tracking_session`), expiration.
2. **Lien primaire** : webhook avec `metadata.session` = `trackingId`, puis confirmation on-chain :
   `Transfer(to=commerçant, value ≥ attendu)` dans un bloc postérieur à la création. Le webhook seul ne suffit jamais
   (authentification des webhooks **[non vérifié]**).
3. **Repli sans webhook** : correspondance par montant. Anti-collision : « montant-signature » de quelques centimes
   (100,00 devient 100,03, jamais en dessous), unique parmi les intents ouverts du même commerçant et token ; sinon refuser
   le virement et proposer le routeur.
4. **Tolérance** : accepter `attendu ≤ reçu ≤ attendu + 0,5 %`. En dessous (frais déduits) : « sous-payé », alerte
   commerçant, jamais « payé » automatique. Au-dessus : payé, surplus noté.
5. **Expiration** : le widget vit 10 min, mais un virement AR peut être plus lent : fenêtre de rapprochement **24 h**
   (Pix : durée du BR Code). Transfert tardif sur facture expirée mais intent ouvert : « payé en retard », décision du
   commerçant ; sinon alerte « transfert non rapproché ».
6. Idempotence par `(txHash, logIndex)` ; un transfert ne ferme qu'une facture ; ambiguïté (2 candidats) : file manuelle.

## 7. Tests
Unitaires : unicité du montant-signature ; tolérance (sous/exact/sur) ; collision de deux factures ; transfert tardif ;
idempotence ; transfert sans intent (faux positif) ; webhook sans transfert on-chain ; transfert sans webhook.
Indexeur : `getLogs` par topic `to`, reorg, redémarrage. Intégration (sandbox Ripio si compte partenaire) : achat réel de
bout en bout AR et BR (**jamais fait à ce jour**), mesure des frais, du délai et du `from`.

## 8. Estimation
- B (auto-chaînage + tests) : **~6 h**.
- A : schéma `ramp_intent` + API 4 h ; indexeur `Transfer` + rapprochement 8 h ; webhook + signature 4 h ; UI + i18n 4 h ;
  tests 6 h ; achat réel de validation 3 h ; **~29 h**, plus le délai d'obtention du compte partenaire (inconnu).

## Non vérifié (à lever avant tout go A)
Équivalence `ramp.ripio.com` public vs widget partenaire ; frais déduits ou non du montant livré ; limites et délais Pix/AR ;
durée de vie du BR Code ; comportement si le payeur a déjà une adresse chez Ripio ; wARS/wBRL/Celo activés côté compte.
