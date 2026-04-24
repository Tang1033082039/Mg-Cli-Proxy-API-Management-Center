import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { authFilesApi } from '@/services/api/authFiles';
import type { GeminiKeyConfig, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';
import type { AuthFileItem } from '@/types/authFile';
import type { CredentialInfo } from '@/types/sourceInfo';
import { buildSourceInfoMap, resolveSourceDisplay } from '@/utils/sourceResolver';
import {
  calculateCacheRate,
  collectUsageDetails,
  extractTokenMetrics,
  formatCompactNumber,
  formatPercentage,
  normalizeAuthIndex,
} from '@/utils/usage';
import type { UsagePayload } from './hooks/useUsageData';
import styles from '@/pages/UsagePage.module.scss';

export interface CredentialStatsCardProps {
  usage: UsagePayload | null;
  loading: boolean;
  geminiKeys: GeminiKeyConfig[];
  claudeConfigs: ProviderKeyConfig[];
  codexConfigs: ProviderKeyConfig[];
  tocodexConfigs?: ProviderKeyConfig[];
  vertexConfigs: ProviderKeyConfig[];
  openaiProviders: OpenAIProviderConfig[];
}

interface CredentialRow {
  key: string;
  displayName: string;
  type: string;
  success: number;
  failure: number;
  total: number;
  successRate: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheRate: number;
}

export function CredentialStatsCard({
  usage,
  loading,
  geminiKeys,
  claudeConfigs,
  codexConfigs,
  tocodexConfigs = [],
  vertexConfigs,
  openaiProviders,
}: CredentialStatsCardProps) {
  const { t } = useTranslation();
  const [authFileMap, setAuthFileMap] = useState<Map<string, CredentialInfo>>(new Map());

  useEffect(() => {
    let cancelled = false;

    authFilesApi
      .list()
      .then((res) => {
        if (cancelled) return;

        const files = Array.isArray(res) ? res : (res as { files?: AuthFileItem[] })?.files;
        if (!Array.isArray(files)) return;

        const map = new Map<string, CredentialInfo>();
        files.forEach((file) => {
          const key = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
          if (!key) return;

          map.set(key, {
            name: file.name || key,
            type: (file.type || file.provider || '').toString(),
          });
        });
        setAuthFileMap(map);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const sourceInfoMap = useMemo(
    () =>
      buildSourceInfoMap({
        geminiApiKeys: geminiKeys,
        claudeApiKeys: claudeConfigs,
        codexApiKeys: codexConfigs,
        tocodexApiKeys: tocodexConfigs,
        vertexApiKeys: vertexConfigs,
        openaiCompatibility: openaiProviders,
      }),
    [claudeConfigs, codexConfigs, geminiKeys, openaiProviders, tocodexConfigs, vertexConfigs]
  );

  const rows = useMemo((): CredentialRow[] => {
    if (!usage) return [];

    const rowMap = new Map<string, CredentialRow>();

    collectUsageDetails(usage).forEach((detail) => {
      const sourceInfo = resolveSourceDisplay(
        detail.source ?? '',
        detail.auth_index,
        sourceInfoMap,
        authFileMap
      );
      const key = sourceInfo.identityKey ?? sourceInfo.displayName;
      const row =
        rowMap.get(key) ??
        ({
          key,
          displayName: sourceInfo.displayName,
          type: sourceInfo.type,
          success: 0,
          failure: 0,
          total: 0,
          successRate: 100,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          cacheRate: 0,
        } satisfies CredentialRow);

      if (detail.failed === true) {
        row.failure += 1;
      } else {
        row.success += 1;
      }

      const tokenMetrics = extractTokenMetrics(detail);
      row.total = row.success + row.failure;
      row.successRate = row.total > 0 ? (row.success / row.total) * 100 : 100;
      row.totalTokens += tokenMetrics.totalTokens;
      row.inputTokens += tokenMetrics.inputTokens;
      row.outputTokens += tokenMetrics.outputTokens;
      row.cachedTokens += tokenMetrics.cachedTokens;
      row.cacheRate = calculateCacheRate(row.cachedTokens, row.totalTokens);
      rowMap.set(key, row);
    });

    return Array.from(rowMap.values()).sort((a, b) => b.total - a.total);
  }, [authFileMap, sourceInfoMap, usage]);

  return (
    <Card title={t('usage_stats.credential_stats')} className={styles.detailsFixedCard}>
      {loading ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rows.length > 0 ? (
        <div className={styles.detailsScroll}>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('usage_stats.credential_name')}</th>
                  <th>{t('usage_stats.requests_count')}</th>
                  <th>{t('usage_stats.total_tokens')}</th>
                  <th>{t('usage_stats.input_tokens')}</th>
                  <th>{t('usage_stats.output_tokens')}</th>
                  <th>{t('usage_stats.cached_tokens')}</th>
                  <th>{t('usage_stats.cache_rate')}</th>
                  <th>{t('usage_stats.success_rate')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td className={styles.modelCell}>
                      <span>{row.displayName}</span>
                      {row.type && <span className={styles.credentialType}>{row.type}</span>}
                    </td>
                    <td>
                      <span className={styles.requestCountCell}>
                        <span>{formatCompactNumber(row.total)}</span>
                        <span className={styles.requestBreakdown}>
                          (
                          <span className={styles.statSuccess}>
                            {row.success.toLocaleString()}
                          </span>{' '}
                          <span className={styles.statFailure}>
                            {row.failure.toLocaleString()}
                          </span>
                          )
                        </span>
                      </span>
                    </td>
                    <td>
                      {formatCompactNumber(row.totalTokens)}
                    </td>
                    <td>
                      {formatCompactNumber(row.inputTokens)}
                    </td>
                    <td>
                      {formatCompactNumber(row.outputTokens)}
                    </td>
                    <td>
                      {formatCompactNumber(row.cachedTokens)}
                    </td>
                    <td>
                      {formatPercentage(row.cacheRate)}
                    </td>
                    <td>
                      <span
                        className={
                          row.successRate >= 95
                            ? styles.statSuccess
                            : row.successRate >= 80
                              ? styles.statNeutral
                              : styles.statFailure
                        }
                      >
                        {row.successRate.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className={styles.hint}>{t('usage_stats.no_data')}</div>
      )}
    </Card>
  );
}
