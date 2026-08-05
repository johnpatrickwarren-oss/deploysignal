# deploysignal
## Knowledge base — read before working here

`~/concord/knowledge` is an LLM-maintained wiki: the statistics, engineering methodology, and design
standards behind the repos in `~/concord`. It is a separate git repository and it is the **single
entry point**. Do not point at any other standards document.

- `knowledge/SCHEMA.md` — how the wiki is written and read. Read first.
- `knowledge/index.md` — root router, topics only. Two hops to any page.
- `knowledge/WORKLIST.md` — outstanding work and unresolved contradictions.

**Check the wiki before claiming anything** about detector maths, validity, or study results. It
records retractions and superseded claims that this repo may still carry, so a doc in this repo
agreeing with you is not confirmation.

**Write findings back as wiki pages** under its schema. Do not correct the wiki by editing repo
docs, and do not leave a finding only in a commit message.

Design and writing standards route through `knowledge/design/` to `~/concord/junction`, which is
canonical for both. `WRITING-STYLE.md` exists only there.

**Communication with John** follows `~/concord/knowledge/design/pages/session-communication.md`:
verify first; cite code, not prose; lead with corrections; decisions get 3+ numbered options with a
recommendation; state what you did not do; a reply is as long as the finding.
