---
name: qq-content-toolkit
description: 给 DSH QQ 机器人装一套 61 个工具的 MCP（qq-content）：B站搜索/专栏/动态/三连、图片与表情包、Pixiv 与本子、音乐点播、LOD 记忆、跨会话检索、网页抓取、PPT 生成、数据图表、Word/Excel 模板填表、课表 DDL、电竞赛程、QQ 空间动态、视频抽帧与转写、识番识漫画。用户说「机器人能干什么」「加个查 B 站的功能」「怎么让它做 PPT」「画个柱状图」「帮我填这个表」「今天有啥课」「WBG 赛程」「发个表情包」「识别这张图是哪个番」「视频讲了什么」时加载。也用于排障：工具注册了但不出现、python 依赖缺失、中文图表乱码、填表丢格式。
---

# 给 QQ 机器人装一套能干活的工具

## 这层加什么

qq-bridge 解决"能不能说话"，这一层解决"能干什么"。

| | 只有 qq-bridge | 加上 qq-content |
|---|---|---|
| 聊天 | ✅ | ✅ |
| 读文档 / 看图 / 听语音 | 部分（bridge 自带的媒体解析） | ✅ 补足 pdf/docx/xlsx 抽取、视频抽帧、音频转写 |
| 查 B 站 / 音乐 / Pixiv | ❌ | ✅ 20 个内容类工具 |
| 做 PPT / 画图表 / 填表 | ❌ | ✅ 三个工程类工具 |
| 长期记忆 | ❌ | ✅ LOD 三层 + 跨会话检索 |
| 课表 / 赛程 | ❌ | ✅ 两个日常类工具 |

**一句话**：bridge 让 agent 能收发消息，qq-content 让它在收到消息后有事可做。

---

## 前置

1. **DSH 在跑**，且已经装了 qq-bridge（见 `qq-bridge-setup` skill）
2. **Node ≥ 22**
3. **Python ≥ 3.10**，装这些包：
   ```bash
   pip install matplotlib python-docx openpyxl python-pptx Pillow
   ```
   - `matplotlib` → 图表；`python-docx` + `openpyxl` → 模板填表
   - `python-pptx` → PPT；`Pillow` → 梗图加字
   - **不装也能启动**，只是对应工具调用时报错
4. **ffmpeg**（视频抽帧、音频转码）
5. 中文字体（图表用）：Linux 装 `fonts-wqy-zenhei`，Windows 用系统自带雅黑

---

## 接入五步

实现放在本仓库的 `code/` 目录，MCP server 没有框架——就是一个 `stdio` 上跑的 Node 进程。
下面是它的骨架，方便你读懂或自己改。

```js
// server.mjs 的最小骨架
import { createInterface } from 'node:readline';

const TOOLS = [
  { name: 'chart_generator', description: '...', inputSchema: {...}, run: chartGenerator },
  { name: 'office_template_filler', description: '...', inputSchema: {...}, run: officeFiller },
  // …61 个
];

const rl = createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

rl.on('line', async (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'qq-content', version: '1.0.0' },
    }});
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    }});
  } else if (req.method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    try {
      const text = await tool.run(req.params.arguments ?? {});
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: String(text) }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `失败：${e.message}` }], isError: true } });
    }
  }
});
```

```
# 1. 拿到 OneBot 端点：复用 qq-bridge 的 config.json，不用自己维护
# 2. 装 python 依赖
pip install matplotlib python-docx openpyxl python-pptx Pillow
# 3. 在 DSH profile 里注册 MCP
```

```yaml
- insert:
    - id: mcp-qq-content
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qq-content
        transport: stdio
        command: 'node'
        args: ['/绝对路径/server.mjs']
        toolCallTimeoutMs: 725000
```

```bash
# 4. 重启 DSH（改 profile 必须重启，热载不生效）
systemctl restart dsh-server      # 或你启动 DSH 的方式

# 5. 验证工具清单
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node server.mjs
# 期望看到 result.tools 里有 61 个
```

