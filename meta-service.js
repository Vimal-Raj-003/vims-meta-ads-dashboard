const https = require('node:https');
const crypto = require('node:crypto');
const { db, encryptSecret, decryptSecret, nowIso, todayDateStr } = require('./db');

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Required permissions per official Meta Marketing & Leadgen Graph API documentation
// Includes ads_management so the user can toggle ads/campaigns ON (ACTIVE) or OFF (PAUSED) directly from the dashboard
const REQUIRED_PERMISSIONS = [
  {
    scope: 'ads_read',
    purpose: 'Retrieve ad accounts, campaigns, ad sets, individual ads, creatives, and advertising performance insights.',
    critical: true
  },
  {
    scope: 'ads_management',
    purpose: 'Turn campaigns, ad sets, or individual ads ON (ACTIVE) and OFF (PAUSED) directly in Meta Ads Manager.',
    critical: true
  },
  {
    scope: 'leads_retrieval',
    purpose: 'Retrieve customer form submissions from Meta Instant Forms attached to your Facebook/Instagram Lead Ads.',
    critical: true
  },
  {
    scope: 'pages_show_list',
    purpose: 'List your connected Facebook Pages so the dashboard can discover lead forms associated with each Page.',
    critical: true
  },
  {
    scope: 'pages_read_engagement',
    purpose: 'Read Page metadata, ad creative previews, and access leadgen_forms edge on your selected Facebook Pages.',
    critical: true
  },
  {
    scope: 'business_management',
    purpose: 'Optional: List all Business Manager portfolios and all N Ad Accounts owned or shared across your businesses.',
    critical: false
  }
];

// Currencies where Meta API reports minor units without cents (1:1 divisor)
const ZERO_DECIMAL_CURRENCIES = new Set([
  'CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND'
]);

function minorUnitToMajor(rawVal, currency = 'INR') {
  if (rawVal === null || rawVal === undefined || rawVal === '') return null;
  const num = Number(rawVal);
  if (!Number.isFinite(num)) return null;
  const div = ZERO_DECIMAL_CURRENCIES.has(String(currency).toUpperCase()) ? 1 : 100;
  return Number((num / div).toFixed(2));
}

/**
 * Perform a GET request to Meta Graph API with automatic retry on transient network/rate limit errors.
 * Never logs the raw access token.
 */
function graphGet(urlOrPath, accessToken, retries = 2) {
  return new Promise((resolve, reject) => {
    let fullUrl = urlOrPath.startsWith('https://')
      ? urlOrPath
      : `${GRAPH_BASE}${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`;

    const parsed = new URL(fullUrl);
    if (accessToken && !parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', accessToken);
    }

    const req = https.get(parsed.toString(), { timeout: 25000 }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(raw || '{}');
        } catch (e) {
          return reject(new Error(`Invalid JSON from Meta Graph API (HTTP ${res.statusCode})`));
        }

        if (res.statusCode >= 200 && res.statusCode < 300 && !json.error) {
          return resolve(json);
        }

        const errObj = json.error || {};
        const code = errObj.code || res.statusCode;
        const subcode = errObj.error_subcode || 0;
        const msg = errObj.message || `Meta Graph API Error (HTTP ${res.statusCode})`;

        // Retry on transient rate-limit or server errors (codes 1, 2, 4, 17, 32, 613)
        if (retries > 0 && [1, 2, 4, 17, 32, 613].includes(Number(code))) {
          setTimeout(() => {
            graphGet(urlOrPath, accessToken, retries - 1).then(resolve).catch(reject);
          }, 1500);
          return;
        }

        const error = new Error(msg);
        error.metaCode = code;
        error.metaSubcode = subcode;
        error.metaType = errObj.type || 'GraphMethodException';
        reject(error);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      if (retries > 0) {
        setTimeout(() => {
          graphGet(urlOrPath, accessToken, retries - 1).then(resolve).catch(reject);
        }, 1500);
      } else {
        const err = new Error('Meta Graph API request timed out.');
        err.metaCode = 'NETWORK_TIMEOUT';
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (retries > 0) {
        setTimeout(() => {
          graphGet(urlOrPath, accessToken, retries - 1).then(resolve).catch(reject);
        }, 1500);
      } else {
        err.metaCode = err.code || 'NETWORK_ERROR';
        reject(err);
      }
    });
  });
}

/**
 * Perform a POST request to Meta Graph API (used to toggle Campaign / Ad Set / Ad status between ACTIVE and PAUSED).
 */
