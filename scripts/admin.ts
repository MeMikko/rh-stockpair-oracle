import { buildAdminServer, adminEnv } from '../src/admin/server.js';

/**
 * The operator panel, run as its own unit.
 *
 * Deliberately not started by `npm run serve`: the whole point of the split is
 * that the process holding the wallet key is a different process from the one
 * answering the internet.
 */

const app = buildAdminServer();

app.listen({ port: adminEnv.port, host: adminEnv.host }).then(
  () => {
    app.log.info(
      `admin panel on http://${adminEnv.host}:${adminEnv.port} — ` +
        (adminEnv.host === '127.0.0.1'
          ? 'reach it with: ssh -L 8090:127.0.0.1:8090 <box>'
          : 'bound off loopback; make sure something else keeps it private'),
    );
  },
  (e) => {
    app.log.error(e);
    process.exit(1);
  },
);
