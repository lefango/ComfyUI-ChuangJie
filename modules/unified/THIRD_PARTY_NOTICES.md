# 第三方来源

GGUF 加载核心源自 [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF)。

- 固定提交：`6ea2651e7df66d7585f6ffee804b20e92fb38b8a`
- 许可：Apache License 2.0，完整文本见 `model/vendor/gguf_core/LICENSE`。
- 保留上游 loader.py、ops.py、dequant.py、nodes.py 的作者标识。
- 本地修改：nodes.py 禁用两个全局模型目录注册调用；该文件中的类仅通过本插件的私有路径解析适配器使用，不向 ComfyUI 注册上游节点类。
- 原始文件 SHA-256 和修改说明：`model/vendor/upstream.json`。安装包文件的实际校验值由交付清单记录。

本插件的界面、资料库、稳定端口、任务拆分及加载适配与项目其他独立模块分别维护。`gguf`、`sentencepiece`、`protobuf` 等运行依赖按其各自许可分发，不把外部 Python 环境或模型权重打入安装包。

临时版内部复用本项目模型加载 0.2.1 和 LoRA 管理器 0.2.1 的引擎与资料管理代码。修改限于独立命名空间、Checkpoint 按需输出、LoRA 管理器嵌入和一体节点适配。原模块源码未改动；开发基线哈希保存在临时模块 `.runtime/original-source-hashes.json`，不随安装包分发。
