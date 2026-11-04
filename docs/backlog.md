# Backlog — à faire dans un deuxième temps

Points décidés mais volontairement repoussés. Chacun commence par une **analyse** (avantages, inconvénients,
risques, coût) validée par l'humain **avant** toute ligne de code.

## B1. Paiement par virement bancaire ou Pix, directement au commerçant (ajouté le 4 nov. 2026)

**Idée** (vue chez Owezy, `github.com/emilianooferreyra/owezy`) : sur la page de paiement, un bouton « Pagar con
transferencia / Pix » ouvre la rampe Ripio avec **l'adresse du commerçant comme destination** et le montant de la
facture. Le client paie en pesos ou en reais depuis sa banque, sans wallet ni crypto ; le commerçant reçoit des
wARS/wBRL ; Cobrá rapproche le transfert entrant de la facture.

Aujourd'hui, la page propose déjà Ripio quand le solde manque, mais les wFIAT arrivent dans le wallet **du payeur**,
qui doit ensuite payer.

**À analyser avant de construire :**

- Avantages attendus : critère 4 du jury (UX pour quelqu'un sans crypto), critère 5 (vrais clients sans wallet),
  pas de gas ni de signature côté payeur.
- Rapprochement : la rampe ne porte pas de référence de facture, donc seul le **montant** relie le transfert à la
  facture. Gestion des collisions (deux factures du même montant), des montants qui arrivent légèrement différents
  (frais de rampe déduits ?), des virements en retard après expiration (10 min, trop court pour un virement ?).
- Indexeur : il ne suit aujourd'hui que l'événement `Paid` du routeur ; il faudrait suivre les `Transfer` de chaque
  wFIAT vers chaque adresse commerçant (charge RPC, faux positifs : un transfert sans rapport vers le commerçant).
- Ce que le paiement perd : la garantie « montant exact, une seule transaction, liée à la facture » du routeur ;
  le crédit de l'agent (ce n'est pas une transaction de l'agent, donc pas taguée ERC-8021 pour le hackathon).
- Ripio : KYC du payeur, frais réels, délais, limites, pays couverts (AR, BR, MX, CO ; pas CL ni PE), paramètres
  exacts du lien (destination, montant, token, réseau Celo) et s'ils sont figés pour l'utilisateur. Aucun achat réel
  testé de bout en bout à ce jour.
- Alternative à comparer : garder la destination = payeur mais enchaîner automatiquement le paiement Cobrá au retour
  de la rampe (montant exact préservé, mais le payeur a besoin d'un wallet).
- Sortie attendue de l'analyse : recommandation go / no-go, design du rapprochement, liste des tests, estimation.
