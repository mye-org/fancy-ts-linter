#!/usr/bin/env node
import { runCli } from '../dist/cli.js';

const result = runCli(process.argv);
if (result.stdout.length > 0) {
  process.stdout.write(`${result.stdout}\n`);
}
if (result.stderr.length > 0) {
  process.stderr.write(`${result.stderr}\n`);
}
process.exitCode = result.exitCode;
