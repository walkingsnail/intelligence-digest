
import yaml from 'js-yaml';  // 需要 npm install js-yaml @types/js-yaml --save
import axios from "axios";
import https from "https";
import { readFile } from 'node:fs/promises';
import process from 'node:process';

// ============================================================================
// Constants 
// ============================================================================

export const FEED_FETCH_TIMEOUT_MS = 15_000;
export const FEED_CONCURRENCY = 10;
export const AI_BATCH_SIZE = 10;
export const MAX_CONCURRENT_AI = 2;

export type CategoryId = 'geopolitics' | 'economic' | 'ai-tech' | 'military' | 'cyber-security' | 'industry' | 'china' | 'energy' | 'venture' | 'other';

export const CATEGORY_META: Record<CategoryId, { emoji: string; label: string }> = {
  'geopolitics': { emoji: '🌍', label: '地缘政治/国际关系' },
  'economic': { emoji: '📈', label: '宏观经济/投资趋势' },
  'ai-tech': { emoji: '🤖', label: 'AI/前沿科技' },
  'military': { emoji: '🛡️', label: '国防/军事' },
  'cyber-security': { emoji: '🔒', label: '数字主权/网络安全' },
  'industry': { emoji: '🏭', label: '产业/供应链' },
  'china': { emoji: '🐉', label: '中国/大国战略' },
  'energy': { emoji: '⚡', label: '能源/资源' },
  'venture': { emoji: '💰', label: '风险资本/科技投资' },
  'other': { emoji: '📝', label: '其他' },
};

// ============================================================================
// Interfaces
// ============================================================================

export interface Article {
  title: string;
  link: string;
  pubDate: Date;
  description: string;
  sourceName: string;
  sourceUrl: string;
}

export interface ScoredArticle extends Article {
  score: number;
  scoreBreakdown: {
    relevance: number;
    quality: number;
    timeliness: number;
  };
  category: CategoryId;
  keywords: string[];
  titleZh: string;
  summary: string;
  reason: string;
}

export interface AIScoringResult {
  results: Array<{
    index: number;
    relevance: number;
    quality: number;
    timeliness: number;
    category: string;
    keywords: string[];
  }>;
}

export interface AISummaryResult {
  results: Array<{
    index: number;
    titleZh: string;
    summary: string;
    reason: string;
  }>;
}

export interface AIClient {
  call(prompt: string): Promise<string>;
}

// ============================================================================
// 从 config/feeds.json 读取 feeds
// ============================================================================

export interface FeedConfig {
  name: string;
  xmlUrl: string;
  htmlUrl: string;
}

export async function loadFeeds(config: AppConfig): Promise<FeedConfig[]> {
  try {
    const feeds_path = config.general.feeds_path
    const data = await readFile(feeds_path, 'utf-8');
    const feeds_config = JSON.parse(data);

    if (!feeds_config.categories || !Array.isArray(feeds_config.categories)) {
      throw new Error('feeds.json 格式错误：缺少 "categories" 数组');
    }

    const allFeeds: FeedConfig[] = [];

    for (const cat of feeds_config.categories) {
      if (cat.feeds && Array.isArray(cat.feeds)) {
        for (const f of cat.feeds) {
          if (f.name && f.xmlUrl && f.htmlUrl) {
            allFeeds.push({
              name: f.name,
              xmlUrl: f.xmlUrl,
              htmlUrl: f.htmlUrl,
            });
          }
        }
      }
    }

    if (allFeeds.length === 0) {
      throw new Error('feeds.json 中没有找到任何有效的 feed');
    }

    logger.info(`[digest] 从 ${feeds_path} 加载了 ${allFeeds.length} 个 feeds`);
    return allFeeds;
  } catch (err: any) {
    logger.error('[digest] 无法加载 feeds 配置：', err.message);
    logger.error('请检查：1. 文件是否存在 2. 路径是否为 ./config/feeds.json 3. JSON 格式是否正确');
    process.exit(1);
  }
}

// ============================================================================
// Visualization 
// ============================================================================

export function humanizeTime(pubDate: Date): string {
  const diffMs = Date.now() - pubDate.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;
  return pubDate.toISOString().slice(0, 10);
}

function stringDisplayWidth(str: string): number {
  // Rough width calculation: ASCII 1, CJK 2
  let width = 0;
  for (const ch of str) {
    if (/[\u2E80-\u9FFF]/.test(ch)) {
      width += 2; // CJK characters
    } else {
      width += 1; // ASCII / half-width
    }
  }
  return width;
}

export function padEndDisplay(str: string, targetWidth: number): string {
  let width = stringDisplayWidth(str);
  let padding = '';
  while (width < targetWidth) {
    padding += ' ';
    width++;
  }
  return str + padding;
}

