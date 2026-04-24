import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Line } from 'react-chartjs-2';
import {
  IconDiamond,
  IconDollarSign,
  IconRefreshCw,
  IconSatellite,
  IconTimer,
  IconTrendingUp,
} from '@/components/ui/icons';
import {
  LATENCY_SOURCE_FIELD,
  calculateLatencyStatsFromDetails,
  calculateCacheRate,
  calculateUsageMetrics,
  formatCompactNumber,
  formatDurationMs,
  formatPerMinuteValue,
  formatPercentage,
  formatUsd,
  collectUsageDetails,
  extractTokenMetrics,
  extractTotalTokens,
  type ModelPrice,
} from '@/utils/usage';
import { sparklineOptions } from '@/utils/usage/chartConfig';
import type { UsagePayload } from './hooks/useUsageData';
import type { SparklineBundle } from './hooks/useSparklines';
import styles from '@/pages/UsagePage.module.scss';

interface StatCardData {
  key: string;
  label: string;
  icon: ReactNode;
  accent: string;
  accentSoft: string;
  accentBorder: string;
  value: string;
  meta?: ReactNode;
  trend: SparklineBundle | null;
}

export interface StatCardsProps {
  usage: UsagePayload | null;
  loading: boolean;
  modelPrices: Record<string, ModelPrice>;
  nowMs: number;
  sparklines: {
    requests: SparklineBundle | null;
    tokens: SparklineBundle | null;
    rpm: SparklineBundle | null;
    tpm: SparklineBundle | null;
    cost: SparklineBundle | null;
  };
}

