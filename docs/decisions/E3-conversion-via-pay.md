# E3 : conversion de trésorerie marchand via pay()

**Décision** : pas de fonction de conversion dans le routeur v1 (immuable). Une conversion marchand est un `pay()` où
`merchant == payer`, soumis par le relayer, avec une seule jambe PERMIT2 (ex. wARS -(100)- USDT).

**Preuve** : `contracts/test/fork/CobraRouterFork.t.sol::test_fork_merchantConversion_wARS_to_USDT_selfPay`
(fork Celo, vrais Permit2/SwapRouter02/tokens, clé fraîche sans délégation 7702). `amountOut` = quote - 1 % ;
le routeur paie exactement `amountOut` puis rembourse le surplus à la même adresse : solde USDT final = sortie du swap
(>= min-out signé), solde du routeur = 0, facture marquée payée.

**Effet** : les fonds convertis sont crédités à l'adresse du signataire (portefeuille agent du marchand).

**Reste à faire** (hors contrats) :
- relayer/web : flux d'intentions de conversion signées par le marchand (Invoice + Leg, id unique, deadline courte) ;
- approbation Permit2 unique du wARS (`approve(PERMIT2, max)`) par le marchand avant la première conversion ;
- calcul min-out côté serveur via QuoterV2 (marge ~1 %), jamais par le LLM.