**第 3、4 步最容易漏**：只启动 server.mjs 不注册 MCP，agent 手上一个工具都没有（不报错，只是问它什么都说不会）。

---

## 工具地图：按"你想干什么"查

### 内容娱乐

| 想干什么 | 用哪个 | 备注 |
|---|---|---|
| 搜 B 站视频/专栏 | `bili_search` | kind=video 搜视频、article 搜专栏（中文攻略/台词/考据比通用搜索准） |
| 读 B 站专栏全文 | `bili_article` | 给 cv 号或链接 |
| 推荐 B 站视频 | `bili_recommend` | 热门/排行/关键词三模式 |
| 看"@我的""回复我的" | `bili_feed` | 需先 `bili_login` 扫码 |
| 回评论 / 私信 | `bili_reply` `bili_dm` `bili_dm_send` | |
| 搜本子 | `doujin_search` `doujin_send` | 日文 tag 命中率最高 |
| 搜 Pixiv 图 | `pixiv_search` / `pixivic_search` | pixiv 官方需代理；pixivic 是镜像 |
| 随机图 | `random_image` | lolicon 图库，可按 tag/画师/长宽比筛 |
| 点歌发语音 | `music_search` → `music_play` | 搜索走网易云，播放走酷我 |
| 歌词 | `song_lyrics` | 带中文翻译 |
| 热搜 / 梗百科 / 番剧榜 | `hot_topic` | kind=hot/meme/acg |
| 识番 | `anime_search` | 先拿图 URL（见 `qq_media_resolver`） |
| 查漫画/轻小说 | `comic_info` | 只查文字资料，不下内容 |
| 运势 / 掷骰 | `fun_dice_fortune` | fortune 按 QQ 号+日期做确定性种子，同人同日结果固定 |

### 图片与表情包

| 想干什么 | 用哪个 |
|---|---|
| 列出收藏的表情 | `sticker_list` |
| 看某个表情长什么样 | `sticker_list` → `qq_get_sticker_image`（bridge 侧） |
| 发表情 | `sticker_send`（一条消息只能一张，不能混文字） |
| 给表情写备注 | `sticker_note`（本地记忆，不改 QQ 备注） |
| 偷别人的表情 | `collect_sticker`（bridge 侧，需 messageId） |
| 图库收集/发送 | `gallery_collect` `gallery_list` `gallery_send` |
| 搜网图 | `image_post`（360/bing/sogou/safebooru 四源） |
| AI 画图 | `image_generate` | 默认 Pollinations（免 key、有配额）；可配智谱/SiliconFlow |
| 梗图加字 | `meme_caption` | 底图可给 url / 图库 id / 内置表情包 |

### 干活

| 想干什么 | 用哪个 | 关键点 |
|---|---|---|
| 做 PPT | `file_make`（format=pptx） | Markdown + `---` 分页，13 种版式，见下节 |
| 数据图表 | `chart_generator` | bar/line/pie/radar，两种样式，见下节 |
| 填 Word/Excel 模板 | `office_template_filler` | 先 inspect 再 fill，保留原格式 |
| 读文档 | `read_file` | pdf/docx/xlsx/csv/txt 抽文字 |
| 听音频/视频内容 | `read_file` 或 `video_transcribe` | 本地转写，不需要联网 API |
| 看视频画面 | `video_peek` | 抽 6 帧拼 3×2 网格喂视觉模型，见下节 |
| 抓网页正文 | `page_text` | 自动提取内嵌统计图 URL |
| 解析链接/BV 号 | `web_link_parse` | 自动识别 BV 号、b23.tv、cv 专栏 |
| 搜索 | `web_search` `site_search` | 多引擎自动降级 |
| 发文件 | `file_send` | 上限 60MB |
| 写空间说说 | `qzone_post` | 会自留一份到 diary/ |
| 看好友空间 | `qzone_feed` | 只读，作为找话题的素材 |

