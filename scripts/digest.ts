import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import MarkdownIt from "markdown-it";
import { updateKeywordTrends, getKeywordTrendsSummary, getHistoricalTrendsForScoring } from './db';
import { CategoryId, ScoredArticle } from './utils';
import { loadFeeds, loadConfig, createPost, logger, printUsage } from './utils';
import { createAIClient, scoreArticlesWithAI, summarizeArticles, generateHighlights } from './llmodel';
import { initProxyAgent, fetchAllFeeds, deduplicateArticles, generateDigestReport } from './content';

async function main(): Promise<void> {
  const config = await loadConfig();
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) printUsage();

  initProxyAgent(config)

  let hours = config.general.default_hours;
  let topN = config.general.default_top_n;
  let lang = config.general.default_lang as "zh" | "en";
  // const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let outputPath = `${config.general.output_dir}/digest.md`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--hours' && args[i + 1]) {
      hours = parseInt(args[++i]!, 10);
    } else if (arg === '--top-n' && args[i + 1]) {
      topN = parseInt(args[++i]!, 10);
    } else if (arg === '--lang' && args[i + 1]) {
      lang = args[++i] as 'zh' | 'en';
    } else if (arg === '--output' && args[i + 1]) {
      outputPath = args[++i]!;
    }
  }
  
  const ApiKey = process.env.OPENAI_API_KEY;
  const ApiBase = process.env.OPENAI_API_BASE;
  const Model = process.env.OPENAI_MODEL;

  if (!ApiKey) {
    logger.error('[digest] Error: Missing API key. Set OPENAI_API_KEY.');
    process.exit(1);
  }

  const aiClient = createAIClient(config);

  logger.info(`[digest] === AI Daily Digest ===`);
  logger.info(`[digest] Time range: ${hours} hours`);
  logger.info(`[digest] Top N: ${topN}`);
  logger.info(`[digest] Language: ${lang}`);
  logger.info(`[digest] Output: ${outputPath}`);
  logger.info(`[digest] AI provider: OpenAI-compatible (${ApiBase}, model=${Model})`);
  logger.info('');

  // 读取 feeds
  logger.info(`[digest] Step 0/5: Loading feeds from ${config.general.feeds_path}...`);
  const feeds = await loadFeeds(config);

  logger.info(`[digest] Step 1/5: Fetching ${feeds.length} RSS feeds...`);
  const fetchedArticles = await fetchAllFeeds(feeds);

  if (fetchedArticles.length === 0) {
    logger.error('[digest] Error: No articles fetched from any feed. Check network / proxy / feeds validity.');
    process.exit(1);
  }

  let allArticles = deduplicateArticles(fetchedArticles);
  logger.info(`[digest] Got ${allArticles.length} articles after deduplicating.`);

  logger.info(`[digest] ------------------------------------`);
  logger.info(`[digest] Step 2/5: Filtering by time range (${hours} hours)...`);
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  const recentArticles = allArticles.filter(a => a.pubDate.getTime() > cutoffTime.getTime());

  logger.info(`[digest] Found ${recentArticles.length} articles within last ${hours} hours`);

  if (recentArticles.length === 0) {
    logger.error(`[digest] Error: No articles found within the last ${hours} hours.`);
    logger.error(`[digest] Try increasing --hours (e.g., --hours 168)`);
    process.exit(1);
  }

  logger.info(`[digest] ------------------------------------`);
  logger.info(`[digest] Step 3/5: AI scoring ${recentArticles.length} articles...`);

  const historicalTrends = getHistoricalTrendsForScoring();
  const scores = await scoreArticlesWithAI(config, recentArticles, aiClient, historicalTrends);

  const scoredArticles = recentArticles.map((article, index) => {
    const score = scores.get(index) || { relevance: 5, quality: 5, timeliness: 5, category: 'other' as CategoryId, keywords: [] };
    return {
      ...article,
      totalScore: score.relevance + score.quality + score.timeliness,
      breakdown: score,
    };
  });

  scoredArticles.sort((a, b) => b.totalScore - a.totalScore);
  const topArticles = scoredArticles.slice(0, topN);

  logger.info(`[digest] Top ${topN} articles selected (score range: ${topArticles[topArticles.length - 1]?.totalScore || 0} - ${topArticles[0]?.totalScore || 0})`);

  logger.info(`[digest] ------------------------------------`);
  logger.info(`[digest] Step 4/5: Generating AI summaries...`);
  const indexedTopArticles = topArticles.map((a, i) => ({ ...a, index: i }));
  const summaries = await summarizeArticles(config, indexedTopArticles, aiClient, lang);

  const finalArticles: ScoredArticle[] = topArticles.map((a, i) => {
    const sm = summaries.get(i) || { titleZh: a.title, summary: a.description.slice(0, 200), reason: '' };
    return {
      title: a.title,
      link: a.link,
      pubDate: a.pubDate,
      description: a.description,
      sourceName: a.sourceName,
      sourceUrl: a.sourceUrl,
      score: a.totalScore,
      scoreBreakdown: {
        relevance: a.breakdown.relevance,
        quality: a.breakdown.quality,
        timeliness: a.breakdown.timeliness,
      },
      category: a.breakdown.category,
      keywords: a.breakdown.keywords,
      titleZh: sm.titleZh,
      summary: sm.summary,
      reason: sm.reason,
    };
  });

  updateKeywordTrends(finalArticles);
  logger.info(`[digest] Step 4/5: 更新关键词趋势数据库...`);

  logger.info(`[digest] ------------------------------------`);
  logger.info(`[digest] Step 5/5: Generating today's highlights...`);
  const latestTrendsData = getKeywordTrendsSummary();
  const latestTrends = latestTrendsData.slice(0, 8).map(t => 
    `${t.keyword}: 连续${t.streak}天${t.today_mentions}次，（今日${t.today_mentions}次）`
  ).join('\n');
  const highlights = await generateHighlights(config, finalArticles, aiClient, lang, latestTrends);

  const successfulSources = new Set(allArticles.map(a => a.sourceName));

  const report = generateDigestReport(finalArticles, highlights);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, report);

  const md = new MarkdownIt();
  const report_html = md.render(report.split("\n").slice(1).join("\n"));

  // WordPress发布
  const wp_title = report.split("\n")[0].slice(1);
  const wp_post = {
    config: config,
    title: wp_title,
    content: report_html,
    status: "publish" as "publish" | "draft" | "private",
    categories: [23]
  };
  createPost(config, wp_post);

  logger.info('');
  logger.info(`[digest] ✅ Done!`);
  logger.info(`[digest] 📁 Report: ${outputPath}`);
  logger.info(`[digest] 📊 Stats: ${successfulSources.size} sources → ${allArticles.length} articles → ${recentArticles.length} recent → ${finalArticles.length} selected`);

  if (finalArticles.length > 0) {
    logger.info('');
    logger.info(`[digest] 🏆 Top 5 Preview:`);
    for (let i = 0; i < Math.min(5, finalArticles.length); i++) {
      const a = finalArticles[i];
      logger.info('------------------------------------------------------------------------------------------------------')
      logger.info(`${i + 1}. ${a.titleZh || a.title} - ${a.pubDate.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`);
      logger.info(``);
      logger.info(`${a.summary.slice(0, 80)}...`);
      logger.info('')
    }
  }
}

main().catch((err) => {
  logger.error(`[digest] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});