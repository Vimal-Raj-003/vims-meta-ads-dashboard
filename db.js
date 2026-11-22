const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'vims_meta_dashboard.sqlite');
const KEY_PATH = path.join(DATA_DIR, 'secret.key');

// Ensure a persistent 32-byte local encryption key for tokens & secrets at rest
function getOrCreateSecretKey() {
  if (fs.existsSync(KEY_PATH)) {
    const hex = fs.readFileSync(KEY_PATH, 'utf8').trim();
    if (hex.length === 64) return Buffer.from(hex, 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, key.toString('hex'), { mode: 0o600 });
  return key;
}

const SECRET_KEY = getOrCreateSecretKey();

function encryptSecret(plainText) {
  if (!plainText) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptSecret(cipherText) {
  if (!cipherText) return '';
  try {
    const parts = String(cipherText).split(':');
    if (parts.length !== 3) return '';
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const enc = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return '';
  }
}

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return {
    salt: salt.toString('hex'),
    hash: derived.toString('hex')
  };
}

function verifyPassword(password, saltHex, expectedHashHex) {
  if (!saltHex || !expectedHashHex) return false;
  const { hash } = hashPassword(password, saltHex);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHashHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function nowIso() {
  return new Date().toISOString();
}

function todayDateStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function initDatabase() {
  db.exec(`
    -- 1. Users & Sessions (Local Authentication without hardcoded shared credentials)
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Admin',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 2. Meta Connection & App Settings (Tokens & Secrets encrypted at rest)
    CREATE TABLE IF NOT EXISTS meta_connections (
      id TEXT PRIMARY KEY,
      app_id TEXT DEFAULT '',
      app_secret_enc TEXT DEFAULT '',
      access_token_enc TEXT DEFAULT '',
      token_type TEXT DEFAULT 'user_or_system',
      token_expires_at TEXT DEFAULT '',
      connected_user_id TEXT DEFAULT '',
      connected_user_name TEXT DEFAULT '',
      granted_permissions TEXT DEFAULT '[]',
      declined_permissions TEXT DEFAULT '[]',
      selected_business_id TEXT DEFAULT '',
      selected_business_name TEXT DEFAULT '',
      selected_ad_account_id TEXT DEFAULT '',
      selected_ad_account_name TEXT DEFAULT '',
      selected_page_ids TEXT DEFAULT '[]',
      selected_page_names TEXT DEFAULT '[]',
      available_businesses_json TEXT DEFAULT '[]',
      available_ad_accounts_json TEXT DEFAULT '[]',
      available_pages_json TEXT DEFAULT '[]',
      page_tokens_enc TEXT DEFAULT '',
      connection_status TEXT DEFAULT 'disconnected',
      blocker_code TEXT DEFAULT '',
      blocker_message TEXT DEFAULT '',
      blocker_action_ta TEXT DEFAULT '',
      auto_sync_interval_minutes INTEGER DEFAULT 15,
      active_data_source TEXT DEFAULT 'meta_api',
      last_sync_at TEXT DEFAULT '',
      last_sync_status TEXT DEFAULT '',
      last_sync_error TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    );

    -- 3. Ad Accounts Metadata & Verified Billing Info
    CREATE TABLE IF NOT EXISTS ad_accounts (
      account_id TEXT PRIMARY KEY,
      data_source TEXT NOT NULL DEFAULT 'meta_api',
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      timezone_name TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      timezone_offset_hours REAL DEFAULT 5.5,
      account_status INTEGER DEFAULT 1,
      amount_spent_total REAL DEFAULT NULL,
      balance_amount_owed REAL DEFAULT NULL,
      spend_cap REAL DEFAULT NULL,
      is_prepay_account INTEGER DEFAULT NULL,
      available_funds_verified REAL DEFAULT NULL,
      funding_source_details TEXT DEFAULT '',
      billing_Verification_note TEXT DEFAULT 'Unavailable from connected data.',
      attribution_spec TEXT DEFAULT '7d_click_1d_view',
      earliest_data_date TEXT DEFAULT '',
      latest_data_date TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    );

    -- 4. Campaigns
    CREATE TABLE IF NOT EXISTS campaigns (
      campaign_id TEXT NOT NULL,
      data_source TEXT NOT NULL DEFAULT 'meta_api',
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'UNKNOWN',
      effective_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      configured_status TEXT DEFAULT '',
      objective TEXT NOT NULL DEFAULT 'OUTCOME_LEADS',
      buying_type TEXT DEFAULT 'AUCTION',
      daily_budget REAL DEFAULT NULL,
      lifetime_budget REAL DEFAULT NULL,
      budget_remaining REAL DEFAULT NULL,
      start_time TEXT DEFAULT '',
      stop_time TEXT DEFAULT '',
      created_time TEXT DEFAULT '',
      updated_time TEXT DEFAULT '',
      is_deleted_on_meta INTEGER DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      PRIMARY KEY (campaign_id, data_source)
    );
    CREATE INDEX IF NOT EXISTS idx_campaigns_account ON campaigns(account_id, data_source);
    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(effective_status, data_source);

    -- 5. Ad Sets
    CREATE TABLE IF NOT EXISTS adsets (
      adset_id TEXT NOT NULL,
      data_source TEXT NOT NULL DEFAULT 'meta_api',
      account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'UNKNOWN',
      effective_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      optimization_goal TEXT DEFAULT '',
      billing_event TEXT DEFAULT '',
      daily_budget REAL DEFAULT NULL,
      lifetime_budget REAL DEFAULT NULL,
      budget_remaining REAL DEFAULT NULL,
      destination_type TEXT DEFAULT '',
      start_time TEXT DEFAULT '',
      end_time TEXT DEFAULT '',
      created_time TEXT DEFAULT '',
      updated_time TEXT DEFAULT '',
      is_deleted_on_meta INTEGER DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      PRIMARY KEY (adset_id, data_source)
    );
    CREATE INDEX IF NOT EXISTS idx_adsets_campaign ON adsets(campaign_id, data_source);
    CREATE INDEX IF NOT EXISTS idx_adsets_account ON adsets(account_id, data_source);

    -- 6. Individual Ads (with Creative Details & Delivery Info)
    CREATE TABLE IF NOT EXISTS ads (
      ad_id TEXT NOT NULL,
      data_source TEXT NOT NULL DEFAULT 'meta_api',
      account_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      adset_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'UNKNOWN',
      effective_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      creative_id TEXT DEFAULT '',
      creative_name TEXT DEFAULT '',
      creative_title TEXT DEFAULT '',
      creative_body TEXT DEFAULT '',
      creative_cta TEXT DEFAULT '',
      creative_link_url TEXT DEFAULT '',
      creative_thumbnail_url TEXT DEFAULT '',
      creative_image_url TEXT DEFAULT '',
      creative_video_id TEXT DEFAULT '',
      creative_media_type TEXT DEFAULT 'IMAGE',
      lead_form_id TEXT DEFAULT '',
      lead_form_name TEXT DEFAULT '',
      delivery_start_date TEXT DEFAULT '',
      delivery_stop_date TEXT DEFAULT '',
      created_time TEXT DEFAULT '',
      updated_time TEXT DEFAULT '',
      is_deleted_on_meta INTEGER DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      PRIMARY KEY (ad_id, data_source)
    );
    CREATE INDEX IF NOT EXISTS idx_ads_campaign ON ads(campaign_id, data_source);
    CREATE INDEX IF NOT EXISTS idx_ads_adset ON ads(adset_id, data_source);
    CREATE INDEX IF NOT EXISTS idx_ads_account ON ads(account_id, data_source);
    CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(effective_status, data_source);

    -- 7. Daily Insights (Entity Level: 'account', 'campaign', 'adset', 'ad')
    -- Platform breakdown: 'all', 'facebook', 'instagram', 'audience_network', 'messenger'
    CREATE TABLE IF NOT EXISTS daily_insights (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      data_source TEXT NOT NULL DEFAULT 'meta_api',
      account_id TEXT NOT NULL,
      campaign_id TEXT DEFAULT '',
      adset_id TEXT DEFAULT '',
      ad_id TEXT DEFAULT '',
      date_start TEXT NOT NULL,
      date_stop TEXT NOT NULL,
      publisher_platform TEXT NOT NULL DEFAULT 'all',
      spend REAL NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      reach INTEGER DEFAULT NULL,
      frequency REAL DEFAULT NULL,
      clicks_all INTEGER NOT NULL DEFAULT 0,
      link_clicks INTEGER NOT NULL DEFAULT 0,
      unique_link_clicks INTEGER DEFAULT NULL,
      form_leads INTEGER NOT NULL DEFAULT 0,
      messaging_leads INTEGER NOT NULL DEFAULT 0,
      website_leads INTEGER NOT NULL DEFAULT 0,
      landing_page_views INTEGER NOT NULL DEFAULT 0,
      post_engagements INTEGER NOT NULL DEFAULT 0,
      video_views INTEGER NOT NULL DEFAULT 0,
      result_type TEXT NOT NULL DEFAULT 'Form Leads',
      results_count INTEGER NOT NULL DEFAULT 0,
      raw_actions_json TEXT DEFAULT '[]',
      attribution_setting TEXT DEFAULT '7d_click_1d_view',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id, date_start, publisher_platform, data_source)
    );
    CREATE INDEX IF NOT EXISTS idx_insights_lookup ON daily_insights(account_id, data_source, entity_type, date_start, publisher_platform);
    CREATE INDEX IF NOT EXISTS idx_insights_campaign ON daily_insights(campaign_id, data_source, date_start);
    CREATE INDEX IF NOT EXISTS idx_insights_ad ON daily_insights(ad_id, data_source, date_start);

    -- 8. Period Reach Cache (Accurate unique deduplicated reach returned by Meta API for multi-day ranges)
    CREATE TABLE IF NOT EXISTS period_reach_cache (
      account_id TEXT NOT NULL,
      data_source TEXT NOT NULL DEFAULT 'meta_api',
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      date_start TEXT NOT NULL,
      date_stop TEXT NOT NULL,
      publisher_platform TEXT NOT NULL DEFAULT 'all',
      unique_reach INTEGER DEFAULT NULL,
      frequency REAL DEFAULT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, data_source, entity_type, entity_id, date_start, date_stop, publisher_platform)
    );

    -- 9. Manually Entered Planned Budgets (Kept strictly separate from Meta Budget & Actual Spend)
    CREATE TABLE IF NOT EXISTS planned_budgets (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      data_source TEXT NOT NULL DEFAULT 'meta_api',
      plan_name TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'account',
      scope_campaign_id TEXT DEFAULT '',
      scope_campaign_name TEXT DEFAULT 'All Campaigns (Account-Wide)',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      planned_amount REAL NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 10. Lead Form Submissions + Preserved Local Follow-up Tracking
    CREATE TABLE IF NOT EXISTS lead_submissions (
      lead_id TEXT NOT NULL,
      data_source TEXT NOT NULL DEFAULT 'meta_api',
      account_id TEXT NOT NULL,
      page_id TEXT DEFAULT '',
      form_id TEXT DEFAULT '',
      form_name TEXT DEFAULT '',
      campaign_id TEXT DEFAULT '',
      campaign_name TEXT DEFAULT '',
      adset_id TEXT DEFAULT '',
      adset_name TEXT DEFAULT '',
      ad_id TEXT DEFAULT '',
      ad_name TEXT DEFAULT '',
      platform TEXT DEFAULT 'fb',
      created_time TEXT NOT NULL,
      submission_date TEXT NOT NULL,
      customer_name TEXT DEFAULT '',
      phone_number TEXT DEFAULT '',
      email TEXT DEFAULT '',
      business_requirements TEXT DEFAULT '',
      city TEXT DEFAULT '',
      organization_name TEXT DEFAULT '',
      raw_field_data_json TEXT DEFAULT '[]',
      is_organic INTEGER DEFAULT 0,
      first_retrieved_at TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      PRIMARY KEY (lead_id, data_source)
    );
    CREATE INDEX IF NOT EXISTS idx_leads_date ON lead_submissions(account_id, data_source, submission_date);
    CREATE INDEX IF NOT EXISTS idx_leads_campaign ON lead_submissions(campaign_id, data_source);
    CREATE INDEX IF NOT EXISTS idx_leads_ad ON lead_submissions(ad_id, data_source);

    -- Local Follow-up Table keyed by lead_id so Meta refreshes NEVER overwrite user follow-up status/notes
    CREATE TABLE IF NOT EXISTS lead_followups (
      lead_id TEXT PRIMARY KEY,
      followup_status TEXT NOT NULL DEFAULT 'New',
      assigned_person TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      next_followup_date TEXT DEFAULT '',
      recorded_deal_value REAL DEFAULT NULL,
      recorded_order_ref TEXT DEFAULT '',
      updated_by TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    );

    -- 11. Upload Batches & Audit Log
    CREATE TABLE IF NOT EXISTS uploaded_reports (
      batch_id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      report_type TEXT NOT NULL,
      account_id TEXT NOT NULL,
      rows_processed INTEGER NOT NULL DEFAULT 0,
      rows_inserted INTEGER NOT NULL DEFAULT 0,
      rows_updated INTEGER NOT NULL DEFAULT 0,
      date_min TEXT DEFAULT '',
      date_max TEXT DEFAULT '',
      column_mapping_json TEXT DEFAULT '{}',
      notes TEXT DEFAULT '',
      uploaded_at TEXT NOT NULL
    );

    -- 12. Sync History Logs
    CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY,
      account_id TEXT DEFAULT '',
      data_source TEXT DEFAULT 'meta_api',
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL,
      campaigns_synced INTEGER DEFAULT 0,
      adsets_synced INTEGER DEFAULT 0,
      ads_synced INTEGER DEFAULT 0,
      insights_synced INTEGER DEFAULT 0,
      leads_synced INTEGER DEFAULT 0,
      message TEXT DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );

    -- 13. Configurable Targets for Performance Analysis ("What needs attention?")
    CREATE TABLE IF NOT EXISTS analysis_targets (
      account_id TEXT PRIMARY KEY,
      target_cpl REAL NOT NULL DEFAULT 250.0,
      max_spend_zero_leads REAL NOT NULL DEFAULT 400.0,
      min_link_ctr_percent REAL NOT NULL DEFAULT 0.85,
      min_clicks_for_ctr_eval INTEGER NOT NULL DEFAULT 40,
      min_impressions_for_eval INTEGER NOT NULL DEFAULT 1000,
      min_click_to_lead_rate_percent REAL NOT NULL DEFAULT 6.0,
      cpl_increase_threshold_percent REAL NOT NULL DEFAULT 25.0,
      lead_followup_sla_hours INTEGER NOT NULL DEFAULT 24,
      updated_at TEXT NOT NULL
    );
  `);

  // Safe schema migrations for existing SQLite database (preserves all existing rows)
  const existingCols = db.prepare(`PRAGMA table_info(meta_connections)`).all().map(c => c.name);
  if (!existingCols.includes('connected_user_email')) {
    db.exec(`ALTER TABLE meta_connections ADD COLUMN connected_user_email TEXT DEFAULT '';`);
  }
  if (!existingCols.includes('target_account_email')) {
    db.exec(`ALTER TABLE meta_connections ADD COLUMN target_account_email TEXT DEFAULT 'vims2023@gmail.com';`);
  }
  if (!existingCols.includes('oauth_state')) {
    db.exec(`ALTER TABLE meta_connections ADD COLUMN oauth_state TEXT DEFAULT '';`);
  }

  // Ensure default singleton row in meta_connections exists
  const conn = db.prepare(`SELECT id FROM meta_connections WHERE id = 'default'`).get();
  if (!conn) {
    db.prepare(`
      INSERT INTO meta_connections (
        id, target_account_email, connection_status, active_data_source, auto_sync_interval_minutes,
        blocker_code, blocker_message, blocker_action_ta, updated_at
      ) VALUES (
        'default',
        'vims2023@gmail.com',
        'not_configured',
        'meta_api',
        15,
        'META_AUTH_REQUIRED',
        'Meta Ad Account for vims2023@gmail.com is not authorized yet. Follow the interactive step-by-step wizard in "Connect Meta Account" to grant read-only permissions.',
        'vims2023@gmail.com Facebook account-il login panni "Connect Meta Account" wizard-il ulla steps follow panni Access Token alladhu Meta App OAuth authorize pannunga.',
        ?
      )
    `).run(nowIso());
  } else {
    db.prepare(`
      UPDATE meta_connections
      SET target_account_email = COALESCE(NULLIF(target_account_email, ''), 'vims2023@gmail.com')
      WHERE id = 'default'
    `).run();
  }

  // Ensure default targets row exists
  const target = db.prepare(`SELECT account_id FROM analysis_targets WHERE account_id = 'default'`).get();
  if (!target) {
    db.prepare(`
      INSERT INTO analysis_targets (
        account_id, target_cpl, max_spend_zero_leads, min_link_ctr_percent,
        min_clicks_for_ctr_eval, min_impressions_for_eval, min_click_to_lead_rate_percent,
        cpl_increase_threshold_percent, lead_followup_sla_hours, updated_at
      ) VALUES ('default', 250.0, 400.0, 0.85, 40, 1000, 6.0, 25.0, 24, ?)
    `).run(nowIso());
  }
}

module.exports = {
  db,
  DATA_DIR,
  DB_PATH,
  initDatabase,
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  nowIso,
  todayDateStr
};
