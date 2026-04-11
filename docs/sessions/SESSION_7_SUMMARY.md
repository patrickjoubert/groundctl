# Session 7 — Show HN Final

## Bugs corrigés

1. **Label "OTHER" fantôme dans `status --detail`** — quand aucun groupe n'existe,
   les features s'affichaient sous un header "OTHER" inutile. Corrigé : render flat
   sans header quand groups.length === 0.

2. **Troncature des noms de features** — `NAME_W` trop petit (22) tronquait des
   noms comme "add-authentication-module" (24 chars). Augmenté à 26.

## Modifications groundctl.org

- **Hero démo** : remplacement du demo.svg par un vrai terminal block montrant
  `groundctl status --detail` sur le repo groundctl lui-même (groupes réels,
  progress bars réelles, items réels)
- **Section "groundctl builds itself"** : ajoutée après "How it works" —
  11 sessions · 21 features · 100% implemented + lien PROJECT_STATE.md
- **Commandes** : ajout de `groundctl doctor  → diagnose your setup`
- **Footer** : "Sessions S1–S3" → "11 sessions · 21 features · tracked in PROJECT_STATE.md"
- **style.css** : ajout `.grp-header` et styles `.meta-built` / `.meta-stats`

## SHOW_HN.md — changements vs version précédente

- Titre capitalisé : "Always know what to build next" (était minuscule)
- Output `status --detail` mis à jour avec les vrais groupes (Core CLI, Intelligence,
  Observability, Distribution) et les vraies stats (21/21, 11 sessions)
- Mention explicite du watch daemon comme "killer feature"
- Proxy detect.groundctl.org mentionné dans le corps (zero API key required)
- Objections enrichies : ajout "Just use a CHANGELOG", "Claude Code already has memory",
  "This is just a wrapper around git log"
- Section objections réorganisée et complétée

## État final

- npm : @groundctl/cli@0.5.1
- groundctl.org : push effectué → Vercel redéploie automatiquement
- detect.groundctl.org : en attente déploiement Worker Cloudflare (credentials wrangler nécessaires)
- Show HN : prêt à poster mardi ou mercredi 9h00 PT

## Prochaine action

groundctl est prêt pour Show HN.
Poster mardi ou mercredi 9h00 PT sur news.ycombinator.com

Avant de poster :
1. Déployer detect.groundctl.org (wrangler login + kv create + deploy)
2. Vérifier groundctl.org visuellement après redéploiement Vercel
3. Poster avec le texte exact de SHOW_HN.md section "Body"
