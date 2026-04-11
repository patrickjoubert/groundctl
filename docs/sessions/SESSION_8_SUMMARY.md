# Session 8 — groundctl plan

## Ce qui a été livré

### PARTIE 1 — Détection automatique du plan dans le transcript
- `types.ts`: nouveau type `ParsedPlannedFeature` + champ `plannedFeatures` dans `ParsedSession`
- `schema.ts`: table `planned_features` (session_id, name, raw_text, confidence, imported)
- `claude-parser.ts`: fonction `extractPlannedFeatures()` — détecte les headers de plan
  ("Here's my plan:", "Step 1:", "My approach:", etc.) et extrait les étapes numérotées
  comme features en kebab-case (max 6 mots)
- `ingest.ts`: après ingest, si des features planifiées détectées et TTY interactif →
  prompt "Import as features? [y/n]"

**Test direct du moteur de détection :**
```
Input: "Here's my plan:\n1. Set up FastAPI project\n2. Create vehicle models..."
Output:
  ○ set-up-fastapi-project-structure
  ○ create-vehicle-models-with-pydantic
  ○ build-vehicles-rest-endpoint
  ○ add-jwt-authentication
  ○ write-comprehensive-tests
  ○ deploy-to-railway-with-docker
```

### PARTIE 2 — groundctl plan (commande explicite)
- Nouvelle commande `groundctl plan [description]`
- Mode 1: `groundctl plan "Build a REST API"` → planification depuis description
- Mode 2: `groundctl plan` → prompt interactif "Describe what you want to build:"
- Mode 3: `groundctl plan --replan` → analyse features existantes + propose la suite
- Fallback chain: detect.groundctl.org/plan → ANTHROPIC_API_KEY → erreur claire
- Import des features + dépendances dans SQLite (`feature_dependencies` table)
- Endpoint `/plan` ajouté dans `packages/detect-api/src/index.ts`
- Option `--group` pour assigner les features planifiées à un groupe

### PARTIE 3 — Dépendances visuelles dans status + next
- `status.ts`: chargement des deps depuis `feature_dependencies`
- `status --detail` affiche `(needs: feature-x)` en rouge pour les deps non satisfaites
- `next.ts`: exclut les features dont les blocking deps ne sont pas done

**Tests:**
```
$ groundctl status --detail
  ○ feature-b  ░░░░░░░░░░░░░░  Depends on A  (needs: feature-a)

$ groundctl next
  → feature-a  ← feature-b n'est PAS proposé car ses deps sont unmet
```

## Test sur EVSpec.io
- `groundctl plan "Add 3 European markets (DE, FR, NL)"` → fallback propre
  (proxy non déployé, ANTHROPIC_API_KEY vide dans ce contexte)
- Fonctionnera dès que detect.groundctl.org est déployé ou ANTHROPIC_API_KEY set

## Bugs trouvés et corrigés
- Aucun nouveau bug (les bugs S7 étaient déjà corrigés)

## État final
- npm : @groundctl/cli@0.6.0
- groundctl plan : ✓ commande enregistrée, fallback propre
- Détection auto plan transcript : ✓ moteur validé
- Dépendances dans status : ✓ `(needs: feature-x)` affiché
- next : ✓ exclusion des features avec deps unmet
- Dashboard v2 : reporté en S9

## Prochaine session
S9 — Dashboard v2 (DAG visuel, vue NOW + PLAN + HEALTH) OU Show HN launch
