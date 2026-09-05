# dsh-im-ops（运维 fork）

本仓库是 [`@xmanrui/dsh-im@4.9.1`](https://github.com/xmanrui/dsh-im) 的 **完整 fork**（九渠道 + AI Office 均保留），用于 Netx / 运维场景下自控：

- 访问控制（入站白名单 / 群策略）
- 会话策略（例如群聊拆个人 Session）
- 通告 / 投递默认与文案

上游 remote 名为 `upstream`。不要与社区包 `@xmanrui/dsh-im` 同时装进同一 profile。

## 与已删除的薄壳 `ops-im` 的关系

曾尝试只做 `ops_im__send` 适配层；因 **入站权限/会话仍在 dsh-im**，无法满足所有权诉求，已删除该薄仓库，改为本 fork。

## 安装（替换社区 im）

```powershell
# 若已安装社区包，先从 profile 移除 @xmanrui/dsh-im
cd D:\project\chatgpt\dsh-im-ops
npm install
npm run build
dsh plugin --profile web add -w "D:\project\chatgpt\dsh-im-ops"
# 重启 dsh web
```

包名：`dsh-im-ops@4.9.1-ops.0`（cordis id：`dsh-im-ops`）。

扫码态一般仍在 `~/.dsh/integrations/…`；换包后若异常，在 IM 设置里重新关联设备。

## 第一刀改动方向（尚未改业务逻辑）

1. WhatsApp / 通用 access mode：运维友好的默认与设置文案  
2. 群 Session key：对齐 oclaw `user_in_chat`（可配置）  
3. 投递默认目标 / 与 netxops 协作说明  

业务改动前先 `npm run build` 冒烟扫码与私聊。

## 同步上游

```powershell
git fetch upstream --tags
git merge v4.9.x   # 或 cherry-pick；冲突自行解决后再 build
```
