import { createServer } from 'node:http';

import { createNodeMiddleware } from '@octokit/webhooks';

import { createApp } from './github/app.js';

const appId = process.env['APP_ID'];
const privateKeyRaw = process.env['PRIVATE_KEY'];
const webhookSecret = process.env['WEBHOOK_SECRET'];

if (!appId || !privateKeyRaw || !webhookSecret) {
  process.stderr.write('APP_ID, PRIVATE_KEY and WEBHOOK_SECRET are required\n');
  process.exit(2);
}

// Accept the PEM either verbatim (with \n escapes) or base64-encoded for easier secret storage.
const privateKey = privateKeyRaw.includes('-----BEGIN')
  ? privateKeyRaw.replace(/\\n/g, '\n')
  : Buffer.from(privateKeyRaw, 'base64').toString('utf8');

const app = createApp({
  appId,
  privateKey,
  webhookSecret,
  ...(process.env['POLICY_PATH'] ? { policyPath: process.env['POLICY_PATH'] } : {}),
  applyLabels: process.env['APPLY_LABELS'] !== 'false',
});

const middleware = createNodeMiddleware(app.webhooks, { path: '/api/webhooks' });
const port = Number(process.env['PORT'] ?? 3000);

createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (await middleware(req, res)) {
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, () => {
  process.stdout.write(`provenance-gate listening on :${port}\n`);
});
