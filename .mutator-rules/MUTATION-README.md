# .mutator-rules/

This directory is **owned by mutator-guard** (/home/bhd/Documents/Projects/bhd/guard-orches/components/mutator-guard). Do not edit by hand — changes will be
overwritten on the next `deploy.sh` run.

- Sibling: pi-curator
- Language: typescript
- mutator-guard SHA: 82afc85378cc1bbf32d6d32d037a2cfcbe7a1b6f
- Generated: 2026-07-16T08:43:53Z
- Integrity: Composite SHA of all deployed files (tamper detection)

To re-deploy:  `(cd /home/bhd/Documents/Projects/bhd/guard-orches/components/mutator-guard && scripts/deploy.sh --sibling pi-curator --sibling-path /home/bhd/Documents/Projects/bhd/pi-curator --lang typescript)`
To run:        `(cd /home/bhd/Documents/Projects/bhd/pi-curator && bash .mutator-rules/stryker/run.sh)`

Safety: a `SAFETY.ack` file must exist in this directory before scans will execute. Author with:
`(cd /home/bhd/Documents/Projects/bhd/guard-orches/components/mutator-guard && scripts/mg-ack-safety.sh pi-curator)`