function graphPost(urlOrPath, accessToken, formParams = {}) {
  return new Promise((resolve, reject) => {
    const fullUrl = urlOrPath.startsWith('https://')
      ? urlOrPath
      : `${GRAPH_BASE}${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`;

    const parsed = new URL(fullUrl);
    const bodyParams = new URLSearchParams();
    for (const [k, v] of Object.entries(formParams)) {
      if (v !== undefined && v !== null) bodyParams.set(k, String(v));
    }
    if (accessToken) {
      bodyParams.set('access_token', accessToken);
    }
    const postData = bodyParams.toString();

    const req = https.request(parsed.toString(), {
      method: 'POST',
      timeout: 20000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(raw || '{}');
        } catch {
          return reject(new Error(`Invalid JSON from Meta Graph API POST (HTTP ${res.statusCode})`));
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && !json.error) {
          return resolve(json);
        }
        const errObj = json.error || {};
        const error = new Error(errObj.message || `Meta Graph API POST Error (HTTP ${res.statusCode})`);
        error.metaCode = errObj.code || res.statusCode;
        reject(error);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Meta Graph API POST request timed out.'));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Toggle a Campaign, Ad Set, or Individual Ad ON ('ACTIVE') or OFF ('PAUSED').
 * - When dataSource === 'meta_api', sends a live POST /{id} status=ACTIVE|PAUSED to Meta Ads Manager
 *   and updates the local SQLite database immediately after Meta confirms.
 * - When dataSource === 'demo_mode' or 'uploaded_report', updates the local status so the switch works in preview too.
 */
async function toggleMetaEntityStatus({ entityType, entityId, newStatus, dataSource = 'meta_api' }) {
  const cleanStatus = String(newStatus || '').toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
  const ts = nowIso();

  if (dataSource === 'meta_api') {
    const conn = db.prepare(`SELECT access_token_enc FROM meta_connections WHERE id = 'default'`).get();
    const accessToken = decryptSecret(conn?.access_token_enc || '');
    if (accessToken && !accessToken.startsWith('vims_synced_session_')) {
      // Live POST to Meta Graph API: POST /{campaign_id | adset_id | ad_id} with status=ACTIVE|PAUSED
      await graphPost(`/${encodeURIComponent(entityId)}`, accessToken, { status: cleanStatus });
    }
  }

  if (entityType === 'campaign') {
    db.prepare(`
      UPDATE campaigns
      SET status = ?, effective_status = ?, updated_time = ?, last_synced_at = ?
      WHERE campaign_id = ? AND data_source = ?
    `).run(cleanStatus, cleanStatus, ts, ts, entityId, dataSource);
  } else if (entityType === 'adset') {
    db.prepare(`
      UPDATE adsets
      SET status = ?, effective_status = ?, updated_time = ?, last_synced_at = ?
      WHERE adset_id = ? AND data_source = ?
    `).run(cleanStatus, cleanStatus, ts, ts, entityId, dataSource);
  } else {
    db.prepare(`
      UPDATE ads
      SET status = ?, effective_status = ?, updated_time = ?, last_synced_at = ?
      WHERE ad_id = ? AND data_source = ?
    `).run(cleanStatus, cleanStatus, ts, ts, entityId, dataSource);
  }

  return {
    entityType,
    entityId,
    status: cleanStatus,
    effectiveStatus: cleanStatus,
    dataSource,
    syncedToMetaAdsManager: dataSource === 'meta_api',
    updatedAt: ts
  };
}

/**
 * Exhaustively paginate a Meta Graph API cursor edge without any arbitrary count limit.
 */
async function graphGetPaginated(initialPath, accessToken, maxPages = 500) {
  const allItems = [];
  let nextUrl = initialPath;
  let pageCount = 0;

  while (nextUrl && pageCount < maxPages) {
    pageCount++;
    const resp = await graphGet(nextUrl, accessToken);
    if (Array.isArray(resp.data)) {
      allItems.push(...resp.data);
    }
    if (resp.paging && resp.paging.next) {
      nextUrl = resp.paging.next;
    } else {
      nextUrl = null;
    }
  }

  return allItems;
}

/**
 * Parse Meta's `actions` array without double-counting overlapping lead types!
 * Meta returns multiple action types for a single form submission:
 *   e.g. `lead` (aggregate), `onsite_conversion.lead_grouped` (instant form), `leadgen_grouped`, `offsite_conversion.fb_pixel_lead`.
 * Rule:
 * - Form Leads (`form_leads`): Use `onsite_conversion.lead_grouped` if present; otherwise `leadgen_grouped`;
 *   only fallback to `lead` if neither specific form action nor pixel/messaging lead is present.
 * - Messaging Leads (`messaging_leads`): `onsite_conversion.messaging_conversation_started_7d`
 * - Website Leads (`website_leads`): `offsite_conversion.fb_pixel_lead`
 * - Link Clicks (`link_clicks`): Explicit `inline_link_clicks` field or `link_click` action.
 */
function extractMetricsFromInsightRow(row, campaignObjective = 'OUTCOME_LEADS') {
  const spend = Number(Number(row.spend || 0).toFixed(2));
  const impressions = parseInt(row.impressions || 0, 10) || 0;
  const reach = (row.reach !== undefined && row.reach !== null && row.reach !== '')
    ? parseInt(row.reach, 10)
    : null;
  const frequency = (row.frequency !== undefined && row.frequency !== null && row.frequency !== '')
    ? Number(Number(row.frequency).toFixed(4))
    : null;
  const clicksAll = parseInt(row.clicks || 0, 10) || 0;

  const actions = Array.isArray(row.actions) ? row.actions : [];
  const actionMap = {};
  for (const act of actions) {
    if (act && act.action_type) {
      actionMap[act.action_type] = parseInt(act.value || 0, 10) || 0;
    }
  }

  // Link clicks: prefer explicit inline_link_clicks field, else action_type === 'link_click'
  const linkClicks = (row.inline_link_clicks !== undefined && row.inline_link_clicks !== null && row.inline_link_clicks !== '')
    ? (parseInt(row.inline_link_clicks, 10) || 0)
    : (actionMap['link_click'] || 0);

  const uniqueLinkClicks = (row.unique_inline_link_clicks !== undefined && row.unique_inline_link_clicks !== null)
    ? (parseInt(row.unique_inline_link_clicks, 10) || 0)
    : null;

  // Strict non-overlapping Form Lead extraction
  let formLeads = 0;
  if ('onsite_conversion.lead_grouped' in actionMap) {
    formLeads = actionMap['onsite_conversion.lead_grouped'];
  } else if ('leadgen_grouped' in actionMap) {
    formLeads = actionMap['leadgen_grouped'];
  } else if ('lead' in actionMap && !('offsite_conversion.fb_pixel_lead' in actionMap)) {
    formLeads = actionMap['lead'];
  }

  const websiteLeads = actionMap['offsite_conversion.fb_pixel_lead'] || 0;
  const messagingLeads = actionMap['onsite_conversion.messaging_conversation_started_7d'] || 0;
  const landingPageViews = actionMap['landing_page_view'] || 0;
  const postEngagements = actionMap['post_engagement'] || 0;
  const videoViews = actionMap['video_view'] || 0;

  // Determine objective-aligned primary result type and count
  const obj = String(campaignObjective || '').toUpperCase();
  let resultType = 'Form Leads';
  let resultsCount = formLeads;

  if (obj.includes('LEAD')) {
    resultType = 'Form Leads';
    resultsCount = formLeads;
  } else if (obj.includes('TRAFFIC') || obj.includes('LINK_CLICKS')) {
    resultType = landingPageViews > 0 ? 'Landing Page Views' : 'Link Clicks';
    resultsCount = landingPageViews > 0 ? landingPageViews : linkClicks;
  } else if (obj.includes('REACH') || obj.includes('AWARENESS')) {
    resultType = 'Reach';
    resultsCount = reach !== null ? reach : impressions;
  } else if (obj.includes('ENGAGEMENT') || obj.includes('MESSAGES')) {
    if (messagingLeads > 0) {
      resultType = 'Messaging Conversations';
      resultsCount = messagingLeads;
    } else {
      resultType = 'Post Engagements';
      resultsCount = postEngagements;
    }
  } else if (obj.includes('VIDEO')) {
    resultType = 'ThruPlay / Video Views';
    resultsCount = videoViews;
  } else if (obj.includes('SALES') || obj.includes('CONVERSIONS')) {
    resultType = websiteLeads > 0 ? 'Website Leads' : 'Form Leads';
    resultsCount = websiteLeads > 0 ? websiteLeads : formLeads;
  }

  return {
    spend,
    impressions,
    reach,
    frequency,
    clicksAll,
    linkClicks,
    uniqueLinkClicks,
    formLeads,
    messagingLeads,
    websiteLeads,
    landingPageViews,
    postEngagements,
    videoViews,
    resultType,
    resultsCount,
    rawActionsJson: JSON.stringify(actions)
  };
}

/**
 * Translate Meta API errors or OAuth issues into clear English + Tamil/Tanglish instructions
 */
function buildBlockerExplanation(err) {
  const code = err.metaCode;
  const msg = String(err.message || '');

  if (code === 190) {
    return {
      blockerCode: 'TOKEN_EXPIRED_OR_INVALID',
      blockerMessage: `Meta Access Token has expired or is invalid (${msg}).`,
      blockerActionTa: `Ungaloda Meta Access Token expire aagiduchi. Meta Business Settings -> System Users alladhu Graph API Explorer poitu pudhu Token generate panni "Connect Meta Account" box-il paste pannunga.`
    };
  }
  if (code === 10 || code === 200 || (code >= 200 && code <= 299) || msg.toLowerCase().includes('permission')) {
    return {
      blockerCode: 'MISSING_META_PERMISSIONS',
      blockerMessage: `Missing required Meta Graph API permissions: ${msg}`,
      blockerActionTa: `Token-il thevaiyana permissions illai. Token generate pannumbodhu "ads_read", "leads_retrieval", "pages_show_list", matrum "pages_read_engagement" permissions tick panni authorize pannunga.`
    };
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'NETWORK_ERROR' || code === 'NETWORK_TIMEOUT' || code === 'EACCES') {
    return {
      blockerCode: 'NETWORK_OR_SANDBOX_RESTRICTED',
      blockerMessage: `Cannot reach graph.facebook.com from current network environment (${msg}).`,
      blockerActionTa: `Internet connection alladhu firewall graph.facebook.com-ai block pannudhu. Ungal computer-il internet active-aa irukka endru check pannunga, alladhu "Upload Report" button use panni Meta Excel/CSV file-ai import pannunga.`
    };
  }
  return {
    blockerCode: `META_API_ERROR_${code || 'UNKNOWN'}`,
    blockerMessage: msg,
    blockerActionTa: `Meta API connection-il oru error vandhurukku: "${msg}". Ungal Ad Account ID matrum Access Token permissions-ai verify pannunga.`
  };
}

/**
 * Exchange an OAuth authorization code for an access token, or exchange a short-lived token for a 60-day token
 */
async function exchangeCodeForToken({ appId, appSecret, redirectUri, code }) {
  const path = `/oauth/access_token?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}`;
  return graphGet(path, null, 1);
}

async function exchangeForLongLivedToken({ appId, appSecret, shortLivedToken }) {
  const path = `/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${encodeURIComponent(shortLivedToken)}`;
  return graphGet(path, null, 1);
}

/**
 * Discover user profile, granted permissions, businesses, ad accounts, and Facebook Pages
 * using an authorized access token.
 */
async function discoverMetaAssets(rawToken, appId = '', appSecret = '') {
  let activeToken = String(rawToken || '').trim();
  if (!activeToken) {
    throw new Error('Access token is required to connect to Meta Graph API.');
  }

  // If App ID and App Secret are provided, attempt to upgrade to a 60-day long-lived token
  let expiresAt = '';
  if (appId && appSecret) {
    try {
      const exchanged = await exchangeForLongLivedToken({
        appId,
        appSecret,
        shortLivedToken: activeToken
      });
      if (exchanged && exchanged.access_token) {
        activeToken = exchanged.access_token;
        if (exchanged.expires_in) {
          expiresAt = new Date(Date.now() + Number(exchanged.expires_in) * 1000).toISOString();
        }
      }
    } catch {
      // Continue with provided token (e.g. if it's already a System User permanent token)
    }
  }

  // 1. Verify identity (/me) — also fetch email if email permission is granted so user can verify vims2023@gmail.com
  const me = await graphGet('/me?fields=id,name,email', activeToken);

  // 2. Check granted permissions (/me/permissions)
  let granted = [];
  let declined = [];
  try {
    const permsResp = await graphGet('/me/permissions', activeToken);
    for (const p of (permsResp.data || [])) {
      if (p.status === 'granted') granted.push(p.permission);
      else declined.push(p.permission);
    }
  } catch {
    // System tokens sometimes don't expose /me/permissions in the same format
  }

  // 3. Discover accessible Businesses (/me/businesses)
  let businesses = [];
  try {
    businesses = await graphGetPaginated('/me/businesses?fields=id,name&limit=100', activeToken);
  } catch {
    businesses = [];
  }

  // 4. Discover ALL accessible Ad Accounts:
  //    - Direct personal/assigned ad accounts (/me/adaccounts)
  //    - Business-owned ad accounts (/{business_id}/owned_ad_accounts)
  //    - Partner/agency shared ad accounts (/{business_id}/client_ad_accounts)
  const adAccountFields = 'id,account_id,name,currency,timezone_name,timezone_offset_hours_utc,account_status,amount_spent,balance,spend_cap,is_prepay_account,funding_source_details,business{id,name}';
  const adAccountsMap = new Map();

  const directAdAccounts = await graphGetPaginated(
    `/me/adaccounts?fields=${adAccountFields}&limit=100`,
    activeToken
  );
  for (const acc of directAdAccounts) {
    if (acc && acc.id) adAccountsMap.set(acc.id, acc);
  }

  for (const biz of businesses) {
    if (!biz || !biz.id) continue;
    try {
      const ownedAccs = await graphGetPaginated(
        `/${biz.id}/owned_ad_accounts?fields=${adAccountFields}&limit=100`,
        activeToken
      );
      for (const acc of ownedAccs) {
        if (acc && acc.id) {
          if (!acc.business) acc.business = { id: biz.id, name: biz.name };
          adAccountsMap.set(acc.id, acc);
        }
      }
    } catch {}
    try {
      const clientAccs = await graphGetPaginated(
        `/${biz.id}/client_ad_accounts?fields=${adAccountFields}&limit=100`,
        activeToken
      );
      for (const acc of clientAccs) {
        if (acc && acc.id) {
          if (!acc.business) acc.business = { id: biz.id, name: biz.name };
          adAccountsMap.set(acc.id, acc);
        }
      }
    } catch {}
  }

  const adAccountsRaw = Array.from(adAccountsMap.values());

  // Extract unique businesses from ad accounts if /me/businesses wasn't populated
  if (businesses.length === 0) {
    const bMap = new Map();
    for (const acc of adAccountsRaw) {
      if (acc.business && acc.business.id) {
        bMap.set(acc.business.id, { id: acc.business.id, name: acc.business.name || acc.business.id });
      }
    }
    businesses = Array.from(bMap.values());
  }

  // 5. Discover accessible Facebook Pages (/me/accounts + Business owned_pages) for Lead Forms retrieval
  const pagesMap = new Map();
  const pageTokensMap = {};
  try {
    const directPages = await graphGetPaginated('/me/accounts?fields=id,name,category,access_token&limit=100', activeToken);
    for (const pg of directPages) {
      if (pg && pg.id) {
        pagesMap.set(pg.id, pg);
        if (pg.access_token) pageTokensMap[pg.id] = pg.access_token;
      }
    }
  } catch {
    // If pages_show_list not granted, record warning
  }

  for (const biz of businesses) {
    if (!biz || !biz.id) continue;
    try {
      const bizPages = await graphGetPaginated(`/${biz.id}/owned_pages?fields=id,name,category,access_token&limit=100`, activeToken);
      for (const pg of bizPages) {
        if (pg && pg.id && !pagesMap.has(pg.id)) {
          pagesMap.set(pg.id, pg);
          if (pg.access_token) pageTokensMap[pg.id] = pg.access_token;
        }
      }
    } catch {}
  }

  const pagesRaw = Array.from(pagesMap.values());

  const sanitizedPages = pagesRaw.map(p => ({
    id: p.id,
    name: p.name,
    category: p.category || 'Facebook Page',
    hasPageToken: Boolean(p.access_token)
  }));

  const sanitizedAccounts = adAccountsRaw.map(a => ({
    id: a.id, // act_123456
    account_id: a.account_id || String(a.id).replace(/^act_/, ''),
    name: a.name || `Ad Account ${a.id}`,
    currency: a.currency || 'INR',
    timezone_name: a.timezone_name || 'Asia/Kolkata',
    timezone_offset_hours: a.timezone_offset_hours_utc ?? 5.5,
    account_status: a.account_status ?? 1,
    business_id: a.business ? a.business.id : '',
    business_name: a.business ? a.business.name : ''
  }));

  // Check if any critical permissions are missing
  const missingCritical = REQUIRED_PERMISSIONS
    .filter(r => r.critical && granted.length > 0 && !granted.includes(r.scope))
    .map(r => r.scope);

  let blockerCode = '';
  let blockerMessage = '';
  let blockerActionTa = '';

  if (sanitizedAccounts.length === 0) {
    blockerCode = 'NO_AD_ACCOUNTS_FOUND';
    blockerMessage = 'Authenticated with Meta, but no Ad Accounts were returned for this token.';
    blockerActionTa = 'Ungal Meta account connect aagiduchi, aanaal indha token-kku Ad Account access illai. Meta Business Settings -> Ad Accounts poitu ungal user/system token-kku Ad Account permission assign pannunga.';
  } else if (missingCritical.length > 0) {
    blockerCode = 'PARTIAL_PERMISSIONS';
    blockerMessage = `Connected, but missing permissions: ${missingCritical.join(', ')}. Lead form retrieval or creative details may be limited.`;
    blockerActionTa = `Account connect aagiduchi, aanaal "${missingCritical.join(', ')}" permissions missing-aa irukku. Ellaa Lead Forms matrum Ads eduka andha permissions-ai allow panni pudhu token generate pannunga.`;
  }

  const defaultAcc = sanitizedAccounts[0] || null;
  const defaultBiz = businesses[0] || (defaultAcc && defaultAcc.business_id ? { id: defaultAcc.business_id, name: defaultAcc.business_name } : null);

  // Persist connection state securely (tokens encrypted at rest)
  db.prepare(`
    UPDATE meta_connections SET
      app_id = ?,
      app_secret_enc = ?,
      access_token_enc = ?,
      token_expires_at = ?,
      connected_user_id = ?,
      connected_user_name = ?,
      connected_user_email = ?,
      granted_permissions = ?,
      declined_permissions = ?,
      selected_business_id = COALESCE(NULLIF(selected_business_id, ''), ?),
      selected_business_name = COALESCE(NULLIF(selected_business_name, ''), ?),
      selected_ad_account_id = COALESCE(NULLIF(selected_ad_account_id, ''), ?),
      selected_ad_account_name = COALESCE(NULLIF(selected_ad_account_name, ''), ?),
      selected_page_ids = CASE WHEN selected_page_ids = '[]' OR selected_page_ids = '' THEN ? ELSE selected_page_ids END,
      selected_page_names = CASE WHEN selected_page_names = '[]' OR selected_page_names = '' THEN ? ELSE selected_page_names END,
      available_businesses_json = ?,
      available_ad_accounts_json = ?,
      available_pages_json = ?,
      page_tokens_enc = ?,
      connection_status = ?,
      blocker_code = ?,
      blocker_message = ?,
      blocker_action_ta = ?,
      active_data_source = 'meta_api',
      updated_at = ?
    WHERE id = 'default'
  `).run(
    appId || '',
    appSecret ? encryptSecret(appSecret) : '',
    encryptSecret(activeToken),
    expiresAt,
    me.id || '',
    me.name || 'Meta User',
    me.email || '',
    JSON.stringify(granted),
    JSON.stringify(declined),
    defaultBiz ? defaultBiz.id : '',
    defaultBiz ? defaultBiz.name : '',
    defaultAcc ? defaultAcc.id : '',
    defaultAcc ? defaultAcc.name : '',
    JSON.stringify(sanitizedPages.map(p => p.id)),
    JSON.stringify(sanitizedPages.map(p => p.name)),
    JSON.stringify(businesses),
    JSON.stringify(sanitizedAccounts),
    JSON.stringify(sanitizedPages),
    encryptSecret(JSON.stringify(pageTokensMap)),
    sanitizedAccounts.length > 0 ? 'connected' : 'partial',
    blockerCode,
    blockerMessage,
    blockerActionTa,
    nowIso()
  );

  // Also upsert discovered ad accounts into ad_accounts table
  for (const rawAcc of adAccountsRaw) {
    upsertAdAccountFromMeta(rawAcc, 'meta_api');
  }

  return getSanitizedConnectionState();
}

function upsertAdAccountFromMeta(rawAcc, dataSource = 'meta_api') {
  const accId = rawAcc.id.startsWith('act_') ? rawAcc.id : `act_${rawAcc.account_id || rawAcc.id}`;
  const currency = rawAcc.currency || 'INR';
  const amountSpent = minorUnitToMajor(rawAcc.amount_spent, currency);
  const balanceOwed = minorUnitToMajor(rawAcc.balance, currency);
  const spendCap = rawAcc.spend_cap && Number(rawAcc.spend_cap) > 0
    ? minorUnitToMajor(rawAcc.spend_cap, currency)
    : null;
  const isPrepay = rawAcc.is_prepay_account === true ? 1 : (rawAcc.is_prepay_account === false ? 0 : null);

  // Parse funding_source_details strictly: never invent a balance!
  // Only report available_funds_verified if Meta explicitly returns a prepaid balance in funding_source_details.
  let availableFundsVerified = null;
  let fundingDisplay = '';
  let billingNote = 'Unavailable from connected data.';

  if (rawAcc.funding_source_details) {
    const fsd = rawAcc.funding_source_details;
    fundingDisplay = fsd.display_string || '';
    // Check if Meta explicitly provides a numeric prepaid available balance
    if (fsd.amount !== undefined && fsd.amount !== null) {
      availableFundsVerified = minorUnitToMajor(fsd.amount, currency);
      billingNote = `Verified prepaid funds from Meta funding source (${fundingDisplay || 'Prepay'}).`;
    } else if (fundingDisplay) {
      // Sometimes display_string says e.g. "Available balance (₹4,250.00 INR)"
      billingNote = `Meta funding source: ${fundingDisplay}. Exact prepaid balance is not exposed as a separate numeric field by Meta API; showing verified amount owed (${currency} ${(balanceOwed ?? 0).toFixed(2)}).`;
    }
  } else if (balanceOwed !== null) {
    billingNote = `Meta reports current unpaid balance / amount owed (${currency} ${balanceOwed.toFixed(2)}). Prepaid wallet balance is unavailable from connected data.`;
  }

  db.prepare(`
    INSERT INTO ad_accounts (
      account_id, data_source, name, currency, timezone_name, timezone_offset_hours,
      account_status, amount_spent_total, balance_amount_owed, spend_cap,
      is_prepay_account, available_funds_verified, funding_source_details,
      billing_verification_note, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      name = excluded.name,
      currency = excluded.currency,
      timezone_name = excluded.timezone_name,
      timezone_offset_hours = excluded.timezone_offset_hours,
      account_status = excluded.account_status,
      amount_spent_total = COALESCE(excluded.amount_spent_total, ad_accounts.amount_spent_total),
      balance_amount_owed = COALESCE(excluded.balance_amount_owed, ad_accounts.balance_amount_owed),
      spend_cap = COALESCE(excluded.spend_cap, ad_accounts.spend_cap),
      is_prepay_account = COALESCE(excluded.is_prepay_account, ad_accounts.is_prepay_account),
      available_funds_verified = excluded.available_funds_verified,
      funding_source_details = excluded.funding_source_details,
      billing_verification_note = excluded.billing_verification_note,
      updated_at = excluded.updated_at
  `).run(
    accId,
    dataSource,
    rawAcc.name || accId,
    currency,
    rawAcc.timezone_name || 'Asia/Kolkata',
    rawAcc.timezone_offset_hours_utc ?? 5.5,
    rawAcc.account_status ?? 1,
    amountSpent,
    balanceOwed,
    spendCap,
    isPrepay,
    availableFundsVerified,
    fundingDisplay,
    billingNote,
    nowIso()
  );
}

/**
 * Full Synchronization of Campaigns, Ad Sets, Ads, Daily Insights (Overall + Publisher Platform),
 * Period Unique Reach, and Page Lead Form Submissions for the selected Ad Account.
 * Preserves previously collected history for paused, completed, archived or deleted ads!
 */
async function syncMetaAdAccount({
  triggerType = 'manual',
  lookbackDays = 90,
  customSince = null,
  customUntil = null
} = {}) {
  const conn = db.prepare(`SELECT * FROM meta_connections WHERE id = 'default'`).get();
  if (!conn || !conn.access_token_enc) {
    throw new Error('Meta account is not connected yet. Please authorize your Meta account first.');
  }

  const accessToken = decryptSecret(conn.access_token_enc);
  if (!accessToken) {
    throw new Error('Stored Meta access token could not be decrypted. Please reconnect your token.');
  }

  const accountId = conn.selected_ad_account_id;
  if (!accountId) {
    throw new Error('No Meta Ad Account is selected. Please select an Ad Account in Setup.');
  }

  const syncId = crypto.randomUUID();
  const startedAt = nowIso();
  const dataSource = 'meta_api';

  let campaignsCount = 0;
  let adsetsCount = 0;
  let adsCount = 0;
  let insightsCount = 0;
  let leadsCount = 0;

  try {
    // 1. Refresh Ad Account Metadata & Billing info
    const accDetails = await graphGet(
      `/${accountId}?fields=id,account_id,name,currency,timezone_name,timezone_offset_hours_utc,account_status,amount_spent,balance,spend_cap,is_prepay_account,funding_source_details`,
      accessToken
    );
    upsertAdAccountFromMeta(accDetails, dataSource);
    const currency = accDetails.currency || 'INR';

    // 2. Discover & Upsert ALL Campaigns (including ACTIVE, PAUSED, ARCHIVED, COMPLETED) via complete pagination
    const filteringAllStatuses = encodeURIComponent(JSON.stringify([
      { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO'] }
    ]));

    const rawCampaigns = await graphGetPaginated(
      `/${accountId}/campaigns?fields=id,name,status,effective_status,configured_status,objective,buying_type,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,created_time,updated_time&filtering=${filteringAllStatuses}&limit=200`,
      accessToken
    );

    const seenCampaignIds = new Set();
    const campaignObjectiveMap = {};

    const upsertCampaignStmt = db.prepare(`
      INSERT INTO campaigns (
        campaign_id, data_source, account_id, name, status, effective_status, configured_status,
        objective, buying_type, daily_budget, lifetime_budget, budget_remaining,
        start_time, stop_time, created_time, updated_time, is_deleted_on_meta,
        first_seen_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(campaign_id, data_source) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        effective_status = excluded.effective_status,
        configured_status = excluded.configured_status,
        objective = excluded.objective,
        buying_type = excluded.buying_type,
        daily_budget = excluded.daily_budget,
        lifetime_budget = excluded.lifetime_budget,
        budget_remaining = excluded.budget_remaining,
        start_time = excluded.start_time,
        stop_time = excluded.stop_time,
        updated_time = excluded.updated_time,
        is_deleted_on_meta = 0,
        last_synced_at = excluded.last_synced_at
    `);

    const syncTs = nowIso();
    for (const c of rawCampaigns) {
      seenCampaignIds.add(c.id);
      campaignObjectiveMap[c.id] = c.objective || 'OUTCOME_LEADS';
      upsertCampaignStmt.run(
        c.id,
        dataSource,
        accountId,
        c.name || `Campaign ${c.id}`,
        c.status || 'UNKNOWN',
        c.effective_status || c.status || 'UNKNOWN',
        c.configured_status || '',
        c.objective || 'OUTCOME_LEADS',
        c.buying_type || 'AUCTION',
        minorUnitToMajor(c.daily_budget, currency),
        minorUnitToMajor(c.lifetime_budget, currency),
        minorUnitToMajor(c.budget_remaining, currency),
        c.start_time || '',
        c.stop_time || '',
        c.created_time || '',
        c.updated_time || '',
        syncTs,
        syncTs
      );
      campaignsCount++;
    }

    // Mark any previously stored campaigns that were deleted on Meta as is_deleted_on_meta = 1 (preserving history!)
    if (seenCampaignIds.size > 0) {
      const existingCampaigns = db.prepare(`SELECT campaign_id FROM campaigns WHERE account_id = ? AND data_source = ?`).all(accountId, dataSource);
      const markDeletedCamp = db.prepare(`UPDATE campaigns SET is_deleted_on_meta = 1, effective_status = CASE WHEN effective_status = 'ACTIVE' THEN 'DELETED' ELSE effective_status END WHERE campaign_id = ? AND data_source = ?`);
      for (const row of existingCampaigns) {
        if (!seenCampaignIds.has(row.campaign_id)) {
          markDeletedCamp.run(row.campaign_id, dataSource);
        }
      }
    }

    // 3. Discover & Upsert ALL Ad Sets via complete pagination
    const rawAdsets = await graphGetPaginated(
      `/${accountId}/adsets?fields=id,name,campaign_id,status,effective_status,optimization_goal,billing_event,daily_budget,lifetime_budget,budget_remaining,destination_type,start_time,end_time,created_time,updated_time&limit=200`,
      accessToken
    );

    const seenAdsetIds = new Set();
    const upsertAdsetStmt = db.prepare(`
      INSERT INTO adsets (
        adset_id, data_source, account_id, campaign_id, name, status, effective_status,
        optimization_goal, billing_event, daily_budget, lifetime_budget, budget_remaining,
        destination_type, start_time, end_time, created_time, updated_time,
        is_deleted_on_meta, first_seen_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(adset_id, data_source) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        name = excluded.name,
        status = excluded.status,
        effective_status = excluded.effective_status,
        optimization_goal = excluded.optimization_goal,
        billing_event = excluded.billing_event,
        daily_budget = excluded.daily_budget,
        lifetime_budget = excluded.lifetime_budget,
        budget_remaining = excluded.budget_remaining,
        destination_type = excluded.destination_type,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        updated_time = excluded.updated_time,
        is_deleted_on_meta = 0,
        last_synced_at = excluded.last_synced_at
    `);

    for (const as of rawAdsets) {
      seenAdsetIds.add(as.id);
      upsertAdsetStmt.run(
        as.id,
        dataSource,
        accountId,
        as.campaign_id || '',
        as.name || `Ad Set ${as.id}`,
        as.status || 'UNKNOWN',
        as.effective_status || as.status || 'UNKNOWN',
        as.optimization_goal || '',
        as.billing_event || '',
        minorUnitToMajor(as.daily_budget, currency),
        minorUnitToMajor(as.lifetime_budget, currency),
        minorUnitToMajor(as.budget_remaining, currency),
        as.destination_type || '',
        as.start_time || '',
        as.end_time || '',
        as.created_time || '',
        as.updated_time || '',
        syncTs,
        syncTs
      );
      adsetsCount++;
    }

    // 4. Discover & Upsert ALL Individual Ads & Creatives via complete pagination
    const rawAds = await graphGetPaginated(
      `/${accountId}/ads?fields=id,name,campaign_id,adset_id,status,effective_status,created_time,updated_time,creative{id,name,title,body,call_to_action_type,image_url,thumbnail_url,video_id,object_type,object_story_spec,asset_feed_spec}&limit=200`,
      accessToken
    );

    const seenAdIds = new Set();
    const upsertAdStmt = db.prepare(`
      INSERT INTO ads (
        ad_id, data_source, account_id, campaign_id, adset_id, name, status, effective_status,
        creative_id, creative_name, creative_title, creative_body, creative_cta,
        creative_link_url, creative_thumbnail_url, creative_image_url, creative_video_id,
        creative_media_type, lead_form_id, created_time, updated_time,
        is_deleted_on_meta, first_seen_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(ad_id, data_source) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        adset_id = excluded.adset_id,
        name = excluded.name,
        status = excluded.status,
        effective_status = excluded.effective_status,
        creative_id = COALESCE(NULLIF(excluded.creative_id, ''), ads.creative_id),
        creative_name = COALESCE(NULLIF(excluded.creative_name, ''), ads.creative_name),
        creative_title = COALESCE(NULLIF(excluded.creative_title, ''), ads.creative_title),
        creative_body = COALESCE(NULLIF(excluded.creative_body, ''), ads.creative_body),
        creative_cta = COALESCE(NULLIF(excluded.creative_cta, ''), ads.creative_cta),
        creative_link_url = COALESCE(NULLIF(excluded.creative_link_url, ''), ads.creative_link_url),
        creative_thumbnail_url = COALESCE(NULLIF(excluded.creative_thumbnail_url, ''), ads.creative_thumbnail_url),
        creative_image_url = COALESCE(NULLIF(excluded.creative_image_url, ''), ads.creative_image_url),
        creative_video_id = COALESCE(NULLIF(excluded.creative_video_id, ''), ads.creative_video_id),
        creative_media_type = excluded.creative_media_type,
        lead_form_id = COALESCE(NULLIF(excluded.lead_form_id, ''), ads.lead_form_id),
        updated_time = excluded.updated_time,
        is_deleted_on_meta = 0,
        last_synced_at = excluded.last_synced_at
    `);

    for (const ad of rawAds) {
      seenAdIds.add(ad.id);
      const cr = ad.creative || {};
      const oss = cr.object_story_spec || {};
      const linkData = oss.link_data || {};
      const videoData = oss.video_data || {};

      const title = cr.title || linkData.name || videoData.title || '';
      const body = cr.body || linkData.message || videoData.message || '';
      const cta = cr.call_to_action_type || (linkData.call_to_action && linkData.call_to_action.type) || (videoData.call_to_action && videoData.call_to_action.type) || '';
      const linkUrl = linkData.link || '';
      const thumbUrl = cr.thumbnail_url || videoData.image_url || cr.image_url || '';
      const imgUrl = cr.image_url || linkData.picture || videoData.image_url || thumbUrl || '';
      const videoId = cr.video_id || videoData.video_id || '';
      const mediaType = videoId ? 'VIDEO' : (cr.object_type || 'IMAGE');

      const leadFormId = (linkData.call_to_action && linkData.call_to_action.value && linkData.call_to_action.value.lead_gen_form_id)
        || (videoData.call_to_action && videoData.call_to_action.value && videoData.call_to_action.value.lead_gen_form_id)
        || '';

      upsertAdStmt.run(
        ad.id,
        dataSource,
        accountId,
        ad.campaign_id || '',
        ad.adset_id || '',
        ad.name || `Ad ${ad.id}`,
        ad.status || 'UNKNOWN',
        ad.effective_status || ad.status || 'UNKNOWN',
        cr.id || '',
        cr.name || '',
        title,
        body,
        cta,
        linkUrl,
        thumbUrl,
        imgUrl,
        videoId,
        mediaType,
        String(leadFormId),
        ad.created_time || '',
        ad.updated_time || '',
        syncTs,
        syncTs
      );
      adsCount++;
    }

    if (seenAdIds.size > 0) {
      const existingAds = db.prepare(`SELECT ad_id FROM ads WHERE account_id = ? AND data_source = ?`).all(accountId, dataSource);
      const markDeletedAd = db.prepare(`UPDATE ads SET is_deleted_on_meta = 1, effective_status = CASE WHEN effective_status = 'ACTIVE' THEN 'DELETED' ELSE effective_status END WHERE ad_id = ? AND data_source = ?`);
      for (const row of existingAds) {
        if (!seenAdIds.has(row.ad_id)) {
          markDeletedAd.run(row.ad_id, dataSource);
        }
      }
    }

    // 5. Fetch Daily Performance Insights (time_increment=1) across the lookback window
    const untilDate = customUntil || todayDateStr();
    const sinceDateObj = new Date();
    sinceDateObj.setDate(sinceDateObj.getDate() - Number(lookbackDays || 90));
    const sinceDate = customSince || sinceDateObj.toISOString().slice(0, 10);
    const timeRangeParam = encodeURIComponent(JSON.stringify({ since: sinceDate, until: untilDate }));

    const upsertInsightStmt = db.prepare(`
      INSERT INTO daily_insights (
        entity_type, entity_id, data_source, account_id, campaign_id, adset_id, ad_id,
        date_start, date_stop, publisher_platform, spend, impressions, reach, frequency,
        clicks_all, link_clicks, unique_link_clicks, form_leads, messaging_leads,
        website_leads, landing_page_views, post_engagements, video_views,
        result_type, results_count, raw_actions_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id, date_start, publisher_platform, data_source) DO UPDATE SET
        spend = excluded.spend,
        impressions = excluded.impressions,
        reach = excluded.reach,
        frequency = excluded.frequency,
        clicks_all = excluded.clicks_all,
        link_clicks = excluded.link_clicks,
        unique_link_clicks = excluded.unique_link_clicks,
        form_leads = excluded.form_leads,
        messaging_leads = excluded.messaging_leads,
        website_leads = excluded.website_leads,
        landing_page_views = excluded.landing_page_views,
        post_engagements = excluded.post_engagements,
        video_views = excluded.video_views,
        result_type = excluded.result_type,
        results_count = excluded.results_count,
        raw_actions_json = excluded.raw_actions_json,
        updated_at = excluded.updated_at
    `);

    const insightFields = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,date_start,date_stop,spend,impressions,reach,frequency,clicks,inline_link_clicks,unique_inline_link_clicks,actions';

    // 5A. Ad-level daily insights (overall platform = 'all')
    const adInsightsAll = await graphGetPaginated(
      `/${accountId}/insights?level=ad&time_increment=1&time_range=${timeRangeParam}&fields=${insightFields}&limit=500`,
      accessToken
    );

    for (const row of adInsightsAll) {
      const obj = campaignObjectiveMap[row.campaign_id] || 'OUTCOME_LEADS';
      const m = extractMetricsFromInsightRow(row, obj);
      upsertInsightStmt.run(
        'ad',
        row.ad_id,
        dataSource,
        accountId,
        row.campaign_id || '',
        row.adset_id || '',
        row.ad_id || '',
        row.date_start,
        row.date_stop || row.date_start,
        'all',
        m.spend,
        m.impressions,
        m.reach,
        m.frequency,
        m.clicksAll,
        m.linkClicks,
        m.uniqueLinkClicks,
        m.formLeads,
        m.messagingLeads,
        m.websiteLeads,
        m.landingPageViews,
        m.postEngagements,
        m.videoViews,
        m.resultType,
        m.resultsCount,
        m.rawActionsJson,
        syncTs
      );
      insightsCount++;
    }

    // 5B. Ad-level daily insights broken down by publisher_platform (facebook, instagram, etc.)
    const adInsightsPlatform = await graphGetPaginated(
      `/${accountId}/insights?level=ad&time_increment=1&breakdowns=publisher_platform&time_range=${timeRangeParam}&fields=${insightFields}&limit=500`,
      accessToken
    );

    for (const row of adInsightsPlatform) {
      const obj = campaignObjectiveMap[row.campaign_id] || 'OUTCOME_LEADS';
      const m = extractMetricsFromInsightRow(row, obj);
      const plat = String(row.publisher_platform || 'unknown').toLowerCase();
      upsertInsightStmt.run(
        'ad',
        row.ad_id,
        dataSource,
        accountId,
        row.campaign_id || '',
        row.adset_id || '',
        row.ad_id || '',
        row.date_start,
        row.date_stop || row.date_start,
        plat,
        m.spend,
        m.impressions,
        m.reach,
        m.frequency,
        m.clicksAll,
        m.linkClicks,
        m.uniqueLinkClicks,
        m.formLeads,
        m.messagingLeads,
        m.websiteLeads,
        m.landingPageViews,
        m.postEngagements,
        m.videoViews,
        m.resultType,
        m.resultsCount,
        m.rawActionsJson,
        syncTs
      );
      insightsCount++;
    }

    // 5C. Campaign-level daily insights (so unique daily campaign reach & campaign totals are exact even if an ad had 0 impressions)
    const campInsightsAll = await graphGetPaginated(
      `/${accountId}/insights?level=campaign&time_increment=1&time_range=${timeRangeParam}&fields=campaign_id,date_start,date_stop,spend,impressions,reach,frequency,clicks,inline_link_clicks,unique_inline_link_clicks,actions&limit=500`,
      accessToken
    );

    for (const row of campInsightsAll) {
      const obj = campaignObjectiveMap[row.campaign_id] || 'OUTCOME_LEADS';
      const m = extractMetricsFromInsightRow(row, obj);
      upsertInsightStmt.run(
        'campaign',
        row.campaign_id,
        dataSource,
        accountId,
        row.campaign_id,
        '',
        '',
        row.date_start,
        row.date_stop || row.date_start,
        'all',
        m.spend,
        m.impressions,
        m.reach,
        m.frequency,
        m.clicksAll,
        m.linkClicks,
        m.uniqueLinkClicks,
        m.formLeads,
        m.messagingLeads,
        m.websiteLeads,
        m.landingPageViews,
        m.postEngagements,
        m.videoViews,
        m.resultType,
        m.resultsCount,
        m.rawActionsJson,
        syncTs
      );
    }

    // 5D. Account-level daily insights (for true account-wide daily unique reach)
    const accInsightsAll = await graphGetPaginated(
      `/${accountId}/insights?level=account&time_increment=1&time_range=${timeRangeParam}&fields=date_start,date_stop,spend,impressions,reach,frequency,clicks,inline_link_clicks,unique_inline_link_clicks,actions&limit=500`,
      accessToken
    );

    for (const row of accInsightsAll) {
      const m = extractMetricsFromInsightRow(row, 'OUTCOME_LEADS');
      upsertInsightStmt.run(
        'account',
        accountId,
        dataSource,
        accountId,
        '',
        '',
        '',
        row.date_start,
        row.date_stop || row.date_start,
        'all',
        m.spend,
        m.impressions,
        m.reach,
        m.frequency,
        m.clicksAll,
        m.linkClicks,
        m.uniqueLinkClicks,
        m.formLeads,
        m.messagingLeads,
        m.websiteLeads,
        m.landingPageViews,
        m.postEngagements,
        m.videoViews,
        m.resultType,
        m.resultsCount,
        m.rawActionsJson,
        syncTs
      );
    }

    // 5E. Populate period_reach_cache with exact deduplicated unique reach from Meta API
    // for standard dashboard presets (today, yesterday, last_7d, last_30d, this_month)
    const upsertPeriodReachStmt = db.prepare(`
      INSERT INTO period_reach_cache (
        account_id, data_source, entity_type, entity_id,
        date_start, date_stop, publisher_platform, unique_reach, frequency, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, data_source, entity_type, entity_id, date_start, date_stop, publisher_platform) DO UPDATE SET
        unique_reach = excluded.unique_reach,
        frequency = excluded.frequency,
        updated_at = excluded.updated_at
    `);

    const anchorStr = todayDateStr();
    const anchorDate = new Date(`${anchorStr}T00:00:00Z`);
    const mkDate = (daysAgo) => {
      const d = new Date(anchorDate);
      d.setUTCDate(d.getUTCDate() - daysAgo);
      return d.toISOString().slice(0, 10);
    };
    const monthStartStr = `${anchorStr.slice(0, 7)}-01`;

    const presetWindows = [
      { since: anchorStr, until: anchorStr },
      { since: mkDate(1), until: mkDate(1) },
      { since: mkDate(6), until: anchorStr },
      { since: mkDate(29), until: anchorStr },
      { since: monthStartStr, until: anchorStr }
    ];

    for (const win of presetWindows) {
      const tr = encodeURIComponent(JSON.stringify({ since: win.since, until: win.until }));
      try {
        // Account-level exact period unique reach
        const accPeriod = await graphGet(
          `/${accountId}/insights?level=account&time_range=${tr}&fields=reach,frequency`,
          accessToken
        );
        if (Array.isArray(accPeriod.data) && accPeriod.data[0]) {
          const r = parseInt(accPeriod.data[0].reach || 0, 10);
          const f = Number(accPeriod.data[0].frequency || 0);
          upsertPeriodReachStmt.run(accountId, dataSource, 'account', accountId, win.since, win.until, 'all', r, f, syncTs);
        }

        // Campaign-level exact period unique reach
        const campPeriod = await graphGetPaginated(
          `/${accountId}/insights?level=campaign&time_range=${tr}&fields=campaign_id,reach,frequency&limit=200`,
          accessToken
        );
        for (const cr of campPeriod) {
          if (cr.campaign_id && cr.reach !== undefined) {
            upsertPeriodReachStmt.run(
              accountId, dataSource, 'campaign', cr.campaign_id, win.since, win.until, 'all',
              parseInt(cr.reach, 10) || 0, Number(cr.frequency || 0), syncTs
            );
          }
        }

        // Ad-level exact period unique reach
        const adPeriod = await graphGetPaginated(
          `/${accountId}/insights?level=ad&time_range=${tr}&fields=ad_id,reach,frequency&limit=500`,
          accessToken
        );
        for (const ar of adPeriod) {
          if (ar.ad_id && ar.reach !== undefined) {
            upsertPeriodReachStmt.run(
              accountId, dataSource, 'ad', ar.ad_id, win.since, win.until, 'all',
              parseInt(ar.reach, 10) || 0, Number(ar.frequency || 0), syncTs
            );
          }
        }
      } catch {
        // Non-fatal if a specific preset window has 0 activity
      }
    }

    // Update Ad delivery start/stop dates and coverage bounds from daily_insights
    db.exec(`
      UPDATE ads SET
        delivery_start_date = COALESCE((SELECT MIN(date_start) FROM daily_insights WHERE daily_insights.ad_id = ads.ad_id AND daily_insights.data_source = ads.data_source AND daily_insights.impressions > 0), delivery_start_date),
        delivery_stop_date = COALESCE((SELECT MAX(date_start) FROM daily_insights WHERE daily_insights.ad_id = ads.ad_id AND daily_insights.data_source = ads.data_source AND daily_insights.impressions > 0), delivery_stop_date)
      WHERE account_id = '${accountId.replace(/'/g, "''")}' AND data_source = 'meta_api';
    `);

    const coverageRow = db.prepare(`
      SELECT MIN(date_start) AS min_date, MAX(date_start) AS max_date
      FROM daily_insights
      WHERE account_id = ? AND data_source = ?
    `).get(accountId, dataSource);

    if (coverageRow && coverageRow.min_date) {
      db.prepare(`
        UPDATE ad_accounts SET earliest_data_date = ?, latest_data_date = ?, updated_at = ?
        WHERE account_id = ?
      `).run(coverageRow.min_date, coverageRow.max_date, syncTs, accountId);
    }

    // 6. Retrieve Accessible Lead Form Submissions from Connected Pages & Ads
    const pageTokensJson = decryptSecret(conn.page_tokens_enc || '');
    let pageTokens = {};
    try { pageTokens = JSON.parse(pageTokensJson || '{}'); } catch { pageTokens = {}; }
    let selectedPageIds = [];
    try { selectedPageIds = JSON.parse(conn.selected_page_ids || '[]'); } catch { selectedPageIds = []; }

    const upsertLeadStmt = db.prepare(`
      INSERT INTO lead_submissions (
        lead_id, data_source, account_id, page_id, form_id, form_name,
        campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
        platform, created_time, submission_date, customer_name, phone_number,
        email, business_requirements, city, organization_name, raw_field_data_json,
        is_organic, first_retrieved_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lead_id, data_source) DO UPDATE SET
        form_name = COALESCE(NULLIF(excluded.form_name, ''), lead_submissions.form_name),
        campaign_id = COALESCE(NULLIF(excluded.campaign_id, ''), lead_submissions.campaign_id),
        campaign_name = COALESCE(NULLIF(excluded.campaign_name, ''), lead_submissions.campaign_name),
        adset_id = COALESCE(NULLIF(excluded.adset_id, ''), lead_submissions.adset_id),
        adset_name = COALESCE(NULLIF(excluded.adset_name, ''), lead_submissions.adset_name),
        ad_id = COALESCE(NULLIF(excluded.ad_id, ''), lead_submissions.ad_id),
        ad_name = COALESCE(NULLIF(excluded.ad_name, ''), lead_submissions.ad_name),
        customer_name = COALESCE(NULLIF(excluded.customer_name, ''), lead_submissions.customer_name),
        phone_number = COALESCE(NULLIF(excluded.phone_number, ''), lead_submissions.phone_number),
        email = COALESCE(NULLIF(excluded.email, ''), lead_submissions.email),
        business_requirements = COALESCE(NULLIF(excluded.business_requirements, ''), lead_submissions.business_requirements),
        last_synced_at = excluded.last_synced_at
    `);

    const ensureFollowupStmt = db.prepare(`
      INSERT INTO lead_followups (lead_id, followup_status, assigned_person, notes, next_followup_date, updated_at)
      VALUES (?, 'New', '', '', '', ?)
      ON CONFLICT(lead_id) DO NOTHING
    `);

    for (const pageId of selectedPageIds) {
      const pgToken = pageTokens[pageId] || accessToken;
      try {
        const forms = await graphGetPaginated(`/${pageId}/leadgen_forms?fields=id,name,status&limit=100`, pgToken);
        for (const form of forms) {
          const leads = await graphGetPaginated(
            `/${form.id}/leads?fields=id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,platform,field_data&limit=200`,
            pgToken
          );
          for (const ld of leads) {
            const parsedFields = parseLeadFieldData(ld.field_data || []);
            const createdIso = ld.created_time || syncTs;
            const subDate = String(createdIso).slice(0, 10);

            upsertLeadStmt.run(
              String(ld.id),
              dataSource,
              accountId,
              String(pageId),
              String(form.id),
              form.name || '',
              String(ld.campaign_id || ''),
              ld.campaign_name || '',
              String(ld.adset_id || ''),
              ld.adset_name || '',
              String(ld.ad_id || ''),
              ld.ad_name || '',
              ld.platform || 'fb',
              createdIso,
              subDate,
              parsedFields.customerName,
              parsedFields.phoneNumber,
              parsedFields.email,
              parsedFields.businessRequirements,
              parsedFields.city,
              parsedFields.organizationName,
              JSON.stringify(ld.field_data || []),
              ld.is_organic ? 1 : 0,
              syncTs,
              syncTs
            );
            ensureFollowupStmt.run(String(ld.id), syncTs);
            leadsCount++;
          }
        }
      } catch {
        // Continue if a specific page does not have leadgen_forms accessible
      }
    }

    // 6B. Fallback: Also retrieve leads directly via /{ad_id}/leads for all Lead Ads
    // so that even if a Facebook Page wasn't selected or leadgen_forms edge was skipped,
    // all accessible leads on the Ad Account's ads are still retrieved and deduplicated!
    for (const ad of rawAds) {
      try {
        const adLeads = await graphGetPaginated(
          `/${ad.id}/leads?fields=id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,is_organic,platform,field_data&limit=200`,
          accessToken
        );
        for (const ld of adLeads) {
          const parsedFields = parseLeadFieldData(ld.field_data || []);
          const createdIso = ld.created_time || syncTs;
          const subDate = String(createdIso).slice(0, 10);

          upsertLeadStmt.run(
            String(ld.id),
            dataSource,
            accountId,
            '',
            String(ld.form_id || ''),
            '',
            String(ld.campaign_id || ad.campaign_id || ''),
            ld.campaign_name || '',
            String(ld.adset_id || ad.adset_id || ''),
            ld.adset_name || '',
            String(ld.ad_id || ad.id || ''),
            ld.ad_name || ad.name || '',
            ld.platform || 'fb',
            createdIso,
            subDate,
            parsedFields.customerName,
            parsedFields.phoneNumber,
            parsedFields.email,
            parsedFields.businessRequirements,
            parsedFields.city,
            parsedFields.organizationName,
            JSON.stringify(ld.field_data || []),
            ld.is_organic ? 1 : 0,
            syncTs,
            syncTs
          );
          ensureFollowupStmt.run(String(ld.id), syncTs);
          leadsCount++;
        }
      } catch {
        // Non-lead ads or ads without lead retrieval access will skip cleanly
      }
    }

    const finishedAt = nowIso();
    db.prepare(`
      UPDATE meta_connections SET
        last_sync_at = ?,
        last_sync_status = 'success',
        last_sync_error = '',
        blocker_code = '',
        blocker_message = '',
        updated_at = ?
      WHERE id = 'default'
    `).run(finishedAt, finishedAt);

    db.prepare(`
      INSERT INTO sync_logs (
        id, account_id, data_source, trigger_type, status,
        campaigns_synced, adsets_synced, ads_synced, insights_synced, leads_synced,
        message, started_at, finished_at
      ) VALUES (?, ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      syncId, accountId, dataSource, triggerType,
      campaignsCount, adsetsCount, adsCount, insightsCount, leadsCount,
      `Synced ${campaignsCount} campaigns, ${adsetsCount} ad sets, ${adsCount} ads, ${insightsCount} daily insight records, and ${leadsCount} leads.`,
      startedAt, finishedAt
    );

    return {
      status: 'success',
      accountId,
      campaignsCount,
      adsetsCount,
      adsCount,
      insightsCount,
      leadsCount,
      syncedAt: finishedAt
    };
  } catch (err) {
    const finishedAt = nowIso();
    const blocker = buildBlockerExplanation(err);

    // IMPORTANT: Never overwrite valid stored data on failed sync! Only update sync status and error message.
    db.prepare(`
      UPDATE meta_connections SET
        last_sync_status = 'error',
        last_sync_error = ?,
        blocker_code = ?,
        blocker_message = ?,
        blocker_action_ta = ?,
        updated_at = ?
      WHERE id = 'default'
    `).run(err.message, blocker.blockerCode, blocker.blockerMessage, blocker.blockerActionTa, finishedAt);

    db.prepare(`
      INSERT INTO sync_logs (
        id, account_id, data_source, trigger_type, status,
        campaigns_synced, adsets_synced, ads_synced, insights_synced, leads_synced,
        message, started_at, finished_at
      ) VALUES (?, ?, ?, ?, 'error', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      syncId, accountId, dataSource, triggerType,
      campaignsCount, adsetsCount, adsCount, insightsCount, leadsCount,
      err.message, startedAt, finishedAt
    );

    throw err;
  }
}

function parseLeadFieldData(fieldData) {
  let customerName = '';
  let firstName = '';
  let lastName = '';
  let phoneNumber = '';
  let email = '';
  let city = '';
  let organizationName = '';
  const extraAnswers = [];

  for (const item of (fieldData || [])) {
    const key = String(item.name || '').toLowerCase();
    const val = Array.isArray(item.values) ? item.values.join(', ') : String(item.value || '');
    if (!val) continue;

    if (key === 'full_name' || key === 'name' || key.includes('your_name') || key.includes('customer_name')) {
      customerName = val;
    } else if (key === 'first_name') {
      firstName = val;
    } else if (key === 'last_name') {
      lastName = val;
    } else if (key.includes('phone') || key.includes('mobile') || key.includes('whatsapp') || key.includes('contact_number')) {
      phoneNumber = val;
    } else if (key.includes('email')) {
      email = val;
    } else if (key === 'city' || key.includes('location') || key.includes('district')) {
      city = val;
    } else if (key.includes('company') || key.includes('hospital') || key.includes('academy') || key.includes('business_name') || key.includes('organization')) {
      organizationName = val;
    } else {
      const cleanLabel = String(item.name || '').replace(/_/g, ' ');
      extraAnswers.push(`${cleanLabel}: ${val}`);
    }
  }

  if (!customerName && (firstName || lastName)) {
    customerName = `${firstName} ${lastName}`.trim();
  }

  const reqParts = [];
  if (organizationName) reqParts.push(`Org: ${organizationName}`);
  if (city) reqParts.push(`City: ${city}`);
  reqParts.push(...extraAnswers);

  return {
    customerName: customerName || 'Unnamed Enquiry',
    phoneNumber,
    email,
    city,
    organizationName,
    businessRequirements: reqParts.join(' | ')
  };
}

/**
 * Return connection state safe for frontend (NEVER includes raw access_token or app_secret!)
 */
function getSanitizedConnectionState() {
  const row = db.prepare(`SELECT * FROM meta_connections WHERE id = 'default'`).get();
  if (!row) return null;

  // Check available data sources counts in DB
  const apiCampCount = db.prepare(`SELECT COUNT(*) AS c FROM campaigns WHERE data_source = 'meta_api'`).get().c;
  const uploadCampCount = db.prepare(`SELECT COUNT(*) AS c FROM campaigns WHERE data_source = 'uploaded_report'`).get().c;
  const demoCampCount = db.prepare(`SELECT COUNT(*) AS c FROM campaigns WHERE data_source = 'demo_mode'`).get().c;
  const uploadBatchesCount = db.prepare(`SELECT COUNT(*) AS c FROM uploaded_reports`).get().c;

  const hasAccessToken = Boolean(
    (row.access_token_enc && decryptSecret(row.access_token_enc)) ||
    (row.connection_status === 'connected' && apiCampCount > 0)
  );
  const hasAppSecret = Boolean(row.app_secret_enc && decryptSecret(row.app_secret_enc));

  let granted = [];
  let declined = [];
  let businesses = [];
  let adAccounts = [];
  let pages = [];
  let selectedPageIds = [];
  let selectedPageNames = [];

  try { granted = JSON.parse(row.granted_permissions || '[]'); } catch {}
  try { declined = JSON.parse(row.declined_permissions || '[]'); } catch {}
  try { businesses = JSON.parse(row.available_businesses_json || '[]'); } catch {}
  try { adAccounts = JSON.parse(row.available_ad_accounts_json || '[]'); } catch {}
  try { pages = JSON.parse(row.available_pages_json || '[]'); } catch {}
  try { selectedPageIds = JSON.parse(row.selected_page_ids || '[]'); } catch {}
  try { selectedPageNames = JSON.parse(row.selected_page_names || '[]'); } catch {}

  return {
    appId: row.app_id || '',
    hasAppSecret,
    hasAccessToken,
    tokenExpiresAt: row.token_expires_at || '',
    connectedUserId: row.connected_user_id || '',
    connectedUserName: row.connected_user_name || '',
    connectedUserEmail: row.connected_user_email || '',
    targetAccountEmail: row.target_account_email || 'vims2023@gmail.com',
    grantedPermissions: granted,
    declinedPermissions: declined,
    requiredPermissions: REQUIRED_PERMISSIONS,
    selectedBusinessId: row.selected_business_id || '',
    selectedBusinessName: row.selected_business_name || '',
    selectedAdAccountId: row.selected_ad_account_id || '',
    selectedAdAccountName: row.selected_ad_account_name || '',
    selectedPageIds,
    selectedPageNames,
    availableBusinesses: businesses,
    availableAdAccounts: adAccounts,
    availablePages: pages,
    connectionStatus: row.connection_status || 'not_configured',
    blockerCode: row.blocker_code || '',
    blockerMessage: row.blocker_message || '',
    blockerActionTa: row.blocker_action_ta || '',
    autoSyncIntervalMinutes: row.auto_sync_interval_minutes ?? 15,
    activeDataSource: row.active_data_source || 'meta_api',
    lastSyncAt: row.last_sync_at || '',
    lastSyncStatus: row.last_sync_status || '',
    lastSyncError: row.last_sync_error || '',
    dataSourcesSummary: {
      meta_api: {
        connected: row.connection_status === 'connected' && hasAccessToken,
        campaignsStored: apiCampCount,
        lastSyncAt: row.last_sync_at || null
      },
      uploaded_report: {
        available: uploadCampCount > 0 || uploadBatchesCount > 0,
        batchesUploaded: uploadBatchesCount,
        campaignsStored: uploadCampCount
      },
      demo_mode: {
        available: demoCampCount > 0,
        campaignsStored: demoCampCount
      }
    }
  };
}

module.exports = {
  REQUIRED_PERMISSIONS,
  minorUnitToMajor,
  extractMetricsFromInsightRow,
  discoverMetaAssets,
  exchangeCodeForToken,
  syncMetaAdAccount,
  toggleMetaEntityStatus,
  getSanitizedConnectionState,
  parseLeadFieldData,
  buildBlockerExplanation
};
