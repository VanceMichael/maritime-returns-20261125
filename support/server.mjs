// 业务应用启动入口：连接本地“合成申报受理台”（support/peer.mjs）。
// 环境变量：
//   PORT          应用端口，默认 4318
//   APP_STATE     应用持久化文件，默认 .local/app.json
//   PEER_BASE_URL 受理台地址，默认 http://127.0.0.1:4317
//   PARTNER_CONFIG 受理台协议配置，默认 fixtures/partner.json
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { PeerClient } from './peer-client.mjs';
import { createApp } from './app.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const partnerConfig = JSON.parse(readFileSync(
    process.env.PARTNER_CONFIG ?? new URL('../fixtures/partner.json', import.meta.url), 'utf8'));
  const stateFile = process.env.APP_STATE ?? '.local/app.json';
  const peerBaseUrl = process.env.PEER_BASE_URL ?? 'http://127.0.0.1:4317';
  const store = new Store(stateFile);
  const peer = new PeerClient(peerBaseUrl, partnerConfig.key, partnerConfig.group, partnerConfig.id);
  const server = createApp(store, peer);
  server.listen(Number(process.env.PORT ?? 4318), '0.0.0.0', () => {
    console.log(JSON.stringify({
      message: '海运优惠申报业务服务已启动',
      port: server.address().port,
      stateFile,
      peerBaseUrl,
    }));
  });
}
