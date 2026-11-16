# CNO Mihomo Manager

面向 OpenWrt 24.10+ 的 Mihomo 管理器，由两个可独立升级的部分组成：

- `io.cno.mihomo`：运行在 circud 中的管理 API、同源 Controller bridge 和现代化 Web UI；
- `cno-mihomo-companion`：运行在 OpenWrt 上的 CNO daemon、procd 服务、原子配置 generation 与 firewall4/nftables 网络接管。

UI 基于 mihomo-ui 改造并延续其视觉语言。浏览器只访问 circud 的同源路径，不配置 Controller URL，不读取 Mihomo Secret，也不直接执行特权系统操作。本项目不依赖 LuCI；LuCI 即使存在也只负责 circud 自身的可选管理入口，不参与本包业务协议。

## 运行模型

```text
Browser
  ├─ /io.cno.mihomo/controller/* ── circud package ── 127.0.0.1:9090
  └─ /io.cno.mihomo/api/v1/*     ── circud package ── cno-mihomoctl
                                                        │ Unix socket
                                                        ▼
                                                   cno-mihomod
                                             ┌──────────┴──────────┐
                                             │ procd-supervised     │
                                             │ Mihomo + fw4/nft     │
                                             └─────────────────────┘
```

固定约定：

- package prefix：`/io.cno.mihomo`；
- Manager API：`/io.cno.mihomo/api/v1/*`；
- Controller bridge：`/io.cno.mihomo/controller/*`；
- Mihomo Controller：`http://127.0.0.1:9090`；
- Secret：仅从 `/etc/io.cno.mihomo/controller.secret` 读取；
- package 数据：circud 的 package `dataDir`，当前为原子 JSON repository；
- companion 控制入口：固定 `/usr/sbin/cno-mihomoctl`，有界 JSON stdin/stdout，无 shell 拼接。

所有 package 路由检查 circud 提供的 `isAuthorized`。写请求还要求同源 `Origin` 和 `X-CNO-Mihomo-Request: 1`。不要把未认证的 circud listener 暴露到不可信网络；远程使用应放在支持 HTTP、SSE 和 WebSocket 的认证反向代理之后。

## 生命周期与安全边界

- 首次安装和首次保存配置不会自动接管网络；网络必须由用户显式启用。
- Mihomo 由独立的 `cno-mihomo-core` procd service 监督。
- circud reload、package reload、companion reload 或 daemon 正常退出都不会停止健康的 Mihomo，也不会撤销已声明的网络策略。
- 只有用户显式执行 `service.stop` 时，companion 才先撤销网络接管，再停止 Mihomo。
- nftables 规则先经过 `nft -c`；策略路由会检查冲突并记录 ownership journal。
- 网络应用或恢复失败时 fail-open，只撤销本包拥有的资源，不清理其他插件的规则。
- Manager 的透明代理使用 firewall4/nftables：TCP 可选 `redirect`、`tproxy` 或 TUN，UDP 可选 `tproxy` 或 TUN。TUN 必须同时接管 TCP/UDP；companion 等待设备 UP 后安装专用双栈路由和 fwmark policy rule，并把 nft table、route、rule 全部写入 ownership journal。停用、切换模式和故障回退只清理本包拥有的资源。

## 构建与测试

需要 Node.js 22.12+、pnpm 12.3.4，以及本地可用的 CNO。所有命令均可在本机执行，不需要 Box。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:package
pnpm --dir compiler test
pnpm --dir compiler typecheck
pnpm test:openwrt
pnpm build:package
```

Playwright 会优先使用 `PLAYWRIGHT_CHROME_PATH`，Linux 上也会自动发现 `/usr/bin/chromium`。没有系统浏览器时可执行：

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm build:package` 会依次构建权威 profile compiler、生产 UI 和 circud ZIP。默认产物为 `artifacts/io.cno.mihomo.zip`。构建门禁包括固定 ID/prefix/base、严格 manifest、无符号链接与路径穿越、静态资源完整性、8 MiB ZIP/16 MiB 解压预算、稳定 mtime/权限/条目顺序，以及 `unzip -t`。

GitHub Actions 的 `Build release packages` workflow 还会使用官方 OpenWrt SDK
构建 companion。OpenWrt 24.10 生成通用架构的 `.ipk`，snapshot 生成通用架构的
`.apk`；companion 只包含 TypeScript、shell 和配置文件，因此 IPK 标记为
`Architecture: all`，对应的 APK 标记为 `arch: noarch`。每次构建都会上传 ZIP、IPK
和 APK workflow artifacts；推送 `v*` tag 时，三种产物会一并附加到 GitHub
Release。

开发源码以 `management.js` 为入口并保留 `package/lib/*` 的领域模块边界；生产发布用 esbuild 将后端 ESM 图和 YAML 依赖压成 `management.bundle.min.js`，只保留 `circud` 宿主 import。发布 ZIP 不再携带开发入口和 `package/lib/*`。circud 本身支持多文件相对 ESM，bundle 是依赖自包含、发布体积与加载优化，不是运行时限制。UI 位于 ZIP 的 `static/`。

## 安装

先安装 OpenWrt companion 包，再安装 circud package：

```sh
# OpenWrt 24.10 SDK 中构建 companion IPK；snapshot SDK 同一命令生成 APK
make package/cno-mihomo-companion/compile V=s

# 目标设备安装生成的 IPK 或 APK 后
circud install ./artifacts/io.cno.mihomo.zip
```

