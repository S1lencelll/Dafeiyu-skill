# qq-content-toolkit · 一份 QQ 机器人工具层的地图

在 [DeepSeek Harness](https://github.com/deepseek-ai) + [qq-bridge](https://github.com/Derpyu520/qq-bridge) 上跑了几个月 QQ 机器人，
把「除了聊天还能干什么」这件事整理成了一份 **agent skill**。

**这个仓库只有文档，没有实现代码。** 分享的是：
63 个工具各自该怎么设计、参数怎么定、提示词怎么写才不会乱调用，以及一路踩过的坑。

---

## 里面有什么

| 文件 | 给谁看 | 内容 |
|---|---|---|
| **[SKILL.md](SKILL.md)** | **agent** | 完整的操作指南：工具地图（按"你想干什么"查）、五个复杂工具的用法、8 个坑、验证清单。放进 `~/.agents/skills/` 后，agent 遇到相关问题会自动加载 |
| **[config.example.json](config.example.json)** | 人 | 配置模板（OneBot 端点、可选的外部 API） |

`SKILL.md` 开头的 frontmatter 写了详细触发词，覆盖：
「机器人能干什么」「加个查 B 站的功能」「怎么让它做 PPT」「画个柱状图」
「帮我填这个表」「今天有啥课」「WBG 赛程」「识别这张图是哪个番」「视频讲了什么」。

---

## 覆盖了什么能力

| 分类 | 能力 |
|---|---|
| **B站** | 搜视频/专栏 · 读专栏全文 · 推荐 · 动态 · 回评论 · 私信 |
| **图片表情** | 收藏表情管理 · 发表情 · 偷表情 · 图库 · 随机图 · 搜网图 · AI 画图 · 梗图加字 |
| **Pixiv / 本子** | 搜图（官方 + 镜像） · 搜本子并发送 |
| **音乐** | 搜歌 · 点歌发语音 · 歌词 · 歌单 |
| **记忆** | LOD 三层读写（总纲/主题/细节） · 跨会话聊天检索 |
| **搜索网页** | 多引擎搜索 · 抓正文 · 链接/BV号解析 · 站点搜索 |
| **干活** | 做 PPT（13 种版式） · 数据图表（4 型） · Word/Excel 模板填表 · 读 pdf/docx/xlsx |
| **QQ 社交** | 短语音 · 定时提醒 · 空间动态 · 媒体解析（文件补后缀 / 图片取公网 URL） |
| **日常** | 课表与 DDL · 电竞赛程 · 运势骰子 · 热搜梗 · 识番 · 查漫画 · 视频抽帧与转写 |

---

## 前提

这份文档假设你已经有：

```
QQ → SnowLuma（OneBot）→ qq-bridge → DSH
```

这条链路。怎么搭见
[qq-bridge-setup](https://github.com/Derpyu520/qq-bridge)（bridge 自己的 README 与 docs 更全）。

要落成代码，需要：

| | 版本 | 用途 |
|---|---|---|
| Node | ≥ 22 | MCP server |
| Python | ≥ 3.10 | 图表 / 填表 / PPT / 文档抽取 |
| ffmpeg | any | 视频抽帧、音频转码 |

Python 包：`matplotlib` `python-docx` `openpyxl` `python-pptx` `Pillow`。

**一个 MCP server 就是 `stdio` 上跑一个 Node 进程**，把工具名单和参数 schema 吐给 DSH 就行，
不需要框架。`SKILL.md` 里每个工具都写了参数形状，照着实现即可。

---

## 怎么用

```bash
# 放进 agent 的 skill 目录，之后遇到相关问题会自动加载
cp -r . ~/.agents/skills/qq-content-toolkit/

# 或者直接把 SKILL.md 丢给 agent 让它读
```

---

## 三个最值得抄的设计

**1. 工具描述里必须写"什么时候别用"**
不只写参数，还要写失败模式。比如图表工具的描述末尾是：

> 严禁用 `image_generate` 画数据图表；返回后必须消化成 1 句短气泡点出核心结论，禁止输出 JSON 原文。

模型会照描述行事。只写"能画图表"的后果是它拿 AI 绘画去画 PPT 里的柱状图——数字全是编的。

**2. 返回给模型的内容要"已消化"，不要原始数据**
工具返回给 agent 的应该是几句人话，不是 JSON dump。
原始数据留给需要它的下游（比如 PPT 生成），不该进上下文烧 token。

**3. 一个工具只管一件事**
`qq_media_resolver` 只负责"把文件/图片变成可用地址"，不做识番；
`chart_generator` 只负责画图，不管排版。合在一起写会让参数变成灾难。

---

## 已知限制

- **电竞赛程**没有稳定数据源（B站电竞接口 404、玩加赛事不可达），只能走搜索兜底，比分可能延迟。
- **AI 画图**默认用 Pollinations 免费通道（有配额）；接商业 API 要自己填 key。
- **PPT 流程图**仍需先画图再嵌，没有原生流程图版式。
- **模板填表**会丢 Word 里占位符跨多个 run 的局部样式（python-docx 固有）。

---

## 许可

文档 MIT（[LICENSE](LICENSE)），随便拿走改。

提到的上游项目各自遵循其许可。
