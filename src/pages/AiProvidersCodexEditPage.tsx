import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { HeaderInputList } from '@/components/ui/HeaderInputList';
import { ModelInputList } from '@/components/ui/ModelInputList';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useEdgeSwipeBack } from '@/hooks/useEdgeSwipeBack';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { SecondaryScreenShell } from '@/components/common/SecondaryScreenShell';
import { apiCallApi, getApiCallErrorMessage, modelsApi, providersApi } from '@/services/api';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import type { ApiKeyEntry, ProviderKeyConfig } from '@/types';
import { buildHeaderObject, headersToEntries, normalizeHeaderEntries } from '@/utils/headers';
import { areKeyValueEntriesEqual, areModelEntriesEqual, areStringArraysEqual } from '@/utils/compare';
import { entriesToModels, modelsToEntries } from '@/components/ui/modelInputListUtils';
import {
  buildApiKeyEntry,
  buildCodexResponsesCompactEndpoint,
  excludedModelsToText,
  parseExcludedModels,
} from '@/components/providers/utils';
import type { ProviderFormState } from '@/components/providers';
import { normalizeModelList, type ModelInfo } from '@/utils/models';
import {
  buildToCodexEndpoint,
  buildToCodexSignedHeaders,
  TOCODEX_DEFAULT_CHAT_PATH,
  TOCODEX_DEFAULT_MODELS_PATH,
  TOCODEX_DEFAULT_RESPONSES_PATH,
  TOCODEX_DEFAULT_TEST_PATH,
  normalizeToCodexRequestMode,
} from '@/utils/tocodex';
import layoutStyles from './AiProvidersEditLayout.module.scss';
import styles from './AiProvidersPage.module.scss';

type LocationState = { fromAiProviders?: boolean } | null;
type ProviderKind = 'codex' | 'tocodex';
type AiProvidersCodexEditPageProps = { provider?: ProviderKind };

type CodexFormState = ProviderFormState & {
  apiKeyEntries: ApiKeyEntry[];
};

type CodexKeyTestStatus = {
  status: 'idle' | 'loading' | 'success' | 'error';
  message: string;
};

const CODEX_TEST_TIMEOUT_MS = 30_000;
const CODEX_TEST_USER_AGENT =
  'codex-tui/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9 (codex-tui; 0.118.0)';
const TOCODEX_TEST_USER_AGENT = 'ToCodex/3.1.3';
const TOCODEX_DEFAULT_HMAC_SECRET = 'tc-hmac-s3cr3t-k3y-2026-tocodex-platform';

const withDefaultHeader = (
  headers: Record<string, string>,
  headerName: string,
  headerValue: string
): Record<string, string> => {
  if (Object.keys(headers).some((key) => key.toLowerCase() === headerName.toLowerCase())) {
    return headers;
  }
  return { ...headers, [headerName]: headerValue };
};

const inferToCodexTestPathFromBaseUrl = (
  baseUrl: string
): typeof TOCODEX_DEFAULT_CHAT_PATH | typeof TOCODEX_DEFAULT_RESPONSES_PATH => {
  const normalizedBaseUrl = baseUrl.trim().toLowerCase();
  if (!normalizedBaseUrl) return TOCODEX_DEFAULT_RESPONSES_PATH;
  try {
    const parsed = new URL(normalizedBaseUrl);
    if (parsed.pathname.replace(/\/+$/g, '').endsWith(TOCODEX_DEFAULT_CHAT_PATH)) {
      return TOCODEX_DEFAULT_CHAT_PATH;
    }
  } catch {
    if (normalizedBaseUrl.replace(/\/+$/g, '').endsWith(TOCODEX_DEFAULT_CHAT_PATH)) {
      return TOCODEX_DEFAULT_CHAT_PATH;
    }
  }
  return TOCODEX_DEFAULT_RESPONSES_PATH;
};

const buildKeyTestStatuses = (count: number): CodexKeyTestStatus[] =>
  Array.from({ length: Math.max(count, 1) }, () => ({ status: 'idle', message: '' }));

const buildEmptyForm = (provider: ProviderKind = 'codex'): CodexFormState => ({
  apiKey: '',
  apiKeyEntries: [provider === 'tocodex' ? buildToCodexApiKeyEntry() : buildApiKeyEntry()],
  priority: undefined,
  prefix: '',
  baseUrl: '',
  websockets: provider === 'codex' ? false : undefined,
  proxyUrl: '',
  requestMode: '',
  chatPath: '',
  responsesPath: '',
  responsesCompactPath: '',
  modelsPath: '',
  testPath: '',
  headers: [],
  models: [],
  excludedModels: [],
  modelEntries: [{ name: '', alias: '' }],
  excludedText: '',
});

const parseIndexParam = (value: string | undefined) => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const getErrorMessage = (err: unknown) => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '';
};

const hasUsableApiKeyEntry = (entry: ApiKeyEntry | undefined, requireHmacSecret: boolean) => {
  const apiKey = String(entry?.apiKey ?? '').trim();
  if (!apiKey) return false;
  if (!requireHmacSecret) return true;
  return Boolean(String(entry?.hmacSecret ?? '').trim() || TOCODEX_DEFAULT_HMAC_SECRET);
};

const buildToCodexApiKeyEntry = (input?: Partial<ApiKeyEntry>): ApiKeyEntry =>
  buildApiKeyEntry({
    ...input,
    hmacSecret: String(input?.hmacSecret ?? '').trim() || TOCODEX_DEFAULT_HMAC_SECRET,
  });

const resolveToCodexHmacSecret = (entry?: Pick<ApiKeyEntry, 'hmacSecret'> | null): string =>
  String(entry?.hmacSecret ?? '').trim() || TOCODEX_DEFAULT_HMAC_SECRET;

function StatusLoadingIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={styles.statusIconSpin}>
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 1A7 7 0 0 1 8 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function StatusSuccessIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="8" fill="var(--success-color, #22c55e)" />
      <path
        d="M4.5 8L7 10.5L11.5 6"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StatusErrorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="8" fill="var(--danger-color, #c65746)" />
      <path
        d="M5 5L11 11M11 5L5 11"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StatusIdleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" stroke="var(--text-tertiary, #9ca3af)" strokeWidth="2" />
    </svg>
  );
}

function StatusIcon({ status }: { status: CodexKeyTestStatus['status'] }) {
  switch (status) {
    case 'loading':
      return <StatusLoadingIcon />;
    case 'success':
      return <StatusSuccessIcon />;
    case 'error':
      return <StatusErrorIcon />;
    default:
      return <StatusIdleIcon />;
  }
}

const normalizeModelEntries = (entries: Array<{ name: string; alias: string }>) =>
  (entries ?? []).reduce<Array<{ name: string; alias: string }>>((acc, entry) => {
    const name = String(entry?.name ?? '').trim();
    let alias = String(entry?.alias ?? '').trim();
    if (name && alias === name) {
      alias = '';
    }
    if (!name && !alias) return acc;
    acc.push({ name, alias });
    return acc;
  }, []);

const normalizeCodexApiKeyEntries = (entries?: ApiKeyEntry[]) =>
  (entries ?? []).reduce<
    Array<{ apiKey: string; hmacSecret: string; proxyUrl: string; disabled: boolean }>
  >(
    (acc, entry) => {
      const apiKey = String(entry?.apiKey ?? '').trim();
      const hmacSecret = String(entry?.hmacSecret ?? '').trim();
      const proxyUrl = String(entry?.proxyUrl ?? '').trim();
      if (!apiKey && !hmacSecret && !proxyUrl) return acc;
      acc.push({ apiKey, hmacSecret, proxyUrl, disabled: entry?.disabled === true });
      return acc;
    },
    []
  );

const areNormalizedCodexApiKeyEntriesEqual = (
  a: ReturnType<typeof normalizeCodexApiKeyEntries>,
  b: ReturnType<typeof normalizeCodexApiKeyEntries>
) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (
      left.apiKey !== right.apiKey ||
      left.hmacSecret !== right.hmacSecret ||
      left.proxyUrl !== right.proxyUrl ||
      left.disabled !== right.disabled
    ) {
      return false;
    }
  }
  return true;
};

