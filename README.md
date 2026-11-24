# qq-content-toolkit · 让 QQ 机器人会干活

在 [DeepSeek Harness](https://github.com/deepseek-ai) + [qq-bridge](https://github.com/Derpyu520/qq-bridge) 上跑出来的
一套 **MCP 工具集**：**61 个工具**，把 agent 从"会聊天"变成"能干活"。

bridge 管「什么时候说话」，这套东西管「说完能做什么」。

---

## 里面有什么

```
code/                  MCP server 本体 + 15 个 python 脚本
  server.mjs           61 个工具的注册与实现
  chart_gen.py         数据图表（matplotlib）
  office_fill.py       Word/Excel 模板填表
  office_make.py       PPTX/DOCX 生成引擎
  doc_extract.py       pdf/docx/xlsx 文本抽取
  memory.mjs           记忆 LOD 读写
  doujin.mjs booru.mjs 图源适配
  …（其余见目录）

SKILL.md               给 agent 看的操作指南（放进 ~/.agents/skills/ 自动加载）
config.example.json    配置模板
```

---

## 能干什么

| 分类 | 工具 |
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

每个工具的参数、什么时候该用、什么时候不该用，都写在 [SKILL.md](SKILL.md)。

---

## 安装

**前提**：已经跑通 `QQ → SnowLuma(OneBot) → qq-bridge → DSH`。
怎么搭见 [qq-bridge 的 README](https://github.com/Derpyu520/qq-bridge)。

```bash
git clone https://github.com/S1lencelll/Dafeiyu-skill.git
cd Dafeiyu-skill/code
npm install                                  # 只有一个依赖 undici

pip install matplotlib python-docx openpyxl python-pptx Pillow
# 还需要 ffmpeg（视频抽帧、音频转码）
```

在 DSH profile 里注册：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: mcp-qq-content
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qq-content
        transport: stdio
        command: 'node'
        args: ['/绝对路径/Dafeiyu-skill/code/server.mjs']
        toolCallTimeoutMs: 725000
```

重启 DSH，验证：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node code/server.mjs
# 期望 result.tools 里有 61 个
```

---

## 配置

工具不需要自己的配置文件——**OneBot 端点直接用 qq-bridge 的 `config.json`**（默认找同级 `../qq-bridge/`，
可用环境变量 `QQ_BRIDGE_CONFIG` 指到别处）。

它只额外读这几个**可选**文件（不放也能跑，对应功能不亮）：

| 文件 | 用途 |
|---|---|
| `imagegen.json` | AI 画图供应商（默认 Pollinations 免费通道） |
| `gemini.json` | Gemini TTS 音色（需要能访问 Google） |
| `pixivic.json` | pixivic 镜像 token |
| `bili-account.json` | B站登录态（`bili_login` 扫码后自动生成） |

模板见 [config.example.json](config.example.json)。**这些文件都在 `.gitignore` 里，不会被误提交。**

---

## 路径约定

代码里**没有写死部署位置**：

```js
const ROOT = dirname(fileURLToPath(import.meta.url));   // 本文件所在目录
const BRIDGE_CONFIG = process.env.QQ_BRIDGE_CONFIG || joinPath(ROOT, '..', 'qq-bridge', 'config.json');
const PY = process.env.QQ_CONTENT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
```

数据目录（`memory/`、`diary/`、`gen/`、`doc-tmp/`）都相对 `ROOT` 自动创建。
换机器、换目录都不用改代码。

---

## 三个值得抄的设计

**1. 工具描述里必须写"什么时候别用"**
不只写参数，还要写失败模式。比如图表工具的描述末尾是：

> 严禁用 `image_generate` 画数据图表；返回后必须消化成 1 句简短回复点出核心结论，禁止输出 JSON 原文。

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

## 关于人设

这个仓库**只提供工具能力**，不含角色设定、称呼、语气规范。
工具返回语都是中性的（"用简短口语点评"），怎么说话由你自己的 preset 决定。

---

## 许可

代码与文档 MIT（[LICENSE](LICENSE)）。依赖的上游项目各自遵循其许可。
