#!/usr/bin/env node
// Thin shim: load the compiled CLI entry. Keeps `bin/` decoupled from TS output.
require('../dist/cli.js');
