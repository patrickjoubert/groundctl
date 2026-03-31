# Show HN — Checklist finale

## Date : 2026-03-31

| Check | Status | Note |
|-------|--------|------|
| npm 0.9.0 | ✅ | `npm info @groundctl/cli version` → `0.9.0` |
| install propre | ✅ | detect → 2 features, hooks Claude+Codex, watch daemon, PROJECT_STATE.md |
| groundctl next | ✅ | features open → affiche priorité / 0 features → auto-suggest |
| export --conductor | ✅ | `.conductor/tasks.md` généré, tagline affichée |
| groundctl doctor | ✅ | detect.groundctl.org reachable, LaunchAgent, Codex hooks |
| groundctl dashboard | ✅ | http://localhost:4242 répond HTML |
| groundctl status | ✅ | 29/29 done, 4 groupes propres (Core CLI / Intelligence / Observability / Distribution) |
| groundctl.org 200 | ✅ | HTTP/2 200, section "Works with your orchestrator" live |
| detect.groundctl.org | ✅ | POST /detect → 8 features JSON retournées |
| GitHub repo | ✅ | `da22608` en sync, README + PROJECT_STATE.md + AGENTS.md visibles |

## Notes

- **CI workflow** : `.github/workflows/ci.yml` retiré temporairement (PAT sans scope `workflow`).
  Ajouter via GitHub UI ou re-pousher après avoir ajouté le scope.
  Les 20 tests passent localement (`npm test`).

- **export --conductor sur projet vide** : affiche "no tasks" si aucune feature importée — comportement correct.
  Sur un projet réel (EVSpec.io) : 2 tasks ready, 0 blocked ✅

- **doctor "could not reach npm registry"** : transitoire — `npm info` confirme 0.9.0 live.

## Verdict

# GO ✅

## Heure recommandée pour poster

**Mardi 2026-04-01 ou Mercredi 2026-04-02**
9h00 PT (18h00 Paris)

## Titre HN

Show HN: groundctl – run multiple AI agents without losing track of what's being built (MIT)

## URL

https://groundctl.org
