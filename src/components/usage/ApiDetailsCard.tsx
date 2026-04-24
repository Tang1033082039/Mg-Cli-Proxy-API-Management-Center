import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import {
  formatCompactNumber,
  formatPercentage,
  formatUsd,
  type ApiModelStats,
  type ApiStats,
} from '@/utils/usage';
import styles from '@/pages/UsagePage.module.scss';

export interface ApiDetailsCardProps {
  apiStats: ApiStats[];
  loading: boolean;
  hasPrices: boolean;
}

type ApiSortKey = 'endpoint' | 'requests' | 'tokens' | 'cost' | 'cacheRate';
type SortDir = 'asc' | 'desc';

type ApiMetricSource = Pick<
  ApiStats,
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedTokens'
  | 'reasoningTokens'
  | 'cacheRate'
  | 'inputCost'
  | 'outputCost'
  | 'cacheCost'
> & {
  requests: number;
  successCount: number;
  failureCount: number;
  totalTokens: number;
  totalCost: number;
};

const getApiMetrics = (api: ApiStats): ApiMetricSource => ({
  requests: api.totalRequests,
  successCount: api.successCount,
  failureCount: api.failureCount,
  totalTokens: api.totalTokens,
  totalCost: api.totalCost,
  inputTokens: api.inputTokens,
  outputTokens: api.outputTokens,
  cachedTokens: api.cachedTokens,
  reasoningTokens: api.reasoningTokens,
  cacheRate: api.cacheRate,
  inputCost: api.inputCost,
  outputCost: api.outputCost,
  cacheCost: api.cacheCost,
});

const getModelMetrics = (stats: ApiModelStats): ApiMetricSource => ({
  requests: stats.requests,
  successCount: stats.successCount,
  failureCount: stats.failureCount,
  totalTokens: stats.tokens,
  totalCost: stats.cost,
  inputTokens: stats.inputTokens,
  outputTokens: stats.outputTokens,
  cachedTokens: stats.cachedTokens,
  reasoningTokens: stats.reasoningTokens,
  cacheRate: stats.cacheRate,
  inputCost: stats.inputCost,
  outputCost: stats.outputCost,
  cacheCost: stats.cacheCost,
});

