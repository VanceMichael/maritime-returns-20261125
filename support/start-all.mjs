// 容器入口：同进程内同时启动受理台与业务服务，各自使用独立持久文件。
import { readFileSync } from 'node:fs';
import { createPeer } from './peer.mjs';
import { Store } from './store.mjs';
import { PeerClient } from './peer-client.mjs';
import { createApp } from './app.mjs';

const partnerConfig = JSON.parse(readFileSync(new URL('../fixtures/partner.json', import.meta.url), 'utf8'));
const peerPort = Number(process.env.PEER_PORT ?? 4317);
const appPort = Number(process.env.PORT ?? 4318);
const peerState = process.env.PARTNER_STATE ?? '.local/partner.json';
const appState = process.env.APP_STATE ?? '.local/app.json';
const peerBaseUrl = process.env.PEER_BASE_URL ?? `http://127.0.0.1:${peerPort}`;

const peer = createPeer(partnerConfig, peerState);
const store = new Store(appState);
const app = createApp(store, new PeerClient(peerBaseUrl, partnerConfig.key, partnerConfig.group, partnerConfig.id));

await new Promise(resolve => peer.listen(peerPort, '0.0.0.0', resolve));
await new Promise(resolve => app.listen(appPort, '0.0.0.0', resolve));
console.log(JSON.stringify({ message: '受理台与业务服务均已启动', peerPort, appPort, peerState, appState }));

const shutdown = () => { peer.close(); app.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
