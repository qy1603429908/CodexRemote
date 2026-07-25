# 测试与证据记录

公开仓库不提交包含开发者主目录、私人任务正文、生产域名/IP 或本机签名工具路径的原始日志。发布证据只保留可复现命令、通过数量、APK 元数据和脱敏协议摘要。

## 标准验证

```bash
npm install
npm run typecheck
npm test
npm run build
npm run build:android
```

Android 额外检查：

```bash
cd apps/mobile/android
./gradlew lintDebug
```

APK 元数据和签名可使用 Android SDK 的 `aapt2`、`apksigner` 检查。发布记录见对应的 `docs/release-v*.md`。

## 真实 Host/WSS 回归

```bash
npm run host:start
npm run test:public-sync -- ws://127.0.0.1:8787/ws
```

公网部署可显式传入自己的 WSS 地址：

```bash
npm run test:public-sync -- wss://codex.example.com/ws
```

脚本从本地 `.env` 读取 `CMR_TOKEN`，但不会输出令牌。

## 隐私规则

- 不提交原始会话正文、附件、任务标题或完整 wire dump；
- 不提交私人域名、公网 IP、VPN 地址、用户名和绝对主目录；
- 协议回归只记录 item 类型、匿名化 ID/哈希、数量和相对顺序；
- `.env`、密钥、证书、keystore 和构建目录必须保持忽略。
