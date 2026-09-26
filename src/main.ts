#!/usr/bin/env node
// The installed `aegis` command. Always runs main(); src/cli.ts keeps its own dev entry for tsx.
import { main } from "./cli.ts";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
