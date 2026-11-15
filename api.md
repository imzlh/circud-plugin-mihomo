# io.cno.mihomo API

所有路径都位于 circud package scope `/io.cno.mihomo`。业务 API 的稳定版本根为 `/io.cno.mihomo/api/v1`；标准 Mihomo API 由 `/io.cno.mihomo/controller` 同源桥接。

## 通用规则

- 每个业务请求都要求 `event.isAuthorized === true`，否则返回 401。
- `POST`、`PUT`、`PATCH`、`DELETE` 还要求同源 `Origin` 和 `X-CNO-Mihomo-Request: 1`，否则返回 403。
- 成功 envelope：`{"ok":true,"result":...}`。
- 失败 envelope：`{"ok":false,"error":{"code":"...","message":"...","details":...}}`。
- Manager 响应使用 `Cache-Control: no-store`。
- 旧 `/api/*` 路径不存在；只有 `/api/v1/*` 是稳定接口。
- 浏览器不能读取或写入 Controller URL/Secret。Controller 固定 loopback，Secret 仅由服务端读取。

## 状态与操作

### `GET /api/v1/status`

组合 companion 状态与 Mihomo `/version` 探测：

```json
{
  "ok": true,
  "result": {
    "service": { "enabled": true, "state": "running", "pid": 1234 },
    "controller": { "reachable": true, "version": "v1.19.15" },
    "config": {
      "state": "active",
      "activeProfileId": "main",
      "activeRevision": 3,
      "generationId": "g-...",
      "sha256": "...",
      "appliedAt": 1794737000000
    },
    "network": {
      "state": "active",
      "desired": true,
      "tcpMode": "redirect",
      "udpMode": "tproxy",
      "ipv4": true,
      "ipv6": false
    }
  }
}
```

companion 未安装或不可用时返回 502，但 package runtime 和静态 UI 保持可用。

### `GET /api/v1/operations`

返回有界的进程内异步操作快照。

### `GET /api/v1/operations/{id}`

读取一项操作；不存在返回 404。

前端不得把 HTTP 202 当作操作成功；必须读取此端点直到 `state` 为 `succeeded` 或 `failed`。当前 UI 会保持按钮忙碌状态并展示后台失败原因。

### `GET /api/v1/capabilities`

返回 companion 协议版本、控制 verb、原子 generation、回滚、网络 ownership journal、fail-open 和 procd supervision 能力。用于在 UI 中显式禁用宿主不支持的动作。

### `GET /api/v1/events`

打开 SSE。事件包括操作开始/完成和 profile、subscription、network 设置变更。事件 sequence 只在当前 package runtime 内单调，reload 后客户端必须重新读取状态。

## 服务与网络

### `POST /api/v1/service/{start|reload|restart|stop}`

立即返回 HTTP 202 和 `{operationId}`。只有显式 `stop` 会先撤销网络接管再停止 Mihomo；package/daemon reload 不执行该路径。

### `GET|PUT /api/v1/service/schedule`

管理设备端定时重启策略。GET 返回 `{revision,config}`；PUT 使用
`{expectedRevision,config}` CAS。配置形状为：

```json
{
  "enabled": true,
  "time": "03:00",
  "days": [0, 1, 2, 3, 4, 5, 6]
}
```

`time` 使用设备本地时区的 24 小时 `HH:MM`，`days` 为星期日到星期六的
`0..6`。package runtime 只维护一个 timer；触发时创建
`service.scheduled-restart` operation 并经 companion/procd 调用
`service.restart`，不使用 cron 或 worker。

### `GET /api/v1/network`

返回 `{config,revision}`。未配置时 revision 为 0。

### `PUT /api/v1/network`

请求：

