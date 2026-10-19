// Opens the database named by MESSAGE_CP_DB at the instant START_AT (epoch ms), then exits 0,
// or prints the error and exits 1. The shared start time makes the processes open together.
import { openDb } from "../../src/db.js";

while (Date.now() < Number(process.env.START_AT)) {
  // Spin: a timer would wake the processes at slightly different moments.
}
try {
  openDb().close();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
