const { db, nowIso, todayDateStr } = require('./db');

// ============================================================================
// Core Analytics, Financial Clarity, Reporting Accuracy & "What Needs Attention?"
// ============================================================================

/**
 * Resolve date preset ('today', 'yesterday', 'last_7d', 'last_30d', 'this_month', 'custom')
 * relative to a reference today string (YYYY-MM-DD).
 * Also computes the exact previous equivalent period for comparison!
 */
function resolveDateRange(preset = 'last_30d', customStart = '', customEnd = '', refToday = '') {
  const anchorStr = refToday || todayDateStr();
  const anchor = new Date(`${anchorStr}T00:00:00Z`);

  let start = new Date(anchor);
  let end = new Date(anchor);
  let label = 'Last 30 Days';

  switch (preset) {
    case 'today':
      label = 'Today';
      break;
    case 'yesterday':
      start.setUTCDate(start.getUTCDate() - 1);
      end.setUTCDate(end.getUTCDate() - 1);
      label = 'Yesterday';
      break;
    case 'last_7d':
      start.setUTCDate(start.getUTCDate() - 6);
      label = 'Last 7 Days';
      break;
    case 'last_30d':
      start.setUTCDate(start.getUTCDate() - 29);
      label = 'Last 30 Days';
      break;
    case 'this_month':
      start.setUTCDate(1);
      label = 'This Month';
      break;
    case 'custom':
      if (customStart && customEnd) {
        start = new Date(`${customStart}T00:00:00Z`);
        end = new Date(`${customEnd}T00:00:00Z`);
        if (start > end) {
          const tmp = start;
          start = end;
          end = tmp;
        }
        label = `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`;
      }
      break;
    default:
      start.setUTCDate(start.getUTCDate() - 29);
      label = 'Last 30 Days';
  }

  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  // Number of inclusive days in period
  const diffMs = end.getTime() - start.getTime();
  const dayCount = Math.max(1, Math.round(diffMs / 86400000) + 1);

  // Previous equivalent period
  const prevEnd = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (dayCount - 1));

  return {
    preset,
    label,
    startDate,
    endDate,
    dayCount,
    prevStartDate: prevStart.toISOString().slice(0, 10),
    prevEndDate: prevEnd.toISOString().slice(0, 10),
    todayDate: anchorStr
  };
}

/**
 * Compute aggregate ratios strictly from matching totals (Section 7 rules):
 * - Never average row-level CPLs, CTRs, or CPCs.
 * - When leads === 0, cpl is null and cplDisplay is "— / No leads" (never 0).
 * - Link CTR = (link_clicks / impressions) * 100
 * - Link CPC = spend / link_clicks
 */
function computeDerivedMetrics(totals, primaryResultType = 'Form Leads') {
  const spend = Number((totals.spend || 0).toFixed(2));
  const impressions = parseInt(totals.impressions || 0, 10) || 0;
  const clicksAll = parseInt(totals.clicks_all || 0, 10) || 0;
  const linkClicks = parseInt(totals.link_clicks || 0, 10) || 0;
  const formLeads = parseInt(totals.form_leads || 0, 10) || 0;
  const messagingLeads = parseInt(totals.messaging_leads || 0, 10) || 0;
  const websiteLeads = parseInt(totals.website_leads || 0, 10) || 0;
  const landingPageViews = parseInt(totals.landing_page_views || 0, 10) || 0;
  const postEngagements = parseInt(totals.post_engagements || 0, 10) || 0;
  const resultsCount = parseInt(totals.results_count ?? formLeads, 10) || 0;

  // Cost per form lead (CPL)
  const cpl = formLeads > 0 ? Number((spend / formLeads).toFixed(2)) : null;
  const cplDisplay = formLeads > 0 ? cpl : '— / No leads';

  // Cost per primary objective result (CPR)
  const costPerResult = resultsCount > 0 ? Number((spend / resultsCount).toFixed(2)) : null;
  const costPerResultDisplay = resultsCount > 0 ? costPerResult : `— / No ${primaryResultType.toLowerCase()}`;

  // Link Click-Through Rate (Link CTR %)
  const linkCtr = impressions > 0 ? Number(((linkClicks / impressions) * 100).toFixed(2)) : null;
  const linkCtrDisplay = impressions > 0 ? `${linkCtr}%` : '—';

  // Cost Per Link Click (Link CPC)
  const linkCpc = linkClicks > 0 ? Number((spend / linkClicks).toFixed(2)) : null;
  const linkCpcDisplay = linkClicks > 0 ? linkCpc : '— / No link clicks';

  // All Clicks CTR & CPC (Explicitly labelled separately from Link Clicks)
  const allCtr = impressions > 0 ? Number(((clicksAll / impressions) * 100).toFixed(2)) : null;
  const allCpc = clicksAll > 0 ? Number((spend / clicksAll).toFixed(2)) : null;

  // Click-to-Form-Lead conversion rate
  const linkClickToLeadRate = linkClicks > 0 ? Number(((formLeads / linkClicks) * 100).toFixed(2)) : null;

  // CPM (Cost per 1,000 impressions)
  const cpm = impressions > 0 ? Number(((spend / impressions) * 1000).toFixed(2)) : null;

  return {
    spend,
    impressions,
    clicksAll,
    linkClicks,
    formLeads,
    messagingLeads,
    websiteLeads,
    landingPageViews,
    postEngagements,
    resultType: primaryResultType,
    resultsCount,
    cpl,
    cplDisplay,
    costPerResult,
    costPerResultDisplay,
    linkCtr,
    linkCtrDisplay,
    linkCpc,
    linkCpcDisplay,
    allCtr,
    allCpc,
    linkClickToLeadRate,
    cpm
  };
}

/**
 * Determine accurate Reach for a given scope & date range (Section 7 rule:
 * "Obtain total reach for the appropriate reporting scope. Do not add daily or individual-ad reach and call it unique total reach.")
 */
function resolveScopeReach({
  accountId,
  dataSource,
  startDate,
  endDate,
  platform = 'all',
  campaignId = '',
  adId = ''
}) {
  const isSingleDay = startDate === endDate;

  // 1. Check period_reach_cache first (populated when exact period unique reach is fetched from Meta API or imported)
  const isAllAccounts = accountId === 'act_vims_all_accounts';
  let entityType = 'account';
  let entityId = accountId;
  if (adId) {
    entityType = 'ad';
    entityId = adId;
  } else if (campaignId) {
    entityType = 'campaign';
    entityId = campaignId;
  }

  const cached = db.prepare(`
    SELECT unique_reach, frequency
    FROM period_reach_cache
    WHERE (? = 1 OR account_id = ?) AND data_source = ? AND entity_type = ? AND entity_id = ?
      AND date_start = ? AND date_stop = ? AND publisher_platform = ?
  `).get(isAllAccounts ? 1 : 0, accountId, dataSource, entityType, entityId, startDate, endDate, platform);

  if (cached && cached.unique_reach !== null && cached.unique_reach !== undefined) {
    return {
      reach: cached.unique_reach,
      isExactUniqueReach: true,
      reachNote: 'Deduplicated unique people reached in this exact period.'
    };
  }

  // 2. If single day, a single entity's daily insight row has exact unique reach for that day
  if (isSingleDay && !isAllAccounts) {
    const dailyRow = db.prepare(`
      SELECT reach
      FROM daily_insights
      WHERE account_id = ? AND data_source = ? AND entity_type = ? AND entity_id = ?
        AND date_start = ? AND publisher_platform = ?
    `).get(accountId, dataSource, entityType, entityId, startDate, platform);

    if (dailyRow && dailyRow.reach !== null && dailyRow.reach !== undefined) {
      return {
        reach: dailyRow.reach,
        isExactUniqueReach: true,
        reachNote: `Exact unique reach for ${startDate}.`
      };
    }
  }

  // 3. When multi-day period unique reach hasn't been cached by a period-level API call:
  // Never sum daily or individual ad reach and call it unique total reach!
  // We inspect max single-day reach as the verified lower bound of unique people reached,
  // and explicitly label it so the user knows daily reach cannot be summed.
  let whereSql = `(? = 1 OR account_id = ?) AND data_source = ? AND date_start >= ? AND date_start <= ? AND publisher_platform = ?`;
  const params = [isAllAccounts ? 1 : 0, accountId, dataSource, startDate, endDate, platform];

  if (adId) {
    whereSql += ` AND entity_type = 'ad' AND ad_id = ?`;
    params.push(adId);
  } else if (campaignId) {
    whereSql += ` AND entity_type = 'campaign' AND campaign_id = ?`;
    params.push(campaignId);
  } else {
    whereSql += ` AND entity_type = 'account'`;
  }

  let reachStats = db.prepare(`
    SELECT MAX(reach) AS max_daily_reach, COUNT(reach) AS days_with_reach
    FROM daily_insights
    WHERE ${whereSql}
  `).get(...params);

  // Fallback to ad-level max reach if account/campaign level row is not present (e.g. uploaded ad report)
  if (!reachStats || reachStats.max_daily_reach === null) {
    let adWhere = `(? = 1 OR account_id = ?) AND data_source = ? AND entity_type = 'ad' AND date_start >= ? AND date_start <= ? AND publisher_platform = ?`;
    const adParams = [isAllAccounts ? 1 : 0, accountId, dataSource, startDate, endDate, platform];
    if (adId) { adWhere += ` AND ad_id = ?`; adParams.push(adId); }
    else if (campaignId) { adWhere += ` AND campaign_id = ?`; adParams.push(campaignId); }

    reachStats = db.prepare(`
      SELECT MAX(reach) AS max_daily_reach, COUNT(reach) AS days_with_reach
      FROM daily_insights
      WHERE ${adWhere}
    `).get(...adParams);
  }

  if (reachStats && reachStats.max_daily_reach !== null) {
    return {
      reach: reachStats.max_daily_reach,
      isExactUniqueReach: false,
      reachNote: 'Peak daily unique reach shown (daily/ad reach cannot be added together without double-counting the same person).'
    };
  }

  return {
    reach: null,
    isExactUniqueReach: false,
    reachNote: 'Unique reach unavailable for this filter combination.'
  };
}

