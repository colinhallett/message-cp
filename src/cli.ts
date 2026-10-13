#!/usr/bin/env node
import { openDb } from "./db.js";
import { loadConfig } from "./hive/config.js";
import { startHive } from "./hive/hive.js";

const [command, ...rest] = process.argv.slice(2);

if (command === "hive") {
  const flag = rest.indexOf("--config");
  const path = flag >= 0 ? rest[flag + 1] : undefined;
  if (!path) {
    console.error("usage: memory-cp hive --config <hive.json>");
    process.exit(2);
  }
  const hive = startHive(openDb(), loadConfig(path));
  const shutdown = () => {
    console.error("memory-cp hive: stopping, waiting for running agents");
    void hive.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else if (command === undefined) {
  await import("./index.js");
} else {
  console.error(`memory-cp: unknown command '${command}'. Commands: hive`);
  process.exit(2);
}