离线安装只适合 circud 未运行时。已运行的 circud 应通过其已认证管理 UI/API 上传 ZIP，使用 circud 自带的运行时替换与失败回滚事务。

安装完成后访问：

```text
http://127.0.0.1:9080/io.cno.mihomo/
```

companion 初始 UCI 网络开关为关闭。先导入、预览并应用一个 profile，确认 Mihomo 和 Controller 健康，再在面板中显式启用网络接管。

首次安装时 companion 会在目标设备生成 32 字节随机 Controller Secret，并以 `0600` 保存；circud package 和 daemon 只读取同一文件。若管理员之后手工更换 Secret，需要 reload package 并重启/重新应用 Mihomo generation，使两端同时采用新值。

## Profile 与增强

生产模式的 profile、不可变 revision、订阅、网络配置和全局增强都由 Manager repository 持久化；浏览器 `localStorage` 只保留界面偏好，不是生产配置源，也不会迁移旧 Nikki UCI 或旧浏览器 Controller 凭据。

编译顺序为规则/代理/代理组序列补丁、全局 Merge/Script、按 profile 顺序引用的可复用混入、profile Merge/Script、Manager runtime overlay、引用清理。可复用混入支持 Merge、Seq 和 Script，资源独立版本化，每份 profile 可排序、停用或解除关联。Merge/Seq 输入上限 5 MiB，并限制 YAML 深度与节点数。

Script 始终通过一次性 CNO helper 运行；每次调用新建原生 `CNO.Sandbox`，只初始化 JSON/Map/TypedArray/BigInt 等基础能力，不暴露网络、文件、Deno namespace 或 package runtime。内存、栈、输入输出、日志和 watchdog 均有上限；不会回退到长期 package runtime 的 `eval`。

结构化“高级配置”编辑器写入普通 Merge 混入，不建立第二套存储。常用字段覆盖 HTTP/SOCKS/mixed 入站、监听地址、认证、模式、进程匹配、Keepalive、DNS/Fake-IP/Policy/Hosts、Sniffer、缓存、GeoData 与 Rule Provider；未展示键保持原样。Controller、Secret、Redirect/TPROXY 端口、DNS listener 和 TUN 路由所有权字段最后由 Manager 覆盖。

preview 返回 compiler revision、content hash、最终 YAML、阶段记录和日志；apply 只提交已经过同一编译器生成的 YAML。revision 使用乐观并发，冲突返回 409，避免多个页面静默覆盖。

权威 compiler 最后覆盖 Manager 运行约束：loopback Controller `127.0.0.1:9090`、Redirect `7892`、TPROXY `7893` 与 DNS listener `1053`。公开 preview 中的 `secret` 固定为空；apply 时才用设备文件中的真实 Secret 生成最终 generation，Secret 不进入浏览器响应或 operation snapshot。

配置页提供持久化订阅管理。订阅由路由器侧获取，可原子创建并关联 profile，也可关联、解除或更换已有 profile；一个 profile 最多由一个订阅拥有刷新权。支持自定义 User-Agent、独立信息 URL、`Subscription-Userinfo` 用量/到期解析、ETag/Last-Modified 条件请求、单个/选中/全部刷新和刷新错误保留。HTTP 304 或正文完全相同时不生成新的 profile revision。

设备端自动刷新使用 package runtime 内一个 `setTimeout`，每次根据持久化的 interval 与 `lastRefreshAt` 重新计算最近到期项；package 重启后恢复计划，浏览器关闭不影响调度，不创建 worker，也绝不自动 apply。`remote` 策略在预览/应用前条件刷新，失败时明确回退最后成功版本；若确认期间远端内容改变，revision CAS 会阻止应用未经预览的新 YAML。`local` 策略不因预览或应用发起网络请求。

未关联 profile 的订阅不会发起刷新请求，也不会进入设备端调度；批量刷新会在 operation result 中保留逐项结果，UI 明确显示部分失败。服务设置另有 revisioned 定时重启策略，使用 package runtime 内单 timer 按设备本地时间和星期触发 companion `service.restart`，不依赖 cron 或 worker。

服务、网络、应用、批量订阅刷新与 generation 回滚等异步动作都会等待 operation 终态，后台失败不会被 UI 误报为成功。

## 目录

- `src/`：React UI 与同源 Manager/Controller 客户端；
- `compiler/`：权威 profile compiler 和 one-shot Script runner 协议；
- `package/`：circud package 后端；
- `openwrt/`：companion OpenWrt package、procd、hotplug、fw4 include；
- `tests/`：Vitest、Node package tests 与 Playwright；
- `api.md`：Manager API 和 bridge 契约。

项目不会直接部署为 Mihomo `external-ui`，也不会让浏览器直连任意 Controller。标准 Mihomo API 仍由同源 `/controller/*` bridge 提供；服务、profile、generation 和网络接管一律走 Manager API。

生产设置页不提供绕开 Manager 的完整 YAML `PUT /configs`、Mihomo 自更新或 `external-ui` 更新入口。完整配置必须进入 profile repository，经 preview 和原子 generation 应用；服务重启必须走 companion/procd。标准 Controller 的模式、节点、provider、连接、日志与明确标注为临时态的运行参数仍由同源 bridge 操作。
