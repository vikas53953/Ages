import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Tests write their own project settings and expect them to apply: trust them (tests/trust.test.ts turns this off).
process.env.AEGIS_TRUST_PROJECT = "1";
// Never touch the real ~/.aegis: each test file gets its own home unless a test sets one.
if (!process.env.AEGIS_HOME) process.env.AEGIS_HOME = mkdtempSync(path.join(os.tmpdir(), "aegis-test-home-"));
