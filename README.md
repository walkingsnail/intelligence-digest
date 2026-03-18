# News/Intelligence Digest

## 思路源自 https://github.com/vigorX777/ai-daily-digest/tree/main，感谢！

## 使用方式

作为 agent skill 使用，在对话中输入 `/digest` 即可启动交互式引导流程：

```
/digest
```

自己真实的想法是直接运行，agent太重了

### 直接命令行运行

```bash
tsx digest.ts
tsx digest.ts --help
tsx validate-feeds.ts
```

## 功能

### 五步处理流水线

```
RSS 抓取 → 时间过滤 → AI 评分 + 分类 → AI 摘要 + 翻译 → 趋势总结
```

1. **RSS 抓取** — 并发抓取自定义源，兼容 RSS 2.0 和 Atom 格式
2. **时间过滤** — 按指定时间窗口筛选近期文章
3. **AI 评分** — AI 从相关性、质量、时效性三个维度打分（1-10），同时完成分类和关键词提取（Gemini 优先，失败自动降级到 OpenAI 兼容接口）
4. **AI 摘要** — 为 Top N 文章生成结构化摘要（4-6 句）、中文标题翻译、推荐理由
5. **趋势总结** — AI 归纳当日技术圈 1-4 个宏观趋势

### 日报结构

生成的 Markdown 文件包含以下板块：

| 板块 | 内容 |
|------|------|
| 📝 今日看点 | 1-4个主题、2-3 句话宏观概括热点话题和大势 |
| 🏆 今日必读 | Top 5 深度展示：中英双语标题、摘要、推荐理由、关键词 |
| 📊 数据概览 | 统计表格 + Mermaid 饼图（分类分布）+ Mermaid 柱状图（高频关键词）+ ASCII 纯文本图 + 话题标签云 |
| 分类文章列表 | 按大分类分组，每篇含中文标题、来源、相对时间、评分、摘要、关键词 |

### 分类体系

- geopolitics: 地缘政治、国际冲突、外交关系、国家安全
- economic: 宏观经济、财政政策、货币政策、全球贸易、投资趋势
- ai-tech: 人工智能/AI、技术政策、半导体、前沿科技演进
- military: 军事行动、国防技术、军备竞赛、战略演习
- cyber-security: 网络安全、数据主权、漏洞、数字间谍
- industry: 工业、基建、供应链、传统行业数字化
- china: 中国、大国战略
- energy: 能源、资源战略
- venture: 风险资本、科技投资
- other: 其他

## 亮点

- **零依赖** — 纯 TypeScript 单文件，无第三方库，基于 Bun 运行时的原生 `fetch` 和内置 XML 解析
- **中英双语** — 所有标题自动翻译为中文，原文标题保留为链接文字，不错过任何语境
- **结构化摘要** — 不是一句话敷衍了事，而是 4-6 句覆盖核心问题 → 关键论点 → 结论的完整概述，30 秒判断一篇文章是否值得读
- **可视化统计** — Mermaid 图表（GitHub/Obsidian 原生渲染）+ ASCII 柱状图（终端友好）+ 标签云，三种方式覆盖所有阅读场景
- **智能分类** — AI 自动将文章归入各大类别，按类浏览比平铺列表高效得多
- **趋势洞察** — 不只是文章列表，还会归纳当天技术圈的宏观趋势，帮你把握大方向

## 环境要求
- 配置`OPENAI_API_KEY`环境变量
- 配置`wp_post_pwd`环境变量，用于wordpress上发布摘要
- 代码中硬编码DEFAULT_API_BASE，可配置环境变量`OPENAI_API_BASE` 覆盖，使用 DeepSeek / OpenAI 等 OpenAI 兼容服务
- 代码中硬编码DEFAULT_MODEL，可配置环境变量`OPENAI_MODEL` 覆盖，使用 DeepSeek / OpenAI 等 OpenAI 兼容服务
- 首次运行前用`tsx scripts/db.ts`初始化数据库