export function generateAsciiBarChart(articles: ScoredArticle[]): string {
  const kwCount = new Map<string, number>();
  for (const a of articles) {
    for (const kw of a.keywords) {
      const normalized = kw.toLowerCase();
      kwCount.set(normalized, (kwCount.get(normalized) || 0) + 1);
    }
  }

  const sorted = Array.from(kwCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (sorted.length === 0) return '';

  const maxVal = sorted[0][1];
  const maxBarWidth = 20;
  const maxLabelLen = Math.max(...sorted.map(([k]) => stringDisplayWidth(k)));

  let chart = '```\n';
  for (const [label, value] of sorted.slice(0, 6)) {
    const barLen = Math.max(1, Math.round((value / maxVal) * maxBarWidth));
    const bar = '█'.repeat(barLen) + '░'.repeat(maxBarWidth - barLen);
    chart += `${padEndDisplay(label, maxLabelLen)} │ ${bar} ${value}\n`;
  }
  chart += '```\n';

  return chart;
}

// ============================================================================
// 配置文件
// ============================================================================

export interface AppConfig {
  ai: {
    default_api_base: string;
    default_model: string;
  };
  prompts: {
    scoring: { version: string; temperature: number; top_p?: number; template: string };
    summarization: { version: string; temperature: number; template: string };
    highlights: { version: string; temperature: number; template: string };
  };
  proxy: {
    enabled: boolean;
    url?: string;
  };
  wordpress: {
    enabled: boolean;
    url: string;
    username: string;
    app_password_env: string;
    categories?: number[];
    default_status?: "draft" | "publish" | "private";
    reject_unauthorized: boolean
  };
  general: {
    feeds_path: string;
    output_dir: string;
    default_hours: number;
    default_top_n: number;
    default_lang: string
  };
}

let cachedConfig: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig;

  const configPath = './config/settings.yaml';
  try {
    const content = await readFile(configPath, 'utf-8');
    const config = yaml.load(content) as AppConfig;

    // 简单校验（生产环境建议用 zod 或 typebox）
    if (!config.ai?.default_api_base) throw new Error("缺少 ai.default_api_base");
    if (!config.prompts?.scoring?.template) throw new Error("缺少 prompts.scoring.template");

    cachedConfig = config;
    return config;
  } catch (err) {
    logger.error(`无法加载配置文件 ${configPath}`, err);
    process.exit(1);
  }
}

// ============================================================================
// RSS/Atom Parsing
// ============================================================================

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .trim();
}

// ============================================================================
// WordPress post
// ============================================================================
export interface WPPost { 
  config: AppConfig, 
  title: string; 
  content: string; 
  status: "draft" | "publish" | "private"; 
  categories?: number[] 
}

export async function createPost(config: AppConfig, post: WPPost) {
  if (!config.wordpress.enabled) {
    logger.info("WordPress 发布已关闭（配置中 wordpress.enabled = false）");
    return;
  }

  const WP_URL = config.wordpress.url;
  const WP_USER = config.wordpress.username;
  const WP_APP_PASSWORD = process.env[config.wordpress.app_password_env];

  if (!WP_APP_PASSWORD) {
    logger.error("缺少 WordPress 应用密码环境变量：" + config.wordpress.app_password_env);
    return;
  }

  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");

  const httpsAgent = new https.Agent({
    rejectUnauthorized: config.wordpress.reject_unauthorized   // 保持原样，内网自签名常见
  });

  try {
    const response = await axios.post(
      `${WP_URL}/wp-json/wp/v2/posts`,
      post,
      {
        httpsAgent,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json"
        }
      }
    );

    logger.info("文章创建成功:");
    logger.info("ID:", response.data.id);
    logger.info("URL:", response.data.link);
  } catch (error: any) {
    logger.error("创建文章失败:", error.response?.data || error.message);
  }
}

// ============================================================================
// 全局日志 + 运行报告收集
// ============================================================================

interface LogEntry {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
  error?: any;
}

const logs: LogEntry[] = [];

function getTimeStamp(): string {
  return new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\//g, '-');
}

export const logger = {
  info(msg: string) {
    const entry = { timestamp: getTimeStamp(), level: 'INFO' as const, message: msg };
    logs.push(entry);
    console.log(`[${entry.timestamp}] ${msg}`);
  },
  warn(msg: string, err?: any) {
    const entry = { timestamp: getTimeStamp(), level: 'WARN' as const, message: msg, error: err };
    logs.push(entry);
    console.warn(`[${entry.timestamp}] WARN: ${msg}`, err ? err : '');
  },
  error(msg: string, err?: any) {
    const entry = { timestamp: getTimeStamp(), level: 'ERROR' as const, message: msg, error: err };
    logs.push(entry);
    console.error(`[${entry.timestamp}] ERROR: ${msg}`, err ? err : '');
  },
};

// ============================================================================
// CLI & main
// ============================================================================

export function printUsage(): never {
  logger.info(`AI Daily Digest - AI-powered RSS digest from top strategic feeds

Usage:
  bun scripts/digest.ts [options]

Options:
  --hours <n>     Time range in hours (default: 24)
  --top-n <n>     Number of top articles to include (default: 18)
  --lang <lang>   Summary language: zh or en (default: zh)
  --output <path> Output file path (default: ./output/digest-YYYYMMDD.md)
  --help          Show this help

Environment:
  OPENAI_API_KEY   Required
  OPENAI_API_BASE  Optional (default: in ./config/settings.yaml)
  OPENAI_MODEL     Optional (default: in ./config/settings.yaml)

Examples:
  bun digest.ts
  tsx digest.ts
  bun digest.ts --hours 48 --top-n 15 --lang en
`);
  process.exit(0);
}