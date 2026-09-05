# dsh-im-ops（运维 fork）

本仓库是 [`@xmanrui/dsh-im@4.9.1`](https://github.com/xmanrui/dsh-im) 的 **完整 fork**（九渠道 + AI Office 均保留），用于 Netx / 运维场景下自控：

- 访问控制（入站白名单 / 群策略）
- 会话策略（群聊按发言人拆分 Session，可配置）
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
dsh plugin --profile web add -w "github:hansjone/dsh-im-ops"
# 或本地：dsh plugin --profile web add -w "D:\project\chatgpt\dsh-im-ops"
# 重启 dsh web
```

包名：`dsh-im-ops@4.9.1-ops.3`（cordis id：`dsh-im-ops`）。

扫码态一般仍在 `~/.dsh/integrations/…`；换包后若异常，在 IM 设置里重新关联设备。

## 已落地的运维改动

1. **群 Session 策略**（对齐 oclaw `user_in_chat`）
   - 默认：`user_in_chat` → 群会话 key 为 `group:<chatId>:user:<senderId>`
   - 可选：`chat` → 整群共享 `group:<chatId>`（上游行为）
   - 在「访问设置」页可改；RPC：`bot.group-session-scope.set`
   - 当前对 **WhatsApp / Telegram / Slack / Discord**（TextHarness 路径）生效；其它渠道的同策略接线后续补齐

2. **访问控制**仍由本 fork 持久化（`workspaces.json` 的 `accessPolicies`），设置 UI 与上游同构，运维可直接改白名单 / open 模式

3. **WhatsApp LID**：群参与者常为不透明 `@lid`，白名单只填手机号时会被静默拒绝。`4.9.1-ops.3` 用 Baileys LID→PN 映射扩展 sender 别名，并在 @ 提及匹配时同样解析；若仍被拒绝会回一句白名单提示

4. **主动群通告**继续用既有 delivery（`botId + targetId`），与入站 Session 策略独立

## 同步上游

```powershell
git fetch upstream --tags
git merge v4.9.x   # 或 cherry-pick；冲突自行解决后再 build
```

改源码后务必 `npm run build` 并推送含 `lib/` 的提交，否则 GitHub 安装会加载过期 bundle。
