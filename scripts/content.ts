
import { setTimeout as sleep } from 'node:timers/promises';
import Parser from 'rss-parser';
import { fetch, ProxyAgent } from "undici";
import { getKeywordTrendsSummary } from './db';
import { FEED_CONCURRENCY, FEED_FETCH_TIMEOUT_MS } from './utils';
import { Article, FeedConfig, stripHtml, logger } from './utils';
import { humanizeTime, generateAsciiBarChart } from './utils';
import { CategoryId, CATEGORY_META, ScoredArticle } from './utils';

// ============================================================================
// Proxy（从配置读取）
// ============================================================================

let proxyAgent: ProxyAgent | undefined;

export function initProxyAgent(config) {
  if (config.proxy.enabled && config.proxy.url) {
    proxyAgent = new ProxyAgent(config.proxy.url);
    logger.info(`使用代理: ${config.proxy.url}`);
  } else {
    proxyAgent = undefined;
    logger.info("代理已禁用");
  }
}

// ============================================================================
// Feed Fetching
// ============================================================================

const parser = new Parser({
  customFields: {
    feed: ['subtitle', 'image'],
    item: [
      'content:encoded',
      'dc:creator',
      'dc:date',
      'media:content',
      'media:thumbnail',
    ],
  },
  maxRedirects: 5,
});

async function fetchFeed(feed: FeedConfig): Promise<Article[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);

    const response = await fetch(feed.xmlUrl, {
      signal: controller.signal,
      dispatcher: proxyAgent,
      headers: {
        "User-Agent": "Strategic-Intelligence-Digest/1.0",
        "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${feed.xmlUrl}`);
    }

    const xmlText = await response.text();

    const feedData = await parser.parseString(xmlText);

    if (!feedData?.items?.length) {
      logger.warn(`[digest] ${feed.name}: No items found after parsing`);
      return [];
    }

    return feedData.items
      .filter(item => item.title && (item.link || item.guid))
      .map(item => {
        const pubDateStr = item.pubDate || item['dc:date'] || '';
        const pubDate = pubDateStr ? new Date(pubDateStr) : new Date(0);

        let description = item['content:encoded'] || item.content || item.summary || '';
        description = stripHtml(description).slice(0, 800);

        return {
          title: (item.title || '').trim(),
          link: (item.link || item.guid || '').trim(),
          pubDate,
          description,
          sourceName: feed.name,
          sourceUrl: feed.htmlUrl,
        };
      });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`[digest] ✗ ${feed.name} (${feed.xmlUrl}): ${errMsg}`);
    if (errMsg.includes('abort')) {
      logger.warn(`[digest]   → timeout after ${FEED_FETCH_TIMEOUT_MS}ms`);
    }
    return [];
  }
}

export async function fetchAllFeeds(feeds: FeedConfig[]): Promise<Article[]> {
  const allArticles: Article[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < feeds.length; i += FEED_CONCURRENCY) {
    const batch = feeds.slice(i, i + FEED_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(fetchFeed));

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        allArticles.push(...result.value);
        successCount++;
      } else {
        failCount++;
      }
    }

    const progress = Math.min(i + FEED_CONCURRENCY, feeds.length);
    logger.info(`[digest] Progress: ${progress}/${feeds.length} feeds processed (${successCount} ok, ${failCount} failed)`);
    logger.info(`[digest] -----------`);
  }

  logger.info(`[digest] Fetched ${allArticles.length} articles from ${successCount} feeds (${failCount} failed)`);
  return allArticles;
}

// ============================================================================
// article deduplication
// ============================================================================

