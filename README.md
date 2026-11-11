# Lattci-chat 0.1.1（晶格）

两台已配对的电脑通过加密 WebSocket 直接收发通知和请求。Codex 插件提供 MCP 工具。本地晶格进程独立收信，Codex 退出时收到的消息保存在本机，插件重新连上后可查看。macOS 上可由系统在登录时启动晶格。

## 安装

首版在 macOS 验证。需要 Codex、Node.js 22.13+ 和 OpenSSL。插件可从 GitHub 安装，包里已包含运行代码，无需 npm 安装。配对命令请在克隆后的仓库目录执行。

```sh
codex plugin marketplace add MyKWK/Lattci-chat
codex plugin add lattci-chat@lattci-chat
git clone https://github.com/MyKWK/Lattci-chat.git
cd Lattci-chat
node plugins/lattci-chat/lattice.cjs --help
```

## 首次配对

1. 选一台可被另一台访问的电脑 A，在 A 上把 `LISTEN_IP` 换成它的局域网或 VPN 地址。

   ```sh
   node plugins/lattci-chat/lattice.cjs init --name A --bind LISTEN_IP
   node plugins/lattci-chat/lattice.cjs service enable
   node plugins/lattci-chat/lattice.cjs identity
   ```

2. B 可以用默认监听地址，主动连接 A。

   ```sh
   node plugins/lattci-chat/lattice.cjs init --name B
   node plugins/lattci-chat/lattice.cjs service enable
   node plugins/lattci-chat/lattice.cjs identity
   ```

3. 双方交换 `identity` 输出的 64 位十六进制身份码。先在 A 信任 B，再在 B 信任 A 并填写 A 的可达地址。

   ```sh
   # 在 A
   node plugins/lattci-chat/lattice.cjs pair B_ID --name B

   # 在 B
   node plugins/lattci-chat/lattice.cjs pair A_ID --name A --address wss://LISTEN_IP:48452

   # 两边都可以查看连接
   node plugins/lattci-chat/lattice.cjs status
   ```

握手后同一条连接可双向传输。新配对默认「无权限」，通知照常显示，请求由接收方运行 `approve 消息编号` 或 `reject 消息编号`。要为某台设备开启直接处理，在接收端运行 `permission 对方身份码 full`。可用 `permission 对方身份码 none` 收回直接处理权限。

如果希望晶格自动启动本机 Codex，首次 `init` 时追加 `--workspace 项目绝对路径 --codex Codex可执行文件绝对路径`。默认只读，需要允许在工作区写入时追加 `--workspace-write`。Agent 在线指插件 MCP 会话已接入晶格。请求可交给新的本机 Codex 执行，也可由接收方在插件中回复已授权请求。

打开新的 Codex 会话后，可以让晶格查看连接、发送通知或请求、读取收件箱、查询消息和回复。也可用命令行验证：

```sh
node plugins/lattci-chat/lattice.cjs send notice --to PEER_ID --body '你好'
node plugins/lattci-chat/lattice.cjs inbox
node plugins/lattci-chat/lattice.cjs message MESSAGE_ID
node plugins/lattci-chat/lattice.cjs resend MESSAGE_ID
```

连接恢复后，由用户决定是否重发。发送状态 `sent` 表示消息交给了本机连接。Codex 退出期间已进入接收端的消息会保留在本机。恢复时晶格在 macOS 上请求系统显示提醒，收件箱始终可查。

测试期间也可用 `serve` 前台启动，使用 `service disable` 停止已注册的后台服务。

## 连接排查

- `ECONNREFUSED` 时先检查 A 是否启动、监听地址和端口是否填对。
- 连接超时时，检查双方所在网络是否互通、系统防火墙是否允许该端口，以及 macOS 的「本地网络」权限。可先在同一局域网验证，再用双方允许使用的 VPN。
- `identity_mismatch` 时重新核对手工交换的身份码，以及地址实际指向的设备。
- 只交换身份码即可完成身份确认，但主动连接的一端仍需要一个可达地址。

## 开发验证

```sh
npm ci
npm run build
npm test
LATTICE_TEST_LAN=1 LATTICE_TEST_CODEX="$(command -v codex)" npm test
```
