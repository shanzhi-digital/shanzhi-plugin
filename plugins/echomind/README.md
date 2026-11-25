# @local/echomind（EchoMind 会议纪要助手）

面向小智办公（DeepSeek Harness）的全链路会议纪要插件：在本机完成双轨实时录音（麦克风 = 我，系统声音 = 其他参会人）与离线语音转写、说话人分离及声纹识别，通过 EchoMind 服务端接入飞书与 DeepSeek 生成带出处的结构化纪要和待办草稿，由用户核对确认后推送为飞书任务，并自动同步纪要至 DataHub「会议纪要」知识库。

## 核心特性

- **双轨实时录音与全局浮条**：复用 `echomind-capture`（macOS Core Audio Process Tap / Windows WASAPI Loopback），支持暂停、恢复、重点打标与退出前优雅封盘；录音/转写期间在窗口右下角显示双轨实时电平条，空闲零占用。
- **本机离线转写与声纹隐私保护**：复用 `echomind-transcribe`（Rust + sherpa-onnx：SenseVoice-Small、Silero VAD、pyannote 3.0、3D-Speaker CAM++），音频不出电脑、声纹向量不进前端和模型上下文、同事声纹须本人在飞书同意卡片点击同意。
- **确定性纪要引擎与证据回放**：内置零依赖打包版 `@echomind/minutes-engine`，保留章节覆盖校验、证据引用修复（`seg-xxxx`）、负责人置信度解析与相对截止日期解析；点击任意出处可在会议详情中按时间轴双轨混音播放原声。
- **安全物理隔离**：模型工具只能只读查状态、控录音、导入音频、查纪要、局部检索原话与暂存待办草稿；**推送飞书任务、修改服务器配置、声纹管理与公司管理**仅通过前端卡片与设置页 RPC 经人工点击执行。
- **DSH 工作区与多账户管理**：与 `@local/contract-sure`、`@local/salesforge` 保持一致的多账户飞书浏览器授权交互，会话令牌仅存小智办公凭据库（`0600`）；二进制与模型缓存于 `~/.dsh/storages/echomind/`，录音优先写入当前 DSH 工作区。

## 开发与测试

```bash
# 从 erji 仓库重新打包 minutes-engine + shared
node build/sync-engine.mjs

# 语法校验与全量单元测试（零三方运行时依赖）
node --check client.js && npm test

# 开发联调指定本地原生二进制目录（指向 erji 编译产物）
export ECHOMIND_BIN_DIR=/Users/zhuanzmima0000/Developer/work/erji/apps/desktop/src-tauri/binaries
```

## 本机桌面端安装

```bash
npm pack --ignore-scripts --pack-destination /Users/zhuanzmima0000/Developer/work/plugins
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove @local/echomind
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add /Users/zhuanzmima0000/Developer/work/plugins/local-echomind-0.1.0.tgz
# 按 Cmd + Q 完全退出并重开小智办公客户端生效
```

## 开源与模型许可声明

- 本地语音识别模型采用 **SenseVoice-Small**（FunAudioLLM / 阿里巴巴通义实验室，https://github.com/FunAudioLLM/SenseVoice，FunASR Model Open Source License v1.1）。
- Silero VAD（MIT）、pyannote segmentation-3.0（MIT）、3D-Speaker CAM++（Apache-2.0）、sherpa-onnx（Apache-2.0）。