const codexConfigToApiKeyEntries = (
  config: ProviderKeyConfig,
  provider: ProviderKind = 'codex'
): ApiKeyEntry[] => {
  const buildEntry = provider === 'tocodex' ? buildToCodexApiKeyEntry : buildApiKeyEntry;
  const entries = config.apiKeyEntries?.length
    ? config.apiKeyEntries
    : config.apiKey
      ? [
          buildEntry({
            apiKey: config.apiKey,
            hmacSecret: config.hmacSecret,
            proxyUrl: config.proxyUrl,
            authIndex: config.authIndex,
          }),
        ]
      : [];
  return entries.length
    ? entries.map((entry) =>
        buildEntry({
          apiKey: entry.apiKey,
          hmacSecret: entry.hmacSecret,
          proxyUrl: entry.proxyUrl,
          authIndex: entry.authIndex,
          disabled: entry.disabled,
        })
      )
    : [buildEntry()];
};

type CodexFormBaseline = {
  apiKeyEntries: ReturnType<typeof normalizeCodexApiKeyEntries>;
  priority: number | null;
  prefix: string;
  baseUrl: string;
  websockets: boolean;
  proxyUrl: string;
  requestMode: string;
  chatPath: string;
  responsesPath: string;
  responsesCompactPath: string;
  modelsPath: string;
  testPath: string;
  headers: ReturnType<typeof normalizeHeaderEntries>;
  models: ReturnType<typeof normalizeModelEntries>;
  excludedModels: string[];
};

const buildCodexBaseline = (form: CodexFormState): CodexFormBaseline => ({
  apiKeyEntries: normalizeCodexApiKeyEntries(form.apiKeyEntries),
  priority:
    form.priority !== undefined && Number.isFinite(form.priority) ? Math.trunc(form.priority) : null,
  prefix: String(form.prefix ?? '').trim(),
  baseUrl: String(form.baseUrl ?? '').trim(),
  websockets: Boolean(form.websockets),
  proxyUrl: String(form.proxyUrl ?? '').trim(),
  requestMode: String(form.requestMode ?? '').trim(),
  chatPath: String(form.chatPath ?? '').trim(),
  responsesPath: String(form.responsesPath ?? '').trim(),
  responsesCompactPath: String(form.responsesCompactPath ?? '').trim(),
  modelsPath: String(form.modelsPath ?? '').trim(),
  testPath: String(form.testPath ?? '').trim(),
  headers: normalizeHeaderEntries(form.headers),
  models: normalizeModelEntries(form.modelEntries),
  excludedModels: parseExcludedModels(form.excludedText ?? ''),
});

