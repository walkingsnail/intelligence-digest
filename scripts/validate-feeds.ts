// validate-feeds.ts
// 用法：bun validate-feeds.ts
// 功能：批量验证所有 feeds，更新 valid/lastChecked，并写回 feeds.json（带备份）

import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fetch, ProxyAgent } from "undici";
import { setTimeout as sleep } from 'node:timers/promises';

const CONFIG_PATH = './config/feeds.json';
const BACKUP_PATH = './config/feeds.json.bak';
const TIMEOUT_MS = 10000; // 10秒超时，验证时更短一点
const CONCURRENCY = 10;
const proxyAgent = new ProxyAgent("http://127.0.0.1:10808"); // 你的代理地址

interface FeedEntry {
    category: string;
    name: string;
    xmlUrl: string;
    htmlUrl: string;
    note?: string;
    active?: boolean;
    lastChecked?: string;
    valid?: boolean;
    // 其他字段忽略
}

interface Category {
    id: string;
    name: string;
    feeds: FeedEntry[];
}

interface Config {
    version: string;
    last_full_validation: string;
    default_fetch_interval_hours: number;
    note: string;
    categories: Category[];
}

async function loadConfig(): Promise<Config> {
    const data = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(data) as Config;
}

async function saveConfig(config: Config) {
    // 先备份
    try {
        await copyFile(CONFIG_PATH, BACKUP_PATH);
        console.log(`[validate] 已备份原文件到 ${BACKUP_PATH}`);
    } catch (err) {
        console.warn('[validate] 备份失败，继续保存（风险自担）:', err);
    }

    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[validate] 已更新 feeds.json`);
}

async function validateFeed(feed: FeedEntry): Promise<{ valid: boolean; reason?: string }> {
    const now = new Date().toISOString();

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(feed.xmlUrl, {
            method: 'HEAD', // 只 HEAD，不下载整个 body，节省流量
            signal: controller.signal,
            dispatcher: proxyAgent,
            headers: {
                "User-Agent": "Strategic-Intelligence-Validator/1.0",
            },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            return { valid: false, reason: `HTTP ${response.status}` };
        }

        // HEAD 成功后，再简单 GET + 解析检查（可选，但更准）
        // 这里为了速度，先只用 HEAD 成功算 valid
        // 如果你想更严格，可以加 parser.parseString(await response.text()) 检查是否是 RSS

        return { valid: true };

    } catch (err: any) {
        const msg = err.message || String(err);
        let reason = msg.includes('abort') ? 'timeout' : msg;
        if (reason.includes('ECONNREFUSED') || reason.includes('ENOTFOUND')) {
            reason = 'connection failed / not found';
        }
        return { valid: false, reason };
    }
}

async function main() {
    console.log(`[validate-feeds] 开始验证 feeds.json ...`);
    console.log(`[validate-feeds] 当前日期: ${new Date().toISOString()}`);

    let config: Config;
    try {
        config = await loadConfig();
    } catch (err) {
        console.error('[validate-feeds] 读取 feeds.json 失败:', err);
        process.exit(1);
    }

    const allFeeds: { feed: FeedEntry; categoryId: string }[] = [];
    for (const cat of config.categories) {
        for (const feed of cat.feeds || []) {
            if (feed.xmlUrl) {
                allFeeds.push({ feed, categoryId: cat.id });
            }
        }
    }

    console.log(`[validate-feeds] 共发现 ${allFeeds.length} 个 feed 需要验证`);

    const results: Array<{
        name: string;
        xmlUrl: string;
        wasValid: boolean | undefined;
        nowValid: boolean;
        reason?: string;
    }> = [];

    // 分批并发验证
    for (let i = 0; i < allFeeds.length; i += CONCURRENCY) {
        const batch = allFeeds.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.allSettled(
            batch.map(async ({ feed }) => {
                const { valid, reason } = await validateFeed(feed);
                return { feed, valid, reason };
            })
        );

        for (const result of batchResults) {
            if (result.status === 'fulfilled') {
                const { feed, valid, reason } = result.value;
                results.push({
                    name: feed.name,
                    xmlUrl: feed.xmlUrl,
                    wasValid: feed.valid,
                    nowValid: valid,
                    reason: valid ? undefined : reason,
                });

                // 更新内存中的 feed
                feed.lastChecked = new Date().toISOString();
                feed.valid = valid;
            } else {
                console.warn('[validate-feeds] 验证失败（未更新）:', result.reason);
            }
        }

        console.log(`[validate-feeds] 已验证 ${Math.min(i + CONCURRENCY, allFeeds.length)} / ${allFeeds.length}`);
        await sleep(100); // 轻微延迟，避免打爆代理或目标站
    }

    // 打印报告
    console.log('\n[validate-feeds] 验证报告：');
    console.log('─'.repeat(80));

    let changed = 0;
    let failed = 0;

    for (const r of results) {
        const status = r.nowValid ? '✅ OK' : `❌ FAIL (${r.reason})`;
        console.log(`${status}  |  ${r.name.padEnd(40)}  |  ${r.xmlUrl.slice(0, 60)}...`);

        if (r.nowValid !== r.wasValid) {
            changed++;
            if (!r.nowValid) failed++;
        }
    }

    console.log('─'.repeat(80));
    console.log(`总计 ${results.length} feeds，失败 ${failed} 个，变更 ${changed} 个`);
    console.log(`建议检查 FAIL 的 feed，手动修复或移除`);

    // 写回
    await saveConfig(config);

    console.log('[validate-feeds] 完成！下次 digest 运行将使用更新后的状态。');
}

main().catch(err => {
    console.error('[validate-feeds] 致命错误：', err);
    process.exit(1);
});