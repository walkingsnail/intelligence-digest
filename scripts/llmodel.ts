import process from 'node:process';
import { AI_BATCH_SIZE, MAX_CONCURRENT_AI } from './utils';
import { logger, AppConfig, CategoryId, Article, ScoredArticle, AIScoringResult, AISummaryResult, AIClient } from './utils';

// ============================================================================
// AI Provider（使用配置中的 base 和 model）
// ============================================================================

async function callOpenAICompatible(
    temperature: number,
    prompt: string,
    apiKey: string,
    apiBase: string,
    model: string
): Promise<string> {
    const normalizedBase = apiBase.replace(/\/+$/, '');
    const response = await fetch(`${normalizedBase}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: temperature,
            top_p: 0.8,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`OpenAI-compatible API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((item: any) => item.type === 'text' && typeof item.text === 'string')
            .map((item: any) => item.text)
            .join('\n');
    }
    return '';
}

export function createAIClient(config: AppConfig): AIClient {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('No AI API key configured. Set OPENAI_API_KEY.');
    }

    const apiBase = config.ai.default_api_base;
    const model = config.ai.default_model;

    return {
        async call(temperature: number, prompt: string): Promise<string> {
            return callOpenAICompatible(temperature, prompt, apiKey, apiBase, model);
        },
    };
}

// ============================================================================
// AI Scoring（使用配置中的 prompt）
// ============================================================================

function parseJsonResponse<T>(text: string): T {
    let jsonText = text.trim();
    if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(jsonText) as T;
}

function buildScoringPrompt(
    config: AppConfig,
    articles: Array<{ index: number; title: string; description: string; sourceName: string }>,
    historicalTrends: string = ''
): string {
    const articlesList = articles.map(a =>
        `Index ${a.index}: [${a.sourceName}] ${a.title}\n${a.description.slice(0, 300)}`
    ).join('\n\n---\n\n');

    let prompt = config.prompts.scoring.template.replace('{articlesList}', articlesList);
    if (historicalTrends.trim() && !historicalTrends.includes('暂无')) {
        prompt = prompt + `\n\n--- 以上是评分要求和待评分文章列表 ---\n\n` +
            `额外参考（仅用于辅助判断 timeliness 和 relevance，不要在输出中重复或提及这些内容）:\n` +
            `${historicalTrends}\n\n` +
            `说明：\n` +
            `- 如果文章关键词与连续多天（streak >= 3）的历史热点高度匹配，timeliness 倾向 8-10 分\n` +
            `- 如果文章引入新关键词或与历史趋势冲突，可适当调整 relevance\n` +
            `严格执行任务：只输出 JSON，不要说任何其他话，包括问候、解释、markdown。输出格式必须是：\n` +
            `{"results": [...]}`;
    };

    return prompt
}

export async function scoreArticlesWithAI(
    config: AppConfig,
    articles: Article[],
    aiClient: AIClient,
    historicalTrends: string = ''
): Promise<Map<number, { relevance: number; quality: number; timeliness: number; category: CategoryId; keywords: string[] }>> {
    const allScores = new Map<number, { relevance: number; quality: number; timeliness: number; category: CategoryId; keywords: string[] }>();

    const indexed = articles.map((article, index) => ({
        index,
        title: article.title,
        description: article.description,
        sourceName: article.sourceName,
    }));

    const batches: typeof indexed[] = [];
    for (let i = 0; i < indexed.length; i += AI_BATCH_SIZE) {
        batches.push(indexed.slice(i, i + AI_BATCH_SIZE));
    }

    logger.info(`[digest] AI scoring: ${articles.length} articles in ${batches.length} batches`);

    const validCategories = new Set<string>(['geopolitics', 'economic', 'ai-tech', 'cyber-security', 'industry', 'china', 'energy', 'venture', 'other']);

    for (let i = 0; i < batches.length; i += MAX_CONCURRENT_AI) {
        const batchGroup = batches.slice(i, i + MAX_CONCURRENT_AI);
        const promises = batchGroup.map(async (batch) => {
            try {
                const prompt = buildScoringPrompt(config, batch, historicalTrends);
                const responseText = await aiClient.call(config.prompts.scoring.temperature, prompt);
                const parsed = parseJsonResponse<AIScoringResult>(responseText);

                if (parsed.results && Array.isArray(parsed.results)) {
                    for (const result of parsed.results) {
                        const clamp = (v: number) => Math.min(10, Math.max(1, Math.round(v)));
                        const cat = (validCategories.has(result.category) ? result.category : 'other') as CategoryId;
                        allScores.set(result.index, {
                            relevance: clamp(result.relevance),
                            quality: clamp(result.quality),
                            timeliness: clamp(result.timeliness),
                            category: cat,
                            keywords: Array.isArray(result.keywords) ? result.keywords.slice(0, 4) : [],
                        });
                    }
                }
            } catch (error) {
                logger.warn(`[digest] Scoring batch failed: ${error instanceof Error ? error.message : String(error)}`);
                for (const item of batch) {
                    allScores.set(item.index, { relevance: 5, quality: 5, timeliness: 5, category: 'other', keywords: [] });
                }
            }
        });

        await Promise.all(promises);
        logger.info(`[digest] Scoring progress: ${Math.min(i + MAX_CONCURRENT_AI, batches.length)}/${batches.length} batches`);
    }

    return allScores;
}