export function AiProvidersCodexEditPage({
  provider = 'codex',
}: AiProvidersCodexEditPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ index?: string }>();
  const isToCodex = provider === 'tocodex';
  const configSection: 'codex-api-key' | 'tocodex-api-key' = isToCodex
    ? 'tocodex-api-key'
    : 'codex-api-key';

  const { showNotification } = useNotificationStore();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const disableControls = connectionStatus !== 'connected';

  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const updateConfigValue = useConfigStore((state) => state.updateConfigValue);
  const clearCache = useConfigStore((state) => state.clearCache);

  const [configs, setConfigs] = useState<ProviderKeyConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<CodexFormState>(() => buildEmptyForm(provider));
  const [baseline, setBaseline] = useState(() => buildCodexBaseline(buildEmptyForm(provider)));
  const [testModel, setTestModel] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [isTestingKeys, setIsTestingKeys] = useState(false);
  const [keyTestStatuses, setKeyTestStatuses] = useState<CodexKeyTestStatus[]>(() =>
    buildKeyTestStatuses(1)
  );

  const [modelDiscoveryOpen, setModelDiscoveryOpen] = useState(false);
  const [modelDiscoveryEndpoint, setModelDiscoveryEndpoint] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<ModelInfo[]>([]);
  const [modelDiscoveryFetching, setModelDiscoveryFetching] = useState(false);
  const [modelDiscoveryError, setModelDiscoveryError] = useState('');
  const [modelDiscoverySearch, setModelDiscoverySearch] = useState('');
  const [modelDiscoverySelected, setModelDiscoverySelected] = useState<Set<string>>(new Set());
  const autoFetchSignatureRef = useRef<string>('');
  const modelDiscoveryRequestIdRef = useRef(0);

  const hasIndexParam = typeof params.index === 'string';
  const editIndex = useMemo(() => parseIndexParam(params.index), [params.index]);
  const invalidIndexParam = hasIndexParam && editIndex === null;

  const initialData = useMemo(() => {
    if (editIndex === null) return undefined;
    return configs[editIndex];
  }, [configs, editIndex]);

  const invalidIndex = editIndex !== null && !initialData;

  const title =
    editIndex !== null
      ? t(isToCodex ? 'ai_providers.tocodex_edit_modal_title' : 'ai_providers.codex_edit_modal_title')
      : t(isToCodex ? 'ai_providers.tocodex_add_modal_title' : 'ai_providers.codex_add_modal_title');

  const handleBack = useCallback(() => {
    const state = location.state as LocationState;
    if (state?.fromAiProviders) {
      navigate(-1);
      return;
    }
    navigate('/ai-providers', { replace: true });
  }, [location.state, navigate]);

  const swipeRef = useEdgeSwipeBack({ onBack: handleBack });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleBack();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleBack]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    fetchConfig(configSection)
      .then((value) => {
        if (cancelled) return;
        setConfigs(Array.isArray(value) ? (value as ProviderKeyConfig[]) : []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : '';
        setError(message || t('notification.refresh_failed'));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [configSection, fetchConfig, t]);

  useEffect(() => {
    if (loading) return;

    if (initialData) {
      const nextRequestMode = isToCodex
        ? normalizeToCodexRequestMode(initialData.requestMode)
        : String(initialData.requestMode ?? '');
      const nextForm: CodexFormState = {
        ...buildEmptyForm(provider),
        ...initialData,
        requestMode: nextRequestMode,
        chatPath: isToCodex ? '' : String(initialData.chatPath ?? ''),
        responsesPath: isToCodex ? '' : String(initialData.responsesPath ?? ''),
        responsesCompactPath: isToCodex ? '' : String(initialData.responsesCompactPath ?? ''),
        modelsPath: isToCodex ? '' : String(initialData.modelsPath ?? ''),
        testPath: isToCodex ? '' : String(initialData.testPath ?? ''),
        apiKeyEntries: codexConfigToApiKeyEntries(initialData, provider),
        websockets: Boolean(initialData.websockets),
        headers: headersToEntries(initialData.headers),
        modelEntries: modelsToEntries(initialData.models),
        excludedText: excludedModelsToText(initialData.excludedModels),
      };
      setForm(nextForm);
      setBaseline(buildCodexBaseline(nextForm));
      setTestStatus('idle');
      setTestMessage('');
      setKeyTestStatuses(buildKeyTestStatuses(nextForm.apiKeyEntries.length));
      return;
    }
    const nextForm = buildEmptyForm(provider);
    setForm(nextForm);
    setBaseline(buildCodexBaseline(nextForm));
    setTestStatus('idle');
    setTestMessage('');
    setKeyTestStatuses(buildKeyTestStatuses(nextForm.apiKeyEntries.length));
  }, [initialData, loading, provider]);

  const normalizedHeaders = useMemo(() => normalizeHeaderEntries(form.headers), [form.headers]);
  const normalizedModels = useMemo(
    () => normalizeModelEntries(form.modelEntries),
    [form.modelEntries]
  );
  const normalizedExcludedModels = useMemo(
    () => parseExcludedModels(form.excludedText ?? ''),
    [form.excludedText]
  );
  const normalizedApiKeyEntries = useMemo(
    () => normalizeCodexApiKeyEntries(form.apiKeyEntries),
    [form.apiKeyEntries]
  );
  const normalizedPriority = useMemo(() => {
    return form.priority !== undefined && Number.isFinite(form.priority)
      ? Math.trunc(form.priority)
      : null;
  }, [form.priority]);
  const isHeadersDirty = useMemo(
    () => !areKeyValueEntriesEqual(baseline.headers, normalizedHeaders),
    [baseline.headers, normalizedHeaders]
  );
  const isModelsDirty = useMemo(
    () => !areModelEntriesEqual(baseline.models, normalizedModels),
    [baseline.models, normalizedModels]
  );
  const isExcludedModelsDirty = useMemo(
    () => !areStringArraysEqual(baseline.excludedModels, normalizedExcludedModels),
    [baseline.excludedModels, normalizedExcludedModels]
  );
  const isApiKeyEntriesDirty = useMemo(
    () => !areNormalizedCodexApiKeyEntriesEqual(baseline.apiKeyEntries, normalizedApiKeyEntries),
    [baseline.apiKeyEntries, normalizedApiKeyEntries]
  );
  const isDirty =
    isApiKeyEntriesDirty ||
    baseline.priority !== normalizedPriority ||
    baseline.prefix !== String(form.prefix ?? '').trim() ||
    baseline.baseUrl !== String(form.baseUrl ?? '').trim() ||
    baseline.websockets !== Boolean(form.websockets) ||
    baseline.proxyUrl !== String(form.proxyUrl ?? '').trim() ||
    baseline.requestMode !== String(form.requestMode ?? '').trim() ||
    baseline.chatPath !== String(form.chatPath ?? '').trim() ||
    baseline.responsesPath !== String(form.responsesPath ?? '').trim() ||
    baseline.responsesCompactPath !== String(form.responsesCompactPath ?? '').trim() ||
    baseline.modelsPath !== String(form.modelsPath ?? '').trim() ||
    baseline.testPath !== String(form.testPath ?? '').trim() ||
    isHeadersDirty ||
    isModelsDirty ||
    isExcludedModelsDirty;
  const canGuard = !loading && !saving && !invalidIndexParam && !invalidIndex;

  const { allowNextNavigation } = useUnsavedChangesGuard({
    enabled: canGuard,
    shouldBlock: ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname,
    dialog: {
      title: t('common.unsaved_changes_title'),
      message: t('common.unsaved_changes_message'),
      confirmText: t('common.leave'),
      cancelText: t('common.stay'),
      variant: 'danger',
    },
  });

  const canSave =
    !disableControls && !saving && !loading && !invalidIndexParam && !invalidIndex && !isTestingKeys;

  const discoveredModelsFiltered = useMemo(() => {
    const filter = modelDiscoverySearch.trim().toLowerCase();
    if (!filter) return discoveredModels;
    return discoveredModels.filter((model) => {
      const name = (model.name || '').toLowerCase();
      const alias = (model.alias || '').toLowerCase();
      const description = (model.description || '').toLowerCase();
      return name.includes(filter) || alias.includes(filter) || description.includes(filter);
    });
  }, [discoveredModels, modelDiscoverySearch]);
  const visibleDiscoveredModelNames = useMemo(
    () => discoveredModelsFiltered.map((model) => model.name),
    [discoveredModelsFiltered]
  );
  const allVisibleDiscoveredSelected = useMemo(
    () =>
      visibleDiscoveredModelNames.length > 0 &&
      visibleDiscoveredModelNames.every((name) => modelDiscoverySelected.has(name)),
    [modelDiscoverySelected, visibleDiscoveredModelNames]
  );
  const modelDiscoveryEntry = useMemo(
    () =>
      form.apiKeyEntries.find(
        (entry) => !entry.disabled && hasUsableApiKeyEntry(entry, isToCodex)
      ) ||
      form.apiKeyEntries.find((entry) => hasUsableApiKeyEntry(entry, isToCodex)) ||
      null,
    [form.apiKeyEntries, isToCodex]
  );
  const modelDiscoveryApiKey = useMemo(
    () => modelDiscoveryEntry?.apiKey.trim() || form.apiKey.trim(),
    [form.apiKey, modelDiscoveryEntry]
  );
  const modelDiscoveryHmacSecret = useMemo(
    () =>
      isToCodex
        ? resolveToCodexHmacSecret(modelDiscoveryEntry)
        : modelDiscoveryEntry?.hmacSecret?.trim() || form.hmacSecret?.trim() || '',
    [form.hmacSecret, isToCodex, modelDiscoveryEntry]
  );
  const modelDiscoveryProxyUrl = useMemo(
    () => modelDiscoveryEntry?.proxyUrl?.trim() || form.proxyUrl?.trim() || '',
    [form.proxyUrl, modelDiscoveryEntry]
  );
  const baseUrl = String(form.baseUrl ?? '').trim();
  const toCodexTestPath = useMemo(() => inferToCodexTestPathFromBaseUrl(baseUrl), [baseUrl]);
  const toCodexRequestMode = toCodexTestPath === TOCODEX_DEFAULT_CHAT_PATH ? 'chat' : 'responses';
  const toCodexTestMode = toCodexTestPath === TOCODEX_DEFAULT_CHAT_PATH ? 'chat' : 'responses';
  const availableModels = useMemo(
    () => form.modelEntries.map((entry) => entry.name.trim()).filter(Boolean),
    [form.modelEntries]
  );
  const modelSelectOptions = useMemo(() => {
    const seen = new Set<string>();
    return form.modelEntries.reduce<Array<{ value: string; label: string }>>((acc, entry) => {
      const name = entry.name.trim();
      if (!name || seen.has(name)) return acc;
      seen.add(name);
      const alias = entry.alias.trim();
      acc.push({
        value: name,
        label: alias && alias !== name ? `${name} (${alias})` : name,
      });
      return acc;
    }, []);
  }, [form.modelEntries]);
  const hasConfiguredModels = availableModels.length > 0;
  const hasTestableKeys = form.apiKeyEntries.some((entry) => hasUsableApiKeyEntry(entry, isToCodex));
  const failedKeyIndexes = useMemo(
    () =>
      keyTestStatuses.reduce<number[]>((acc, status, index) => {
        if (
          status?.status === 'error' &&
          hasUsableApiKeyEntry(form.apiKeyEntries[index], isToCodex)
        ) {
          acc.push(index);
        }
        return acc;
      }, []),
    [form.apiKeyEntries, isToCodex, keyTestStatuses]
  );
  const connectivityConfigSignature = useMemo(() => {
    const headersSignature = form.headers
      .map((entry) => `${entry.key.trim()}:${entry.value.trim()}`)
      .join('|');
    const modelsSignature = form.modelEntries
      .map((entry) => `${entry.name.trim()}:${entry.alias.trim()}`)
      .join('|');
    return [
      provider,
      baseUrl,
      form.proxyUrl?.trim() || '',
      isToCodex ? toCodexRequestMode : form.requestMode?.trim() || '',
      form.chatPath?.trim() || '',
      form.responsesPath?.trim() || '',
      form.responsesCompactPath?.trim() || '',
      form.modelsPath?.trim() || '',
      isToCodex ? toCodexTestPath : form.testPath?.trim() || '',
      testModel.trim(),
      headersSignature,
      modelsSignature,
    ].join('||');
  }, [
    baseUrl,
    form.chatPath,
    form.headers,
    form.modelEntries,
    form.modelsPath,
    form.proxyUrl,
    form.responsesCompactPath,
    form.responsesPath,
    isToCodex,
    provider,
    testModel,
    toCodexRequestMode,
    toCodexTestPath,
  ]);
  const previousConnectivityConfigRef = useRef(connectivityConfigSignature);

  useEffect(() => {
    setKeyTestStatuses(buildKeyTestStatuses(form.apiKeyEntries.length));
  }, [form.apiKeyEntries.length]);

  useEffect(() => {
    if (previousConnectivityConfigRef.current === connectivityConfigSignature) {
      return;
    }
    previousConnectivityConfigRef.current = connectivityConfigSignature;
    setKeyTestStatuses(buildKeyTestStatuses(form.apiKeyEntries.length));
    setTestStatus('idle');
    setTestMessage('');
  }, [connectivityConfigSignature, form.apiKeyEntries.length]);

  useEffect(() => {
    if (testModel && availableModels.includes(testModel)) {
      return;
    }
    setTestModel(availableModels[0] || '');
  }, [availableModels, testModel]);

  const setKeyTestStatus = useCallback((index: number, nextStatus: CodexKeyTestStatus) => {
    setKeyTestStatuses((prev) => {
      const next = prev.length === form.apiKeyEntries.length ? [...prev] : buildKeyTestStatuses(form.apiKeyEntries.length);
      next[index] = nextStatus;
      return next;
    });
  }, [form.apiKeyEntries.length]);

  const resetTestState = useCallback((count?: number) => {
    setKeyTestStatuses(buildKeyTestStatuses(count ?? form.apiKeyEntries.length));
    setTestStatus('idle');
    setTestMessage('');
  }, [form.apiKeyEntries.length]);

  const mergeDiscoveredModels = useCallback(
    (selectedModels: ModelInfo[]) => {
      if (!selectedModels.length) return;

      let addedCount = 0;
      setForm((prev) => {
        const mergedMap = new Map<string, { name: string; alias: string }>();
        prev.modelEntries.forEach((entry) => {
          const name = entry.name.trim();
          if (!name) return;
          mergedMap.set(name.toLowerCase(), { name, alias: entry.alias?.trim() || '' });
        });

        selectedModels.forEach((model) => {
          const name = String(model.name ?? '').trim();
          if (!name) return;
          const key = name.toLowerCase();
          if (mergedMap.has(key)) return;
          mergedMap.set(key, { name, alias: model.alias ?? '' });
          addedCount += 1;
        });

        const mergedEntries = Array.from(mergedMap.values());
        return {
          ...prev,
          modelEntries: mergedEntries.length ? mergedEntries : [{ name: '', alias: '' }],
        };
      });

      if (addedCount > 0) {
        showNotification(
          t('ai_providers.codex_models_fetch_added', { count: addedCount }),
          'success'
        );
      }
    },
    [setForm, showNotification, t]
  );

  const runSingleKeyTest = useCallback(
    async (keyIndex: number): Promise<boolean> => {
      if (!baseUrl) {
        showNotification(
          t(isToCodex ? 'notification.tocodex_test_url_required' : 'notification.codex_test_url_required'),
          'error'
        );
        return false;
      }

      const endpoint = isToCodex
        ? buildToCodexEndpoint(baseUrl, toCodexTestPath, TOCODEX_DEFAULT_TEST_PATH)
        : buildCodexResponsesCompactEndpoint(baseUrl);
      if (!endpoint) {
        showNotification(
          t(isToCodex ? 'notification.tocodex_test_url_required' : 'notification.codex_test_url_required'),
          'error'
        );
        return false;
      }

      const keyEntry = form.apiKeyEntries[keyIndex];
      if (!keyEntry?.apiKey?.trim()) {
        setKeyTestStatus(keyIndex, {
          status: 'error',
          message: t(
            isToCodex ? 'notification.tocodex_test_key_required' : 'notification.codex_test_key_required'
          ),
        });
        return false;
      }
      const hmacSecret = isToCodex ? resolveToCodexHmacSecret(keyEntry) : '';

      const modelName = testModel.trim() || availableModels[0] || '';
      if (!modelName) {
        showNotification(t('notification.codex_test_model_required'), 'error');
        return false;
      }

      const customHeaders = isToCodex
        ? withDefaultHeader(buildHeaderObject(form.headers), 'User-Agent', TOCODEX_TEST_USER_AGENT)
        : buildHeaderObject(form.headers);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Connection: 'Keep-Alive',
        ...customHeaders,
      };
      if (!isToCodex && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
        headers.Authorization = `Bearer ${keyEntry.apiKey.trim()}`;
      }
      if (!isToCodex && !Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) {
        headers['User-Agent'] = CODEX_TEST_USER_AGENT;
      }

      setKeyTestStatus(keyIndex, { status: 'loading', message: '' });

      try {
        const resolvedHeaders = isToCodex
          ? await buildToCodexSignedHeaders({
              method: 'POST',
              endpoint,
              apiKey: keyEntry.apiKey.trim(),
              hmacSecret,
              customHeaders,
            })
          : headers;
        const requestBody = isToCodex
          ? toCodexTestMode === 'chat'
            ? JSON.stringify({
                model: modelName,
                messages: [{ role: 'user', content: 'Hi' }],
                stream: false,
              })
            : JSON.stringify({
                model: modelName,
                input: 'Hi',
                stream: false,
              })
          : JSON.stringify({
              model: modelName,
              input: 'Hi',
            });
        const result = await apiCallApi.request(
          {
            method: 'POST',
            url: endpoint,
            proxyUrl: keyEntry.proxyUrl?.trim() || form.proxyUrl?.trim() || undefined,
            header: resolvedHeaders,
            data: requestBody,
          },
          { timeout: CODEX_TEST_TIMEOUT_MS }
        );

        if (result.statusCode < 200 || result.statusCode >= 300) {
          throw new Error(getApiCallErrorMessage(result));
        }

        setKeyTestStatus(keyIndex, { status: 'success', message: '' });
        return true;
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        const errorCode =
          typeof err === 'object' && err !== null && 'code' in err
            ? String((err as { code?: string }).code)
            : '';
        const isTimeout = errorCode === 'ECONNABORTED' || message.toLowerCase().includes('timeout');
        setKeyTestStatus(keyIndex, {
          status: 'error',
          message: isTimeout
            ? t('ai_providers.codex_test_timeout', { seconds: CODEX_TEST_TIMEOUT_MS / 1000 })
            : message,
        });
        return false;
      }
    },
    [
      availableModels,
      baseUrl,
      form.apiKeyEntries,
      form.headers,
      form.proxyUrl,
      isToCodex,
      setKeyTestStatus,
      showNotification,
      t,
      testModel,
      toCodexTestMode,
      toCodexTestPath,
    ]
  );

  const testSingleKey = useCallback(
    async (keyIndex: number): Promise<boolean> => {
      if (isTestingKeys) return false;
      setIsTestingKeys(true);
      setTestStatus('loading');
      setTestMessage(t(isToCodex ? 'ai_providers.tocodex_test_running' : 'ai_providers.codex_test_running'));
      try {
        const passed = await runSingleKeyTest(keyIndex);
        if (passed) {
          setTestStatus('success');
          setTestMessage(t(isToCodex ? 'ai_providers.tocodex_test_success' : 'ai_providers.codex_test_success'));
        } else {
          setTestStatus('error');
          setTestMessage(t('ai_providers.codex_test_failed'));
        }
        return passed;
      } finally {
        setIsTestingKeys(false);
      }
    },
    [isTestingKeys, isToCodex, runSingleKeyTest, t]
  );

  const testAllKeys = useCallback(async () => {
    if (isTestingKeys) return;

    if (!baseUrl) {
      const message = t(
        isToCodex ? 'notification.tocodex_test_url_required' : 'notification.codex_test_url_required'
      );
      setTestStatus('error');
      setTestMessage(message);
      showNotification(message, 'error');
      return;
    }

    const endpoint = isToCodex
      ? buildToCodexEndpoint(baseUrl, toCodexTestPath, TOCODEX_DEFAULT_TEST_PATH)
      : buildCodexResponsesCompactEndpoint(baseUrl);
    if (!endpoint) {
      const message = t(
        isToCodex ? 'notification.tocodex_test_url_required' : 'notification.codex_test_url_required'
      );
      setTestStatus('error');
      setTestMessage(message);
      showNotification(message, 'error');
      return;
    }

    const modelName = testModel.trim() || availableModels[0] || '';
    if (!modelName) {
      const message = t('notification.codex_test_model_required');
      setTestStatus('error');
      setTestMessage(message);
      showNotification(message, 'error');
      return;
    }

    const validKeyIndexes = form.apiKeyEntries
      .map((entry, index) => (hasUsableApiKeyEntry(entry, isToCodex) ? index : -1))
      .filter((index) => index >= 0);
    if (validKeyIndexes.length === 0) {
      const message = t(
        isToCodex ? 'notification.tocodex_test_key_required' : 'notification.codex_test_key_required'
      );
      setTestStatus('error');
      setTestMessage(message);
      showNotification(message, 'error');
      return;
    }

    setIsTestingKeys(true);
    setTestStatus('loading');
    setTestMessage(t(isToCodex ? 'ai_providers.tocodex_test_running' : 'ai_providers.codex_test_running'));
    setKeyTestStatuses(buildKeyTestStatuses(form.apiKeyEntries.length));

    try {
      const results = await Promise.all(validKeyIndexes.map((index) => runSingleKeyTest(index)));
      const successCount = results.filter(Boolean).length;
      const failedCount = validKeyIndexes.length - successCount;

      if (failedCount === 0) {
        const message = t('ai_providers.codex_test_all_success', { count: successCount });
        setTestStatus('success');
        setTestMessage(message);
        showNotification(message, 'success');
      } else if (successCount === 0) {
        const message = t('ai_providers.codex_test_all_failed', { count: failedCount });
        setTestStatus('error');
        setTestMessage(message);
        showNotification(message, 'error');
      } else {
        const message = t('ai_providers.codex_test_all_partial', {
          success: successCount,
          failed: failedCount,
        });
        setTestStatus('error');
        setTestMessage(message);
        showNotification(message, 'warning');
      }
    } finally {
      setIsTestingKeys(false);
    }
  }, [
    availableModels,
    baseUrl,
    form.apiKeyEntries,
    isTestingKeys,
    isToCodex,
    runSingleKeyTest,
    showNotification,
    t,
    testModel,
    toCodexTestPath,
  ]);

  const disableFailedKeys = useCallback(() => {
    if (!failedKeyIndexes.length) return;
    setForm((prev) => ({
      ...prev,
      apiKeyEntries: prev.apiKeyEntries.map((entry, index) =>
        failedKeyIndexes.includes(index) ? { ...entry, disabled: true } : entry
      ),
    }));
    setTestStatus('idle');
    setTestMessage('');
    showNotification(
      t('notification.codex_failed_keys_disabled', { count: failedKeyIndexes.length }),
      'success'
    );
  }, [failedKeyIndexes, showNotification, t]);

  const removeFailedKeys = useCallback(() => {
    if (!failedKeyIndexes.length) return;
    const failedSet = new Set(failedKeyIndexes);
    setForm((prev) => {
      const nextEntries = prev.apiKeyEntries.filter((_, index) => !failedSet.has(index));
      return {
        ...prev,
        apiKeyEntries: nextEntries.length
          ? nextEntries
          : [isToCodex ? buildToCodexApiKeyEntry() : buildApiKeyEntry()],
      };
    });
    setKeyTestStatuses((prev) => {
      const nextStatuses = prev.filter((_, index) => !failedSet.has(index));
      return nextStatuses.length ? nextStatuses : buildKeyTestStatuses(1);
    });
    setTestStatus('idle');
    setTestMessage('');
    showNotification(
      t('notification.codex_failed_keys_removed', { count: failedKeyIndexes.length }),
      'success'
    );
  }, [failedKeyIndexes, isToCodex, showNotification, t]);

  const fetchCodexModelDiscovery = useCallback(async () => {
    const requestId = (modelDiscoveryRequestIdRef.current += 1);
    setModelDiscoveryFetching(true);
    setModelDiscoveryError('');

    try {
      const headerObject = isToCodex
        ? withDefaultHeader(buildHeaderObject(form.headers), 'User-Agent', TOCODEX_TEST_USER_AGENT)
        : buildHeaderObject(form.headers);
      let list: ModelInfo[] = [];
      if (isToCodex) {
        const endpoint = buildToCodexEndpoint(
          form.baseUrl ?? '',
          TOCODEX_DEFAULT_MODELS_PATH,
          TOCODEX_DEFAULT_MODELS_PATH
        );
        if (!endpoint) {
          throw new Error(t('notification.tocodex_test_url_required'));
        }
        if (!modelDiscoveryApiKey) {
          throw new Error(t('notification.tocodex_test_key_required'));
        }
        if (!modelDiscoveryHmacSecret) {
          throw new Error(t('notification.tocodex_hmac_secret_required'));
        }
        const resolvedHeaders = await buildToCodexSignedHeaders({
          method: 'GET',
          endpoint,
          apiKey: modelDiscoveryApiKey,
          hmacSecret: modelDiscoveryHmacSecret,
          customHeaders: headerObject,
          contentType: null,
        });
        const result = await apiCallApi.request({
          method: 'GET',
          url: endpoint,
          proxyUrl: modelDiscoveryProxyUrl || undefined,
          header: resolvedHeaders,
        });
        if (result.statusCode < 200 || result.statusCode >= 300) {
          throw new Error(getApiCallErrorMessage(result));
        }
        list = normalizeModelList(result.body ?? result.bodyText, { dedupe: true });
      } else {
        const hasCustomAuthorization = Object.keys(headerObject).some(
          (key) => key.toLowerCase() === 'authorization'
        );
        const apiKey = modelDiscoveryApiKey || undefined;
        list = await modelsApi.fetchV1ModelsViaApiCall(
          form.baseUrl ?? '',
          hasCustomAuthorization ? undefined : apiKey,
          headerObject
        );
      }
      if (modelDiscoveryRequestIdRef.current !== requestId) return;
      setDiscoveredModels(list);
    } catch (err: unknown) {
      if (modelDiscoveryRequestIdRef.current !== requestId) return;
      setDiscoveredModels([]);
      const message = getErrorMessage(err);
      setModelDiscoveryError(`${t('ai_providers.codex_models_fetch_error')}: ${message}`);
    } finally {
      if (modelDiscoveryRequestIdRef.current === requestId) {
        setModelDiscoveryFetching(false);
      }
    }
  }, [
    form.baseUrl,
    form.headers,
    isToCodex,
    modelDiscoveryApiKey,
    modelDiscoveryHmacSecret,
    modelDiscoveryProxyUrl,
    t,
  ]);

  useEffect(() => {
    if (!modelDiscoveryOpen) {
      autoFetchSignatureRef.current = '';
      modelDiscoveryRequestIdRef.current += 1;
      setModelDiscoveryFetching(false);
      return;
    }

    const nextEndpoint = isToCodex
      ? buildToCodexEndpoint(
          form.baseUrl ?? '',
          TOCODEX_DEFAULT_MODELS_PATH,
          TOCODEX_DEFAULT_MODELS_PATH
        )
      : modelsApi.buildV1ModelsEndpoint(form.baseUrl ?? '');
    setModelDiscoveryEndpoint(nextEndpoint);
    setDiscoveredModels([]);
    setModelDiscoverySearch('');
    setModelDiscoverySelected(new Set());
    setModelDiscoveryError('');

    if (!nextEndpoint) return;

    const headerObject = buildHeaderObject(form.headers);
    const hasCustomAuthorization = Object.keys(headerObject).some(
      (key) => key.toLowerCase() === 'authorization'
    );
    const hasApiKeyField = Boolean(modelDiscoveryApiKey);
    const hasHmacSecretField = Boolean(modelDiscoveryHmacSecret);
    const canAutoFetch = hasApiKeyField || hasCustomAuthorization;
    const canAutoFetchToCodex = hasApiKeyField && hasHmacSecretField;

    if (isToCodex ? !canAutoFetchToCodex : !canAutoFetch) return;

    const headerSignature = Object.entries(headerObject)
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([key, value]) => `${key}:${value}`)
      .join('|');
    const signature = `${nextEndpoint}||${modelDiscoveryApiKey}||${modelDiscoveryHmacSecret}||${modelDiscoveryProxyUrl}||${headerSignature}`;
    if (autoFetchSignatureRef.current === signature) return;
    autoFetchSignatureRef.current = signature;

    void fetchCodexModelDiscovery();
  }, [
    fetchCodexModelDiscovery,
    form.baseUrl,
    form.headers,
    isToCodex,
    modelDiscoveryApiKey,
    modelDiscoveryHmacSecret,
    modelDiscoveryOpen,
    modelDiscoveryProxyUrl,
  ]);

  useEffect(() => {
    const availableNames = new Set(discoveredModels.map((model) => model.name));
    setModelDiscoverySelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((name) => {
        if (availableNames.has(name)) {
          next.add(name);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [discoveredModels]);

  const toggleModelDiscoverySelection = (name: string) => {
    setModelDiscoverySelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleSelectVisibleDiscoveredModels = useCallback(() => {
    setModelDiscoverySelected((prev) => {
      const next = new Set(prev);
      visibleDiscoveredModelNames.forEach((name) => next.add(name));
      return next;
    });
  }, [visibleDiscoveredModelNames]);

  const handleClearDiscoveredModelSelection = useCallback(() => {
    setModelDiscoverySelected(new Set());
  }, []);

  const handleApplyDiscoveredModels = () => {
    const selectedModels = discoveredModels.filter((model) =>
      modelDiscoverySelected.has(model.name)
    );
    if (selectedModels.length) {
      mergeDiscoveredModels(selectedModels);
    }
    setModelDiscoveryOpen(false);
  };

  const handleSave = useCallback(async () => {
    if (!canSave) return;

    const trimmedBaseUrl = (form.baseUrl ?? '').trim();
    const baseUrl = trimmedBaseUrl || undefined;
    if (!baseUrl) {
      showNotification(
        t(isToCodex ? 'notification.tocodex_base_url_required' : 'notification.codex_base_url_required'),
        'error'
      );
      return;
    }
    const apiKeyEntries = form.apiKeyEntries
      .map((entry) => ({
        apiKey: entry.apiKey.trim(),
        hmacSecret: isToCodex ? resolveToCodexHmacSecret(entry) : entry.hmacSecret?.trim() || undefined,
        proxyUrl: entry.proxyUrl?.trim() || undefined,
        disabled: entry.disabled === true,
      }))
      .filter((entry) => entry.apiKey);
    if (!apiKeyEntries.length) {
      showNotification(
        t(isToCodex ? 'notification.tocodex_api_key_required' : 'notification.codex_api_key_required'),
        'error'
      );
      return;
    }

    setSaving(true);
    setError('');
    try {
      const inferredTestPath = inferToCodexTestPathFromBaseUrl(baseUrl);
      const inferredRequestMode = inferredTestPath === TOCODEX_DEFAULT_CHAT_PATH ? 'chat' : 'responses';
      const payload: ProviderKeyConfig = {
        apiKey: '',
        apiKeyEntries,
        priority: form.priority !== undefined ? Math.trunc(form.priority) : undefined,
        prefix: form.prefix?.trim() || undefined,
        baseUrl,
        websockets: isToCodex ? undefined : Boolean(form.websockets),
        proxyUrl: form.proxyUrl?.trim() || undefined,
        requestMode: isToCodex ? inferredRequestMode : undefined,
        chatPath: undefined,
        responsesPath: undefined,
        responsesCompactPath: undefined,
        modelsPath: undefined,
        testPath: isToCodex ? inferredTestPath : undefined,
        headers: buildHeaderObject(form.headers),
        models: entriesToModels(form.modelEntries),
        excludedModels: parseExcludedModels(form.excludedText),
      };

      const nextList =
        editIndex !== null
          ? configs.map((item, idx) => (idx === editIndex ? payload : item))
          : [...configs, payload];

      if (isToCodex) {
        await providersApi.saveToCodexConfigs(nextList);
      } else {
        await providersApi.saveCodexConfigs(nextList);
      }

      let syncedConfigs = nextList;
      let refreshed = false;
      try {
        const latest = await fetchConfig(configSection, true);
        if (Array.isArray(latest)) {
          syncedConfigs = latest as ProviderKeyConfig[];
          refreshed = true;
        }
      } catch {
        // 保存成功后刷新失败时，回退到本地计算结果，避免列表状态丢失
      }

      if (!refreshed) {
        updateConfigValue(configSection, syncedConfigs);
        clearCache(configSection);
      }

      setConfigs(syncedConfigs);
      showNotification(
        editIndex !== null
          ? t(isToCodex ? 'notification.tocodex_config_updated' : 'notification.codex_config_updated')
          : t(isToCodex ? 'notification.tocodex_config_added' : 'notification.codex_config_added'),
        'success'
      );
      allowNextNavigation();
      setBaseline(buildCodexBaseline(form));
      handleBack();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      setError(message);
      showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [
    allowNextNavigation,
    canSave,
    clearCache,
    configSection,
    configs,
    editIndex,
    fetchConfig,
    form,
    handleBack,
    isToCodex,
    showNotification,
    t,
    updateConfigValue,
  ]);

  const canOpenModelDiscovery =
    !disableControls &&
    !saving &&
    !isTestingKeys &&
    !loading &&
    !invalidIndexParam &&
    !invalidIndex &&
    Boolean((form.baseUrl ?? '').trim());
  const canApplyModelDiscovery =
    !disableControls &&
    !saving &&
    !isTestingKeys &&
    !modelDiscoveryFetching &&
    modelDiscoverySelected.size > 0;

  const renderKeyEntries = (entries: ApiKeyEntry[]) => {
    const list = entries.length ? entries : [isToCodex ? buildToCodexApiKeyEntry() : buildApiKeyEntry()];
    const tableLayoutStyle = {
      gridTemplateColumns: isToCodex
        ? '42px 52px 68px minmax(220px, 1.15fr) minmax(200px, 1.05fr) minmax(180px, 0.9fr) 168px'
        : '46px 56px 72px minmax(220px, 1.4fr) minmax(200px, 1.1fr) 180px',
      minWidth: isToCodex ? '980px' : '860px',
    } as const;

    const updateEntry = (idx: number, field: 'apiKey' | 'hmacSecret' | 'proxyUrl', value: string) => {
      const next = list.map((entry, i) =>
        i === idx ? { ...entry, [field]: value, authIndex: undefined } : entry
      );
      setForm((prev) => ({ ...prev, apiKeyEntries: next }));
      setKeyTestStatus(idx, { status: 'idle', message: '' });
      setTestStatus('idle');
      setTestMessage('');
    };

    const setEntryEnabled = (idx: number, enabled: boolean) => {
      const next = list.map((entry, i) =>
        i === idx ? { ...entry, disabled: !enabled } : entry
      );
      setForm((prev) => ({ ...prev, apiKeyEntries: next }));
    };

    const removeEntry = (idx: number) => {
      const next = list.filter((_, i) => i !== idx);
      setForm((prev) => ({
        ...prev,
        apiKeyEntries: next.length
          ? next
          : [isToCodex ? buildToCodexApiKeyEntry() : buildApiKeyEntry()],
      }));
      resetTestState(next.length);
    };

    const addEntry = () => {
      setForm((prev) => ({
        ...prev,
        apiKeyEntries: [...list, isToCodex ? buildToCodexApiKeyEntry() : buildApiKeyEntry()],
      }));
      resetTestState(list.length + 1);
    };

    return (
      <div className={styles.keyEntriesList}>
        <div className={styles.keyEntriesToolbar}>
          <span className={styles.keyEntriesCount}>
            {t('ai_providers.codex_keys_count')}: {list.length}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={addEntry}
            disabled={saving || disableControls || isTestingKeys}
            className={styles.addKeyButton}
          >
            {t('ai_providers.codex_keys_add_btn')}
          </Button>
        </div>
        <div className={styles.keyTableShell}>
          <div className={styles.keyTableHeader} style={tableLayoutStyle}>
            <div className={styles.keyTableColIndex}>#</div>
            <div className={styles.keyTableColStatus}>{t('common.status')}</div>
            <div className={styles.keyTableColStatus}>{t('ai_providers.config_toggle_label')}</div>
            <div className={styles.keyTableColKey}>{t('common.api_key')}</div>
            {isToCodex && (
              <div className={styles.keyTableColKey}>
                {t('ai_providers.tocodex_hmac_secret_label')}
              </div>
            )}
            <div className={styles.keyTableColProxy}>{t('common.proxy_url')}</div>
            <div className={styles.keyTableColAction}>{t('common.action')}</div>
          </div>
          {list.map((entry, index) => {
            const keyStatus = keyTestStatuses[index] ?? { status: 'idle', message: '' };
            const modelName = testModel.trim() || availableModels[0] || '';
            const canTestKey =
              hasUsableApiKeyEntry(entry, isToCodex) &&
              Boolean(baseUrl) &&
              Boolean(modelName);

            return (
              <div key={index} className={styles.keyTableRow} style={tableLayoutStyle}>
                <div className={styles.keyTableColIndex}>{index + 1}</div>
                <div className={styles.keyTableColStatus}>
                  <span
                    className={styles.statusIconWrapper}
                    title={keyStatus.message || undefined}
                  >
                    <StatusIcon status={keyStatus.status} />
                  </span>
                </div>
                <div className={styles.keyTableColStatus}>
                  <ToggleSwitch
                    checked={entry.disabled !== true}
                    onChange={(enabled) => setEntryEnabled(index, enabled)}
                    disabled={saving || disableControls || isTestingKeys}
                    ariaLabel={`${t('ai_providers.config_toggle_label')} ${index + 1}`}
                  />
                </div>
                <div className={styles.keyTableColKey}>
                  <input
                    type="text"
                    value={entry.apiKey}
                    onChange={(e) => updateEntry(index, 'apiKey', e.target.value)}
                    disabled={saving || disableControls || isTestingKeys}
                    className={`input ${styles.keyTableInput}`}
                    placeholder={t('ai_providers.codex_add_modal_key_placeholder')}
                  />
                </div>
                {isToCodex && (
                  <div className={styles.keyTableColKey}>
                    <input
                      type="text"
                      value={entry.hmacSecret ?? ''}
                      onChange={(e) => updateEntry(index, 'hmacSecret', e.target.value)}
                      disabled={saving || disableControls || isTestingKeys}
                      className={`input ${styles.keyTableInput}`}
                      placeholder={t('ai_providers.tocodex_hmac_secret_placeholder')}
                    />
                  </div>
                )}
                <div className={styles.keyTableColProxy}>
                  <input
                    type="text"
                    value={entry.proxyUrl ?? ''}
                    onChange={(e) => updateEntry(index, 'proxyUrl', e.target.value)}
                    disabled={saving || disableControls || isTestingKeys}
                    className={`input ${styles.keyTableInput}`}
                    placeholder={t('ai_providers.codex_add_modal_proxy_placeholder')}
                  />
                </div>
                <div className={styles.keyTableColAction}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void testSingleKey(index)}
                    disabled={saving || disableControls || isTestingKeys || !canTestKey}
                    loading={keyStatus.status === 'loading'}
                  >
                    {t('ai_providers.codex_test_single_action')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeEntry(index)}
                    disabled={saving || disableControls || isTestingKeys || list.length <= 1}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <SecondaryScreenShell
      ref={swipeRef}
      contentClassName={layoutStyles.content}
      title={title}
      onBack={handleBack}
      backLabel={t('common.back')}
      backAriaLabel={t('common.back')}
      hideTopBarBackButton
      hideTopBarRightAction
      floatingAction={
        <div className={layoutStyles.floatingActions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleBack}
            className={layoutStyles.floatingBackButton}
          >
            {t('common.back')}
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            loading={saving}
            disabled={!canSave}
            className={layoutStyles.floatingSaveButton}
          >
            {t('common.save')}
          </Button>
        </div>
      }
      isLoading={loading}
      loadingLabel={t('common.loading')}
    >
      <Card>
        {error && <div className="error-box">{error}</div>}
        {invalidIndexParam || invalidIndex ? (
          <div className="hint">{t('common.invalid_provider_index')}</div>
        ) : (
          <>
            <Input
              label={t('ai_providers.codex_add_modal_url_label')}
              value={form.baseUrl ?? ''}
              onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
              disabled={disableControls || saving || isTestingKeys}
            />
            <Input
              label={t('ai_providers.priority_label')}
              hint={t('ai_providers.priority_hint')}
              type="number"
              step={1}
              value={form.priority ?? ''}
              onChange={(e) => {
                const raw = e.target.value;
                const parsed = raw.trim() === '' ? undefined : Number(raw);
                setForm((prev) => ({
                  ...prev,
                  priority: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
                }));
              }}
              disabled={disableControls || saving || isTestingKeys}
            />
            <Input
              label={t('ai_providers.prefix_label')}
              placeholder={t('ai_providers.prefix_placeholder')}
              value={form.prefix ?? ''}
              onChange={(e) => setForm((prev) => ({ ...prev, prefix: e.target.value }))}
              hint={t('ai_providers.prefix_hint')}
              disabled={disableControls || saving || isTestingKeys}
            />
            {!isToCodex && (
              <div className="form-group">
                <label>{t('ai_providers.codex_websockets_label')}</label>
                <ToggleSwitch
                  checked={Boolean(form.websockets)}
                  onChange={(value) => setForm((prev) => ({ ...prev, websockets: value }))}
                  disabled={disableControls || saving || isTestingKeys}
                  ariaLabel={t('ai_providers.codex_websockets_label')}
                />
                <div className="hint">{t('ai_providers.codex_websockets_hint')}</div>
              </div>
            )}
            <Input
              label={t('ai_providers.codex_add_modal_proxy_label')}
              value={form.proxyUrl ?? ''}
              onChange={(e) => setForm((prev) => ({ ...prev, proxyUrl: e.target.value }))}
              disabled={disableControls || saving || isTestingKeys}
            />
            <HeaderInputList
              entries={form.headers}
              onChange={(entries) => setForm((prev) => ({ ...prev, headers: entries }))}
              addLabel={t('common.custom_headers_add')}
              keyPlaceholder={t('common.custom_headers_key_placeholder')}
              valuePlaceholder={t('common.custom_headers_value_placeholder')}
              removeButtonTitle={t('common.delete')}
              removeButtonAriaLabel={t('common.delete')}
              disabled={disableControls || saving || isTestingKeys}
            />

            <div className={styles.keyEntriesSection}>
              <div className={styles.keyEntriesHeader}>
                <label className={styles.keyEntriesTitle}>
                  {t('ai_providers.codex_keys_label')}
                </label>
                <span className={styles.keyEntriesHint}>
                  {t('ai_providers.codex_keys_hint')}
                </span>
              </div>
              {renderKeyEntries(form.apiKeyEntries)}
            </div>

            <div className={styles.modelConfigSection}>
              <div className={styles.modelConfigHeader}>
                <label className={styles.modelConfigTitle}>
                  {t('ai_providers.codex_models_label')}
                </label>
                <div className={styles.modelConfigToolbar}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        modelEntries: [...prev.modelEntries, { name: '', alias: '' }],
                      }))
                    }
                    disabled={disableControls || saving || isTestingKeys}
                  >
                    {t('ai_providers.codex_models_add_btn')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setModelDiscoveryOpen(true)}
                    disabled={!canOpenModelDiscovery}
                  >
                    {t('ai_providers.codex_models_fetch_button')}
                  </Button>
                </div>
              </div>
              <div className={styles.sectionHint}>{t('ai_providers.codex_models_hint')}</div>

              <ModelInputList
                entries={form.modelEntries}
                onChange={(entries) => setForm((prev) => ({ ...prev, modelEntries: entries }))}
                namePlaceholder={t('common.model_name_placeholder')}
                aliasPlaceholder={t('common.model_alias_placeholder')}
                disabled={disableControls || saving || isTestingKeys}
                hideAddButton
                className={styles.modelInputList}
                rowClassName={styles.modelInputRow}
                inputClassName={styles.modelInputField}
                removeButtonClassName={styles.modelRowRemoveButton}
                removeButtonTitle={t('common.delete')}
                removeButtonAriaLabel={t('common.delete')}
              />
            </div>
            <div className={styles.modelTestPanel}>
              <div className={styles.modelTestTopRow}>
                <div className={styles.modelTestMeta}>
                  <label className={styles.modelTestLabel}>{t('ai_providers.codex_test_title')}</label>
                  <span className={styles.modelTestHint}>
                    {t(isToCodex ? 'ai_providers.tocodex_test_hint' : 'ai_providers.codex_test_hint')}
                  </span>
                </div>
                <div className={styles.modelTestPrimaryActions}>
                  <Select
                    value={testModel}
                    options={modelSelectOptions}
                    onChange={(value) => {
                      setTestModel(value);
                      setTestStatus('idle');
                      setTestMessage('');
                    }}
                    placeholder={
                      hasConfiguredModels
                        ? t('ai_providers.codex_test_select_placeholder')
                        : t('ai_providers.codex_test_select_empty')
                    }
                    className={styles.openaiTestSelect}
                    ariaLabel={t('ai_providers.codex_test_title')}
                    disabled={
                      saving ||
                      disableControls ||
                      isTestingKeys ||
                      testStatus === 'loading' ||
                      !hasConfiguredModels
                    }
                  />
                  <Button
                    variant={testStatus === 'error' ? 'danger' : 'secondary'}
                    size="sm"
                    onClick={() => void testAllKeys()}
                    loading={testStatus === 'loading'}
                    disabled={
                      saving ||
                      disableControls ||
                      isTestingKeys ||
                      testStatus === 'loading' ||
                      !hasConfiguredModels ||
                      !hasTestableKeys
                    }
                    title={t('ai_providers.codex_test_all_hint')}
                    className={styles.modelTestAllButton}
                  >
                    {t('ai_providers.codex_test_all_action')}
                  </Button>
                </div>
              </div>
              <div className={styles.modelTestBottomRow}>
                <div className={styles.modelTestBatchActions}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={disableFailedKeys}
                    disabled={saving || disableControls || isTestingKeys || failedKeyIndexes.length === 0}
                    className={styles.modelTestBatchButton}
                  >
                    {t('ai_providers.codex_disable_failed_action')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={removeFailedKeys}
                    disabled={saving || disableControls || isTestingKeys || failedKeyIndexes.length === 0}
                    className={styles.modelTestBatchButton}
                  >
                    {t('ai_providers.codex_remove_failed_action')}
                  </Button>
                </div>
              </div>
            </div>
            {testMessage && (
              <div
                className={`status-badge ${
                  testStatus === 'error'
                    ? 'error'
                    : testStatus === 'success'
                      ? 'success'
                      : 'muted'
                }`}
              >
                {testMessage}
              </div>
            )}
            <div className="form-group">
              <label>{t('ai_providers.excluded_models_label')}</label>
              <textarea
                className="input"
                placeholder={t('ai_providers.excluded_models_placeholder')}
                value={form.excludedText}
                onChange={(e) => setForm((prev) => ({ ...prev, excludedText: e.target.value }))}
                rows={4}
                disabled={disableControls || saving || isTestingKeys}
              />
              <div className="hint">{t('ai_providers.excluded_models_hint')}</div>
            </div>

            <Modal
              open={modelDiscoveryOpen}
              title={t(isToCodex ? 'ai_providers.tocodex_models_fetch_title' : 'ai_providers.codex_models_fetch_title')}
              onClose={() => setModelDiscoveryOpen(false)}
              width={720}
              footer={
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setModelDiscoveryOpen(false)}
                    disabled={modelDiscoveryFetching}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleApplyDiscoveredModels}
                    disabled={!canApplyModelDiscovery}
                  >
                    {t('ai_providers.codex_models_fetch_apply')}
                  </Button>
                </>
              }
            >
              <div className={styles.openaiModelsContent}>
                <div className={styles.sectionHint}>
                  {t(isToCodex ? 'ai_providers.tocodex_models_fetch_hint' : 'ai_providers.codex_models_fetch_hint')}
                </div>
                <div className={styles.openaiModelsEndpointSection}>
                  <label className={styles.openaiModelsEndpointLabel}>
                    {t('ai_providers.codex_models_fetch_url_label')}
                  </label>
                  <div className={styles.openaiModelsEndpointControls}>
                    <input
                      className={`input ${styles.openaiModelsEndpointInput}`}
                      readOnly
                      value={modelDiscoveryEndpoint}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void fetchCodexModelDiscovery()}
                      loading={modelDiscoveryFetching}
                      disabled={disableControls || saving}
                    >
                      {t('ai_providers.codex_models_fetch_refresh')}
                    </Button>
                  </div>
                </div>
                <Input
                  label={t('ai_providers.codex_models_search_label')}
                  placeholder={t('ai_providers.codex_models_search_placeholder')}
                  value={modelDiscoverySearch}
                  onChange={(e) => setModelDiscoverySearch(e.target.value)}
                  disabled={modelDiscoveryFetching}
                />
                {discoveredModels.length > 0 && (
                  <div className={styles.modelDiscoveryToolbar}>
                    <div className={styles.modelDiscoveryToolbarActions}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleSelectVisibleDiscoveredModels}
                        disabled={
                          disableControls ||
                          saving ||
                          modelDiscoveryFetching ||
                          discoveredModelsFiltered.length === 0 ||
                          allVisibleDiscoveredSelected
                        }
                      >
                        {t('ai_providers.model_discovery_select_visible')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleClearDiscoveredModelSelection}
                        disabled={
                          disableControls ||
                          saving ||
                          modelDiscoveryFetching ||
                          modelDiscoverySelected.size === 0
                        }
                      >
                        {t('ai_providers.model_discovery_clear_selection')}
                      </Button>
                    </div>
                    <div className={styles.modelDiscoverySelectionSummary}>
                      {t('ai_providers.model_discovery_selected_count', {
                        count: modelDiscoverySelected.size,
                      })}
                    </div>
                  </div>
                )}
                {modelDiscoveryError && <div className="error-box">{modelDiscoveryError}</div>}
                {modelDiscoveryFetching ? (
                  <div className={styles.sectionHint}>
                    {t('ai_providers.codex_models_fetch_loading')}
                  </div>
                ) : discoveredModels.length === 0 ? (
                  <div className={styles.sectionHint}>
                    {t('ai_providers.codex_models_fetch_empty')}
                  </div>
                ) : discoveredModelsFiltered.length === 0 ? (
                  <div className={styles.sectionHint}>
                    {t('ai_providers.codex_models_search_empty')}
                  </div>
                ) : (
                  <div className={styles.modelDiscoveryList}>
                    {discoveredModelsFiltered.map((model) => {
                      const checked = modelDiscoverySelected.has(model.name);
                      return (
                        <SelectionCheckbox
                          key={model.name}
                          checked={checked}
                          onChange={() => toggleModelDiscoverySelection(model.name)}
                          disabled={disableControls || saving || modelDiscoveryFetching}
                          ariaLabel={model.name}
                          className={`${styles.modelDiscoveryRow} ${
                            checked ? styles.modelDiscoveryRowSelected : ''
                          }`}
                          labelClassName={styles.modelDiscoverySelectionLabel}
                          label={
                            <div className={styles.modelDiscoveryMeta}>
                              <div className={styles.modelDiscoveryName}>
                                {model.name}
                                {model.alias && (
                                  <span className={styles.modelDiscoveryAlias}>{model.alias}</span>
                                )}
                              </div>
                              {model.description && (
                                <div className={styles.modelDiscoveryDesc}>{model.description}</div>
                              )}
                            </div>
                          }
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </Modal>
          </>
        )}
      </Card>
    </SecondaryScreenShell>
  );
}
