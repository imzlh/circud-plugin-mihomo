# io.cno.mihomo package

这是 circud package 后端源码。开发入口 `management.js` 与 `lib/` 保持领域化 ESM 模块；生产构建将整个后端图和 YAML 依赖压缩为 `management.bundle.min.js`，ZIP 只交付该入口、`meta.json` 和 Vite 的 `static/`。circud 支持直接加载源码图，bundle 仅用于依赖自包含和生产体积优化，不是加载器限制。

- prefix：`/io.cno.mihomo`
- Manager API：`/io.cno.mihomo/api/v1/*`
- Mihomo REST bridge：`/io.cno.mihomo/controller/*`
- 实时 WebSocket bridge：`/io.cno.mihomo/controller/{traffic,memory,connections,logs}`

Controller 固定为 `http://127.0.0.1:9090`。Secret 从 `/etc/io.cno.mihomo/controller.secret` 读取，永不返回浏览器；不存在浏览器可写的 Controller 配置端点。所有路由要求 `event.isAuthorized`，写请求额外校验同源 `Origin` 和 `X-CNO-Mihomo-Request: 1`。

Profile、不可变 revision、订阅和设置存储在 package `dataDir/profiles.json`。每次修改先克隆内存状态，写入有界临时文件并 rename，成功后才提交内存状态。采用 JSON repository 是为了避开当前宿主 `sqlite3.exec/prepare` 缺少 capability resource 的限制，不需要扩大 package 权限。

服务和网络动作只调用固定 `/usr/sbin/cno-mihomoctl`。action 是白名单 argv，输入输出为有界 JSON，无 shell。入口在调用 native spawn 前检查 helper 是否存在，未安装 companion 时返回稳定 502，不会导致 package runtime 退出。

四个实时端点使用 libcjs curl 连接 Mihomo 的 newline-delimited HTTP stream，再映射成 circud WebSocket text frame，因此不要求 curl 模块自身提供 WebSocket client。