function ApiMetricsSummary({
  metrics,
  hasPrices,
  compact = false,
}: {
  metrics: ApiMetricSource;
  hasPrices: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const costValue = hasPrices ? formatUsd(metrics.totalCost) : '--';
  const inputCost = hasPrices ? formatUsd(metrics.inputCost) : '--';
  const outputCost = hasPrices ? formatUsd(metrics.outputCost) : '--';
  const cacheCost = hasPrices ? formatUsd(metrics.cacheCost) : '--';

  return (
    <div className={`${styles.apiMetricsSummary} ${compact ? styles.apiMetricsSummaryCompact : ''}`}>
      <span className={styles.apiMetricChip}>
        <span>{t('usage_stats.requests_count')}</span>
        <strong>{metrics.requests.toLocaleString()}</strong>
        <em>
          {metrics.failureCount > 0 ? (
            <>
              <span className={styles.statSuccess}>{metrics.successCount.toLocaleString()}</span>{' '}
              <span className={styles.statFailure}>{metrics.failureCount.toLocaleString()}</span>
            </>
          ) : (
            <span className={styles.statSuccess}>{metrics.successCount.toLocaleString()}</span>
          )}
        </em>
      </span>
      <span className={styles.apiMetricChip}>
        <span>{t('usage_stats.tokens_count')}</span>
        <strong>{formatCompactNumber(metrics.totalTokens)}</strong>
        <em>
          {t('usage_stats.input_tokens')} {formatCompactNumber(metrics.inputTokens)} ·{' '}
          {t('usage_stats.output_tokens')} {formatCompactNumber(metrics.outputTokens)}
        </em>
      </span>
      <span className={styles.apiMetricChip}>
        <span>{t('usage_stats.cached_tokens')}</span>
        <strong>{formatCompactNumber(metrics.cachedTokens)}</strong>
        <em>{cacheCost}</em>
      </span>
      <span className={styles.apiMetricChip}>
        <span>{t('usage_stats.cache_rate')}</span>
        <strong>{formatPercentage(metrics.cacheRate)}</strong>
      </span>
      {metrics.reasoningTokens > 0 && (
        <span className={styles.apiMetricChip}>
          <span>{t('usage_stats.reasoning_tokens')}</span>
          <strong>{formatCompactNumber(metrics.reasoningTokens)}</strong>
        </span>
      )}
      {hasPrices && (
        <span className={styles.apiMetricChip}>
          <span>{t('usage_stats.total_cost')}</span>
          <strong>{costValue}</strong>
          <em>
            {inputCost} / {outputCost}
          </em>
        </span>
      )}
    </div>
  );
}

export function ApiDetailsCard({ apiStats, loading, hasPrices }: ApiDetailsCardProps) {
  const { t } = useTranslation();
  const [expandedApis, setExpandedApis] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<ApiSortKey>('requests');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const toggleExpand = (endpoint: string) => {
    setExpandedApis((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(endpoint)) {
        newSet.delete(endpoint);
      } else {
        newSet.add(endpoint);
      }
      return newSet;
    });
  };

  const handleSort = (key: ApiSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'endpoint' ? 'asc' : 'desc');
    }
  };

  const sorted = useMemo(() => {
    const list = [...apiStats];
    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      switch (sortKey) {
        case 'endpoint': return dir * a.endpoint.localeCompare(b.endpoint);
        case 'requests': return dir * (a.totalRequests - b.totalRequests);
        case 'tokens': return dir * (a.totalTokens - b.totalTokens);
        case 'cost': return dir * (a.totalCost - b.totalCost);
        case 'cacheRate': return dir * (a.cacheRate - b.cacheRate);
        default: return 0;
      }
    });
    return list;
  }, [apiStats, sortKey, sortDir]);

  const arrow = (key: ApiSortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <Card title={t('usage_stats.api_details')} className={styles.detailsFixedCard}>
      {loading ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : sorted.length > 0 ? (
        <>
          <div className={styles.apiSortBar}>
            {([
              ['endpoint', 'usage_stats.api_endpoint'],
              ['requests', 'usage_stats.requests_count'],
              ['tokens', 'usage_stats.tokens_count'],
              ['cacheRate', 'usage_stats.cache_rate'],
              ...(hasPrices ? [['cost', 'usage_stats.total_cost']] : []),
            ] as [ApiSortKey, string][]).map(([key, labelKey]) => (
              <button
                key={key}
                type="button"
                aria-pressed={sortKey === key}
                className={`${styles.apiSortBtn} ${sortKey === key ? styles.apiSortBtnActive : ''}`}
                onClick={() => handleSort(key)}
              >
                {t(labelKey)}{arrow(key)}
              </button>
            ))}
          </div>
          <div className={styles.detailsScroll}>
            <div className={styles.apiList}>
              {sorted.map((api, index) => {
                const isExpanded = expandedApis.has(api.endpoint);
                const panelId = `api-models-${index}`;
                const modelEntries = Object.entries(api.models).sort(
                  (left, right) => right[1].requests - left[1].requests
                );

                return (
                  <div key={api.endpoint} className={styles.apiItem}>
                    <button
                      type="button"
                      className={styles.apiHeader}
                      onClick={() => toggleExpand(api.endpoint)}
                      aria-expanded={isExpanded}
                      aria-controls={panelId}
                    >
                      <div className={styles.apiInfo}>
                        <span className={styles.apiEndpoint}>{api.endpoint}</span>
                        <ApiMetricsSummary metrics={getApiMetrics(api)} hasPrices={hasPrices} />
                      </div>
                      <span className={styles.expandIcon}>
                        {isExpanded ? '▼' : '▶'}
                      </span>
                    </button>
                    {isExpanded && (
                      <div id={panelId} className={styles.apiModels}>
                        {modelEntries.map(([model, stats]) => (
                          <div key={model} className={styles.modelRow}>
                            <div className={styles.modelRowHeader}>
                              <span className={styles.modelName}>{model}</span>
                            </div>
                            <ApiMetricsSummary
                              metrics={getModelMetrics(stats)}
                              hasPrices={hasPrices}
                              compact
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : (
        <div className={styles.hint}>{t('usage_stats.no_data')}</div>
      )}
    </Card>
  );
}
