# Session 9 — Dashboard v2

## Ce qui a été livré

### Dashboard v2 — 3-view cockpit

Réécriture complète de `packages/cli/src/commands/dashboard.ts` (141 → 560 lignes).

#### Architecture
- Serveur HTTP pur Node, zéro nouvelle dépendance
- SPA 3 onglets via `?view=now|plan|health`
- Auto-refresh 10s via `setInterval(() => location.reload(), 10000)` (pas de meta refresh)
- Couleurs : `#0d0d0d` bg · `#e0e0e0` text · `#00ff88` green · `#ffaa00` warnings · `#ff4444` errors
- Police : `'Courier New', monospace`
- Compatibilité : shim pour DBs sans `group_id` (EVSpec.io, projets pré-S5)

#### VUE NOW (défaut)
- Colonne gauche : nom projet, `% implemented`, barre de progression, stats (sessions, last session, active claims, arch decisions), Health Score /100 avec 4 mini-barres (Features/Tests/Arch/Claims)
- Colonne droite — Action Zone :
  - **IN PROGRESS** : claims actifs + durée écoulée, alerte rouge si stale >24h
  - **READY TO BUILD** : features pending sans deps bloquantes, top item en vert
  - **BLOCKED** : features avec deps non satisfaites + `needs: dep-name`
  - **NEXT RECOMMENDED** : `groundctl claim "..."` hint

#### VUE PLAN
- DAG ASCII par groupe : sections horizontales labellisées
- Chaque feature = nœud cliquable `[icon name]` avec couleur par statut
- Flèches `→` entre nœuds connectés par une dépendance
- Tri topologique BFS par groupe, détection de chaînes
- **Popup modal** au clic : nom, statut, priorité, description, items, dépendances, hint `claim`
- Légende : `✓ done · ● in progress · ○ ready · ⊘ blocked · → depends on`

#### VUE HEALTH
- Score /100 avec barres CSS animées (Features 40 · Tests 20 · Arch log 20 · Claims 10 · Deploy 10)
- **Debt Tracker** : stale claims, missing test files, arch decisions needed, features pending
- **Recommendations** numérotées et actionnables (générées depuis les données)
- **Session Timeline** : 10 dernières sessions, durée, fichiers, décisions, date relative

### Compat fix
Détection dynamique des colonnes via `PRAGMA table_info(features)` + `SELECT name FROM sqlite_master` pour éviter les crashs sur des schémas plus anciens (EVSpec.io testé ✓).

## Tests
```
$ groundctl dashboard                         # groundctl project
→ NOW  : 23/23 done, 0 active claims, 0 blocked, NEXT = nothing (all done 🎉)
→ PLAN : 4 groupes × features, nodes cliquables
→ HEALTH : score 52/100, 3 recommendations

$ cd /Users/patrick/EVSpec.io && groundctl dashboard
→ NOW  : EVSpec.io, features en cours, actions zone active
→ PLAN : 8 groupes (no feature_groups table → fallback ungrouped)
→ HEALTH : breakdown correct
```

## État final
- npm : @groundctl/cli@0.7.0 ✓ publié
- git tag v0.7.0 ✓ poussé
- `feature/dashboard-v2` : ✓ completed
- Tests : groundctl ✓ · EVSpec.io ✓

## Prochaine session
S10 — Show HN launch (si le dashboard est bon) OU Cloudflare Worker deploy (wrangler login requis) OU groundctl.org refresh avec screenshot dashboard v2