### 长期能力

| 想干什么 | 用哪个 |
|---|---|
| 记事实 | `memory_write`（分类：人物/项目/技术/偏好/环境） |
| 按需取回 | `memory_recall`（带 token 预算） |
| 改记忆 | `memory_edit`（patch/move） |
| 跨会话检索聊天 | `chat_search`（按关键词/昵称/QQ 号，或总览各会话最新动态） |
| 看某会话历史 | `chat_history` |
| 课表与 DDL | `academic_ddl_tracker` |
| 电竞赛程 | `esports_match_radar` |
| 定时提醒 | `qq_schedule_reminder` |
| 发短语音 | `qq_send_tts_voice` |
| 服务器状态 | `server_status` |


---

## 五个需要额外说明的工具

### `chart_generator` — 别用 AI 画图画图表

```js
chart_generator({
  chartType: 'bar',            // bar | line | pie | radar
  title: '三大产业增加值同比',
  labels: ['一季度','二季度','三季度'],
  datasets: [
    { name: '第二产业', values: [4.8, 5.2, 5.6] },
    { name: '第三产业', values: [5.0, 5.4, 5.9] },
  ],
  style: 'academic',           // academic 白底深蓝 | transparent 透明底（叠深色 PPT）
  unit: '%',
  key: 'group:123456',         // 可选：直接发到会话；不给就返回本地路径
})
```

**为什么必须用它**：AI 绘画画出来的"图表"数字是假的、坐标轴是错的，学术/商务场合直接翻车。
这个工具是 matplotlib 真渲染，300dpi，数值即真相。

输出 2850×1585 左右、单张 60~270 KB。`radar` 至少要 3 个维度。

### `office_template_filler` — 在原模板上填，不是重做一个

```js
// 第一步：看结构
office_template_filler({ mode: 'inspect', path: '/path/实验报告模板.docx' })
// → 占位符：name、sid、date、score；段落 4 段，表格 1 个（2×2，首行：项目/结果）

// 第二步：填
office_template_filler({
  mode: 'fill',
  path: '/path/实验报告模板.docx',
  mappings: { name: '张三', sid: '20230101', date: '2026-11-23', score: '92' },
  key: 'private:123456',       // 直接把成品发回去
})
```

Excel 两种填法都支持：

```js
mappings: {
  who: '李雷',              // 替换单元格里的 {{who}}
  '进度!C2': '已完成',       // 按「工作表!坐标」直接写，保留样式与公式
}
```

**能保留什么**：原字体、字号、边框、合并单元格、Excel 公式。**会丢什么**：Word 里
占位符跨多个 run 的局部样式（整段会退化成首个 run 的格式）——这是 python-docx 的固有限制。

从 QQ 直接取文件时不用先下载，给 `groupId + fileId`（群）或 `userId + fileId + fileHash`（私聊）。

### `qq_media_resolver` — 两个真实痛点

**痛点一**：群友发的文件到了本地没有后缀，`read_file` 按扩展名分发，读不了。
`resolve_file` 会从 `Content-Disposition` 和 content-type 补出来，落地成带后缀的文件。

**痛点二**：识番接口只认 `http(s)` 链接，而桥接层给的是本地缓存路径。
`resolve_image_url` 从消息段里取 QQ 图床的公网地址（`multimedia.nt.qq.com.cn`）。

```js
qq_media_resolver({ action: 'resolve_image_url', messageId: 123456789 })
// → https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=...

qq_media_resolver({ action: 'resolve_file', groupId: 123456, fileId: 'xxx' })
// → <你的缓存目录>/qqfile-1795-报告.docx（36KB）
```

**注意**：本地文件转不成公网 URL。如果只能拿到本地路径，就明说拿不到，
别让调用方拿着 `C:/...` 去请求外部 API。

### `video_peek` — 一次看六帧，不是逐帧描述