/**
 * Build the complete dashboard payload for the active data source, account, and selected filters.
 */
function getDashboardOverview({
  dataSource = '',
  accountId = '',
  preset = 'last_30d',
  startDate = '',
  endDate = '',
  campaignId = '',
  adId = '',
  statusFilter = 'ALL',
  platformFilter = 'all',
  searchQuery = ''
} = {}) {
  const conn = db.prepare(`SELECT * FROM meta_connections WHERE id = 'default'`).get();
  const activeSource = dataSource || (conn ? conn.active_data_source : 'meta_api') || 'meta_api';

  // Determine active account for the chosen dataSource
  let account = null;
  if (accountId) {
    account = db.prepare(`SELECT * FROM ad_accounts WHERE account_id = ?`).get(accountId);
  }
  if (!account && conn && conn.selected_ad_account_id) {
    account = db.prepare(`SELECT * FROM ad_accounts WHERE account_id = ? AND data_source = ?`).get(conn.selected_ad_account_id, activeSource);
  }
  if (!account) {
    account = db.prepare(`SELECT * FROM ad_accounts WHERE data_source = ? ORDER BY updated_at DESC LIMIT 1`).get(activeSource);
  }
  if (!account) {
    // Fallback empty account shell if nothing synced/uploaded yet
    account = {
      account_id: conn?.selected_ad_account_id || 'unconnected',
      data_source: activeSource,
      name: conn?.selected_ad_account_name || 'No Ad Account Connected Yet',
      currency: 'INR',
      timezone_name: 'Asia/Kolkata',
      timezone_offset_hours: 5.5,
      account_status: 1,
      amount_spent_total: null,
      balance_amount_owed: null,
      spend_cap: null,
      is_prepay_account: null,
      available_funds_verified: null,
      funding_source_details: '',
      billing_verification_note: 'Unavailable from connected data.',
      attribution_spec: '7d_click_1d_view',
      earliest_data_date: '',
      latest_data_date: ''
    };
  }

  const accId = account.account_id;
  const isAllAcc = accId === 'act_vims_all_accounts' ? 1 : 0;
  // Determine reference today date: use latest available date if in demo/upload or current local date
  const refToday = todayDateStr();
  const dateRange = resolveDateRange(preset, startDate, endDate, refToday);

  // 1. Data Coverage & Missing Period Detection
  const coverage = db.prepare(`
    SELECT MIN(date_start) AS min_date, MAX(date_start) AS max_date, COUNT(DISTINCT date_start) AS active_days
    FROM daily_insights
    WHERE (? = 1 OR account_id = ?) AND data_source = ? AND entity_type = 'ad'
  `).get(isAllAcc, accId, activeSource) || { min_date: null, max_date: null, active_days: 0 };

  let missingPeriodsNote = '';
  let isPartialPeriod = false;
  if (!coverage.min_date) {
    missingPeriodsNote = 'No daily performance records stored for this data source yet.';
    isPartialPeriod = true;
  } else {
    const notes = [];
    if (dateRange.startDate < coverage.min_date) {
      notes.push(`Historical data before ${coverage.min_date} is not available in stored records.`);
      isPartialPeriod = true;
    }
    if (dateRange.endDate > coverage.max_date) {
      notes.push(`Latest available insight date is ${coverage.max_date}.`);
    }
    missingPeriodsNote = notes.join(' ');
  }

  // 2. Active Status Counts Now (Strictly separate from historical period performance!)
  const activeCampaignsNow = db.prepare(`
    SELECT COUNT(*) AS c FROM campaigns
    WHERE (? = 1 OR account_id = ?) AND data_source = ? AND effective_status = 'ACTIVE' AND is_deleted_on_meta = 0
  `).get(isAllAcc, accId, activeSource).c;

  const totalCampaignsStored = db.prepare(`
    SELECT COUNT(*) AS c FROM campaigns
    WHERE (? = 1 OR account_id = ?) AND data_source = ?
  `).get(isAllAcc, accId, activeSource).c;

  const activeAdsNow = db.prepare(`
    SELECT COUNT(*) AS c FROM ads
    WHERE (? = 1 OR account_id = ?) AND data_source = ? AND effective_status = 'ACTIVE' AND is_deleted_on_meta = 0
  `).get(isAllAcc, accId, activeSource).c;

  const totalAdsStored = db.prepare(`
    SELECT COUNT(*) AS c FROM ads
    WHERE (? = 1 OR account_id = ?) AND data_source = ?
  `).get(isAllAcc, accId, activeSource).c;

  // Build filter clause for ad-level daily_insights (we aggregate from ad-level ONLY, never adding campaign+adset+ad together!)
  function buildAdInsightFilter(sDate, eDate) {
    const clauses = [
      `(? = 1 OR di.account_id = ?)`,
      `di.data_source = ?`,
      `di.entity_type = 'ad'`,
      `di.date_start >= ?`,
      `di.date_start <= ?`,
      `di.publisher_platform = ?`
    ];
    const params = [isAllAcc, accId, activeSource, sDate, eDate, platformFilter || 'all'];

    if (campaignId) {
      clauses.push(`di.campaign_id = ?`);
      params.push(campaignId);
    }
    if (adId) {
      clauses.push(`di.ad_id = ?`);
      params.push(adId);
    }
    if (statusFilter && statusFilter !== 'ALL') {
      clauses.push(`a.effective_status = ?`);
      params.push(statusFilter);
    }
    if (searchQuery && searchQuery.trim() !== '') {
      const q = `%${searchQuery.trim().toLowerCase()}%`;
      clauses.push(`(LOWER(a.name) LIKE ? OR LOWER(c.name) LIKE ? OR LOWER(di.ad_id) LIKE ? OR LOWER(di.campaign_id) LIKE ?)`);
      params.push(q, q, q, q);
    }

    return { whereSql: clauses.join(' AND '), params };
  }

  // 3. Today's Actual Figures (Clearly distinguished from selected period totals)
  const todayFilter = buildAdInsightFilter(dateRange.todayDate, dateRange.todayDate);
  const todayRaw = db.prepare(`
    SELECT
      COALESCE(SUM(di.spend), 0) AS spend,
      COALESCE(SUM(di.impressions), 0) AS impressions,
      COALESCE(SUM(di.clicks_all), 0) AS clicks_all,
      COALESCE(SUM(di.link_clicks), 0) AS link_clicks,
      COALESCE(SUM(di.form_leads), 0) AS form_leads,
      COALESCE(SUM(di.messaging_leads), 0) AS messaging_leads,
      COALESCE(SUM(di.website_leads), 0) AS website_leads,
      COALESCE(SUM(di.landing_page_views), 0) AS landing_page_views,
      COALESCE(SUM(di.post_engagements), 0) AS post_engagements,
      COALESCE(SUM(di.results_count), 0) AS results_count
    FROM daily_insights di
    LEFT JOIN ads a ON a.ad_id = di.ad_id AND a.data_source = di.data_source
    LEFT JOIN campaigns c ON c.campaign_id = di.campaign_id AND c.data_source = di.data_source
    WHERE ${todayFilter.whereSql}
  `).get(...todayFilter.params);

  const todayMetrics = computeDerivedMetrics(todayRaw);

  // 4. Selected Period Totals (Aggregated strictly from Ad-level daily_insights to avoid double-counting campaign/adset/ad)
  const periodFilter = buildAdInsightFilter(dateRange.startDate, dateRange.endDate);
  const periodRaw = db.prepare(`
    SELECT
      COALESCE(SUM(di.spend), 0) AS spend,
      COALESCE(SUM(di.impressions), 0) AS impressions,
      COALESCE(SUM(di.clicks_all), 0) AS clicks_all,
      COALESCE(SUM(di.link_clicks), 0) AS link_clicks,
      COALESCE(SUM(di.form_leads), 0) AS form_leads,
      COALESCE(SUM(di.messaging_leads), 0) AS messaging_leads,
      COALESCE(SUM(di.website_leads), 0) AS website_leads,
      COALESCE(SUM(di.landing_page_views), 0) AS landing_page_views,
      COALESCE(SUM(di.post_engagements), 0) AS post_engagements,
      COALESCE(SUM(di.results_count), 0) AS results_count
    FROM daily_insights di
    LEFT JOIN ads a ON a.ad_id = di.ad_id AND a.data_source = di.data_source
    LEFT JOIN campaigns c ON c.campaign_id = di.campaign_id AND c.data_source = di.data_source
    WHERE ${periodFilter.whereSql}
  `).get(...periodFilter.params);

  const periodMetrics = computeDerivedMetrics(periodRaw);
  const periodReachInfo = resolveScopeReach({
    accountId: accId,
    dataSource: activeSource,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    platform: platformFilter || 'all',
    campaignId,
    adId
  });

  // 5. Previous Equivalent Period Totals (For Period-over-Period Comparison)
  const prevFilter = buildAdInsightFilter(dateRange.prevStartDate, dateRange.prevEndDate);
  const prevRaw = db.prepare(`
    SELECT
      COALESCE(SUM(di.spend), 0) AS spend,
      COALESCE(SUM(di.impressions), 0) AS impressions,
      COALESCE(SUM(di.clicks_all), 0) AS clicks_all,
      COALESCE(SUM(di.link_clicks), 0) AS link_clicks,
      COALESCE(SUM(di.form_leads), 0) AS form_leads,
      COALESCE(SUM(di.results_count), 0) AS results_count,
      COUNT(DISTINCT di.date_start) AS days_with_data
    FROM daily_insights di
    LEFT JOIN ads a ON a.ad_id = di.ad_id AND a.data_source = di.data_source
    LEFT JOIN campaigns c ON c.campaign_id = di.campaign_id AND c.data_source = di.data_source
    WHERE ${prevFilter.whereSql}
  `).get(...prevFilter.params);

  const prevMetrics = computeDerivedMetrics(prevRaw);
  const hasEnoughPrevData = (prevRaw.days_with_data || 0) >= Math.max(1, Math.floor(dateRange.dayCount * 0.5));

  // Compute percentage deltas where previous period has sufficient data
  function calcDeltaPercent(currVal, prevVal) {
    if (!hasEnoughPrevData || currVal === null || prevVal === null || prevVal <= 0) return null;
    return Number((((currVal - prevVal) / prevVal) * 100).toFixed(1));
  }

  const comparison = {
    prevStartDate: dateRange.prevStartDate,
    prevEndDate: dateRange.prevEndDate,
    daysWithData: prevRaw.days_with_data || 0,
    requiredDays: dateRange.dayCount,
    hasEnoughPrevData,
    statusLabel: hasEnoughPrevData
      ? `Compared vs ${dateRange.prevStartDate} to ${dateRange.prevEndDate}`
      : (prevRaw.days_with_data > 0
          ? `Partial previous period (${prevRaw.days_with_data}/${dateRange.dayCount} days available)`
          : 'Insufficient historical data for previous period comparison'),
    previousTotals: prevMetrics,
    deltas: {
      spendPercent: calcDeltaPercent(periodMetrics.spend, prevMetrics.spend),
      formLeadsPercent: calcDeltaPercent(periodMetrics.formLeads, prevMetrics.formLeads),
      cplPercent: calcDeltaPercent(periodMetrics.cpl, prevMetrics.cpl),
      linkClicksPercent: calcDeltaPercent(periodMetrics.linkClicks, prevMetrics.linkClicks),
      linkCtrPercent: calcDeltaPercent(periodMetrics.linkCtr, prevMetrics.linkCtr)
    }
  };

  // 6. Daily Chart Series (Current Period + Previous Equivalent Period aligned day-by-day)
  const dailyRows = db.prepare(`
    SELECT
      di.date_start AS date,
      COALESCE(SUM(di.spend), 0) AS spend,
      COALESCE(SUM(di.impressions), 0) AS impressions,
      COALESCE(SUM(di.link_clicks), 0) AS link_clicks,
      COALESCE(SUM(di.form_leads), 0) AS form_leads
    FROM daily_insights di
    LEFT JOIN ads a ON a.ad_id = di.ad_id AND a.data_source = di.data_source
    LEFT JOIN campaigns c ON c.campaign_id = di.campaign_id AND c.data_source = di.data_source
    WHERE ${periodFilter.whereSql}
    GROUP BY di.date_start
    ORDER BY di.date_start ASC
  `).all(...periodFilter.params);

  const prevDailyRows = db.prepare(`
    SELECT
      di.date_start AS date,
      COALESCE(SUM(di.spend), 0) AS spend,
      COALESCE(SUM(di.impressions), 0) AS impressions,
      COALESCE(SUM(di.link_clicks), 0) AS link_clicks,
      COALESCE(SUM(di.form_leads), 0) AS form_leads
    FROM daily_insights di
    LEFT JOIN ads a ON a.ad_id = di.ad_id AND a.data_source = di.data_source
    LEFT JOIN campaigns c ON c.campaign_id = di.campaign_id AND c.data_source = di.data_source
    WHERE ${prevFilter.whereSql}
    GROUP BY di.date_start
    ORDER BY di.date_start ASC
  `).all(...prevFilter.params);

  const dailyMap = new Map(dailyRows.map(r => [r.date, r]));
  const prevDailyMap = new Map(prevDailyRows.map(r => [r.date, r]));

  const dailyChart = [];
  const cursor = new Date(`${dateRange.startDate}T00:00:00Z`);
  const prevCursor = new Date(`${dateRange.prevStartDate}T00:00:00Z`);

  for (let i = 0; i < dateRange.dayCount; i++) {
    const dStr = cursor.toISOString().slice(0, 10);
    const pStr = prevCursor.toISOString().slice(0, 10);
    const row = dailyMap.get(dStr);
    const pRow = prevDailyMap.get(pStr);

    const spend = row ? Number(row.spend.toFixed(2)) : 0;
    const formLeads = row ? (parseInt(row.form_leads, 10) || 0) : 0;
    const impressions = row ? (parseInt(row.impressions, 10) || 0) : 0;
    const linkClicks = row ? (parseInt(row.link_clicks, 10) || 0) : 0;
    const cpl = formLeads > 0 ? Number((spend / formLeads).toFixed(2)) : null;

    const prevSpend = pRow ? Number(pRow.spend.toFixed(2)) : null;
    const prevFormLeads = pRow ? (parseInt(pRow.form_leads, 10) || 0) : null;
    const prevCpl = (pRow && prevFormLeads > 0) ? Number((prevSpend / prevFormLeads).toFixed(2)) : null;

    dailyChart.push({
      date: dStr,
      hasData: Boolean(row),
      spend,
      impressions,
      linkClicks,
      formLeads,
      cpl,
      cplDisplay: formLeads > 0 ? cpl : '— / No leads',
      prevDate: pStr,
      prevHasData: Boolean(pRow),
      prevSpend,
      prevFormLeads,
      prevCpl
    });

    cursor.setUTCDate(cursor.getUTCDate() + 1);
    prevCursor.setUTCDate(prevCursor.getUTCDate() + 1);
  }

  // 7. Financial Clarity Section (Section 4: 4 Strictly Separate Concepts)
  const financialClarity = buildFinancialClarity({
    account,
    dataSource: activeSource,
    dateRange,
    todaySpend: todayMetrics.spend,
    periodSpend: periodMetrics.spend
  });

  // 8. Campaign Performance Table (Includes active + paused/completed/archived campaigns + Today's 1-day metrics)
  const campaignsTable = buildCampaignPerformanceTable({
    accountId: accId,
    dataSource: activeSource,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    todayDate: dateRange.todayDate,
    platformFilter: platformFilter || 'all',
    campaignId,
    statusFilter,
    searchQuery
  });

  // 9. Individual Ad Performance Table (Includes creative thumbnails, ad copy, CTA, delivery dates, period + Today's 1-day metrics)
  const adsTable = buildAdPerformanceTable({
    accountId: accId,
    dataSource: activeSource,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    todayDate: dateRange.todayDate,
    platformFilter: platformFilter || 'all',
    campaignId,
    adId,
    statusFilter,
    searchQuery
  });

  // 10. All Ad Accounts Summary for the Switcher (Supports N Ad Accounts)
  const allAccountsForSource = db.prepare(`
    SELECT
      aa.*,
      (SELECT COUNT(*) FROM campaigns c WHERE (aa.account_id = 'act_vims_all_accounts' OR c.account_id = aa.account_id) AND c.data_source = aa.data_source AND c.effective_status = 'ACTIVE') AS active_campaigns,
      (SELECT COUNT(*) FROM ads a WHERE (aa.account_id = 'act_vims_all_accounts' OR a.account_id = aa.account_id) AND a.data_source = aa.data_source AND a.effective_status = 'ACTIVE') AS active_ads
    FROM ad_accounts aa
    WHERE aa.data_source = ?
    ORDER BY CASE WHEN aa.account_id = 'act_vims_all_accounts' THEN 0 ELSE 1 END, aa.updated_at DESC
  `).all(activeSource);

  // 10. Leads & Follow-up Tracking + 3-Way Lead Count Reconciliation (Section 5)
  const leadsSection = buildLeadsAndReconciliation({
    accountId: accId,
    dataSource: activeSource,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    campaignId,
    adId,
    reportedFormLeadsCount: periodMetrics.formLeads
  });

  // 11. "What needs attention?" Performance Analysis & Suggested Improvements (Section 6)
  const recommendations = buildWhatNeedsAttention({
    accountId: accId,
    dataSource: activeSource,
    currency: account.currency || 'INR',
    dateRange,
    campaignsTable,
    adsTable,
    leadsSection
  });

  // Filter dropdown options (All stored campaigns & ads for this account)
  const allCampaignOptions = db.prepare(`
    SELECT campaign_id, name, effective_status, objective
    FROM campaigns
    WHERE (? = 1 OR account_id = ?) AND data_source = ?
    ORDER BY CASE WHEN effective_status = 'ACTIVE' THEN 0 ELSE 1 END, name ASC
  `).all(isAllAcc, accId, activeSource);

  const allAdOptions = db.prepare(`
    SELECT ad_id, name, campaign_id, effective_status
    FROM ads
    WHERE (? = 1 OR account_id = ?) AND data_source = ?
    ORDER BY CASE WHEN effective_status = 'ACTIVE' THEN 0 ELSE 1 END, name ASC
  `).all(isAllAcc, accId, activeSource);

  return {
    account: {
      accountId: account.account_id,
      name: account.name,
      currency: account.currency || 'INR',
      timezoneName: account.timezone_name || 'Asia/Kolkata',
      timezoneOffsetHours: account.timezone_offset_hours ?? 5.5,
      attributionSpec: account.attribution_spec || '7d_click_1d_view (7-day click / 1-day view)',
      dataSource: activeSource
    },
    coverage: {
      earliestDate: coverage.min_date || null,
      latestDate: coverage.max_date || null,
      activeDaysStored: coverage.active_days || 0,
      isPartialPeriod,
      missingPeriodsNote
    },
    dateRange,
    filters: {
      preset,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      campaignId,
      adId,
      statusFilter,
      platformFilter: platformFilter || 'all',
      searchQuery
    },
    filterOptions: {
      adAccounts: allAccountsForSource,
      campaigns: allCampaignOptions,
      ads: allAdOptions
    },
    summaryCards: {
      activeCampaignsNow,
      totalCampaignsStored,
      activeAdsNow,
      totalAdsStored,
      todayActualSpend: todayMetrics.spend,
      todayReach: resolveScopeReach({
        accountId: accId,
        dataSource: activeSource,
        startDate: dateRange.todayDate,
        endDate: dateRange.todayDate,
        platform: platformFilter || 'all',
        campaignId,
        adId
      }).reach,
      todayImpressions: todayMetrics.impressions,
      todayLinkClicks: todayMetrics.linkClicks,
      todayFormLeads: todayMetrics.formLeads,
      todayCplDisplay: todayMetrics.cplDisplay,
      periodActualSpend: periodMetrics.spend,
      periodReach: periodReachInfo.reach,
      periodReachIsExact: periodReachInfo.isExactUniqueReach,
      periodReachNote: periodReachInfo.reachNote,
      periodImpressions: periodMetrics.impressions,
      periodLinkClicks: periodMetrics.linkClicks,
      periodClicksAll: periodMetrics.clicksAll,
      periodLinkCtr: periodMetrics.linkCtr,
      periodLinkCtrDisplay: periodMetrics.linkCtrDisplay,
      periodLinkCpc: periodMetrics.linkCpc,
      periodLinkCpcDisplay: periodMetrics.linkCpcDisplay,
      periodReportedFormLeads: periodMetrics.formLeads,
      periodCpl: periodMetrics.cpl,
      periodCplDisplay: periodMetrics.cplDisplay,
      plannedBudgetRemaining: financialClarity.activePlanSummary.remainingAmount,
      plannedBudgetStatus: financialClarity.activePlanSummary.statusLabel,
      plannedBudgetTotal: financialClarity.activePlanSummary.plannedAmount
    },
    comparison,
    dailyChart,
    financialClarity,
    campaignsTable,
    adsTable,
    leadsSection,
    recommendations
  };
}

