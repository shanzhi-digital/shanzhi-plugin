---
name: echomind-review-and-push
description: 会后审阅 EchoMind 会议纪要与待办草稿、校对未命名说话人、核对负责人与截止日期，并生成交互式确认卡片由用户确认推送飞书任务。
---

# 会后校对纪要并推送飞书待办

## 适用场景
当用户要求「整理刚才那场会的纪要」「把会议待办发到飞书」「帮我核对一下负责人」「把说话人 2 改成李四」时触发。

## 标准步骤
1. **读取会议详情**：先调用 `echomind_list_meetings` 定位目标会议，再调用 `echomind_get_meeting` 查看结构化概要、议题、结论、决定、待议问题、说话人列表与待办草稿。
2. **校对未命名说话人**：如果存在未关联人员的说话人（如「说话人 2」），按需调用 `echomind_search_transcript` 查看其代表性发言并询问用户真实姓名；用户确认后调用 `echomind_process_meeting(action="rename_speaker")` 改名（若用户希望同步记住声纹，提示用户在会议详情面板勾选「记住声音」触发飞书本人同意卡片）。
3. **重分或重跑纪要**：若面对面/线上场景判断有误或人数不对，先询问实际人数并调用 `echomind_process_meeting(action="rediarize", scene=..., speakers=...)`；若仅修改了说话人姓名想刷新纪要，调用 `echomind_process_meeting(action="regenerate_minutes")`。
4. **暂存推送确认卡**：核对待办标题、负责人和截止日期（不确定时留空并标明待定，不得编造），随后调用 `echomind_stage_todo_push` 生成对话内「待办确认并推送飞书」卡片。
5. **安全边界**：绝不宣称飞书任务已创建，明确请用户在下方卡片核对勾选后点击「确认并推送到飞书」；同时提醒用户可在卡片底部查看或切换 DataHub「放进知识库」同步状态。
