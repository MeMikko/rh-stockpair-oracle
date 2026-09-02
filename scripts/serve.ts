import { buildServer } from '../src/api/server.js';
import { env } from '../config/chain.js';

const app = buildServer();
app.listen({ port: env.port, host: env.host }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
