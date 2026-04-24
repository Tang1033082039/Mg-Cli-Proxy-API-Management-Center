/**
 * 版本相关 API
 */

import { apiClient } from './client';

export const versionApi = {
  checkLatest: () => apiClient.get<Record<string, unknown>>('/latest-version'),
  updateManagementPanel: () => apiClient.post<Record<string, unknown>>('/management-panel/update')
};