/**
 * Section 4: Keep all 4 financial figures strictly clear and separate:
 * 1. Meta campaign or ad set configured budget.
 * 2. Actual advertising spend.
 * 3. Manually entered spending plan for a defined period & scope.
 * 4. Verified Meta billing or available-funds information.
 */
function buildFinancialClarity({ account, dataSource, dateRange, todaySpend, periodSpend }) {
  const accId = account.account_id;
  const isAllAcc = accId === 'act_vims_all_accounts' ? 1 : 0;

  // 1. Meta Configured Budgets (Active Campaigns & Ad Sets)
  const activeCampBudgets = db.prepare(`
    SELECT campaign_id, name, effective_status, daily_budget, lifetime_budget, budget_remaining
    FROM campaigns
    WHERE (? = 1 OR account_id = ?) AND data_source = ? AND effective_status = 'ACTIVE'
  `).all(isAllAcc, accId, dataSource);

  const activeAdsetBudgets = db.prepare(`
    SELECT adset_id, name, campaign_id, effective_status, daily_budget, lifetime_budget, budget_remaining
    FROM adsets
    WHERE (? = 1 OR account_id = ?) AND data_source = ? AND effective_status = 'ACTIVE'
  `).all(isAllAcc, accId, dataSource);

  let configuredDailyBudgetSum = 0;
  let configuredLifetimeBudgetSum = 0;

  for (const c of activeCampBudgets) {
    if (c.daily_budget) configuredDailyBudgetSum += Number(c.daily_budget);
    if (c.lifetime_budget) configuredLifetimeBudgetSum += Number(c.lifetime_budget);
  }
  for (const as of activeAdsetBudgets) {
    if (as.daily_budget) configuredDailyBudgetSum += Number(as.daily_budget);
    if (as.lifetime_budget) configuredLifetimeBudgetSum += Number(as.lifetime_budget);
  }

  // 3. Manually Entered Planned Budgets (Calculate actual spend matching each plan's exact dates & scope!)
  const rawPlans = db.prepare(`
    SELECT * FROM planned_budgets
    WHERE account_id = ? AND data_source = ?
    ORDER BY start_date DESC, created_at DESC
  `).all(accId, dataSource);

  const evaluatedPlans = rawPlans.map(plan => {
    let spendRow;
    if (plan.scope_type === 'campaign' && plan.scope_campaign_id) {
      spendRow = db.prepare(`
        SELECT COALESCE(SUM(spend), 0) AS actual_spend
        FROM daily_insights
        WHERE (? = 1 OR account_id = ?) AND data_source = ? AND entity_type = 'ad'
          AND publisher_platform = 'all'
          AND campaign_id = ? AND date_start >= ? AND date_start <= ?
      `).get(isAllAcc, accId, dataSource, plan.scope_campaign_id, plan.start_date, plan.end_date);
    } else {
      spendRow = db.prepare(`
        SELECT COALESCE(SUM(spend), 0) AS actual_spend
        FROM daily_insights
        WHERE (? = 1 OR account_id = ?) AND data_source = ? AND entity_type = 'ad'
          AND publisher_platform = 'all'
          AND date_start >= ? AND date_start <= ?
      `).get(isAllAcc, accId, dataSource, plan.start_date, plan.end_date);
    }

    const actualSpendForPlan = Number((spendRow?.actual_spend || 0).toFixed(2));
    const plannedAmt = Number(Number(plan.planned_amount || 0).toFixed(2));
    const remainingAmt = Number((plannedAmt - actualSpendForPlan).toFixed(2));
    const isExceeded = remainingAmt < 0;
    const utilizationPercent = plannedAmt > 0 ? Number(((actualSpendForPlan / plannedAmt) * 100).toFixed(1)) : 0;

    return {
      id: plan.id,
      planName: plan.plan_name,
      scopeType: plan.scope_type,
      scopeCampaignId: plan.scope_campaign_id,
      scopeCampaignName: plan.scope_campaign_name || 'All Campaigns (Account-Wide)',
      startDate: plan.start_date,
      endDate: plan.end_date,
      plannedAmount: plannedAmt,
      actualSpendInScope: actualSpendForPlan,
      remainingAmount: remainingAmt,
      exceededBy: isExceeded ? Math.abs(remainingAmt) : 0,
      isExceeded,
      utilizationPercent,
      statusLabel: isExceeded
        ? `Exceeded by ${Math.abs(remainingAmt).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
        : `${utilizationPercent}% used`,
      notes: plan.notes || ''
    };
  });

  // Identify primary active plan overlapping current selected dateRange (or latest plan)
  const overlappingPlan = evaluatedPlans.find(p => p.startDate <= dateRange.endDate && p.endDate >= dateRange.startDate)
    || evaluatedPlans[0]
    || null;

  const activePlanSummary = overlappingPlan
    ? {
        hasPlan: true,
        planName: overlappingPlan.planName,
        scopeLabel: `${overlappingPlan.scopeCampaignName} (${overlappingPlan.startDate} to ${overlappingPlan.endDate})`,
        plannedAmount: overlappingPlan.plannedAmount,
        actualSpendInScope: overlappingPlan.actualSpendInScope,
        remainingAmount: overlappingPlan.remainingAmount,
        isExceeded: overlappingPlan.isExceeded,
        exceededBy: overlappingPlan.exceededBy,
        utilizationPercent: overlappingPlan.utilizationPercent,
        statusLabel: overlappingPlan.statusLabel
      }
    : {
        hasPlan: false,
        planName: 'No Spending Plan Entered',
        scopeLabel: 'Click "Manage Planned Budget" to set your spending plan',
        plannedAmount: null,
        actualSpendInScope: periodSpend,
        remainingAmount: null,
        isExceeded: false,
        exceededBy: 0,
        utilizationPercent: null,
        statusLabel: 'No plan set'
      };

  // 4. Verified Meta Billing / Available Funds vs Amount Owed
  const availableFundsDisplay = (account.available_funds_verified !== null && account.available_funds_verified !== undefined)
    ? account.available_funds_verified
    : 'Unavailable from connected data';

  const amountOwedDisplay = (account.balance_amount_owed !== null && account.balance_amount_owed !== undefined)
    ? account.balance_amount_owed
    : 'Unavailable from connected data';

  return {
    metaConfiguredBudget: {
      activeDailyBudgetTotal: Number(configuredDailyBudgetSum.toFixed(2)),
      activeLifetimeBudgetTotal: Number(configuredLifetimeBudgetSum.toFixed(2)),
      activeCampaignsCount: activeCampBudgets.length,
      note: 'Configured daily/lifetime limits set inside Meta Ads Manager (not actual money spent).'
    },
    actualAdSpend: {
      todaySpend,
      selectedPeriodSpend: periodSpend,
      lifetimeAccountSpend: account.amount_spent_total,
      note: 'Actual reported expenditure billed by Meta for delivered impressions/clicks.'
    },
    plannedBudgets: evaluatedPlans,
    activePlanSummary,
    verifiedMetaBilling: {
      availableFundsVerified: account.available_funds_verified,
      availableFundsDisplay,
      amountOwed: account.balance_amount_owed,
      amountOwedDisplay,
      spendCap: account.spend_cap,
      fundingSourceDetails: account.funding_source_details || 'Not reported by current connection',
      verificationNote: account.billing_verification_note || 'Unavailable from connected data.'
    }
  };
}

/**
 * Campaign Performance Table (Aggregates daily_insights per campaign; includes historical paused/completed/archived campaigns)
 */
function buildCampaignPerformanceTable({
  accountId,
  dataSource,
  startDate,
  endDate,
  todayDate = '',
  platformFilter = 'all',
  campaignId = '',
  statusFilter = 'ALL',
  searchQuery = ''
}) {
  const refToday = todayDate || endDate;
  const isAllAcc = accountId === 'act_vims_all_accounts' ? 1 : 0;
  let campWhere = `(? = 1 OR c.account_id = ?) AND c.data_source = ?`;
  const campParams = [isAllAcc, accountId, dataSource];

  if (campaignId) {
    campWhere += ` AND c.campaign_id = ?`;
    campParams.push(campaignId);
  }
  if (statusFilter && statusFilter !== 'ALL') {
    campWhere += ` AND c.effective_status = ?`;
    campParams.push(statusFilter);
  }
  if (searchQuery && searchQuery.trim() !== '') {
    const q = `%${searchQuery.trim().toLowerCase()}%`;
    campWhere += ` AND (LOWER(c.name) LIKE ? OR LOWER(c.campaign_id) LIKE ? OR LOWER(c.objective) LIKE ?)`;
    campParams.push(q, q, q);
  }

  const campaigns = db.prepare(`
    SELECT
      c.*,
      (SELECT COUNT(*) FROM adsets asets WHERE asets.campaign_id = c.campaign_id AND asets.data_source = c.data_source) AS adsets_count,
      (SELECT COUNT(*) FROM ads a WHERE a.campaign_id = c.campaign_id AND a.data_source = c.data_source) AS total_ads_count,
      (SELECT COUNT(*) FROM ads a WHERE a.campaign_id = c.campaign_id AND a.data_source = c.data_source AND a.effective_status = 'ACTIVE') AS active_ads_count
    FROM campaigns c
    WHERE ${campWhere}
    ORDER BY CASE WHEN c.effective_status = 'ACTIVE' THEN 0 ELSE 1 END, c.name ASC
  `).all(...campParams);

  const metricsStmt = db.prepare(`
    SELECT
      COALESCE(SUM(spend), 0) AS spend,
      COALESCE(SUM(impressions), 0) AS impressions,
      COALESCE(SUM(clicks_all), 0) AS clicks_all,
      COALESCE(SUM(link_clicks), 0) AS link_clicks,
      COALESCE(SUM(form_leads), 0) AS form_leads,
      COALESCE(SUM(messaging_leads), 0) AS messaging_leads,
      COALESCE(SUM(website_leads), 0) AS website_leads,
      COALESCE(SUM(landing_page_views), 0) AS landing_page_views,
      COALESCE(SUM(post_engagements), 0) AS post_engagements,
      COALESCE(SUM(results_count), 0) AS results_count,
      MAX(result_type) AS sample_result_type
    FROM daily_insights
    WHERE (? = 1 OR account_id = ?) AND data_source = ? AND entity_type = 'ad'
      AND campaign_id = ? AND date_start >= ? AND date_start <= ? AND publisher_platform = ?
  `);

  const todayStmt = db.prepare(`
    SELECT
      COALESCE(SUM(spend), 0) AS today_spend,
      MAX(reach) AS today_reach,
      COALESCE(SUM(impressions), 0) AS today_impressions,
      COALESCE(SUM(form_leads), 0) AS today_leads
    FROM daily_insights
    WHERE (? = 1 OR account_id = ?) AND data_source = ? AND entity_type = 'ad'
      AND campaign_id = ? AND date_start = ? AND publisher_platform = ?
  `);

  const rows = [];
  for (const c of campaigns) {
    const rawM = metricsStmt.get(isAllAcc, accountId, dataSource, c.campaign_id, startDate, endDate, platformFilter);
    const todayM = todayStmt.get(isAllAcc, accountId, dataSource, c.campaign_id, refToday, platformFilter);
    const primaryResType = determineObjectiveResultLabel(c.objective, rawM);
    const derived = computeDerivedMetrics(rawM, primaryResType);
    const reachInfo = resolveScopeReach({
      accountId,
      dataSource,
      startDate,
      endDate,
      platform: platformFilter,
      campaignId: c.campaign_id
    });

    rows.push({
      campaignId: c.campaign_id,
      name: c.name,
      status: c.status,
      effectiveStatus: c.effective_status,
      isDeletedOnMeta: Boolean(c.is_deleted_on_meta),
      objective: c.objective,
      objectiveLabel: formatObjectiveHuman(c.objective),
      dailyBudget: c.daily_budget,
      lifetimeBudget: c.lifetime_budget,
      adsetsCount: c.adsets_count || 0,
      totalAdsCount: c.total_ads_count || 0,
      activeAdsCount: c.active_ads_count || 0,
      startTime: c.start_time,
      stopTime: c.stop_time,
      todaySpend: Number((todayM?.today_spend || 0).toFixed(2)),
      todayReach: todayM?.today_reach ?? 0,
      todayLeads: todayM?.today_leads ?? 0,
      reach: reachInfo.reach,
      reachIsExact: reachInfo.isExactUniqueReach,
      ...derived
    });
  }

  // Sort by spend DESC then active status
  rows.sort((a, b) => {
    if (b.spend !== a.spend) return b.spend - a.spend;
    if (a.effectiveStatus === 'ACTIVE' && b.effectiveStatus !== 'ACTIVE') return -1;
    if (b.effectiveStatus === 'ACTIVE' && a.effectiveStatus !== 'ACTIVE') return 1;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

/**
 * Individual Ad Performance Table (Includes creative thumbnails, full copy, delivery dates, metrics)
 */
function buildAdPerformanceTable({
  accountId,
  dataSource,
  startDate,
  endDate,
  todayDate = '',
  platformFilter = 'all',
  campaignId = '',
  adId = '',
  statusFilter = 'ALL',
  searchQuery = ''
}) {
  const refToday = todayDate || endDate;
  const isAllAcc = accountId === 'act_vims_all_accounts' ? 1 : 0;
  let adWhere = `(? = 1 OR a.account_id = ?) AND a.data_source = ?`;
  const adParams = [isAllAcc, accountId, dataSource];

  if (campaignId) {
    adWhere += ` AND a.campaign_id = ?`;
    adParams.push(campaignId);
  }
  if (adId) {
    adWhere += ` AND a.ad_id = ?`;
    adParams.push(adId);
  }
  if (statusFilter && statusFilter !== 'ALL') {
    adWhere += ` AND a.effective_status = ?`;
    adParams.push(statusFilter);
  }
  if (searchQuery && searchQuery.trim() !== '') {
    const q = `%${searchQuery.trim().toLowerCase()}%`;
    adWhere += ` AND (LOWER(a.name) LIKE ? OR LOWER(c.name) LIKE ? OR LOWER(aset.name) LIKE ? OR LOWER(a.ad_id) LIKE ? OR LOWER(a.creative_title) LIKE ? OR LOWER(a.creative_body) LIKE ?)`;
    adParams.push(q, q, q, q, q, q);
  }

  const ads = db.prepare(`
    SELECT
      a.*,
      c.name AS campaign_name,
      c.objective AS campaign_objective,
      c.effective_status AS campaign_status,
      aset.name AS adset_name,
      aset.optimization_goal AS adset_optimization_goal
    FROM ads a
    LEFT JOIN campaigns c ON c.campaign_id = a.campaign_id AND c.data_source = a.data_source
    LEFT JOIN adsets aset ON aset.adset_id = a.adset_id AND aset.data_source = a.data_source
    WHERE ${adWhere}
  `).all(...adParams);

  const metricsStmt = db.prepare(`
    SELECT
      COALESCE(SUM(spend), 0) AS spend,
      COALESCE(SUM(impressions), 0) AS impressions,
      COALESCE(SUM(clicks_all), 0) AS clicks_all,
      COALESCE(SUM(link_clicks), 0) AS link_clicks,
      COALESCE(SUM(form_leads), 0) AS form_leads,
      COALESCE(SUM(messaging_leads), 0) AS messaging_leads,
      COALESCE(SUM(website_leads), 0) AS website_leads,
      COALESCE(SUM(landing_page_views), 0) AS landing_page_views,
      COALESCE(SUM(post_engagements), 0) AS post_engagements,
      COALESCE(SUM(results_count), 0) AS results_count,
      MIN(CASE WHEN impressions > 0 THEN date_start ELSE NULL END) AS active_first_day,
      MAX(CASE WHEN impressions > 0 THEN date_start ELSE NULL END) AS active_last_day
    FROM daily_insights
    WHERE (? = 1 OR account_id = ?) AND data_source = ? AND entity_type = 'ad'
      AND ad_id = ? AND date_start >= ? AND date_start <= ? AND publisher_platform = ?
  `);

  const todayAdStmt = db.prepare(`
    SELECT
      COALESCE(SUM(spend), 0) AS today_spend,
      MAX(reach) AS today_reach,
      COALESCE(SUM(impressions), 0) AS today_impressions,
      COALESCE(SUM(link_clicks), 0) AS today_link_clicks,
      COALESCE(SUM(form_leads), 0) AS today_leads
    FROM daily_insights
    WHERE (? = 1 OR account_id = ?) AND data_source = ? AND entity_type = 'ad'
      AND ad_id = ? AND date_start = ? AND publisher_platform = ?
  `);

  const rows = [];
  for (const ad of ads) {
    const rawM = metricsStmt.get(isAllAcc, accountId, dataSource, ad.ad_id, startDate, endDate, platformFilter);
    const todayM = todayAdStmt.get(isAllAcc, accountId, dataSource, ad.ad_id, refToday, platformFilter);
    const primaryResType = determineObjectiveResultLabel(ad.campaign_objective, rawM);
    const derived = computeDerivedMetrics(rawM, primaryResType);
    const reachInfo = resolveScopeReach({
      accountId,
      dataSource,
      startDate,
      endDate,
      platform: platformFilter,
      adId: ad.ad_id
    });

    rows.push({
      adId: ad.ad_id,
      name: ad.name,
      campaignId: ad.campaign_id,
      campaignName: ad.campaign_name || `Campaign ${ad.campaign_id}`,
      campaignObjective: ad.campaign_objective || 'OUTCOME_LEADS',
      objectiveLabel: formatObjectiveHuman(ad.campaign_objective),
      adsetId: ad.adset_id,
      adsetName: ad.adset_name || `Ad Set ${ad.adset_id}`,
      status: ad.status,
      effectiveStatus: ad.effective_status,
      isDeletedOnMeta: Boolean(ad.is_deleted_on_meta),
      todaySpend: Number((todayM?.today_spend || 0).toFixed(2)),
      todayReach: todayM?.today_reach ?? 0,
      todayImpressions: todayM?.today_impressions ?? 0,
      todayLinkClicks: todayM?.today_link_clicks ?? 0,
      todayLeads: todayM?.today_leads ?? 0,
      creative: {
        creativeId: ad.creative_id,
        title: ad.creative_title || ad.name,
        body: ad.creative_body || '',
        cta: ad.creative_cta || 'LEARN_MORE',
        linkUrl: ad.creative_link_url || '',
        thumbnailUrl: ad.creative_thumbnail_url || '',
        imageUrl: ad.creative_image_url || ad.creative_thumbnail_url || '',
        videoId: ad.creative_video_id || '',
        mediaType: ad.creative_media_type || 'IMAGE',
        leadFormId: ad.lead_form_id || '',
        leadFormName: ad.lead_form_name || ''
      },
      deliveryStartDate: ad.delivery_start_date || rawM.active_first_day || '',
      deliveryStopDate: ad.delivery_stop_date || rawM.active_last_day || '',
      reach: reachInfo.reach,
      reachIsExact: reachInfo.isExactUniqueReach,
      ...derived
    });
  }

  rows.sort((a, b) => {
    if (b.spend !== a.spend) return b.spend - a.spend;
    if (a.effectiveStatus === 'ACTIVE' && b.effectiveStatus !== 'ACTIVE') return -1;
    if (b.effectiveStatus === 'ACTIVE' && a.effectiveStatus !== 'ACTIVE') return 1;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

function determineObjectiveResultLabel(objective = '', rawM = {}) {
  const obj = String(objective || '').toUpperCase();
  if (obj.includes('LEAD')) return 'Form Leads';
  if (obj.includes('TRAFFIC') || obj.includes('LINK_CLICKS')) {
    return (rawM.landing_page_views > 0) ? 'Landing Page Views' : 'Link Clicks';
  }
  if (obj.includes('REACH') || obj.includes('AWARENESS')) return 'Impressions';
  if (obj.includes('ENGAGEMENT') || obj.includes('MESSAGES')) {
    return (rawM.messaging_leads > 0) ? 'Messaging Conversations' : 'Post Engagements';
  }
  if (obj.includes('SALES') || obj.includes('CONVERSIONS')) {
    return (rawM.website_leads > 0) ? 'Website Leads' : 'Form Leads';
  }
  return 'Form Leads';
}

function formatObjectiveHuman(objective = '') {
  const obj = String(objective || '').toUpperCase();
  if (obj.includes('LEAD')) return 'Lead Generation (Instant Forms)';
  if (obj.includes('TRAFFIC') || obj.includes('LINK_CLICKS')) return 'Traffic & Link Clicks';
  if (obj.includes('REACH') || obj.includes('AWARENESS')) return 'Brand Awareness & Reach';
  if (obj.includes('ENGAGEMENT')) return 'Engagement & Messages';
  if (obj.includes('SALES') || obj.includes('CONVERSIONS')) return 'Conversions / Sales';
  return objective || 'Lead Generation';
}

/**
 * Section 5: Leads Table & 3-Way Lead Count Reconciliation
 * Strictly separates:
 * 1. Leads reported in advertising metrics (`reportedFormLeadsCount`)
 * 2. Lead contact records successfully retrieved (`retrievedLeadRecordsCount`)
 * 3. Leads our team has qualified or marked as Won customers (`teamQualifiedCount`, `teamWonCustomersCount`)
 */
function buildLeadsAndReconciliation({
  accountId,
  dataSource,
  startDate,
  endDate,
  campaignId = '',
  adId = '',
  reportedFormLeadsCount = 0
}) {
  const isAllAcc = accountId === 'act_vims_all_accounts' ? 1 : 0;
  let leadWhere = `(? = 1 OR l.account_id = ?) AND l.data_source = ? AND l.submission_date >= ? AND l.submission_date <= ?`;
  const leadParams = [isAllAcc, accountId, dataSource, startDate, endDate];

  if (campaignId) {
    leadWhere += ` AND l.campaign_id = ?`;
    leadParams.push(campaignId);
  }
  if (adId) {
    leadWhere += ` AND l.ad_id = ?`;
    leadParams.push(adId);
  }

  const leads = db.prepare(`
    SELECT
      l.*,
      COALESCE(f.followup_status, 'New') AS followup_status,
      COALESCE(f.assigned_person, '') AS assigned_person,
      COALESCE(f.notes, '') AS notes,
      COALESCE(f.next_followup_date, '') AS next_followup_date,
      f.recorded_deal_value,
      COALESCE(f.recorded_order_ref, '') AS recorded_order_ref,
      f.updated_at AS followup_updated_at
    FROM lead_submissions l
    LEFT JOIN lead_followups f ON f.lead_id = l.lead_id
    WHERE ${leadWhere}
    ORDER BY l.created_time DESC
  `).all(...leadParams);

  const statusBreakdown = {
    New: 0,
    Contacted: 0,
    Interested: 0,
    'Demo Scheduled': 0,
    Won: 0,
    Lost: 0
  };

  let recordedRevenueTotal = 0;
  let recordedOrdersCount = 0;

  for (const ld of leads) {
    const st = ld.followup_status || 'New';
    statusBreakdown[st] = (statusBreakdown[st] || 0) + 1;
    if (st === 'Won' && ld.recorded_deal_value && Number(ld.recorded_deal_value) > 0) {
      recordedRevenueTotal += Number(ld.recorded_deal_value);
      recordedOrdersCount++;
    }
  }

  const retrievedCount = leads.length;
  const qualifiedCount = (statusBreakdown['Interested'] || 0) + (statusBreakdown['Demo Scheduled'] || 0) + (statusBreakdown['Won'] || 0);
  const wonCustomersCount = statusBreakdown['Won'] || 0;

  const diff = reportedFormLeadsCount - retrievedCount;
  let discrepancyExplanation = '';
  if (diff === 0) {
    discrepancyExplanation = 'Reported ad-metric form leads and retrieved lead contact records match for this period.';
  } else if (diff > 0) {
    discrepancyExplanation = `Ad metrics report ${reportedFormLeadsCount} form leads, while ${retrievedCount} contact records were retrieved (${diff} difference). Common reasons: (1) Attribution Date vs Submission Date — Meta Insights attributes a lead to the date the ad was clicked/viewed (7-day click / 1-day view window), whereas the Lead Table filters by actual form submission timestamp; (2) Missing Page 'leads_retrieval' permission on one of the Facebook Pages; or (3) Meta retention window (Meta stores raw form submissions on Pages for 90 days).`;
  } else {
    discrepancyExplanation = `Retrieved lead records (${retrievedCount}) exceed ad-attributed form leads (${reportedFormLeadsCount}) by ${Math.abs(diff)}. Common reasons: (1) Customers clicked an ad prior to ${startDate} and submitted the form during this period; or (2) Organic / shared post submissions on the same Instant Form.`;
  }

  return {
    reconciliation: {
      reportedInAdMetrics: reportedFormLeadsCount,
      retrievedContactRecords: retrievedCount,
      teamQualifiedLeads: qualifiedCount,
      teamWonCustomers: wonCustomersCount,
      recordedOrdersCount,
      recordedRevenueTotal: Number(recordedRevenueTotal.toFixed(2)),
      statusBreakdown,
      discrepancyCount: diff,
      discrepancyExplanation,
      enquiryDisclaimer: 'A form submission is an enquiry, not a sale. Orders or revenue appear only when explicitly recorded by your sales team on a Won lead.'
    },
    leads: leads.map(l => ({
      leadId: l.lead_id,
      dataSource: l.data_source,
      createdTime: l.created_time,
      submissionDate: l.submission_date,
      customerName: l.customer_name,
      phoneNumber: l.phone_number,
      email: l.email,
      businessRequirements: l.business_requirements,
      city: l.city,
      organizationName: l.organization_name,
      campaignId: l.campaign_id,
      campaignName: l.campaign_name,
      adsetId: l.adset_id,
      adsetName: l.adset_name,
      adId: l.ad_id,
      adName: l.ad_name,
      formId: l.form_id,
      formName: l.form_name,
      platform: l.platform,
      isOrganic: Boolean(l.is_organic),
      followupStatus: l.followup_status,
      assignedPerson: l.assigned_person,
      notes: l.notes,
      nextFollowupDate: l.next_followup_date,
      recordedDealValue: l.recorded_deal_value,
      recordedOrderRef: l.recorded_order_ref,
      followupUpdatedAt: l.followup_updated_at
    }))
  };
}

/**
 * Section 6: "What needs attention?" — Explainable Rules & Suggested Improvements
 * - Separates observed facts from possible explanations.
 * - Compares campaigns/ads with similar objectives using account history and configurable targets.
 * - Never invents industry benchmarks, guaranteed results, or fake confidence scores.
 * - Displays "Not enough data" when sample size is too small.
 */
function buildWhatNeedsAttention({
  accountId,
  dataSource,
  currency = 'INR',
  dateRange,
  campaignsTable,
  adsTable,
  leadsSection
}) {
  const targets = db.prepare(`SELECT * FROM analysis_targets WHERE account_id = ?`).get(accountId)
    || db.prepare(`SELECT * FROM analysis_targets WHERE account_id = 'default'`).get()
    || {
      target_cpl: 250,
      max_spend_zero_leads: 400,
      min_link_ctr_percent: 0.85,
      min_clicks_for_ctr_eval: 40,
      min_impressions_for_eval: 1000,
      min_click_to_lead_rate_percent: 6.0,
      cpl_increase_threshold_percent: 25.0,
      lead_followup_sla_hours: 24
    };

  const items = [];
  const periodLabel = `${dateRange.startDate} to ${dateRange.endDate}`;

  // Calculate account's own historical average CPL across Lead Generation campaigns in this period
  const leadCampaigns = campaignsTable.filter(c => String(c.objective).toUpperCase().includes('LEAD'));
  const totalLeadCampSpend = leadCampaigns.reduce((s, c) => s + c.spend, 0);
  const totalLeadCampLeads = leadCampaigns.reduce((s, c) => s + c.formLeads, 0);
  const accountAvgLeadCpl = totalLeadCampLeads > 0 ? Number((totalLeadCampSpend / totalLeadCampLeads).toFixed(2)) : null;

  // Rule 1: Leads waiting for follow-up (Status === 'New')
  const uncontactedLeads = (leadsSection.leads || []).filter(l => l.followupStatus === 'New');
  if (uncontactedLeads.length > 0) {
    const oldestNew = uncontactedLeads[uncontactedLeads.length - 1];
    items.push({
      id: 'rule_leads_waiting_followup',
      category: 'Lead Follow-up SLA',
      severity: 'high',
      entityType: 'Leads Queue',
      entityName: `${uncontactedLeads.length} Uncontacted Form Enquir${uncontactedLeads.length === 1 ? 'y' : 'ies'} (Status: New)`,
      reportingPeriod: periodLabel,
      dataSufficiency: 'Sufficient data (Verified retrieved lead records)',
      hasEnoughData: true,
      observedFacts: `${uncontactedLeads.length} retrieved form submission(s) in this period are still marked as "New" with no follow-up status update. Oldest uncontacted submission: ${oldestNew.customerName} (${oldestNew.submissionDate}, Campaign: ${oldestNew.campaignName || 'N/A'}).`,
      whyItDeservesAttention: 'Possible explanation: Enquiries from Facebook/Instagram Instant Forms cool down quickly if not contacted promptly. Delaying outreach reduces the chance of qualifying the lead or scheduling a demo.',
      practicalNextStep: 'Assign the "New" leads in the Leads & Follow-ups table below to a team member, call/WhatsApp the prospect, and update their status to Contacted, Interested, or Demo Scheduled.'
    });
  }

  // Evaluate Individual Ads & Campaigns
  for (const ad of adsTable) {
    if (ad.spend <= 0 && ad.impressions <= 0) continue;
    const isLeadObjective = String(ad.campaignObjective).toUpperCase().includes('LEAD');

    // Check data sufficiency first
    if (ad.impressions < targets.min_impressions_for_eval && ad.spend < targets.max_spend_zero_leads) {
      items.push({
        id: `insufficient_${ad.adId}`,
        category: 'Data Sufficiency Check',
        severity: 'info',
        entityType: 'Ad',
        entityName: `${ad.name} (Campaign: ${ad.campaignName})`,
        reportingPeriod: periodLabel,
        dataSufficiency: 'Not enough data',
        hasEnoughData: false,
        observedFacts: `Spend: ${currency} ${ad.spend.toFixed(2)} | Impressions: ${ad.impressions.toLocaleString('en-IN')} | Link Clicks: ${ad.linkClicks} | Reported Form Leads: ${ad.formLeads}.`,
        whyItDeservesAttention: `This ad has fewer than ${targets.min_impressions_for_eval.toLocaleString('en-IN')} impressions and less than ${currency} ${targets.max_spend_zero_leads} spend in the selected window — Not enough data to draw reliable conclusions.`,
        practicalNextStep: 'Allow the ad to accumulate more delivery or select a wider date range (e.g., Last 30 Days) before judging creative or audience performance.'
      });
      continue;
    }

    // Rule 2: Spend with Zero or Very Few Reported Leads (Lead Generation Objective)
    if (isLeadObjective && ad.formLeads === 0 && ad.spend >= targets.max_spend_zero_leads) {
      items.push({
        id: `zero_leads_${ad.adId}`,
        category: 'Spend Without Reported Leads',
        severity: 'high',
        entityType: 'Ad',
        entityName: `${ad.name} (Campaign: ${ad.campaignName})`,
        reportingPeriod: periodLabel,
        dataSufficiency: 'Sufficient data',
        hasEnoughData: true,
        observedFacts: `Actual Spend: ${currency} ${ad.spend.toFixed(2)} | Impressions: ${ad.impressions.toLocaleString('en-IN')} | Link Clicks: ${ad.linkClicks} | Reported Form Leads: 0 (Threshold: ${currency} ${targets.max_spend_zero_leads}).`,
        whyItDeservesAttention: 'Observed fact: This ad spent above your zero-lead review threshold without generating any attributed form submissions. Possible explanations include form friction (too many questions), audience mismatch, or budget going to other ads in the ad set.',
        practicalNextStep: 'Review whether the attached Instant Form asks too many manual text fields, or test pausing this ad in Ads Manager so budget shifts to higher-converting ads in the same campaign.'
      });
    }

    // Rule 3: High / Increasing Cost Per Lead compared to target or account average
    if (isLeadObjective && ad.formLeads > 0 && ad.cpl !== null) {
      const benchmarkCpl = accountAvgLeadCpl || targets.target_cpl;
      if (ad.cpl > targets.target_cpl * (1 + targets.cpl_increase_threshold_percent / 100)) {
        items.push({
          id: `high_cpl_${ad.adId}`,
          category: 'Elevated Cost Per Form Lead',
          severity: 'medium',
          entityType: 'Ad',
          entityName: `${ad.name} (Campaign: ${ad.campaignName})`,
          reportingPeriod: periodLabel,
          dataSufficiency: ad.formLeads >= 3 ? 'Sufficient data' : 'Limited lead volume (< 3 leads)',
          hasEnoughData: ad.formLeads >= 3,
          observedFacts: `Cost Per Form Lead: ${currency} ${ad.cpl.toFixed(2)} across ${ad.formLeads} lead(s) on ${currency} ${ad.spend.toFixed(2)} spend. Configured Target CPL: ${currency} ${targets.target_cpl.toFixed(2)}${accountAvgLeadCpl ? ` | Account Lead-Campaign Average CPL: ${currency} ${accountAvgLeadCpl.toFixed(2)}` : ''}.`,
          whyItDeservesAttention: 'Observed fact: Cost per form lead on this ad is significantly higher than your configured target and peer lead ads. Possible explanations include narrower audience saturation, higher auction CPM, or lower click-to-form completion rate.',
          practicalNextStep: 'Compare this ad’s Link CTR and Click-to-Lead conversion rate against your lower-CPL ads in the same campaign, and test a clearer headline or simpler lead form.'
        });
      }
    }

    // Rule 4: Low Link Click-Through Rate (Link CTR)
    if (ad.impressions >= targets.min_impressions_for_eval && ad.linkCtr !== null && ad.linkCtr < targets.min_link_ctr_percent) {
      items.push({
        id: `low_ctr_${ad.adId}`,
        category: 'Low Link Click-Through Rate',
        severity: 'medium',
        entityType: 'Ad',
        entityName: `${ad.name} (Campaign: ${ad.campaignName})`,
        reportingPeriod: periodLabel,
        dataSufficiency: 'Sufficient data',
        hasEnoughData: true,
        observedFacts: `Link CTR: ${ad.linkCtr.toFixed(2)}% (${ad.linkClicks} link clicks from ${ad.impressions.toLocaleString('en-IN')} impressions). Configured minimum Link CTR target: ${targets.min_link_ctr_percent}%.`,
        whyItDeservesAttention: 'Observed fact: Fewer than 1 in 100 impressions resulted in a link/form click. Possible explanations: the visual hook, thumbnail, headline, or audience targeting may not be stopping users in the feed — note that low clicks justify testing a new creative or message, but do not prove the poster alone is the cause.',
        practicalNextStep: 'Test a variation with a clearer Tamil/English value proposition in the first line of ad copy and a high-contrast poster or short video hook.'
      });
    }

    // Rule 5: Clicks without enough Form Submissions (High Form Drop-off)
    if (isLeadObjective && ad.linkClicks >= targets.min_clicks_for_ctr_eval && ad.linkClickToLeadRate !== null && ad.linkClickToLeadRate < targets.min_click_to_lead_rate_percent) {
      items.push({
        id: `form_dropoff_${ad.adId}`,
        category: 'Clicks Without Enough Form Submissions',
        severity: 'medium',
        entityType: 'Ad',
        entityName: `${ad.name} (Campaign: ${ad.campaignName})`,
        reportingPeriod: periodLabel,
        dataSufficiency: 'Sufficient data',
        hasEnoughData: true,
        observedFacts: `Link Clicks: ${ad.linkClicks} | Reported Form Leads: ${ad.formLeads} | Click-to-Form-Lead Rate: ${ad.linkClickToLeadRate.toFixed(2)}% (Target minimum: ${targets.min_click_to_lead_rate_percent}%).`,
        whyItDeservesAttention: 'Observed fact: People are clicking the ad call-to-action, but most close the Instant Form before submitting. Possible explanations: mismatch between what the ad promises and the form intro screen, or too many custom short-answer questions.',
        practicalNextStep: 'Inspect the Instant Form in Meta Ads Manager: test an "Intro" headline that matches the ad headline and reduce custom questions to 1-2 multiple-choice fields plus Name & Phone.'
      });
    }

    // Rule 6: Possible Creative Fatigue (Trend analysis across first half vs second half of period)
    if (dateRange.dayCount >= 10 && ad.impressions >= 2500) {
      const midDateObj = new Date(`${dateRange.startDate}T00:00:00Z`);
      midDateObj.setUTCDate(midDateObj.getUTCDate() + Math.floor(dateRange.dayCount / 2));
      const midDateStr = midDateObj.toISOString().slice(0, 10);

      const isAllAcc = accountId === 'act_vims_all_accounts' ? 1 : 0;
      const firstHalf = db.prepare(`
        SELECT COALESCE(SUM(spend),0) AS spend, COALESCE(SUM(impressions),0) AS imp, COALESCE(SUM(link_clicks),0) AS lc, COALESCE(SUM(form_leads),0) AS leads
        FROM daily_insights
        WHERE (? = 1 OR account_id = ?) AND data_source = ? AND entity_type = 'ad' AND ad_id = ?
          AND publisher_platform = 'all' AND date_start >= ? AND date_start < ?
      `).get(isAllAcc, accountId, dataSource, ad.adId, dateRange.startDate, midDateStr);

      const secondHalf = db.prepare(`
        SELECT COALESCE(SUM(spend),0) AS spend, COALESCE(SUM(impressions),0) AS imp, COALESCE(SUM(link_clicks),0) AS lc, COALESCE(SUM(form_leads),0) AS leads
        FROM daily_insights
        WHERE (? = 1 OR account_id = ?) AND data_source = ? AND entity_type = 'ad' AND ad_id = ?
          AND publisher_platform = 'all' AND date_start >= ? AND date_start <= ?
      `).get(isAllAcc, accountId, dataSource, ad.adId, midDateStr, dateRange.endDate);

      if (firstHalf && secondHalf && firstHalf.imp >= 1000 && secondHalf.imp >= 1000) {
        const ctr1 = (firstHalf.lc / firstHalf.imp) * 100;
        const ctr2 = (secondHalf.lc / secondHalf.imp) * 100;
        const cpl1 = firstHalf.leads > 0 ? firstHalf.spend / firstHalf.leads : null;
        const cpl2 = secondHalf.leads > 0 ? secondHalf.spend / secondHalf.leads : null;

        const ctrDropPercent = ctr1 > 0 ? ((ctr1 - ctr2) / ctr1) * 100 : 0;
        const cplRisePercent = (cpl1 && cpl2 && cpl1 > 0) ? ((cpl2 - cpl1) / cpl1) * 100 : 0;

        if (ctrDropPercent >= 25 && (cplRisePercent >= 25 || (firstHalf.leads >= 3 && secondHalf.leads === 0))) {
          items.push({
            id: `fatigue_${ad.adId}`,
            category: 'Possible Creative Fatigue Trend',
            severity: 'medium',
            entityType: 'Ad',
            entityName: `${ad.name} (Campaign: ${ad.campaignName})`,
            reportingPeriod: periodLabel,
            dataSufficiency: 'Sufficient multi-day trend data',
            hasEnoughData: true,
            observedFacts: `First half (${dateRange.startDate} to ${midDateStr}): Link CTR ${ctr1.toFixed(2)}%${cpl1 ? `, CPL ${currency} ${cpl1.toFixed(2)}` : ''}. Second half (${midDateStr} to ${dateRange.endDate}): Link CTR dropped to ${ctr2.toFixed(2)}% (-${ctrDropPercent.toFixed(0)}%)${cpl2 ? `, CPL rose to ${currency} ${cpl2.toFixed(2)} (+${cplRisePercent.toFixed(0)}%)` : ', 0 leads'}.`,
            whyItDeservesAttention: 'Observed fact: Both click-through rate and lead efficiency declined in the second half of the selected period. Possible explanation: the same audience has seen this creative multiple times (creative fatigue), or auction competition shifted.',
            practicalNextStep: 'Prepare a fresh visual angle or video testimonial for this ad set while keeping your winning form and audience settings.'
          });
        }
      }
    }
  }

  return {
    targets,
    accountAvgLeadCpl,
    disclaimer: 'All items below are read-only analytical suggestions based on observed figures and your configurable targets. This dashboard never modifies, pauses, or edits your Meta advertisements.',
    items
  };
}

module.exports = {
  resolveDateRange,
  computeDerivedMetrics,
  resolveScopeReach,
  getDashboardOverview,
  buildFinancialClarity,
  buildCampaignPerformanceTable,
  buildAdPerformanceTable,
  buildLeadsAndReconciliation,
  buildWhatNeedsAttention
};
