// Administration status for the Bitcoin Signals project.
//
// This is what the CFLab administration screens read: which storage backend the
// project uses, whether it is reachable, how collection is doing, and what the
// last recorded backup verification said. It never returns observation payloads.

import type { Bindings } from '../types';
import { BITCOIN_SIGNALS, storageHealth, type StorageHealth } from '../projects';
import { alertsView, backupView, collectionView, type OpenAlert, type BackupView, type CollectionView } from './queries';
import { readSettings, type AlertRules, type NotificationSettings } from './alerts';
import { REPORTABLE_OBSERVATIONS_SQL, reportableAlertsSql } from './policy';

export interface ProjectStatus {
  generated_at: string;
  project: {
    app_id: string;
    name: string;
    dashboard: string;
    storage: StorageHealth;
  };
  data: {
    observations: number;
    evidence: number;
    alerts_open: number;
    last_observation_at: string | null;
    oldest_observation_at: string | null;
  };
  collection: CollectionView;
  alerts: OpenAlert[];
  backup: BackupView;
  backups_expected: { databases: string[]; max_age_hours: number; command: string };
  settings: { notifications: NotificationSettings; rules: AlertRules };
}

export const BACKUP_DATABASES = ['cflab', 'cflab-analytics', 'cflab-bitcoin-signals'] as const;
export const BACKUP_FRESHNESS_HOURS = 30;

export async function projectStatus(env: Bindings, now = new Date()): Promise<ProjectStatus> {
  const db = env.BTC_SIGNALS;
  const [storage, counts, evidenceCount, openAlerts, range] = await Promise.all([
    storageHealth(env, BITCOIN_SIGNALS.appId),
    db.prepare(`SELECT COUNT(*) AS n FROM bs_observations WHERE ${REPORTABLE_OBSERVATIONS_SQL}`).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM bs_evidence').first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM bs_alerts WHERE acknowledged_at IS NULL AND ${reportableAlertsSql()}`).first<{ n: number }>(),
    db.prepare(`SELECT MAX(observed_at) AS newest, MIN(observed_at) AS oldest FROM bs_observations WHERE ${REPORTABLE_OBSERVATIONS_SQL}`).first<{ newest: string | null; oldest: string | null }>(),
  ]);
  const [collection, alerts, backup, settings] = await Promise.all([
    collectionView(db, now),
    alertsView(db, 20),
    backupView(db, now),
    readSettings(db),
  ]);
  return {
    generated_at: now.toISOString(),
    project: {
      app_id: BITCOIN_SIGNALS.appId,
      name: BITCOIN_SIGNALS.name,
      dashboard: BITCOIN_SIGNALS.dashboardPath,
      storage,
    },
    data: {
      observations: Number(counts?.n ?? 0),
      evidence: Number(evidenceCount?.n ?? 0),
      alerts_open: Number(openAlerts?.n ?? 0),
      last_observation_at: range?.newest ?? null,
      oldest_observation_at: range?.oldest ?? null,
    },
    collection,
    alerts,
    backup,
    backups_expected: {
      databases: [...BACKUP_DATABASES],
      max_age_hours: BACKUP_FRESHNESS_HOURS,
      command: 'node scripts/backup/backup-status.mjs --json',
    },
    settings: { notifications: settings.notifications, rules: settings.rules },
  };
}
