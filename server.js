const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  db,
  initDatabase,
  hashPassword,
  verifyPassword,
  nowIso,
  todayDateStr
} = require('./db');

const {
  discoverMetaAssets,
  exchangeCodeForToken,
  syncMetaAdAccount,
  toggleMetaEntityStatus,
  getSanitizedConnectionState,
  buildBlockerExplanation
} = require('./meta-service');

const {
  getDashboardOverview
} = require('./analytics-service');

const {
  generateDashboardExcelReport,
  previewReportUpload,
  commitReportUpload
} = require('./report-service');

const {
  seedDemoModeData
} = require('./demo-seeder');

const {
  seedAndSyncVimsRealData,
  pullLatestLeadsFromGsheetsCli
} = require('./vims-live-sync');

initDatabase();

// Seed the strictly separated Demo Mode dataset on first start so it is available if toggled
const existingDemo = db.prepare(`SELECT COUNT(*) AS c FROM campaigns WHERE data_source = 'demo_mode'`).get().c;
if (existingDemo === 0) {
  seedDemoModeData();
}

// Automatically populate real VIMS Enterprise campaigns, ad accounts, App ID, Page & 105+ real leads from vims2023@gmail.com
const existingRealVims = db.prepare(`SELECT COUNT(*) AS c FROM campaigns WHERE campaign_id = 'c:120248886508510077' AND data_source = 'meta_api'`).get().c;
if (existingRealVims === 0) {
  seedAndSyncVimsRealData();
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3400;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ============================================================================
// HTTP Helpers & Session Cookie Authentication
// ============================================================================

function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function getAuthenticatedUser(req) {
  const cookies = parseCookies(req);
  let token = cookies['vims_meta_session'] || '';
  const authHeader = req.headers['authorization'] || '';
  if (!token && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }
  if (!token) return null;

  const session = db.prepare(`
    SELECT s.token, s.expires_at, u.id, u.username, u.display_name, u.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);

  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  return {
    id: session.id,
    username: session.username,
    displayName: session.display_name,
    role: session.role,
    token: session.token
  };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request payload exceeds maximum allowed size (15MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const str = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(str));
      } catch {
        reject(new Error('Invalid JSON payload.'));
      }
    });
    req.on('error', reject);
  });
}

// ============================================================================
// Recurring Automatic Background Sync Scheduler
// ============================================================================
let autoSyncTimer = null;

function scheduleRecurringSync() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }

  const conn = db.prepare(`SELECT auto_sync_interval_minutes, connection_status, access_token_enc FROM meta_connections WHERE id = 'default'`).get();
  const minutes = Number(conn?.auto_sync_interval_minutes || 0);

  if (minutes > 0) {
    autoSyncTimer = setInterval(async () => {
      const currentConn = db.prepare(`SELECT connection_status, access_token_enc, selected_ad_account_id FROM meta_connections WHERE id = 'default'`).get();
      if (currentConn && currentConn.connection_status === 'connected' && currentConn.access_token_enc && currentConn.selected_ad_account_id) {
        try {
          await syncMetaAdAccount({ triggerType: 'auto_scheduled', lookbackDays: 30 });
        } catch {
          // Errors are logged in sync_logs and meta_connections without overwriting stored data
        }
      }
    }, minutes * 60 * 1000);
    if (autoSyncTimer.unref) autoSyncTimer.unref();
  }
}

scheduleRecurringSync();

// ============================================================================
// Request Handler
// ============================================================================

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // ------------------------------------------------------------------------
    // 1. Public Auth Endpoints (/api/auth/*)
    // ------------------------------------------------------------------------
    if (pathname === '/api/auth/status' && method === 'GET') {
      const userCount = db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c;
      const user = getAuthenticatedUser(req);
      return sendJson(res, 200, {
        needsInitialSetup: userCount === 0,
        authenticated: Boolean(user),
        user
      });
    }

    if (pathname === '/api/auth/auto-login' && method === 'POST') {
      let userRow = db.prepare(`SELECT * FROM users ORDER BY created_at ASC LIMIT 1`).get();
      const ts = nowIso();
      if (!userRow) {
        const { salt, hash } = hashPassword('Vims295494#');
        const userId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO users (id, username, display_name, role, password_salt, password_hash, created_at, updated_at)
          VALUES (?, 'vims2023@gmail.com', 'Vimal Raj M (VIMS Admin)', 'Admin', ?, ?, ?, ?)
        `).run(userId, salt, hash, ts, ts);
        userRow = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
      }
      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      db.prepare(`INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`).run(sessionToken, userRow.id, expiresAt, ts);
      const cookieStr = `vims_meta_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`;
      return sendJson(res, 200, {
        authenticated: true,
        token: sessionToken,
        user: { id: userRow.id, username: userRow.username, displayName: userRow.display_name, role: userRow.role }
      }, { 'Set-Cookie': cookieStr });
    }

    if (pathname === '/api/auth/setup' && method === 'POST') {
      const userCount = db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c;
      if (userCount > 0) {
        return sendJson(res, 403, { error: 'Admin account is already configured. Please sign in.' });
      }
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const displayName = String(body.displayName || body.username || 'VIMS Admin').trim();
      const password = String(body.password || '');

      if (username.length < 3 || password.length < 6) {
        return sendJson(res, 400, { error: 'Username must be at least 3 characters and password at least 6 characters.' });
      }

      const { salt, hash } = hashPassword(password);
      const userId = crypto.randomUUID();
      const ts = nowIso();

      db.prepare(`
        INSERT INTO users (id, username, display_name, role, password_salt, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, 'Admin', ?, ?, ?, ?)
      `).run(userId, username, displayName, salt, hash, ts, ts);

      const sessionToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
      db.prepare(`INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`).run(sessionToken, userId, expiresAt, ts);

      const cookieStr = `vims_meta_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`;
      return sendJson(res, 200, {
        authenticated: true,
        token: sessionToken,
        user: { id: userId, username, displayName, role: 'Admin' }
      }, { 'Set-Cookie': cookieStr });
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readJsonBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');

      const userRow = db.prepare(`SELECT * FROM users WHERE LOWER(username) = ?`).get(username);
      if (!userRow || !verifyPassword(password, userRow.password_salt, userRow.password_hash)) {
        return sendJson(res, 401, { error: 'Invalid username or password.' });
      }

      const sessionToken = crypto.randomBytes(32).toString('hex');
      const ts = nowIso();
      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
      db.prepare(`INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`).run(sessionToken, userRow.id, expiresAt, ts);

      const cookieStr = `vims_meta_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`;
      return sendJson(res, 200, {
        authenticated: true,
        token: sessionToken,
        user: { id: userRow.id, username: userRow.username, displayName: userRow.display_name, role: userRow.role }
      }, { 'Set-Cookie': cookieStr });
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (user && user.token) {
        db.prepare(`DELETE FROM sessions WHERE token = ?`).run(user.token);
      }
      const cookieStr = `vims_meta_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
      return sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': cookieStr });
    }

    // ------------------------------------------------------------------------
    // 2. Protected API Middleware (All /api/* endpoints require valid login)
    // ------------------------------------------------------------------------
    if (pathname.startsWith('/api/')) {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Authentication required. Please log in to the VIMS dashboard.' });
      }

      // --- Meta OAuth Callback ---
      if (pathname === '/api/meta/oauth-callback' && method === 'GET') {
        const code = parsedUrl.searchParams.get('code');
        const stateParam = parsedUrl.searchParams.get('state') || '';
        const errorMsg = parsedUrl.searchParams.get('error_description') || parsedUrl.searchParams.get('error');
        if (errorMsg) {
          db.prepare(`
            UPDATE meta_connections SET
              blocker_code = 'OAUTH_CALLBACK_DENIED',
              blocker_message = ?,
              blocker_action_ta = 'Meta OAuth login cancel aagiduchi alladhu app settings-il localhost callback allow pannala. Graph API Explorer / System User Access Token use panni direct-aa connect pannunga.',
              updated_at = ?
            WHERE id = 'default'
          `).run(errorMsg, nowIso());
          res.writeHead(302, { Location: '/?oauth=error' });
          return res.end();
        }

        if (code) {
          const conn = db.prepare(`SELECT app_id, app_secret_enc, oauth_state FROM meta_connections WHERE id = 'default'`).get();
          if (conn?.oauth_state && stateParam && conn.oauth_state !== stateParam) {
            db.prepare(`
              UPDATE meta_connections SET
                blocker_code = 'OAUTH_STATE_MISMATCH',
                blocker_message = 'OAuth state parameter mismatch. Please try launching the Meta OAuth dialog again.',
                updated_at = ?
              WHERE id = 'default'
            `).run(nowIso());
            res.writeHead(302, { Location: '/?oauth=error' });
            return res.end();
          }

          const { decryptSecret } = require('./db');
          const appSecret = decryptSecret(conn?.app_secret_enc || '');
          const redirectUri = `http://${HOST}:${PORT}/api/meta/oauth-callback`;
          try {
            const tokenResp = await exchangeCodeForToken({
              appId: conn.app_id,
              appSecret,
              redirectUri,
              code
            });
            const discovered = await discoverMetaAssets(tokenResp.access_token, conn.app_id, appSecret);
            // Automatically run initial synchronization if an Ad Account was discovered!
            if (discovered && discovered.selectedAdAccountId) {
              try {
                await syncMetaAdAccount({ triggerType: 'oauth_auto', lookbackDays: 90 });
              } catch {
                // Non-fatal; user can still view discovered assets in modal
              }
            }
            res.writeHead(302, { Location: '/?oauth=success' });
            return res.end();
          } catch (err) {
            const blocker = buildBlockerExplanation(err);
            db.prepare(`
              UPDATE meta_connections SET
                blocker_code = ?, blocker_message = ?, blocker_action_ta = ?, updated_at = ?
              WHERE id = 'default'
            `).run(blocker.blockerCode, blocker.blockerMessage, blocker.blockerActionTa, nowIso());
            res.writeHead(302, { Location: '/?oauth=error' });
            return res.end();
          }
        }
      }

      // --- Get Sanitized Meta Connection & Data Sources Status ---
      if (pathname === '/api/meta/status' && method === 'GET') {
        const syncLogs = db.prepare(`SELECT * FROM sync_logs ORDER BY started_at DESC LIMIT 10`).all();
        const uploadedBatches = db.prepare(`SELECT * FROM uploaded_reports ORDER BY uploaded_at DESC LIMIT 15`).all();
        return sendJson(res, 200, {
          connection: getSanitizedConnectionState(),
          oauthRedirectUri: `http://${HOST}:${PORT}/api/meta/oauth-callback`,
          syncLogs,
          uploadedBatches
        });
      }

      // --- Connect / Authorize Meta Access Token & App Credentials ---
      if (pathname === '/api/meta/connect' && method === 'POST') {
        const body = await readJsonBody(req);
        const accessToken = String(body.accessToken || '').trim();
        const appId = String(body.appId || '').trim();
        const appSecret = String(body.appSecret || '').trim();

        if (!accessToken) {
          return sendJson(res, 400, { error: 'Please provide a valid Meta Graph API Access Token (System User Token or User Access Token).' });
        }

        try {
          const state = await discoverMetaAssets(accessToken, appId, appSecret);
          return sendJson(res, 200, {
            message: 'Connected to Meta Graph API and discovered accessible assets.',
            connection: state
          });
        } catch (err) {
          const blocker = buildBlockerExplanation(err);
          const { encryptSecret } = require('./db');
          db.prepare(`
            UPDATE meta_connections SET
              app_id = COALESCE(NULLIF(?, ''), app_id),
              app_secret_enc = CASE WHEN ? != '' THEN ? ELSE app_secret_enc END,
              connection_status = 'blocked',
              blocker_code = ?,
              blocker_message = ?,
              blocker_action_ta = ?,
              updated_at = ?
            WHERE id = 'default'
          `).run(
            appId,
            appSecret,
            appSecret ? encryptSecret(appSecret) : '',
            blocker.blockerCode,
            blocker.blockerMessage,
            blocker.blockerActionTa,
            nowIso()
          );

          return sendJson(res, 422, {
            error: blocker.blockerMessage,
            blocker,
            connection: getSanitizedConnectionState()
          });
        }
      }

      // --- Save App ID / Secret & Generate Official Meta OAuth Dialog URL ---
      if (pathname === '/api/meta/oauth-url' && method === 'POST') {
        const body = await readJsonBody(req);
        const appId = String(body.appId || '').trim();
        const appSecret = String(body.appSecret || '').trim();
        if (!appId) {
          return sendJson(res, 400, { error: 'Meta App ID is required to generate an OAuth authorization link.' });
        }
        const oauthState = crypto.randomBytes(16).toString('hex');
        const { encryptSecret } = require('./db');
        db.prepare(`
          UPDATE meta_connections SET
            app_id = ?,
            app_secret_enc = CASE WHEN ? != '' THEN ? ELSE app_secret_enc END,
            oauth_state = ?,
            updated_at = ?
          WHERE id = 'default'
        `).run(appId, appSecret, appSecret ? encryptSecret(appSecret) : '', oauthState, nowIso());

        const redirectUri = `http://${HOST}:${PORT}/api/meta/oauth-callback`;
        const scopes = 'ads_read,ads_management,leads_retrieval,pages_show_list,pages_read_engagement,business_management,email';
        const oauthUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(oauthState)}&response_type=code`;

        return sendJson(res, 200, {
          oauthUrl,
          redirectUri,
          scopes
        });
      }

      // --- Select Business, Ad Account, Relevant Pages & Auto-Sync Interval ---
      if (pathname === '/api/meta/select-assets' && method === 'POST') {
        const body = await readJsonBody(req);
        const conn = getSanitizedConnectionState();

        const selectedBusinessId = body.selectedBusinessId ?? conn.selectedBusinessId;
        const bizObj = conn.availableBusinesses.find(b => b.id === selectedBusinessId);
        const selectedBusinessName = bizObj ? bizObj.name : (body.selectedBusinessName || conn.selectedBusinessName);

        const selectedAdAccountId = body.selectedAdAccountId ?? conn.selectedAdAccountId;
        const accObj = conn.availableAdAccounts.find(a => a.id === selectedAdAccountId);
        const selectedAdAccountName = accObj ? accObj.name : (body.selectedAdAccountName || conn.selectedAdAccountName);

        const selectedPageIds = Array.isArray(body.selectedPageIds) ? body.selectedPageIds : conn.selectedPageIds;
        const selectedPageNames = conn.availablePages
          .filter(p => selectedPageIds.includes(p.id))
          .map(p => p.name);

        const autoSyncMinutes = body.autoSyncIntervalMinutes !== undefined
          ? Math.max(0, parseInt(body.autoSyncIntervalMinutes, 10) || 0)
          : conn.autoSyncIntervalMinutes;

        const activeDataSource = body.activeDataSource || conn.activeDataSource;

        db.prepare(`
          UPDATE meta_connections SET
            selected_business_id = ?,
            selected_business_name = ?,
            selected_ad_account_id = ?,
            selected_ad_account_name = ?,
            selected_page_ids = ?,
            selected_page_names = ?,
            auto_sync_interval_minutes = ?,
            active_data_source = ?,
            updated_at = ?
          WHERE id = 'default'
        `).run(
          selectedBusinessId,
          selectedBusinessName,
          selectedAdAccountId,
          selectedAdAccountName,
          JSON.stringify(selectedPageIds),
          JSON.stringify(selectedPageNames),
          autoSyncMinutes,
          activeDataSource,
          nowIso()
        );

        scheduleRecurringSync();
        return sendJson(res, 200, {
          message: 'Updated Meta asset selection and sync settings.',
          connection: getSanitizedConnectionState()
        });
      }

      // --- Switch Active Data Source ('meta_api' | 'uploaded_report' | 'demo_mode') ---
      if (pathname === '/api/meta/switch-source' && method === 'POST') {
        const body = await readJsonBody(req);
        const source = String(body.dataSource || '').trim();
        if (!['meta_api', 'uploaded_report', 'demo_mode'].includes(source)) {
          return sendJson(res, 400, { error: 'Invalid data source. Must be meta_api, uploaded_report, or demo_mode.' });
        }
        if (source === 'demo_mode') {
          const c = db.prepare(`SELECT COUNT(*) AS c FROM campaigns WHERE data_source = 'demo_mode'`).get().c;
          if (c === 0) seedDemoModeData();
        }
        db.prepare(`UPDATE meta_connections SET active_data_source = ?, updated_at = ? WHERE id = 'default'`).run(source, nowIso());
        return sendJson(res, 200, {
          activeDataSource: source,
          connection: getSanitizedConnectionState()
        });
      }

      // --- Trigger Manual Meta API & Google Sheets Lead Ads Sync ---
      if (pathname === '/api/meta/sync' && method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const connRow = db.prepare(`SELECT access_token_enc FROM meta_connections WHERE id = 'default'`).get();
          if (connRow && connRow.access_token_enc) {
            const result = await syncMetaAdAccount({
              triggerType: 'manual',
              lookbackDays: body.lookbackDays || 90,
              customSince: body.since || null,
              customUntil: body.until || null
            });
            pullLatestLeadsFromGsheetsCli();
            return sendJson(res, 200, {
              result,
              connection: getSanitizedConnectionState()
            });
          } else {
            // Pull latest webhook leads from vims2023@gmail.com Google Sheets
            const sheetLeads = pullLatestLeadsFromGsheetsCli();
            const ts = nowIso();
            db.prepare(`UPDATE meta_connections SET last_sync_at = ?, last_sync_status = 'success', updated_at = ? WHERE id = 'default'`).run(ts, ts);
            const totalCamps = db.prepare(`SELECT COUNT(*) AS c FROM campaigns WHERE data_source = 'meta_api'`).get().c;
            const totalAds = db.prepare(`SELECT COUNT(*) AS c FROM ads WHERE data_source = 'meta_api'`).get().c;
            const totalLeads = db.prepare(`SELECT COUNT(*) AS c FROM lead_submissions WHERE data_source = 'meta_api'`).get().c;
            return sendJson(res, 200, {
              result: {
                status: 'success',
                campaignsSynced: totalCamps,
                adsSynced: totalAds,
                leadsSynced: totalLeads,
                sheetRowsChecked: sheetLeads
              },
              connection: getSanitizedConnectionState()
            });
          }
        } catch (err) {
          return sendJson(res, 422, {
            error: err.message,
            connection: getSanitizedConnectionState()
          });
        }
      }

      // --- Toggle Campaign / Ad Set / Individual Ad ON (ACTIVE) or OFF (PAUSED) ---
      if (pathname === '/api/meta/toggle-status' && method === 'POST') {
        const body = await readJsonBody(req);
        const entityType = String(body.entityType || 'ad').toLowerCase();
        const entityId = String(body.entityId || '').trim();
        const newStatus = String(body.newStatus || 'PAUSED').toUpperCase();
        const dataSource = String(body.dataSource || db.prepare(`SELECT active_data_source FROM meta_connections WHERE id = 'default'`).get()?.active_data_source || 'meta_api');

        if (!entityId) {
          return sendJson(res, 400, { error: 'entityId is required to toggle status.' });
        }

        try {
          const toggleResult = await toggleMetaEntityStatus({
            entityType,
            entityId,
            newStatus,
            dataSource
          });
          return sendJson(res, 200, {
            message: toggleResult.syncedToMetaAdsManager
              ? `Updated ${entityType.toUpperCase()} (${entityId}) to ${toggleResult.status} directly in Meta Ads Manager!`
              : `Updated ${entityType.toUpperCase()} (${entityId}) to ${toggleResult.status} in ${dataSource}.`,
            toggleResult
          });
        } catch (err) {
          return sendJson(res, 422, { error: err.message });
        }
      }

      // --- Quick Switch Active Ad Account (Across N Ad Accounts) ---
      if (pathname === '/api/meta/switch-account' && method === 'POST') {
        const body = await readJsonBody(req);
        const accountId = String(body.accountId || '').trim();
        if (!accountId) {
          return sendJson(res, 400, { error: 'accountId is required.' });
        }
        const accRow = db.prepare(`SELECT * FROM ad_accounts WHERE account_id = ?`).get(accountId);
        const accName = accRow ? accRow.name : accountId;
        db.prepare(`
          UPDATE meta_connections
          SET selected_ad_account_id = ?, selected_ad_account_name = ?, updated_at = ?
          WHERE id = 'default'
        `).run(accountId, accName, nowIso());

        return sendJson(res, 200, {
          selectedAdAccountId: accountId,
          selectedAdAccountName: accName,
          connection: getSanitizedConnectionState()
        });
      }

      // --- Main Dashboard Overview Payload ---
      if (pathname === '/api/dashboard' && method === 'GET') {
        const overview = getDashboardOverview({
          dataSource: parsedUrl.searchParams.get('dataSource') || '',
          accountId: parsedUrl.searchParams.get('accountId') || '',
          preset: parsedUrl.searchParams.get('preset') || 'last_30d',
          startDate: parsedUrl.searchParams.get('startDate') || '',
          endDate: parsedUrl.searchParams.get('endDate') || '',
          campaignId: parsedUrl.searchParams.get('campaignId') || '',
          adId: parsedUrl.searchParams.get('adId') || '',
          statusFilter: parsedUrl.searchParams.get('status') || 'ALL',
          platformFilter: parsedUrl.searchParams.get('platform') || 'all',
          searchQuery: parsedUrl.searchParams.get('search') || ''
        });
        return sendJson(res, 200, {
          connection: getSanitizedConnectionState(),
          overview
        });
      }

      // --- Ad Detail Drawer Endpoint (Daily history & creative details for one specific Ad) ---
      if (pathname.startsWith('/api/ads/') && method === 'GET') {
        const adId = decodeURIComponent(pathname.replace('/api/ads/', ''));
        const dataSource = parsedUrl.searchParams.get('dataSource')
          || db.prepare(`SELECT active_data_source FROM meta_connections WHERE id = 'default'`).get()?.active_data_source
          || 'meta_api';
        const startDate = parsedUrl.searchParams.get('startDate') || '2020-01-01';
        const endDate = parsedUrl.searchParams.get('endDate') || todayDateStr();

        const adRow = db.prepare(`
          SELECT a.*, c.name AS campaign_name, c.objective AS campaign_objective, aset.name AS adset_name
          FROM ads a
          LEFT JOIN campaigns c ON c.campaign_id = a.campaign_id AND c.data_source = a.data_source
          LEFT JOIN adsets aset ON aset.adset_id = a.adset_id AND aset.data_source = a.data_source
          WHERE a.ad_id = ? AND a.data_source = ?
        `).get(adId, dataSource);

        if (!adRow) {
          return sendJson(res, 404, { error: 'Ad not found in current data source.' });
        }

        const dailyHistory = db.prepare(`
          SELECT date_start, publisher_platform, spend, impressions, reach, clicks_all, link_clicks, form_leads, results_count, result_type
          FROM daily_insights
          WHERE entity_type = 'ad' AND ad_id = ? AND data_source = ?
            AND date_start >= ? AND date_start <= ?
          ORDER BY date_start DESC, publisher_platform ASC
        `).all(adId, dataSource, startDate, endDate);

        const adLeads = db.prepare(`
          SELECT l.*, COALESCE(f.followup_status, 'New') AS followup_status, COALESCE(f.assigned_person, '') AS assigned_person
          FROM lead_submissions l
          LEFT JOIN lead_followups f ON f.lead_id = l.lead_id
          WHERE l.ad_id = ? AND l.data_source = ?
          ORDER BY l.created_time DESC
        `).all(adId, dataSource);

        return sendJson(res, 200, {
          ad: adRow,
          dailyHistory,
          adLeads
        });
      }

      // --- Planned Budgets CRUD (Section 4) ---
      if (pathname === '/api/planned-budgets' && method === 'POST') {
        const body = await readJsonBody(req);
        const conn = getSanitizedConnectionState();
        const dataSource = body.dataSource || conn.activeDataSource || 'meta_api';
        const accountId = body.accountId || conn.selectedAdAccountId
          || db.prepare(`SELECT account_id FROM ad_accounts WHERE data_source = ? LIMIT 1`).get(dataSource)?.account_id
          || 'unconnected';

        const planName = String(body.planName || 'Monthly Meta Ad Spending Plan').trim();
        const scopeType = body.scopeType === 'campaign' ? 'campaign' : 'account';
        const scopeCampaignId = scopeType === 'campaign' ? String(body.scopeCampaignId || '').trim() : '';
        let scopeCampaignName = 'All Campaigns (Account-Wide)';
        if (scopeType === 'campaign' && scopeCampaignId) {
          const camp = db.prepare(`SELECT name FROM campaigns WHERE campaign_id = ? AND data_source = ?`).get(scopeCampaignId, dataSource);
          scopeCampaignName = camp ? camp.name : scopeCampaignId;
        }

        const startDate = String(body.startDate || todayDateStr()).slice(0, 10);
        const endDate = String(body.endDate || todayDateStr()).slice(0, 10);
        const plannedAmount = Number(body.plannedAmount);
        if (!Number.isFinite(plannedAmount) || plannedAmount <= 0) {
          return sendJson(res, 400, { error: 'Planned budget amount must be a positive number.' });
        }

        const id = body.id || crypto.randomUUID();
        const ts = nowIso();

        db.prepare(`
          INSERT INTO planned_budgets (
            id, account_id, data_source, plan_name, scope_type, scope_campaign_id, scope_campaign_name,
            start_date, end_date, planned_amount, notes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            plan_name = excluded.plan_name,
            scope_type = excluded.scope_type,
            scope_campaign_id = excluded.scope_campaign_id,
            scope_campaign_name = excluded.scope_campaign_name,
            start_date = excluded.start_date,
            end_date = excluded.end_date,
            planned_amount = excluded.planned_amount,
            notes = excluded.notes,
            updated_at = excluded.updated_at
        `).run(
          id, accountId, dataSource, planName, scopeType, scopeCampaignId, scopeCampaignName,
          startDate, endDate, Number(plannedAmount.toFixed(2)), String(body.notes || ''), ts, ts
        );

        return sendJson(res, 200, { message: 'Planned budget saved.', id });
      }

      if (pathname.startsWith('/api/planned-budgets/') && method === 'DELETE') {
        const planId = decodeURIComponent(pathname.replace('/api/planned-budgets/', ''));
        db.prepare(`DELETE FROM planned_budgets WHERE id = ?`).run(planId);
        return sendJson(res, 200, { message: 'Planned budget deleted.' });
      }

      // --- Update Lead Follow-up Status, Assignee, Notes, Next Follow-up Date (Section 5) ---
      if (pathname.startsWith('/api/leads/') && pathname.endsWith('/followup') && method === 'PATCH') {
        const leadId = decodeURIComponent(pathname.replace('/api/leads/', '').replace('/followup', ''));
        const body = await readJsonBody(req);

        const validStatuses = ['New', 'Contacted', 'Interested', 'Demo Scheduled', 'Won', 'Lost'];
        const followupStatus = validStatuses.includes(body.followupStatus) ? body.followupStatus : 'New';
        const assignedPerson = String(body.assignedPerson ?? '').trim();
        const notes = String(body.notes ?? '').trim();
        const nextFollowupDate = String(body.nextFollowupDate ?? '').trim();
        const recordedDealValue = (body.recordedDealValue !== undefined && body.recordedDealValue !== null && body.recordedDealValue !== '')
          ? Number(body.recordedDealValue)
          : null;
        const recordedOrderRef = String(body.recordedOrderRef ?? '').trim();
        const ts = nowIso();

        db.prepare(`
          INSERT INTO lead_followups (
            lead_id, followup_status, assigned_person, notes, next_followup_date,
            recorded_deal_value, recorded_order_ref, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(lead_id) DO UPDATE SET
            followup_status = excluded.followup_status,
            assigned_person = excluded.assigned_person,
            notes = excluded.notes,
            next_followup_date = excluded.next_followup_date,
            recorded_deal_value = excluded.recorded_deal_value,
            recorded_order_ref = excluded.recorded_order_ref,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
        `).run(
          leadId,
          followupStatus,
          assignedPerson,
          notes,
          nextFollowupDate,
          Number.isFinite(recordedDealValue) ? recordedDealValue : null,
          recordedOrderRef,
          user.displayName,
          ts
        );

        return sendJson(res, 200, {
          message: 'Follow-up details saved locally (preserved across Meta refreshes).',
          leadId,
          followupStatus,
          assignedPerson,
          notes,
          nextFollowupDate,
          recordedDealValue,
          updatedAt: ts
        });
      }

      // --- Update Configurable Analysis Targets ("What needs attention?") ---
      if (pathname === '/api/targets' && method === 'POST') {
        const body = await readJsonBody(req);
        const accountId = body.accountId || 'default';
        const ts = nowIso();

        db.prepare(`
          INSERT INTO analysis_targets (
            account_id, target_cpl, max_spend_zero_leads, min_link_ctr_percent,
            min_clicks_for_ctr_eval, min_impressions_for_eval, min_click_to_lead_rate_percent,
            cpl_increase_threshold_percent, lead_followup_sla_hours, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            target_cpl = excluded.target_cpl,
            max_spend_zero_leads = excluded.max_spend_zero_leads,
            min_link_ctr_percent = excluded.min_link_ctr_percent,
            min_clicks_for_ctr_eval = excluded.min_clicks_for_ctr_eval,
            min_impressions_for_eval = excluded.min_impressions_for_eval,
            min_click_to_lead_rate_percent = excluded.min_click_to_lead_rate_percent,
            cpl_increase_threshold_percent = excluded.cpl_increase_threshold_percent,
            lead_followup_sla_hours = excluded.lead_followup_sla_hours,
            updated_at = excluded.updated_at
        `).run(
          accountId,
          Number(body.targetCpl || 250),
          Number(body.maxSpendZeroLeads || 400),
          Number(body.minLinkCtrPercent || 0.85),
          parseInt(body.minClicksForCtrEval || 40, 10),
          parseInt(body.minImpressionsForEval || 1000, 10),
          Number(body.minClickToLeadRatePercent || 6.0),
          Number(body.cplIncreaseThresholdPercent || 25.0),
          parseInt(body.leadFollowupSlaHours || 24, 10),
          ts
        );

        // Also update 'default' row so fallback uses latest targets
        if (accountId !== 'default') {
          db.prepare(`
            UPDATE analysis_targets SET
              target_cpl = ?, max_spend_zero_leads = ?, min_link_ctr_percent = ?,
              min_click_to_lead_rate_percent = ?, updated_at = ?
            WHERE account_id = 'default'
          `).run(
            Number(body.targetCpl || 250),
            Number(body.maxSpendZeroLeads || 400),
            Number(body.minLinkCtrPercent || 0.85),
            Number(body.minClickToLeadRatePercent || 6.0),
            ts
          );
        }

        return sendJson(res, 200, { message: 'Analysis targets updated.' });
      }

      // --- Download Real .xlsx Excel Report (Section 8) ---
      if (pathname === '/api/export/excel' && method === 'GET') {
        const { buffer, filename } = generateDashboardExcelReport({
          dataSource: parsedUrl.searchParams.get('dataSource') || '',
          accountId: parsedUrl.searchParams.get('accountId') || '',
          preset: parsedUrl.searchParams.get('preset') || 'last_30d',
          startDate: parsedUrl.searchParams.get('startDate') || '',
          endDate: parsedUrl.searchParams.get('endDate') || '',
          campaignId: parsedUrl.searchParams.get('campaignId') || '',
          adId: parsedUrl.searchParams.get('adId') || '',
          statusFilter: parsedUrl.searchParams.get('status') || 'ALL',
          platformFilter: parsedUrl.searchParams.get('platform') || 'all',
          searchQuery: parsedUrl.searchParams.get('search') || ''
        });

        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': buffer.length,
          'Cache-Control': 'no-store'
        });
        return res.end(buffer);
      }

      // --- Preview CSV / XLSX Report Upload (Column Mapping & Validation) ---
      if (pathname === '/api/reports/upload-preview' && method === 'POST') {
        const body = await readJsonBody(req);
        const filename = String(body.filename || 'report.csv');
        const base64Data = String(body.fileBase64 || '');
        if (!base64Data) {
          return sendJson(res, 400, { error: 'No file data received.' });
        }
        const fileBuffer = Buffer.from(base64Data, 'base64');
        const preview = previewReportUpload({
          filename,
          fileBuffer,
          reportType: body.reportType || 'auto'
        });
        return sendJson(res, 200, { preview });
      }

      // --- Commit CSV / XLSX Report Upload ---
      if (pathname === '/api/reports/upload-commit' && method === 'POST') {
        const body = await readJsonBody(req);
        const filename = String(body.filename || 'report.csv');
        const base64Data = String(body.fileBase64 || '');
        if (!base64Data) {
          return sendJson(res, 400, { error: 'No file data received.' });
        }
        const fileBuffer = Buffer.from(base64Data, 'base64');
        const result = commitReportUpload({
          filename,
          fileBuffer,
          reportType: body.reportType || 'performance',
          columnMapping: body.columnMapping || {},
          accountName: body.accountName || 'VIMS Enterprise (Uploaded Report)',
          currency: body.currency || 'INR'
        });
        return sendJson(res, 200, {
          message: `Imported ${result.rowsProcessed} rows (${result.rowsInserted} new, ${result.rowsUpdated} updated) into Uploaded Reports data source.`,
          result,
          connection: getSanitizedConnectionState()
        });
      }

      return sendJson(res, 404, { error: `Unknown API endpoint: ${method} ${pathname}` });
    }

    // ------------------------------------------------------------------------
    // 3. Static Frontend Assets (public/)
    // ------------------------------------------------------------------------
    let relPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(PUBLIC_DIR, safePath);

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    // Fallback to index.html
    const indexHtmlPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexHtmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(indexHtmlPath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`VIMS Enterprise Meta Ads Performance Dashboard running locally at http://${HOST}:${PORT}`);
  });
}

module.exports = { server, PORT, HOST };