export function StatCards({ usage, loading, modelPrices, nowMs, sparklines }: StatCardsProps) {
  const { t } = useTranslation();
  const latencyHint = t('usage_stats.latency_unit_hint', {
    field: LATENCY_SOURCE_FIELD,
    unit: t('usage_stats.duration_unit_ms'),
  });

  const hasPrices = Object.keys(modelPrices).length > 0;

  const { usageMetrics, rateStats, latencyStats } = useMemo(() => {
    const empty = {
      usageMetrics: {
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          cacheRate: 0,
        },
        costs: {
          inputCost: 0,
          outputCost: 0,
          cacheCost: 0,
          totalCost: 0,
        },
      },
      rateStats: { rpm: 0, tpm: 0, windowMinutes: 30, requestCount: 0, tokenCount: 0 },
      latencyStats: {
        averageMs: null as number | null,
        totalMs: null as number | null,
        sampleCount: 0,
      },
    };

    if (!usage) return empty;
    const details = collectUsageDetails(usage);
    if (!details.length) return empty;

    const usageMetrics = calculateUsageMetrics(usage, modelPrices);
    const latencyStats = calculateLatencyStatsFromDetails(details);

    const now = nowMs;
    const windowMinutes = 30;
    const windowStart = now - windowMinutes * 60 * 1000;
    let requestCount = 0;
    let tokenCount = 0;
    const hasValidNow = Number.isFinite(now) && now > 0;

    details.forEach((detail) => {
      const timestamp = detail.__timestampMs ?? 0;
      if (
        hasValidNow &&
        Number.isFinite(timestamp) &&
        timestamp >= windowStart &&
        timestamp <= now
      ) {
        requestCount += 1;
        tokenCount += extractTotalTokens(detail);
      }
    });

    const denominator = windowMinutes > 0 ? windowMinutes : 1;
    return {
      usageMetrics,
      rateStats: {
        rpm: requestCount / denominator,
        tpm: tokenCount / denominator,
        windowMinutes,
        requestCount,
        tokenCount,
      },
      latencyStats,
    };
  }, [hasPrices, modelPrices, nowMs, usage]);

  const displayTotalTokens = usage?.total_tokens ?? usageMetrics.tokens.totalTokens;
  const displayCacheRate = calculateCacheRate(
    usageMetrics.tokens.cachedTokens,
    displayTotalTokens
  );
  const providerCacheRates = useMemo(() => {
    const buckets = new Map<string, { totalTokens: number; cachedTokens: number }>();
    collectUsageDetails(usage).forEach((detail) => {
      const source = String(detail.source ?? '').toLowerCase();
      const label = source.includes('claude')
        ? 'Claude'
        : source.includes('codex')
          ? 'Codex'
          : source.includes('openai')
            ? 'OpenAI'
            : source.includes('vertex')
              ? 'Vertex'
              : source.includes('gemini')
                ? 'Gemini'
                : t('usage_stats.other_provider');
      const tokenMetrics = extractTokenMetrics(detail);
      const current = buckets.get(label) ?? { totalTokens: 0, cachedTokens: 0 };
      current.totalTokens += tokenMetrics.totalTokens;
      current.cachedTokens += tokenMetrics.cachedTokens;
      buckets.set(label, current);
    });
    return Array.from(buckets.entries())
      .map(([label, bucket]) => ({
        label,
        cacheRate: calculateCacheRate(bucket.cachedTokens, bucket.totalTokens),
      }))
      .sort((a, b) => b.cacheRate - a.cacheRate)
      .slice(0, 5);
  }, [t, usage]);

  const statsCards: StatCardData[] = [
    {
      key: 'requests',
      label: t('usage_stats.total_requests'),
      icon: <IconSatellite size={16} />,
      accent: '#8b8680',
      accentSoft: 'rgba(139, 134, 128, 0.18)',
      accentBorder: 'rgba(139, 134, 128, 0.35)',
      value: loading ? '-' : (usage?.total_requests ?? 0).toLocaleString(),
      meta: (
        <>
          <span className={styles.statMetaItem}>
            <span className={styles.statMetaDot} style={{ backgroundColor: '#10b981' }} />
            {t('usage_stats.success_requests')}: {loading ? '-' : (usage?.success_count ?? 0)}
          </span>
          <span className={styles.statMetaItem}>
            <span className={styles.statMetaDot} style={{ backgroundColor: '#c65746' }} />
            {t('usage_stats.failed_requests')}: {loading ? '-' : (usage?.failure_count ?? 0)}
          </span>
          {latencyStats.sampleCount > 0 && (
            <span className={styles.statMetaItem} title={latencyHint}>
              {t('usage_stats.avg_time')}:{' '}
              {loading ? '-' : formatDurationMs(latencyStats.averageMs)}
            </span>
          )}
        </>
      ),
      trend: sparklines.requests,
    },
    {
      key: 'tokens',
      label: t('usage_stats.total_tokens'),
      icon: <IconDiamond size={16} />,
      accent: '#8b5cf6',
      accentSoft: 'rgba(139, 92, 246, 0.18)',
      accentBorder: 'rgba(139, 92, 246, 0.35)',
      value: loading ? '-' : formatCompactNumber(displayTotalTokens),
      meta: (
        <>
          <span className={styles.statMetaItem}>
            {t('usage_stats.input_tokens')}:{' '}
            {loading ? '-' : formatCompactNumber(usageMetrics.tokens.inputTokens)}
          </span>
          <span className={styles.statMetaItem}>
            {t('usage_stats.output_tokens')}:{' '}
            {loading ? '-' : formatCompactNumber(usageMetrics.tokens.outputTokens)}
          </span>
          <span className={styles.statMetaItem}>
            {t('usage_stats.cached_tokens')}:{' '}
            {loading ? '-' : formatCompactNumber(usageMetrics.tokens.cachedTokens)}
          </span>
          <span className={styles.statMetaItem}>
            {t('usage_stats.reasoning_tokens')}:{' '}
            {loading ? '-' : formatCompactNumber(usageMetrics.tokens.reasoningTokens)}
          </span>
        </>
      ),
      trend: sparklines.tokens,
    },
    {
      key: 'cacheRate',
      label: t('usage_stats.cache_rate'),
      icon: <IconRefreshCw size={16} />,
      accent: '#14b8a6',
      accentSoft: 'rgba(20, 184, 166, 0.18)',
      accentBorder: 'rgba(20, 184, 166, 0.35)',
      value: loading ? '-' : formatPercentage(displayCacheRate),
      meta: providerCacheRates.length ? (
        <div className={styles.providerCacheRateList}>
          {providerCacheRates.map((item) => (
            <span key={item.label} className={styles.providerCacheRateItem}>
              <span>{item.label}</span>
              <strong>{formatPercentage(item.cacheRate)}</strong>
            </span>
          ))}
        </div>
      ) : (
        <span className={styles.statMetaItem}>{t('usage_stats.no_data')}</span>
      ),
      trend: null,
    },
    {
      key: 'rpm',
      label: t('usage_stats.rpm_30m'),
      icon: <IconTimer size={16} />,
      accent: '#22c55e',
      accentSoft: 'rgba(34, 197, 94, 0.18)',
      accentBorder: 'rgba(34, 197, 94, 0.32)',
      value: loading ? '-' : formatPerMinuteValue(rateStats.rpm),
      meta: (
        <span className={styles.statMetaItem}>
          {t('usage_stats.total_requests')}:{' '}
          {loading ? '-' : rateStats.requestCount.toLocaleString()}
        </span>
      ),
      trend: sparklines.rpm,
    },
    {
      key: 'tpm',
      label: t('usage_stats.tpm_30m'),
      icon: <IconTrendingUp size={16} />,
      accent: '#f97316',
      accentSoft: 'rgba(249, 115, 22, 0.18)',
      accentBorder: 'rgba(249, 115, 22, 0.32)',
      value: loading ? '-' : formatPerMinuteValue(rateStats.tpm),
      meta: (
        <span className={styles.statMetaItem}>
          {t('usage_stats.total_tokens')}:{' '}
          {loading ? '-' : formatCompactNumber(rateStats.tokenCount)}
        </span>
      ),
      trend: sparklines.tpm,
    },
    {
      key: 'cost',
      label: t('usage_stats.total_cost'),
      icon: <IconDollarSign size={16} />,
      accent: '#f59e0b',
      accentSoft: 'rgba(245, 158, 11, 0.18)',
      accentBorder: 'rgba(245, 158, 11, 0.32)',
      value: loading ? '-' : hasPrices ? formatUsd(usageMetrics.costs.totalCost) : '--',
      meta: (
        <>
          <span className={styles.statMetaItem}>
            {t('usage_stats.input_cost')}:{' '}
            {loading ? '-' : hasPrices ? formatUsd(usageMetrics.costs.inputCost) : '--'}
          </span>
          <span className={styles.statMetaItem}>
            {t('usage_stats.output_cost')}:{' '}
            {loading ? '-' : hasPrices ? formatUsd(usageMetrics.costs.outputCost) : '--'}
          </span>
          <span className={styles.statMetaItem}>
            {t('usage_stats.cache_cost')}:{' '}
            {loading ? '-' : hasPrices ? formatUsd(usageMetrics.costs.cacheCost) : '--'}
          </span>
          {!hasPrices && (
            <span className={`${styles.statMetaItem} ${styles.statSubtle}`}>
              {t('usage_stats.cost_need_price')}
            </span>
          )}
        </>
      ),
      trend: hasPrices ? sparklines.cost : null,
    },
  ];

  return (
    <div className={styles.statsGrid}>
      {statsCards.map((card) => (
        <div
          key={card.key}
          className={styles.statCard}
          style={
            {
              '--accent': card.accent,
              '--accent-soft': card.accentSoft,
              '--accent-border': card.accentBorder,
            } as CSSProperties
          }
        >
          <div className={styles.statCardHeader}>
            <div className={styles.statLabelGroup}>
              <span className={styles.statLabel}>{card.label}</span>
            </div>
            <span className={styles.statIconBadge}>{card.icon}</span>
          </div>
          <div className={styles.statValue}>{card.value}</div>
          {card.meta && <div className={styles.statMetaRow}>{card.meta}</div>}
          <div className={styles.statTrend}>
            {card.trend ? (
              <Line
                className={styles.sparkline}
                data={card.trend.data}
                options={sparklineOptions}
              />
            ) : (
              <div className={styles.statTrendPlaceholder}></div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
