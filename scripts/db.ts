// --- 兼容性DB连接
// 首先尝试bun:sqlite，如果失败则使用better-sqlite3
let Database: any;
let db: any;

try {
  // 尝试Bun的SQLite
  Database = require('bun:sqlite').Database;
  console.log('[db] Using bun:sqlite');
} catch (bunError) {
  try {
    // 如果Bun不可用，使用better-sqlite3
    Database = require('better-sqlite3');
    console.log('[db] Using better-sqlite3');
  } catch (sqliteError) {
    console.error('[db] Error: No SQLite module available');
    // 创建虚拟db对象
    db = {
      exec: () => {},
      transaction: (fn: () => void) => fn(),
      prepare: () => ({ run: () => {} }),
      all: () => []
    };
  }
}

// 如果成功加载了数据库类，创建数据库实例
if (Database && typeof Database === 'function') {
  try {
    db = new Database('./data/digest-history.db', { create: true });
  } catch (err) {
    console.error('[db] Failed to create database:', err);
    // 创建虚拟db对象
    db = {
      exec: () => {},
      transaction: (fn: () => void) => fn(),
      prepare: () => ({ run: () => {} }),
      all: () => []
    };
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS keyword_trends (
    keyword TEXT PRIMARY KEY,
    first_seen TEXT,
    last_seen TEXT,
    streak INTEGER DEFAULT 1,
    total_mentions INTEGER DEFAULT 0,
    today_mentions INTEGER DEFAULT 0,
    categories TEXT,
    sample_titles TEXT
  );
`);

import type { ScoredArticle } from './utils';

export function updateKeywordTrends(articles: ScoredArticle[]) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  db.transaction(() => {
    for (const art of articles) {
      for (const kw of art.keywords || []) {
        const normKw = kw.trim().toLowerCase();
        if (!normKw) continue;

        const existing = db.prepare(
          'SELECT * FROM keyword_trends WHERE keyword = ?'
        ).get(normKw);

        if (existing) {
          // 更新现有记录
          const newStreak = existing.last_seen === yesterday 
            ? existing.streak + 1 
            : 1;

          db.prepare(`
            UPDATE keyword_trends 
            SET last_seen = ?, 
                streak = ?, 
                total_mentions = total_mentions + 1,
                today_mentions = today_mentions + 1
            WHERE keyword = ?
          `).run(today, newStreak, normKw);
        } else {
          // 插入新记录
          db.prepare(`
            INSERT INTO keyword_trends 
            (keyword, first_seen, last_seen, streak, total_mentions, today_mentions, categories, sample_titles)
            VALUES (?, ?, ?, 1, 1, 1, ?, ?)
          `).run(
            normKw, 
            today, 
            today, 
            art.category || 'unknown',
            art.title?.slice(0, 100) || ''
          );
        }
      }
    }
  });
}

export function getKeywordTrendsSummary() {
  const rows = db.prepare(`
    SELECT 
      keyword,
      first_seen,
      last_seen,
      streak,
      total_mentions,
      today_mentions
    FROM keyword_trends 
    ORDER BY today_mentions DESC, total_mentions DESC
    LIMIT 20
  `).all();

  return rows.map((row: any) => ({
    keyword: row.keyword,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    streak: row.streak,
    total_mentions: row.total_mentions,
    today_mentions: row.today_mentions,
    trend: row.streak >= 3 ? '🔥热门' : row.today_mentions >= 2 ? '📈上涨' : '📊活跃'
  }));
}

export function getHistoricalTrendsForScoring(): string {
  try {
    const trends = getKeywordTrendsSummary();
    if (!trends || trends.length === 0) {
      return "暂无历史趋势数据";
    }
    
    // 格式化趋势数据为字符串
    return trends.map(t => 
      `${t.keyword}: 连续${t.streak}天${t.today_mentions}次，（今日${t.today_mentions}次）`
    ).join('\n');
  } catch (error) {
    console.error('[db] Error getting historical trends:', error);
    return "暂无历史趋势数据";
  }
}

// 清理过期数据（可选）
export function cleanupOldKeywords(daysToKeep = 30) {
  const cutoff = new Date(Date.now() - daysToKeep * 86400000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM keyword_trends WHERE last_seen < ?').run(cutoff);
  console.log(`[db] Cleaned up keywords older than ${daysToKeep} days`);
}