function normalizeUrl(url: string): string {
    if (!url || typeof url !== 'string') {
        return '';
    }

    try {
        let u = new URL(url.trim());

        if (u.protocol === 'http:') {
            u.protocol = 'https:';
        }

        const trackingParams = [
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            'utm_id', 'fbclid', 'ref', 'source', 'referrer', 'click_id', 'affiliate',
            'campaign', 'ad_id', 'gclid', 'msclkid', 'twclid', 'igshid', '_ga',
            'mc_cid', 'mc_eid', 'vero_id', 'oly_enc_id', 'oly_anon_id'
        ];

        trackingParams.forEach(param => {
            u.searchParams.delete(param);
        });

        let path = u.pathname;
        if (path.endsWith('/')) {
            path = path.slice(0, -1);
        }
        if (path.endsWith('/index.html') || path.endsWith('/index.php') || path.endsWith('/index')) {
            path = path.replace(/\/index(\.html|\.php)?$/, '');
        }

        u.pathname = path;

        if (u.hostname.startsWith('www.')) {
            u.hostname = u.hostname.replace(/^www\./, '');
        }

        return u.origin + u.pathname + u.search;
    } catch (e) {
        logger.warn(`[normalizeUrl] Invalid URL: ${url}`);
        return url.split('?')[0].split('#')[0].trim();
    }
}

export function deduplicateArticles(articles: Article[]): Article[] {
    const seen = new Map<string, Article>();

    for (const article of articles) {
        if (!article.link || !article.title) {
            continue;
        }

        const normLink = normalizeUrl(article.link);
        let key = normLink;

        const existing = seen.get(key);
        if (!existing || article.pubDate > existing.pubDate) {
            seen.set(key, article);
        }
    }

    const unique = Array.from(seen.values());
    unique.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

    return unique;
}


// ============================================================================
// Report Generation
// ============================================================================

export function generateDigestReport(articles: ScoredArticle[], highlights: string): string {
  const now = new Date();

  let report = `# 📰 新闻快报 — ${now.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}\n\n`;

  const trendsText = getKeywordTrendsSummary(6);
  report += ` ${trendsText}\n\n`;

  if (highlights) {
    report += `## 📝 今日看点\n\n`;
    report += `${highlights}\n\n`;
    report += `---\n\n`;
  }

  if (articles.length >= 5) {
    report += `## 🏆 必读\n\n`;
    for (let i = 0; i < Math.min(5, articles.length); i++) {
      const a = articles[i];
      const medal = ['🥇', '🥈', '🥉'][i % 3];
      const catMeta = CATEGORY_META[a.category];

      report += `${medal} **${a.titleZh || a.title}**\n\n`;
      report += `[${a.title}](${a.link}) — ${a.sourceName} · ${humanizeTime(a.pubDate)} · ${catMeta.emoji} ${catMeta.label}\n\n`;
      report += `> ${a.summary}\n\n`;
      if (a.reason) {
        report += `💡 *为什么值得读*: ${a.reason}\n\n`;
      }
      if (a.keywords.length > 0) {
        report += `🏷️ ${a.keywords.join(', ')}\n\n`;
      }
    }
    report += `---\n\n`;
  }

  const asciiChart = generateAsciiBarChart(articles);
  if (asciiChart) {
      report += `📊 关键词\n\n${asciiChart}\n\n`;
  }

  report += `---\n\n`;

  const categoryGroups = new Map<CategoryId, ScoredArticle[]>();
  for (const a of articles) {
    const list = categoryGroups.get(a.category) || [];
    list.push(a);
    categoryGroups.set(a.category, list);
  }

  const sortedCategories = Array.from(categoryGroups.entries())
    .sort((a, b) => b[1].length - a[1].length);

  let globalIndex = 0;
  for (const [catId, catArticles] of sortedCategories) {
    const catMeta = CATEGORY_META[catId];
    report += `## ${catMeta.emoji} ${catMeta.label}\n\n`;

    for (const a of catArticles) {
      globalIndex++;
      const scoreTotal = a.scoreBreakdown.relevance + a.scoreBreakdown.quality + a.scoreBreakdown.timeliness;

      report += `### ${globalIndex}. ${a.titleZh || a.title}\n\n`;
      report += `[${a.title}](${a.link}) — **${a.sourceName}** · ${humanizeTime(a.pubDate)} · ⭐ ${scoreTotal}/30\n\n`;
      report += `> ${a.summary}\n\n`;
      if (a.keywords.length > 0) {
        report += `🏷️ ${a.keywords.join(', ')}\n\n`;
      }
      report += `---\n\n`;
    }
  }
  report += `# 新闻快报 — ${now.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}\n\n`;

  return report;
}