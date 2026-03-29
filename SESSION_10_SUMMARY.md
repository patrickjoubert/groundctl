# Session 10 — Dashboard v3 Architecte

## Ce qui a été livré

### VUE LE PLAN
- Carte complète du produit, structurée par groupe (CORE CLI · INTELLIGENCE · OBSERVABILITY · DISTRIBUTION · OTHER)
- Chaque feature = une carte cliquable avec : nom (14px+, gras), description, barre de progression (progress_done/total), badge priorité, tags de dépendances ("⊘ needs: dep-name" en rouge si bloquante, "↳ dep-name" en gris si satisfaite)
- Clic sur une carte → modal popup avec description complète, items, dépendances avec statut, bouton **▶ LAUNCH**
- Header de groupe avec barre de progression horizontale et compteur done/total

### VUE LE CHANTIER
- **AGENTS EN COURS** : cards pour chaque claim actif avec session ID, durée, fichiers modifiés, badge "⚠ STALE" si >2h
- **PRÊT À LANCER** : grille de cards pour les features pending sans deps bloquantes, chacune avec bouton **▶ LAUNCH**
  - Clic LAUNCH → `POST /api/claim` → toast "claimed" → reload auto
  - Fonctionne sur EVSpec.io : 3 features disponibles avec boutons cliquables ✓
- **BLOQUÉ** : liste des features avec deps non satisfaites (si applicable)
- **ALERTES** : stale claims détectés, sinon "✓ Aucune alerte active"

### VUE LES CORPS DE MÉTIER
- Un bloc par groupe avec header (nom, barre de progression, done/total %)
- Tableau des features : icône statut + nom + barre prog + description + bouton ▶ (si disponible)
- **Parallel runs** : calcul automatique des paires de features disponibles sans dep mutuelle
  - Affiche "▶ feat-A + ▶ feat-B" si deux features peuvent être lancées en //
  - Affiche "✓ Corps de métier complet" si tout est done

### API `/api/claim` (POST)
- Accepte `{ featureId: string }` — claim la feature dans SQLite
- Écrit directement dans db.sqlite (export sql.js → writeFileSync)
- Retourne `{ok: true, featureName}` ou `{ok: false, error}`

## Nouvelles commandes CLI

### `groundctl launch <feature>`
- Claim la feature puis `spawn('claude', ['--print', prompt], {stdio: 'inherit'})`
- Inclut le contenu d'AGENTS.md dans le prompt de démarrage
- Fallback si claude absent : affiche la commande à copier

### `groundctl agents`
- Liste tous les claims actifs avec : session ID, durée, fichiers modifiés
- Marque les stales (>2h) en rouge avec instruction `groundctl stale`

### `groundctl stale`
- Liste les claims >2h
- Si TTY : demande confirmation "Libérer tous les claims stales ? [y/N]"
- Release : UPDATE claims SET released_at + UPDATE features SET status = 'pending'
- Écrit SQLite directement (sql.js export)

## Tests

```
cd /Users/patrick/groundctl
groundctl dashboard
→ LE PLAN          : 4 groupes + OTHER, 29 cartes, 100% done
→ LE CHANTIER      : 1 agent EN COURS (feature/dashboard-v3), 0 features ready
→ LES CORPS        : 5 corps, tous à 100%, "Corps de métier complet" ✓

cd /Users/patrick/EVSpec.io
groundctl dashboard
→ LE PLAN          : 8 features (OTHER group, no feature_groups table)
→ LE CHANTIER      : 0 agents, 3 features PRÊT À LANCER avec ▶ LAUNCH ✓
→ LES CORPS        : 2 corps (OTHER + ungrouped)

groundctl agents    → 1 actif (feature/dashboard-v3)
groundctl stale     → ✓ Aucun claim stale
```

## Bugs trouvés et corrigés
- **Compat SQLite** : PRAGMA table_info check avant SELECT group_id/items/progress_done (S9 fix conservé)
- **Parallel runs overflow** : break outer après 2 paires trouvées pour éviter O(n²) sur gros projets
- **claimFeatureInDb import** : export depuis dashboard.ts, importé par launch.ts et stale.ts

## État final
- npm : @groundctl/cli@0.8.0 ✓ publié
- git tag v0.8.0 ✓ poussé
- `feature/dashboard-v3` : ✓ completed
- Tests : groundctl ✓ · EVSpec.io ✓

| Feature           | Statut |
|-------------------|--------|
| Vue LE PLAN       | ✓ |
| Vue LE CHANTIER   | ✓ |
| Vue LES CORPS     | ✓ |
| groundctl launch  | ✓ |
| groundctl agents  | ✓ |
| groundctl stale   | ✓ |
| POST /api/claim   | ✓ |
| Compat old DBs    | ✓ |

## Prochaine session
S11 — Show HN launch
- Finaliser SHOW_HN.md avec dashboard v3 + launch command
- Test multi-agents sur EVSpec.io avec 2-3 agents en //
- Update groundctl.org avec screenshot dashboard v3