把短视频抽 6 帧拼成 3×2 网格，作为**一张图**喂给视觉模型。

```js
video_peek({ bvid: 'BV1xx411c7XX', frames: 6, maxSeconds: 60 })
```

返回走 `__mcpContent` 自定义段（text + image 两段）。比逐帧描述省 token，
也比只抽一帧准——一帧看不出"在打架"还是"在跳舞"。

### PPT：13 种版式 + 一条硬规则

```markdown
---
layout: cover
title: 2026 年前三季度国民经济运行数据公报
subtitle: 结构化解析
---
---
layout: chart
title: 季度 GDP 同比增速连续两季回升
chart: {"type":"line","labels":["Q1","Q2","Q3"],"series":[{"name":"同比","values":[5.3,5.0,5.4]}]}
takeaway: 增速在 Q3 重回 5.4%
---
---
layout: kpi-cards
title: 三项总量指标同步走强
cards:
  - { title: 社零总额, body: 累计 35.4 万亿元，同比增长 4.6%，服务零售增速快于商品零售。 }
  - { title: 固定资产投资, body: 累计 37.1 万亿元，同比增长 3.4%，制造业投资维持 9% 以上。 }
---
```

版式全名单：`cover` `section` `bullets` `grid-2x2` `cols-3` `kpi-cards` `timeline`
`table` `chart` `split-visual` `two-col` `image-right` `image-left` `image-full`。

主题传 6 个字段：`{bg, surface, primary, accent, text, muted}`。

**硬规则（写进提示词才有效）**：数据公报类 PPT 不许交"无图空壳"——
网页有统计图就嵌原图，没有就自绘 3~4 张；每张卡片必须有标题 + 35~55 字正文，
不留 `—` 占位符。

---

## 踩过的坑

1. **`execFile` 不支持 stdin**。想把 JSON 喂给 python 脚本，别用 `bash -lc "python x.py < r.json"`
   ——Windows 上根本没 bash。给脚本加 `--spec <文件>` 参数，两端通吃。

2. **中文图表变方块**。matplotlib 默认字体没有中文。必须显式加载字体文件
   （`/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc` 或 `C:/Windows/Fonts/msyh.ttc`），
   同时设 `axes.unicode_minus = False`，否则负号也是方块。

3. **`galleryIndex()` 返回 `{ items: [...] }` 不是数组**。写 `idx.find(...)` 直接崩
   （`idx.find is not a function`），正确写法 `(idx.items || []).find(...)`。

4. **本地文件 ≠ 公网地址**。`anime_search` 这类外部接口只认真实 http(s) URL，
   把 `C:/cache/xxx.jpg` 传过去只会得到一个看不懂的错误。

5. **python 依赖缺失不报错，只在调用时炸**。启动时能跑不代表能干活——
   装完依赖一定逐个工具试一次。

6. **工具数对不上就是没注册上**。`tools/list` 返回 61 个才叫装好；
   少几个通常是 description 里有多余的换行或引号，把 JSON 结构破坏了。

7. **改完 server.mjs 必须重启 DSH**。MCP 是 DSH 的子进程，文件变了进程里还是旧代码。

8. **同名工具别重复注册**。两个工具叫同一个名字，MCP 里后者覆盖前者，JSON-RPC 不报错。

---

## 装完的验证清单

```text
□ tools/list 返回 61 个工具
□ chart_generator 出一张含中文的图，数字对得上
□ office_template_filler 对一份 .docx 做 inspect，能看到占位符
□ read_file 读一份 pdf，能抽出正文
□ memory_write 写一条，memory_recall 能取回来
□ 在 QQ 里问一句需要外部信息的话，确认 agent 真的调了工具而不是凭空编
```

最后一条最重要：**能调工具 ≠ 会调工具**。
在提示词里写清"什么时候该调哪个"（工具描述写细一点），
否则模型会把所有问题都用聊天解决。
