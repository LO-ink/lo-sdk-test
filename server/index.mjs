import { createServer } from "node:http";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHandler } from "./app.mjs";
import { createGoVerifier } from "./initdata-go.mjs";
const port = Number(process.env.PORT ?? 5407);
// The container has one writer and a dedicated private upload subdirectory.
if (process.env.LO_UPLOAD_DIR) {
  await mkdir(process.env.LO_UPLOAD_DIR, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(process.env.LO_UPLOAD_DIR, {
    withFileTypes: true,
  })) {
    if (entry.isDirectory() && /^upload-[A-Za-z0-9]{6}$/.test(entry.name))
      await rm(join(process.env.LO_UPLOAD_DIR, entry.name), {
        recursive: true,
      });
  }
}
const server = createServer(
  createHandler(process.env, {
    verifyWithGo: createGoVerifier(),
  }),
);
server.requestTimeout = 60000;
server.listen(port, process.env.BIND_ADDRESS ?? "127.0.0.1", () =>
  console.log(`LO SDK Test: http://127.0.0.1:${port}`),
);