// ============================================================================
// AI Summarization（使用配置中的 prompt）
// ============================================================================

function buildSummaryPrompt(
    config: AppConfig,
    articles: Array<{ index: number; title: string; description: string; sourceName: string; link: string }>,
    lang: 'zh' | 'en'
): string {
    const articlesList = articles.map(a =>
        `Index ${a.index}: [${a.sourceName}] ${a.title}\nURL: ${a.link}\n${a.description.slice(0, 800)}`
    ).join('\n\n---\n\n');

    const langInstruction = lang === 'zh'
        ? '请用中文撰写摘要和推荐理由。如果原文是英文，请翻译为中文。标题翻译也用中文。'
        : 'Write summaries, reasons, and title translations in English.';

    return config.prompts.summarization.template
        .replace('{langInstruction}', langInstruction)
        .replace('{articlesList}', articlesList);
}

export async function summarizeArticles(
    config: AppConfig,
    articles: Array<Article & { index: number }>,
    aiClient: AIClient,
    lang: 'zh' | 'en'
): Promise<Map<number, { titleZh: string; summary: string; reason: string }>> {
    const summaries = new Map<number, { titleZh: string; summary: string; reason: string }>();

    const indexed = articles.map(a => ({
        index: a.index,
        title: a.title,
        description: a.description,
        sourceName: a.sourceName,
        link: a.link,
    }));

    const batches: typeof indexed[] = [];
    for (let i = 0; i < indexed.length; i += AI_BATCH_SIZE) {
        batches.push(indexed.slice(i, i + AI_BATCH_SIZE));
    }

    logger.info(`[digest] Generating summaries for ${articles.length} articles in ${batches.length} batches`);

    for (let i = 0; i < batches.length; i += MAX_CONCURRENT_AI) {
        const batchGroup = batches.slice(i, i + MAX_CONCURRENT_AI);
        const promises = batchGroup.map(async (batch) => {
            try {
                const prompt = buildSummaryPrompt(config, batch, lang);
                const responseText = await aiClient.call(config.prompts.summarization.temperature, prompt);
                const parsed = parseJsonResponse<AISummaryResult>(responseText);

                if (parsed.results && Array.isArray(parsed.results)) {
                    for (const result of parsed.results) {
                        summaries.set(result.index, {
                            titleZh: result.titleZh || '',
                            summary: result.summary || '',
                            reason: result.reason || '',
                        });
                    }
                }
            } catch (error) {
                logger.warn(`[digest] Summary batch failed: ${error instanceof Error ? error.message : String(error)}`);
                for (const item of batch) {
                    summaries.set(item.index, { titleZh: item.title, summary: item.title, reason: '' });
                }
            }
        });

        await Promise.all(promises);
        logger.info(`[digest] Summary progress: ${Math.min(i + MAX_CONCURRENT_AI, batches.length)}/${batches.length} batches`);
    }

    return summaries;
}

// ============================================================================
// AI Highlights（使用配置中的 prompt）
// ============================================================================

export async function generateHighlights(
    config: AppConfig,
    articles: ScoredArticle[],
    aiClient: AIClient,
    lang: 'zh' | 'en',
    latestTrends: string = ''
): Promise<string> {
    const articleList = articles.slice(0, 10).map((a, i) =>
        `${i + 1}. [${a.category}] ${a.titleZh || a.title} — ${a.summary.slice(0, 100)}`
    ).join('\n');

    const langNote = lang === 'zh' ? '用中文回答。' : 'Write in English.';

    let prompt = config.prompts.highlights.template
        .replace('{langNote}', langNote)
        .replace('{articleList}', articleList);

    if (latestTrends.trim() && !latestTrends.includes('暂无')) {
        prompt =
            `# 结合今日关键词趋势写看点总结:\n${latestTrends}\n\n` +
            `总结要求：\n` +
            `- 优先关注连续多天（streak >= 3）的关键词及其背后的战略含义\n` +
            `- 把今天的高频新词与历史趋势对比，提炼“延续”、“爆发”、“转折”等模式\n` +
            `- 宏观角度：地缘政治、经济影响、技术变革、投资机会等\n` +
            `- 避免逐条罗列文章，要写成连贯的趋势洞见\n\n` +
            prompt;
    }

    try {
        const text = await aiClient.call(config.prompts.highlights.temperature, prompt);
        return text.trim();
    } catch (error) {
        console.warn(`[digest] Highlights generation failed: ${error instanceof Error ? error.message : String(error)}`);
        return '';
    }
}
