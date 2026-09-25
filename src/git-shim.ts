#!/usr/bin/env node
import { runCli } from "./main.js";
// Explicit bootstrap installs this only in AGSX_HOME/shims. A native Git
// invocation is the user's effect request; no global git command is replaced.
runCli(["git.run", "--apply", "--args", JSON.stringify(process.argv.slice(2))], "git");
