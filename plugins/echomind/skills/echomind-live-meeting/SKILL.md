---
name: echomind-live-meeting
description: 引导完成会前录音环境与权限自检、识别正在进行的线上会议软件、开启双轨会议录音、会中打点暂停与会后自动转写生成带出处纪要。
---

# 实时会议录音与会后自动出纪要

## 适用场景
当用户说「帮我开始录这场会」「准备开腾讯会议/飞书会议了」「暂停录音」「标一下重点」「结束录音并整理纪要」时触发。

## 标准步骤
1. **检查状态与运行环境**：先调用 `echomind_status` 查看登录状态、录音/转写二进制与语音模型是否就绪，以及是否已有进行中的录音。
2. **检测权限与会议软件**：开录前调用 `echomind_recording_control(action="check_env")` 检查麦克风/系统录音权限与当前活动会议（腾讯会议、飞书会议、Zoom 等）。若缺少权限或组件，明确给出操作路径（系统设置或「设置 → EchoMind 会议配置」）。
3. **开启录音**：调用 `echomind_recording_control(action="start", title=..., source=...)` 开启双轨录音，告知用户窗口底部已出现实时电平与控制条，切后台开会时录音照常进行，但请勿直接退出小智办公。
4. **会中控制**：按用户指令调用 `echomind_recording_control` 的 `mark`、`pause`、`resume`。
5. **结束与会后处理**：调用 `echomind_recording_control(action="stop")` 后，插件会自动排队执行本机离线转写、声纹匹配、飞书日历参会人关联和 DeepSeek 纪要生成，提醒用户可在进度卡片查看进度；完成后引导调用 `echomind_get_meeting` 审阅纪要与待办。
