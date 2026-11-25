---
name: echomind-import-audio
description: 将手机录音、录音笔文件或导出的会议音视频导入 EchoMind 本地工作区，按面对面或线上场景执行离线转写、说话人分离与纪要提取。
---

# 导入本地音频并生成会议纪要

## 适用场景
当用户提供本地 `.wav` / `.m4a` / `.mp3` / `.flac` / `.ogg` / `.mp4` 会议录音文件路径，希望转写并整理纪要与待办时触发。

## 标准步骤
1. **检查转写环境**：调用 `echomind_status` 确认本机转写模块、语音模型和飞书账户状态。
2. **执行音频导入**：调用 `echomind_import_audio` 传入 `filePath`、可选 `title`、`source`（默认 `offline`）、`scene`（默认 `in-person`）与可选参会人数 `speakers`。
3. **跟踪处理与后续核对**：导入成功后，告知用户已转换为标准分段录音并自动进入离线转写与 DeepSeek 纪要流水线；若模型缺失则提示在设置页下载约 200 MB 离线模型；完成后调用 `echomind_get_meeting` 与 `echomind_stage_todo_push` 进入核对与推送流程。
