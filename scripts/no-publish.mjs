#!/usr/bin/env node
process.stderr.write(
  "This independent rebuild is not authorized for publication. Final naming, license/provenance review, registry configuration and a separate release decision are required. Existing team clients are unchanged.\n",
);
process.exitCode = 1;
