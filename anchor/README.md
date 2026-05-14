# Anchor methodology — pointer

This project was built using the [Anchor](https://github.com/johnpatrickwarren-oss/anchor)
coordination methodology (four-anchor pre-merge defense, role separation,
memorial accretion, round scaling, multi-cluster coordination via the
Coordinator role).

Anchor was originally developed inside this project's predecessor
(`deploysignal-private`) and later extracted to its own canonical repo:

→ **https://github.com/johnpatrickwarren-oss/anchor**

The methodology spec, role skills (PM, Architect, TPM, Implementer,
Reviewer, Coordinator), fillable templates, and case studies all live
in the canonical repo. This pointer replaces a previously-embedded
mirror of those files. The mirror was kept in sync manually and would
drift between updates, occasionally serving stale methodology to readers
— a worse outcome than not embedding it at all.

The case study tracing how Anchor emerged while building this project:

→ **https://github.com/johnpatrickwarren-oss/anchor/blob/main/case-studies/deploysignal-coordination-trail.md**

## What used to be here

The `anchor/` directory previously contained:

- `METHODOLOGY.md` (one-page consolidated reference)
- `README.md` (overview)
- `skills/` (numbered skill files: pre-emit grilling, memorial accretion, four-anchor defense, etc.)
- `templates/` (PRD, spec, TPM reply, reviewer report, project roles)
- `case-studies/` (worked-example coordination trail for this project)

All of those files now live in the canonical repo. The
`tools/sync-from-anchor.sh` helper that maintained the embedded mirror
has also been removed.
