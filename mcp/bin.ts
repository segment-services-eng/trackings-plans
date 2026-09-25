#!/usr/bin/env node
import { logToStderr, main } from "./server.js";

main().catch((err) => {
  logToStderr(err);
  process.exit(1);
});
