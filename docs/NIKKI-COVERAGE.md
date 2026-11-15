# Nikki 功能覆盖矩阵

核对日期：2026-11-16。参考基线为 Nikki 当前仓库的 README 及
`luci-app-nikki` 中 `app.js`、`profile.js`、`mixin.js`、`proxy.js`、
`editor.js`、`log.js`，并核对 `nikki.conf` 与透明代理实现。本文只比较
OpenWrt Mihomo 管理主路径，不把 LuCI 表单结构当成功能要求。

## 核心能力

| Nikki 能力                         | 本项目状态   | 实现与证据                                                                                                                                          |
| ---------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redirect / TPROXY / TUN，IPv4/IPv6 | 已实现       | Manager 网络契约、companion 双重校验、firewall4/nftables、TUN route/fwmark ownership journal、fail-open；OpenWrt integration 覆盖应用、清理和回滚。 |
| Router/LAN 访问控制                | 已实现       | Router/LAN 独立代理与 DNS 开关、来源 IPv4/IPv6 CIDR、LAN 入站接口；ACL 同时约束代理和 DNS。                                                         |
| 端口与绕过策略                     | 已实现       | TCP/UDP 目标端口、DSCP、FWMark/mask、保留地址、中国大陆绕过、Fake-IP 例外与 Ping 接管。                                                             |
| Profile 管理与编辑                 | 更强机制替代 | 服务端 CRUD、排序、URL 抓取、原文编辑、不可变 revision、历史恢复、预览、原子 generation 应用和回滚；不是直接编辑运行目录文件。                      |
| Profile Mixin                      | 更强机制替代 | 全局与 profile 增强、可复用 Merge/Seq/Script 资源、有序引用、CAS；Script 在一次性原生 `CNO.Sandbox` 中执行。                                        |
| Scheduled Restart                  | 已实现       | revisioned `service.schedule`，本地时间和星期选择，package 单 timer，触发 `service.restart` operation；无 cron/worker。                             |

## 订阅管理

| Nikki 能力                                    | 本项目状态   | 实现与差异                                                                                                      |
| --------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| 名称、URL、信息 URL、User-Agent、remote/local | 已实现       | 字段等价；URL 在服务端校验为无凭据、无 fragment 的 HTTP/HTTPS。                                                 |
| 用量、总量、到期时间、更新时间                | 已实现       | 解析 `Subscription-Userinfo`，显示 used/total/remaining/expire；独立信息端点失败不阻断 YAML。                   |
| 手动更新                                      | 已实现并扩展 | 单个、选中、全部刷新；批量逐项结果和部分失败提示；未关联项在联网前拒绝。                                        |
| 后台定时更新                                  | 扩展实现     | 每订阅 interval，设备端单 timer，package reload 后恢复；不依赖浏览器，不自动应用配置。                          |
| 条件请求和无变化处理                          | 扩展实现     | ETag、Last-Modified、304 和相同正文不新增 profile revision。                                                    |
| 订阅作为启动配置                              | 更强机制替代 | 订阅关联 profile；远端优先会在 preview/apply 前条件刷新，失败明确回退最后成功版本，CAS 阻止应用未预览的新正文。 |
| 订阅导入                                      | 扩展实现     | 先抓取并验证 Mihomo YAML，再用一次原子 repository commit 创建 subscription/profile 对。                         |

## 常用及高级 Mihomo 配置

结构化高级配置写入普通 Merge 混入，未展示键保持原样；用户始终可以切换到
YAML 原文编辑。左侧“`Mihomo 设置`”是一等入口，直接编辑全局 Merge；启停时
保留内容，保存前校验 YAML，并使用 revision CAS 防止覆盖其他会话。当前覆盖
Nikki 常用项：

- 模式、日志级别、进程匹配、出站接口、IPv6、统一延迟、TCP 并发与 Keepalive；
- HTTP、SOCKS、mixed 入站、监听地址、LAN 监听和认证；
- 全局 User-Agent、TLS 指纹、GeoX ETag 与 Geosite matcher；
- DNS 开关、IPv6、Fake-IP/redir-host、缓存算法、Fake-IP 范围/TTL/filter、
  default/nameserver/proxy/direct/fallback、fallback filter、nameserver policy、Hosts；
- Sniffer 总开关、DNS mapping、纯 IP、force/skip domain，以及 HTTP/TLS/QUIC
  端口、源/目标地址跳过与 override destination；
- 节点选择/Fake-IP 缓存、GeoData loader、GeoX URL 与自动更新；
- Rule Provider 映射，以及独立可排序的 rules/proxies/proxy-groups Seq 混入。

Redirect/TPROXY 端口、DNS listener、Controller/Secret 和 TUN 路由字段由
Manager runtime overlay 固定或生成，防止 profile 与 companion 网络所有权分裂。
修改 TUN 或 Fake-IP runtime 字段后，Manager 会重新编译并原子应用当前 profile；
仅修改 ACL、端口、绕过与 Ping 接管时，则在透明代理已启用的情况下重新协调网络。
没有活动 profile 时可以先保存设置，但必须先在“配置”页预览并应用，才能启用接管。

## 运行面板

现代化 Web UI 通过同源 Controller bridge 提供运行状态、流量/内存、代理组选择与
测速、provider 更新与健康检查、规则、活动/最近连接、关闭连接、实时日志、运行
设置、连通性诊断和维护操作。Controller Secret 不进入浏览器。

## 有意不迁移

下列能力不是路由器 Mihomo 管理主路径，或会破坏本项目的所有权/安全边界：

- LuCI 技术栈及 UCI 表单本身；
- 任意 procd rlimit、环境变量、启动延迟和 `core_only`；
- 按用户、组、cgroup 或 MAC 枚举的 LuCI 动态选择器；当前使用明确 CIDR/接口 ACL；
- 任意文件路径编辑、运行目录文件编辑和 external-controller/Secret/TLS 暴露；
- 后端日志文件定时清理；UI 管理 Mihomo 实时日志缓冲，companion 不制造高增长应用日志；
- 下载并替换第三方 dashboard；本 UI 作为 circud package 静态资源原子升级；
- WebDAV 全目录备份、桌面系统代理、托盘和全局快捷键。

这些排除项不影响 Nikki README 定义的透明代理、访问控制、Profile Mixin、
Profile Editor 和 Scheduled Restart 五项核心能力。