```json
{
  "expectedRevision": 2,
  "config": {
    "tcpMode": "redirect",
    "udpMode": "tproxy",
    "ipv4": true,
    "ipv6": false,
    "router": { "proxy": false, "dns": false },
    "lan": { "proxy": true, "dns": false },
    "bypassReserved": true,
    "bypassCn": false,
    "routerAcl": [],
    "lanAcl": [],
    "lanInterfaces": ["br-lan"],
    "tcpPorts": ["0-65535"],
    "udpPorts": ["0-65535"],
    "bypassDscp": [4],
    "bypassMarks": ["0x80/0xff"],
    "reservedCidrs": ["10.0.0.0/8", "fc00::/7"],
    "fakeIp": {
      "pingHijack": true,
      "ipv4Range": "198.18.0.1/16",
      "ipv6Range": "fc00::/18"
    },
    "tun": {
      "device": "mihomo",
      "stack": "mixed",
      "mtu": 9000,
      "gso": true
    }
  }
}
```

只保存期望配置，不自动启用网络。revision 不匹配返回 409 `network_revision_conflict`。

`tcpMode` 支持 `redirect|tproxy|tun`，`udpMode` 支持 `tproxy|tun`；TUN 必须同时用于 TCP/UDP。`routerAcl` 和 `lanAcl` 是去重后的 IPv4/IPv6 CIDR 列表，空列表表示该范围内全部源地址。LAN 接口、TCP/UDP 端口集合、DSCP、FWMark/mask、自定义保留地址与 Fake-IP Ping 均由 nftables 规则执行；Fake-IP 范围同时覆盖最终 Mihomo DNS 配置。API 在保存时校验 mode、CIDR、端口、mark、TUN 设备名、stack 和 MTU，companion 在特权边界再次校验。

### `POST /api/v1/network/{enable|disable|reconcile}`

异步操作，返回 202。`enable` 才会显式接管；失败时 companion fail-open。`enable` 与 `reconcile` 会把 Manager repository 中当前保存的完整网络配置传给 companion，UI 中选择的 TCP/UDP 模式和流量范围因此是权威输入。

### `POST /api/v1/generation/rollback`

异步回滚到 `status.config.previousGenerationId`。请求被 companion 的 active-generation CAS 保护；没有上一代时失败，UI 不会启用按钮。

## Profile repository

### `GET /api/v1/profiles`

返回按 position 排序的摘要。

### `POST /api/v1/profiles`

创建 profile，至少包含 `name` 和 `content`。YAML 最大 5 MiB。

### `GET /api/v1/profiles/{id}`

返回当前 active revision 及 YAML 原文。

### `PUT /api/v1/profiles/{id}`

更新并创建不可变的新 revision。必须提交 `expectedRevision`；冲突返回 409 `profile_revision_conflict` 和当前 revision。

### `DELETE /api/v1/profiles/{id}`

请求体包含 `expectedRevision`。

### `POST|PUT /api/v1/profiles/reorder`

请求 `{ids:[...]}`，必须恰好包含当前全部 profile ID。

### `GET /api/v1/profiles/{id}/revisions`

返回 revision、创建时间和内容字节数。

### `GET|POST /api/v1/profiles/{id}/revisions/{revision}`

GET 读取历史 revision；POST 将其设为 active。之后再次编辑仍会分配大于所有历史值的新 revision。

### `POST /api/v1/profiles/fetch`

服务端获取 HTTP/HTTPS YAML，最大 5 MiB，最多跟随 3 次 redirect。

### `POST /api/v1/profiles/{id}/preview`

请求 `{expectedRevision}`。返回 `profileId`、`profileRevision`、`compilerRevision`、`contentHash`、最终 `content`、`logs`、`stages` 和可选 `subscriptionRefresh`。若 profile 关联 `remote` 策略订阅，预览前先做条件刷新；远端失败时使用最后成功 revision，并在 `subscriptionRefresh` 返回明确 fallback 信息。

### `POST /api/v1/profiles/{id}/apply`

请求 `{expectedRevision,options?}`，返回 HTTP 202 `{operationId}`。编译后的 YAML 通过 companion 的原子 generation 流程应用。

