# Lattci-chat 0.1.2（晶格）

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

以下命令使用当前源码构建的运行包。已安装过的设备请更新 Codex 插件。macOS 上已注册后台服务的设备用新版 `lattice.cjs` 再执行一次 `service enable`，以更新后台程序。手动运行 `serve` 的设备用新版程序重启。

1. 选一台可被另一台访问的电脑 A，在 A 上把 `LISTEN_IP` 换成它的局域网或 VPN 地址。

   ```sh
   node plugins/lattci-chat/lattice.cjs init --name A --description '可整理项目资料，负责汇总进度。' --bind LISTEN_IP
   node plugins/lattci-chat/lattice.cjs service enable
   node plugins/lattci-chat/lattice.cjs identity
   ```

2. B 可以用默认监听地址，主动连接 A。

   ```sh
   node plugins/lattci-chat/lattice.cjs init --name B --description '可审阅测试记录，负责反馈验证结果。'
   node plugins/lattci-chat/lattice.cjs service enable
   node plugins/lattci-chat/lattice.cjs identity
   ```

3. 双方交换 `identity` 输出的设备声明。先在 A 登记 B，再在 B 登记 A 并填写 A 的可达地址。

   - `name` 是设备向好友展示的名称。
   - `lattci-code` 是原有的 64 位十六进制公开身份码，和输出中的 `id` 相同。
   - `description` 说明这台机器能做什么、可以做什么、负责什么。首次登记好友须填写，最多 2000 字符。

   ```sh
   # 在 A
   node plugins/lattci-chat/lattice.cjs pair B_CODE --name B --description '可审阅测试记录，负责反馈验证结果。'

   # 在 B
   node plugins/lattci-chat/lattice.cjs pair A_CODE --name A --description '可整理项目资料，负责汇总进度。' --address wss://LISTEN_IP:48452

   # 两边都可以查看连接
   node plugins/lattci-chat/lattice.cjs status
   ```

握手后同一条连接可双向传输。新配对默认「无权限」，通知照常显示，请求由接收方运行 `approve 消息编号` 或 `reject 消息编号`。要为某台设备开启直接处理，在接收端运行 `permission 对方身份码 full`。可用 `permission 对方身份码 none` 收回直接处理权限。

### 维护设备声明

可在命令行修改本机的描述，或在 Codex 里请晶格更新本机的能力和职权声明。`identity` 和 `status` 会立即显示新版描述。更新后把 `identity` 输出交给好友，由对方用原晶格码重新执行 `pair` 更新记录。

```sh
node plugins/lattci-chat/lattice.cjs profile --description '可审阅测试记录，并负责汇总缺陷。'
node plugins/lattci-chat/lattice.cjs identity
```

升级后，原来的好友记录会继续使用，未填写的描述显示为 `null`。重新执行 `pair` 可补填描述，省略 `--address` 时沿用已登记的地址。实际请求授权仍由接收方通过 `permission` 管理。

### 执行任务和审批写入

晶格默认使用 `~/.lattice/workspace` 执行已授权的任务。如果设置了 `LATTICE_HOME`，专用目录是该目录下的 `workspace`。已有的自定义目录继续使用。首次初始化也可用 `--workspace 目录` 指定。自动执行需要本机 Codex CLI 支持权限配置和 App Server 的路径权限审批。找不到可执行文件时，首次初始化可用 `--codex 可执行文件绝对路径` 指定。

任务可以读取、写入和删除专用工作目录内的文件。目录外普通文件默认只读，写入和删除需要本机使用者批准。好友的 `full` 权限只免除任务请求审批。Agent 在线指插件 MCP 会话已接入晶格。

当任务申请在目录外写入时，用本机终端查看申请中的路径与理由。批准仅对本次任务中列出的路径生效。拒绝或未批准时，目录外仍保持只读。

```sh
node plugins/lattci-chat/lattice.cjs reviews
node plugins/lattci-chat/lattice.cjs review APPROVAL_ID
```

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
