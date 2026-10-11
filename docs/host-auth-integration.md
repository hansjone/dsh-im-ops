# Host 认证集成与排错 / Host authentication integration

`dsh-im-ops 4.9.1-ops.38` 与 `uds-auth 0.2.21` 配合时，同 Host 的机器人 RPC、事件流迭代和命令调用使用 `udsAuth.runAsHost(callback)`。该可选服务只向进程内插件开放，不增加 HTTP 或 Connection RPC 端点。回调期间 UDS 用户上下文为 `undefined`，符合 UDS 已有的 Host 后台调用规则；调用结束后恢复原网页身份。网页未登录请求和普通用户工作区权限继续由 UDS ACL 检查，后台会话不继承网页用户所有者。

没有安装 `uds-auth` 时无需配置。认证插件晚于 IM 就绪或重载后，IM 每次调用都会重新查找服务。显式配置 `harnessBaseUrl` 的远程 HTTP 连接继续使用远程 Host 的访问控制，不使用本机后台回调。

同时更新两个插件，然后重启运行中的 Harness Host。本机开发链接会加载最新源码及重新构建的 `lib/index.js`；复制发布包时也必须包含对应版本的 UDS 服务方法。不要通过关闭网页 ACL 或复用最后一位网页登录用户来解决后台消息处理问题。

`HARNESS_LOGIN_REQUIRED` 表示认证插件要求登录，`HARNESS_ACCESS` 表示访问被拒绝。这两类错误保留已有聊天绑定。`WORKSPACE_UNAVAILABLE` 和 `PRESET_UNAVAILABLE` 表示明确的工作区与预设错误；`SESSION_CREATE` 表示尚未细分的建会话失败，应根据参考号检查 Host 日志，不能仅凭该错误码判定目录无效。模型选择发生在创建 Session 之后，只有模型阶段的错误才能证明是模型问题。

本机诊断文件位于 `%USERPROFILE%\.dsh\integrations\dsh-im-ops\last-message-failure.json`（Linux/macOS 为 `~/.dsh/integrations/dsh-im-ops/last-message-failure.json`）。核对 `referenceId`、`method`、`messages` 与 `details.udsError`；文件包含本机路径等诊断信息，分享前检查内容。旧版本的 `internal` 加“登录后才能创建会话”也会识别为认证问题。只有明确的 `agent-preset/*` / `agent-preset-*` 错误允许去掉预设重试一次，通用错误不触发改预设重试。

## English

With `uds-auth 0.2.21`, `dsh-im-ops 4.9.1-ops.38` runs same-Host bot RPCs, event iterator operations, and commands through the optional `udsAuth.runAsHost(callback)` service. The callback clears only the UDS browser identity for trusted in-process operations and restores the caller afterward. This service adds no remote endpoint. Browser login checks and user workspace ACLs remain active; background Sessions do not inherit a browser owner.

Update both plugins and restart the Harness Host. Hosts without UDS need no additional setup. Service lookup happens on every call to support late initialization and reload. Explicit `harnessBaseUrl` connections retain remote access controls and do not use the local callback. Distribute the rebuilt IM bundle and the matching UDS implementation together when both plugins are installed.

`HARNESS_LOGIN_REQUIRED` and `HARNESS_ACCESS` preserve existing chat bindings. Inspect the matching reference ID in the local diagnostic file and Host logs before treating a generic `SESSION_CREATE` error as a workspace problem. Model selection occurs after Session creation. Only explicit preset errors permit a retry without the preset; generic, authentication, and transport errors do not.
