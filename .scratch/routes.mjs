import Fastify from 'fastify';
import { installConsole, findConsoleDir } from '../packages/server/dist/console.js';
console.log('console dir:', findConsoleDir() ?? '(none)');
const app = Fastify({ logger: false });
app.decorate('huskAuthEnabled', false);
await installConsole(app);
await app.ready();
console.log(app.printRoutes({ commonPrefix: false }));
await app.close();
