import { createServer } from "node:http";
import { createHandler } from "./app.mjs";
import { createGoVerifier } from "./initdata-go.mjs";
const port = Number(process.env.PORT ?? 5407);
const server = createServer(
  createHandler(process.env, {
    verifyWithGo: createGoVerifier(),
  }),
);
server.requestTimeout = 60000;
server.listen(port, process.env.BIND_ADDRESS ?? "127.0.0.1", () =>
  console.log(`LO SDK Test: http://127.0.0.1:${port}`),
);