## 全局增强

### `GET /api/v1/enhancement/global`

返回 `{revision,enhancement}`。

### `PUT /api/v1/enhancement/global`

请求 `{expectedRevision,enhancement}`。冲突返回 409 `enhancement_revision_conflict`。

Merge/Seq 在权威 compiler 内执行。Script 使用一次性 CNO helper 和每次新建的原生 `CNO.Sandbox`，不向脚本提供网络、文件或 Deno namespace，也不会回退到主 package runtime 执行。

## 可复用混入

- `GET|POST /api/v1/mixins`
- `GET|PUT|DELETE /api/v1/mixins/{id}`

资源类型为 `merge`、`seq` 或 `script`；Seq 还必须指定 `rules|proxies|groups` target。更新与删除使用 `expectedRevision` CAS。profile 的 `mixins` 字段保存有序 `{id,enabled}` 引用；编辑混入会推进所有引用 profile 的 revision，删除时原子清理全部引用，旧预览因此不能静默采用新内容。

## 订阅

- `GET|POST /api/v1/subscriptions`
- `GET|PUT|DELETE /api/v1/subscriptions/{id}`
- `POST /api/v1/subscriptions/import`
- `POST /api/v1/subscriptions/refresh`
- `POST /api/v1/subscriptions/{id}/refresh`

subscription 同样使用 revision CAS。主要字段为 `name`、`url`、`infoUrl`、`userAgent`、`prefer`、`updateIntervalMinutes` 和 `profileId`。`prefer` 为 `remote|local`；一个 profile 最多关联一个 subscription。`/import` 先抓取并校验 YAML，再原子创建 subscription/profile 对；`/refresh` 接受可选 `{ids:[...]}`，作为有界后台 operation 顺序刷新选中项。

只有已关联 profile 的 subscription 可以刷新。单项未关联刷新会在联网前返回
409 `subscription_profile_unlinked`；“刷新全部”和设备调度器也会跳过未关联项。
批量 operation 的 result 包含 `total`、`succeeded`、`failed` 与逐项
`results`，因此部分失败不会被 UI 当作全成功。

刷新使用已保存的 ETag/Last-Modified 做条件请求；304 或完全相同正文不创建 profile revision。独立 `infoUrl` 只用于读取 `Subscription-Userinfo`，失败会记录 `metadata.infoError`，但不阻断有效 YAML。正文刷新错误被截断并记录，不会覆盖最后成功 YAML。

生产 UI 提供创建、原子导入、关联/解除、更换配置、编辑、单个/选中/全部刷新和删除。刷新永不自动 apply，新 revision 必须再次预览并由用户确认应用。

订阅 URL 只接受无 userinfo、无 fragment 的 HTTP/HTTPS 地址。设备端调度器只维护一个 timer，按持久化 interval 和最后刷新时间计算到期项；package 重启后重算，浏览器关闭不影响它。调度刷新只保存 revision，不自动应用或启用网络。

## Controller bridge

`/io.cno.mihomo/controller/*` 保留 Mihomo method、query、body 和安全响应 header，但：

- 目标始终为 `http://127.0.0.1:9090`；
- 后端按需注入 `Authorization: Bearer ...`；
- 浏览器传入的 Authorization、Cookie、circud CSRF 和 hop-by-hop header 不转发；
- 不跟随 Controller redirect；
- Secret 永不出现在 bridge URL 或 WebSocket query。

实时 WebSocket 路径固定为 `traffic`、`memory`、`connections`、`logs`。package 将 Mihomo newline-delimited streaming HTTP 转成 WebSocket text frame；未知升级路径以 code 1008 关闭。

## 静态 UI

- `GET|HEAD /io.cno.mihomo/`：`static/index.html`；
- `/assets/*` 与 `/favicon.svg`：仅安全的包内文件；
- 其他 GET/HEAD：Hash Router fallback；
- 其他 method：405。
