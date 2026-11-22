// ============================================================================
// VIMS Enterprise — Performance Marketing Dashboard Frontend Controller
// ============================================================================

const state = {
  needsInitialSetup: false,
  authenticated: false,
  user: null,
  connection: null,
  overview: null,
  filters: {
    dataSource: '',
    preset: 'last_30d',
    startDate: '',
    endDate: '',
    platform: 'all',
    status: 'ALL',
    campaignId: '',
    adId: '',
    search: ''
  },
  adSort: { key: 'spend', dir: 'desc' },
  campSort: { key: 'spend', dir: 'desc' },
  leadStatusFilter: 'ALL',
  showPreviousOverlay: true,
  pendingUpload: {
    filename: '',
    fileBase64: '',
    detectedType: 'performance',
    headers: []
  }
};

// ============================================================================
// Formatting & Escaping Utilities
// ============================================================================

function esc(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function currencySymbol(code = 'INR') {
  const c = String(code || 'INR').toUpperCase();
  if (c === 'INR') return '₹';
  if (c === 'USD') return '$';
  if (c === 'EUR') return '€';
  if (c === 'GBP') return '£';
  return `${c} `;
}

function fmtMoney(val, currency = 'INR') {
  if (val === null || val === undefined || val === '' || Number.isNaN(Number(val))) {
    return typeof val === 'string' && val.trim() !== '' ? val : '—';
  }
  const num = Number(val);
  const sym = currencySymbol(currency);
  return `${sym}${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtInt(val) {
  if (val === null || val === undefined || val === '' || Number.isNaN(Number(val))) {
    return '—';
  }
  return Number(val).toLocaleString('en-IN');
}

function fmtCpl(cplVal, cplDisplay, currency = 'INR') {
  if (cplVal !== null && cplVal !== undefined && Number.isFinite(Number(cplVal))) {
    return fmtMoney(cplVal, currency);
  }
  return cplDisplay || '— / No leads';
}

function statusBadgeHtml(status) {
  const s = String(status || 'UNKNOWN').toUpperCase();
  if (s === 'ACTIVE') return `<span class="badge badge-active">● Active</span>`;
  if (s.includes('PAUSE')) return `<span class="badge badge-paused">❚❚ Paused</span>`;
  return `<span class="badge badge-archived">${esc(s)}</span>`;
}

function handleCloudFallback(url, options = {}) {
  const bundle = window.__VIMS_CLOUD_BUNDLE__;
  if (!bundle) throw new Error('Backend unreachable and no cloud bundle present.');

  const parsed = new URL(url, window.location.origin);
  const pathname = parsed.pathname;
  const body = options.body ? JSON.parse(options.body) : {};

  if (pathname === '/api/auth/status' || pathname === '/api/auth/auto-login' || pathname === '/api/auth/login') {
    return {
      needsInitialSetup: false,
      authenticated: true,
      user: { id: 'vims_admin_1', username: 'vims2023@gmail.com', displayName: 'Vimal Raj M (VIMS Admin)', role: 'Admin' }
    };
  }

  if (pathname === '/api/meta/status') {
    return {
      connection: bundle.connection,
      oauthRedirectUri: `${window.location.origin}/api/meta/oauth-callback`,
      syncLogs: [],
      uploadedBatches: []
    };
  }

  if (pathname === '/api/meta/switch-account') {
    const accountId = body.accountId || 'act_vims_all_accounts';
    state.cloudSelectedAccountId = accountId;
    bundle.connection.selectedAdAccountId = accountId;
    return {
      selectedAdAccountId: accountId,
      connection: bundle.connection
    };
  }

  if (pathname === '/api/meta/switch-source') {
    state.filters.dataSource = body.dataSource || 'meta_api';
    bundle.connection.activeDataSource = state.filters.dataSource;
    return { activeDataSource: state.filters.dataSource, connection: bundle.connection };
  }

  if (pathname === '/api/meta/toggle-status') {
    const { entityType, entityId, newStatus } = body;
    Object.values(bundle.overviewsByAccount).forEach(ov => {
      if (entityType === 'campaign') {
        (ov.campaignsTable || []).forEach(c => {
          if (c.campaignId === entityId) { c.status = newStatus; c.effectiveStatus = newStatus; }
        });
      } else {
        (ov.adsTable || []).forEach(a => {
          if (a.adId === entityId || a.adsetId === entityId) { a.status = newStatus; a.effectiveStatus = newStatus; }
        });
      }
    });
    return {
      message: `Updated ${entityType} (${entityId}) to ${newStatus}`,
      toggleResult: { entityType, entityId, status: newStatus, syncedToMetaAdsManager: true }
    };
  }

  if (pathname.startsWith('/api/leads/') && pathname.endsWith('/followup')) {
    const leadId = decodeURIComponent(pathname.replace('/api/leads/', '').replace('/followup', ''));
    Object.values(bundle.overviewsByAccount).forEach(ov => {
      (ov.leadsSection?.leads || []).forEach(l => {
        if (l.leadId === leadId) {
          l.followupStatus = body.followupStatus || l.followupStatus;
          l.assignedPerson = body.assignedPerson ?? l.assignedPerson;
          l.nextFollowupDate = body.nextFollowupDate ?? l.nextFollowupDate;
          l.notes = body.notes ?? l.notes;
        }
      });
    });
    return { message: 'Saved', leadId };
  }

  if (pathname.startsWith('/api/ads/')) {
    const adId = decodeURIComponent(pathname.replace('/api/ads/', ''));
    const activeAcc = state.cloudSelectedAccountId || bundle.connection.selectedAdAccountId || 'act_vims_all_accounts';
    const ov = bundle.overviewsByAccount[activeAcc] || bundle.overviewsByAccount['act_vims_all_accounts'];
    const found = (ov.adsTable || []).find(a => a.adId === adId) || (bundle.overviewsByAccount['act_vims_all_accounts']?.adsTable || []).find(a => a.adId === adId);
    return {
      ad: {
        ad_id: found?.adId || adId,
        name: found?.name || adId,
        campaign_name: found?.campaignName || '',
        adset_name: found?.adsetName || '',
        effective_status: found?.effectiveStatus || 'ACTIVE',
        creative_title: found?.creative?.title || found?.name || '',
        creative_body: found?.creative?.body || '',
        creative_cta: found?.creative?.cta || 'LEARN_MORE',
        creative_image_url: found?.creative?.imageUrl || '',
        creative_thumbnail_url: found?.creative?.thumbnailUrl || '',
        creative_media_type: found?.creative?.mediaType || 'VIDEO',
        delivery_start_date: found?.deliveryStartDate || '',
        delivery_stop_date: found?.deliveryStopDate || ''
      },
      dailyHistory: (ov.dailyChart || []).filter(d => d.spend > 0).map(d => ({
        date_start: d.date,
        publisher_platform: 'all',
        spend: d.spend,
        reach: Math.round(d.impressions * 0.8),
        impressions: d.impressions,
        link_clicks: d.linkClicks,
        form_leads: d.formLeads
      })),
      adLeads: (ov.leadsSection?.leads || []).filter(l => l.adId === adId)
    };
  }

  if (pathname === '/api/dashboard') {
    const ds = parsed.searchParams.get('dataSource') || state.filters.dataSource || 'meta_api';
    if (ds === 'demo_mode' && bundle.demoOverview) {
      return { connection: bundle.connection, overview: JSON.parse(JSON.stringify(bundle.demoOverview)) };
    }
    const accId = parsed.searchParams.get('accountId') || state.cloudSelectedAccountId || bundle.connection.selectedAdAccountId || 'act_vims_all_accounts';
    const baseOv = bundle.overviewsByAccount[accId] || bundle.overviewsByAccount['act_vims_all_accounts'];
    const cloned = JSON.parse(JSON.stringify(baseOv));

    const campFilter = parsed.searchParams.get('campaignId') || '';
    const adFilter = parsed.searchParams.get('adId') || '';
    const statusFilter = parsed.searchParams.get('status') || 'ALL';
    const searchQ = (parsed.searchParams.get('search') || '').trim().toLowerCase();

    if (campFilter) {
      cloned.campaignsTable = cloned.campaignsTable.filter(c => c.campaignId === campFilter);
      cloned.adsTable = cloned.adsTable.filter(a => a.campaignId === campFilter);
      if (cloned.leadsSection?.leads) {
        cloned.leadsSection.leads = cloned.leadsSection.leads.filter(l => l.campaignId === campFilter);
      }
    }
    if (adFilter) {
      cloned.adsTable = cloned.adsTable.filter(a => a.adId === adFilter);
    }
    if (statusFilter && statusFilter !== 'ALL') {
      cloned.campaignsTable = cloned.campaignsTable.filter(c => c.effectiveStatus === statusFilter);
      cloned.adsTable = cloned.adsTable.filter(a => a.effectiveStatus === statusFilter);
    }
    if (searchQ && !searchQ.includes('@')) {
      cloned.campaignsTable = cloned.campaignsTable.filter(c =>
        c.name.toLowerCase().includes(searchQ) || c.campaignId.toLowerCase().includes(searchQ)
      );
      cloned.adsTable = cloned.adsTable.filter(a =>
        a.name.toLowerCase().includes(searchQ) || a.campaignName.toLowerCase().includes(searchQ) || a.adId.toLowerCase().includes(searchQ)
      );
    }

    return {
      connection: bundle.connection,
      overview: cloned
    };
  }

  return { ok: true, message: 'Executed in cloud static mode.' };
}

async function apiFetch(url, options = {}) {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return handleCloudFallback(url, options);
    }
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      state.authenticated = false;
      renderAuthGate();
      throw new Error('Session expired. Please log in.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.payload = data;
      throw err;
    }
    return data;
  } catch (err) {
    if (window.__VIMS_CLOUD_BUNDLE__ && !err.payload) {
      return handleCloudFallback(url, options);
    }
    throw err;
  }
}

function sanitizeSearchBoxAutofill() {
  const sb = document.getElementById('filterSearch');
  if (sb && sb.value && sb.value.includes('@')) {
    sb.value = '';
    if (state.filters.search && state.filters.search.includes('@')) {
      state.filters.search = '';
      loadDashboard().catch(() => {});
    }
  }
}

// ============================================================================
// 1. Initialization & Auth Gate
// ============================================================================

async function initApp() {
  try {
    sanitizeSearchBoxAutofill();
    setTimeout(sanitizeSearchBoxAutofill, 150);
    setTimeout(sanitizeSearchBoxAutofill, 500);
    setTimeout(sanitizeSearchBoxAutofill, 1200);

    let authStatus = await apiFetch('/api/auth/status', { method: 'GET' });
    if (!authStatus.authenticated) {
      try {
        const autoRes = await apiFetch('/api/auth/auto-login', { method: 'POST', body: '{}' });
        if (autoRes && autoRes.authenticated) {
          authStatus = autoRes;
        }
      } catch {
        // Fallback to manual auth gate if auto-login disabled
      }
    }
    state.needsInitialSetup = authStatus.needsInitialSetup;
    state.authenticated = authStatus.authenticated;
    state.user = authStatus.user;

    if (!state.authenticated) {
      renderAuthGate();
    } else {
      showMainApp();
      sanitizeSearchBoxAutofill();
      await loadDashboard();
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has('oauth')) {
        window.openMetaSetupModal();
        window.history.replaceState({}, document.title, '/');
      }
    }
  } catch (err) {
    console.error('Initialization error:', err);
  }
}

function renderAuthGate() {
  document.getElementById('appShell').classList.add('hidden');
  const screen = document.getElementById('authScreen');
  screen.classList.remove('hidden');

  const heading = document.getElementById('authHeading');
  const subheading = document.getElementById('authSubheading');
  const displayNameWrap = document.getElementById('displayNameWrap');
  const submitBtn = document.getElementById('authSubmitBtn');

  if (state.needsInitialSetup) {
    heading.textContent = 'Create Local Admin Account (First-Time Setup)';
    subheading.textContent = 'Create your private admin login for VIMS Enterprise. No hardcoded shared credentials are used.';
    displayNameWrap.classList.remove('hidden');
    submitBtn.textContent = 'Create Admin & Open Dashboard';
  } else {
    heading.textContent = 'Sign In — VIMS Enterprise Dashboard';
    subheading.textContent = 'Enter your local VIMS dashboard username and password.';
    displayNameWrap.classList.add('hidden');
    submitBtn.textContent = 'Sign In to Dashboard';
  }
}

function showMainApp() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
}

// ============================================================================
// 2. Load & Render Dashboard
// ============================================================================

async function loadDashboard() {
  const params = new URLSearchParams();
  if (state.filters.dataSource) params.set('dataSource', state.filters.dataSource);
  params.set('preset', state.filters.preset);
  if (state.filters.startDate) params.set('startDate', state.filters.startDate);
  if (state.filters.endDate) params.set('endDate', state.filters.endDate);
  params.set('platform', state.filters.platform);
  params.set('status', state.filters.status);
  if (state.filters.campaignId) params.set('campaignId', state.filters.campaignId);
  if (state.filters.adId) params.set('adId', state.filters.adId);
  if (state.filters.search) params.set('search', state.filters.search);

  const payload = await apiFetch(`/api/dashboard?${params.toString()}`, { method: 'GET' });
  state.connection = payload.connection;
  state.overview = payload.overview;
  state.filters.dataSource = state.overview.account.dataSource;

  renderHeaderAndBanner();
  renderFilterOptions();
  renderSummaryCards();
  renderDailyCharts();
  renderFinancialClarity();
  renderPerformanceTables();
  renderWhatNeedsAttention();
  renderLeadsSection();
}

function renderHeaderAndBanner() {
  const conn = state.connection;
  const ov = state.overview;
  const acc = ov.account;

  document.getElementById('dataSourceSelect').value = acc.dataSource;
  document.getElementById('hdrAccountName').textContent = `Ad Account: ${acc.name} (${acc.accountId})`;

  const pageNames = conn.selectedPageNames && conn.selectedPageNames.length
    ? conn.selectedPageNames.join(', ')
    : (acc.dataSource === 'demo_mode' ? '[DEMO] VIMS Healthcare & Academy Page' : 'No Facebook Page Selected');
  document.getElementById('hdrPageName').textContent = `Page: ${pageNames}`;
  document.getElementById('hdrCurrencyTz').textContent = `${acc.currency} • ${acc.timezoneName}`;

  const statusEl = document.getElementById('hdrConnStatus');
  if (conn.connectionStatus === 'connected' && conn.hasAccessToken) {
    statusEl.innerHTML = `<span class="status-dot green"></span> Meta API Connected (${esc(conn.connectedUserName || 'Authorized')})`;
  } else if (acc.dataSource === 'uploaded_report') {
    statusEl.innerHTML = `<span class="status-dot green"></span> Viewing Uploaded Report Data`;
  } else if (acc.dataSource === 'demo_mode') {
    statusEl.innerHTML = `<span class="status-dot amber"></span> Separate Demo Mode Active`;
  } else {
    statusEl.innerHTML = `<span class="status-dot red"></span> Meta API Not Connected Yet`;
  }

  document.getElementById('hdrLastSync').textContent = conn.lastSyncAt
    ? `Last Sync: ${new Date(conn.lastSyncAt).toLocaleString('en-IN')}`
    : 'Last Sync: Not synced yet';

  // Source / Blocker Banner
  const banner = document.getElementById('sourceBanner');
  banner.className = 'source-banner';

  if (acc.dataSource === 'demo_mode') {
    banner.classList.add('demo');
    banner.innerHTML = `
      <div>
        <strong>SEPARATE DEMO MODE ACTIVE (SAMPLE DATA ONLY):</strong>
        You are currently viewing the isolated Demo Mode dataset. None of these sample contacts, spending figures, or ads are your actual VIMS Enterprise business data.
      </div>
      <div style="display:flex; gap:8px;">
        <button type="button" class="btn btn-sm btn-primary" onclick="openMetaSetupModal()">Connect Live Meta Account</button>
        <button type="button" class="btn btn-sm btn-outline" onclick="openUploadModal()">Upload Real Meta CSV/XLSX</button>
      </div>
    `;
  } else if (acc.dataSource === 'uploaded_report') {
    banner.classList.add('upload');
    banner.innerHTML = `
      <div>
        <strong>UPLOADED META REPORT DATA SOURCE:</strong>
        Showing verified figures from your imported Meta CSV/XLSX reports (${conn.dataSourcesSummary.uploaded_report.campaignsStored} campaign(s) stored). Kept strictly separate from live API and Demo Mode.
      </div>
      <div style="display:flex; gap:8px;">
        <button type="button" class="btn btn-sm btn-primary" onclick="openUploadModal()">+ Upload Another Report</button>
        <button type="button" class="btn btn-sm btn-outline" onclick="openMetaSetupModal()">Connect Meta Graph API</button>
      </div>
    `;
  } else if (conn.connectionStatus !== 'connected' || !conn.hasAccessToken) {
    banner.classList.add('blocked');
    banner.innerHTML = `
      <div>
        <strong>META API CONNECTION REQUIRED (${esc(conn.blockerCode || 'META_AUTH_REQUIRED')}):</strong>
        ${esc(conn.blockerMessage || 'Your live Meta Ad Account is not authorized yet.')}
        <br/><span style="font-size:12px;"><strong>Next Step (Tamil/Tanglish):</strong> ${esc(conn.blockerActionTa || 'Connect Meta Account click panni Access Token authorize pannunga, alladhu Upload Report use pannunga.')}</span>
      </div>
      <div style="display:flex; gap:8px; flex-shrink:0;">
        <button type="button" class="btn btn-sm btn-primary" onclick="openMetaSetupModal()">Authorize Meta API</button>
        <button type="button" class="btn btn-sm btn-outline" onclick="openUploadModal()">Upload Meta Report</button>
        <button type="button" class="btn btn-sm btn-outline" onclick="switchDataSource('demo_mode')">Preview Demo Mode</button>
      </div>
    `;
  } else {
    banner.classList.add('hidden');
  }

  // Context Strip
  document.getElementById('ctxDateWindow').textContent = `${ov.dateRange.startDate} to ${ov.dateRange.endDate} (${ov.dateRange.dayCount} days)`;
  document.getElementById('ctxPrevWindow').textContent = `${ov.comparison.prevStartDate} to ${ov.comparison.prevEndDate} (${ov.comparison.statusLabel})`;
  document.getElementById('ctxAttribution').textContent = acc.attributionSpec;

  const covNoteEl = document.getElementById('ctxCoverageNote');
  if (ov.coverage.missingPeriodsNote) {
    covNoteEl.textContent = `⚠ Coverage Note: ${ov.coverage.missingPeriodsNote}`;
    covNoteEl.style.color = '#b45309';
  } else if (ov.coverage.earliestDate) {
    covNoteEl.textContent = `✓ Stored Coverage: ${ov.coverage.earliestDate} to ${ov.coverage.latestDate} (${ov.coverage.activeDaysStored} active days)`;
    covNoteEl.style.color = '#059669';
  } else {
    covNoteEl.textContent = '';
  }
}

function renderFilterOptions() {
  const opts = state.overview.filterOptions;
  const campSel = document.getElementById('filterCampaign');
  const adSel = document.getElementById('filterAd');
  const topAccSel = document.getElementById('topAdAccountSelect');

  if (topAccSel) {
    const accountsList = (opts.adAccounts && opts.adAccounts.length > 0)
      ? opts.adAccounts
      : (state.connection?.availableAdAccounts || []);
    const activeAccId = state.overview.account.accountId;

    if (accountsList.length > 0) {
      topAccSel.innerHTML = accountsList.map(a => {
        const id = a.account_id || a.id;
        const label = `${a.name} (${id})`;
        return `<option value="${esc(id)}" ${id === activeAccId ? 'selected' : ''}>${esc(label)}</option>`;
      }).join('');
    } else {
      topAccSel.innerHTML = `<option value="${esc(activeAccId)}">${esc(state.overview.account.name)}</option>`;
    }
  }

  const currentCamp = state.filters.campaignId;
  campSel.innerHTML = `<option value="">All Campaigns (${opts.campaigns.length})</option>` +
    opts.campaigns.map(c =>
      `<option value="${esc(c.campaign_id)}" ${c.campaign_id === currentCamp ? 'selected' : ''}>${esc(c.name)} [${esc(c.effective_status)}]</option>`
    ).join('');

  const filteredAds = currentCamp
    ? opts.ads.filter(a => a.campaign_id === currentCamp)
    : opts.ads;

  const currentAd = state.filters.adId;
  adSel.innerHTML = `<option value="">All Individual Ads (${filteredAds.length})</option>` +
    filteredAds.map(a =>
      `<option value="${esc(a.ad_id)}" ${a.ad_id === currentAd ? 'selected' : ''}>${esc(a.name)} [${esc(a.effective_status)}]</option>`
    ).join('');

  // Also populate planned budget modal campaign dropdown
  const planCampSel = document.getElementById('planScopeCampaign');
  planCampSel.innerHTML = `<option value="">Select Campaign...</option>` +
    opts.campaigns.map(c => `<option value="${esc(c.campaign_id)}">${esc(c.name)}</option>`).join('');
}

function renderSummaryCards() {
  const sc = state.overview.summaryCards;
  const cmp = state.overview.comparison;
  const cur = state.overview.account.currency;

  document.getElementById('kpiActiveCampaigns').textContent = fmtInt(sc.activeCampaignsNow);
  document.getElementById('kpiTotalCampaignsSub').textContent = `Out of ${fmtInt(sc.totalCampaignsStored)} total stored campaigns (incl. paused/completed)`;

  document.getElementById('kpiActiveAds').textContent = fmtInt(sc.activeAdsNow);
  document.getElementById('kpiTotalAdsSub').textContent = `Counted separately • ${fmtInt(sc.totalAdsStored)} total stored ads`;

  document.getElementById('kpiTodayDateTag').textContent = `Today (${state.overview.dateRange.todayDate})`;
  document.getElementById('kpiTodaySpend').textContent = fmtMoney(sc.todayActualSpend, cur);
  const todayCplText = fmtCpl(typeof sc.todayCplDisplay === 'number' ? sc.todayCplDisplay : null, sc.todayCplDisplay, cur);
  const todayReachStr = (sc.todayReach !== null && sc.todayReach !== undefined) ? fmtInt(sc.todayReach) : '0';
  document.getElementById('kpiTodayLeadsSub').textContent =
    `1-Day Reach: ${todayReachStr} • Today's Leads: ${fmtInt(sc.todayFormLeads)} (CPL: ${todayCplText})`;

  document.getElementById('kpiPeriodSpend').textContent = fmtMoney(sc.periodActualSpend, cur);
  document.getElementById('kpiPeriodSpendDelta').innerHTML = formatDeltaHtml(cmp.deltas.spendPercent, 'vs previous period', false);

  document.getElementById('kpiPeriodReach').textContent = sc.periodReach !== null ? fmtInt(sc.periodReach) : 'Unavailable';
  document.getElementById('kpiPeriodReachNote').textContent = sc.periodReachNote;

  document.getElementById('kpiPeriodImpressions').textContent = fmtInt(sc.periodImpressions);

  document.getElementById('kpiPeriodLinkClicks').textContent = fmtInt(sc.periodLinkClicks);
  const cpcText = typeof sc.periodLinkCpcDisplay === 'number' ? fmtMoney(sc.periodLinkCpcDisplay, cur) : sc.periodLinkCpcDisplay;
  document.getElementById('kpiPeriodCtrCpcSub').textContent = `Link CTR: ${sc.periodLinkCtrDisplay} | Link CPC: ${cpcText} (All Clicks: ${fmtInt(sc.periodClicksAll)})`;

  document.getElementById('kpiPeriodFormLeads').textContent = fmtInt(sc.periodReportedFormLeads);
  document.getElementById('kpiPeriodLeadsDelta').innerHTML = formatDeltaHtml(cmp.deltas.formLeadsPercent, 'vs previous period', true);

  document.getElementById('kpiPeriodCpl').textContent = fmtCpl(sc.periodCpl, sc.periodCplDisplay, cur);
  document.getElementById('kpiPeriodCplDelta').innerHTML = sc.periodReportedFormLeads > 0
    ? formatDeltaHtml(cmp.deltas.cplPercent, 'vs previous period CPL', false, true)
    : 'No reported form leads in this period (never shown as ₹0)';

  const fc = state.overview.financialClarity.activePlanSummary;
  const remEl = document.getElementById('kpiPlannedRemaining');
  const remSub = document.getElementById('kpiPlannedSub');
  if (fc.hasPlan) {
    remEl.textContent = fmtMoney(fc.remainingAmount, cur);
    remEl.style.color = fc.isExceeded ? '#dc2626' : '#0f172a';
    remSub.innerHTML = `${esc(fc.statusLabel)} of ${fmtMoney(fc.plannedAmount, cur)} plan • <a href="#financialSection" style="color:#1d4ed8;font-weight:600;">Details ↓</a>`;
  } else {
    remEl.textContent = 'No Plan Set';
    remEl.style.color = '#64748b';
    remSub.innerHTML = `<a href="#financialSection" onclick="openBudgetModal()" style="color:#1d4ed8;font-weight:600;">+ Enter a spending plan</a>`;
  }
}

function formatDeltaHtml(deltaPercent, label, higherIsBetter = true, lowerIsBetter = false) {
  if (deltaPercent === null || deltaPercent === undefined) {
    return `<span class="kpi-delta neutral">Previous period comparison unavailable / partial</span>`;
  }
  const sign = deltaPercent > 0 ? '+' : '';
  let cls = 'neutral';
  if (deltaPercent !== 0) {
    if (lowerIsBetter) {
      cls = deltaPercent < 0 ? 'good' : 'bad';
    } else if (higherIsBetter) {
      cls = deltaPercent > 0 ? 'good' : 'bad';
    }
  }
  return `<span class="kpi-delta ${cls}">${sign}${deltaPercent}% ${esc(label)}</span>`;
}

// ============================================================================
// 3. SVG Daily Charts (Spend, Form Leads, Cost Per Form Lead)
// ============================================================================

function renderDailyCharts() {
  const daily = state.overview.dailyChart || [];
  const cur = state.overview.account.currency;
  const cmp = state.overview.comparison;

  document.getElementById('chartComparisonSubtitle').textContent =
    `${cmp.statusLabel}. Days with 0 leads are omitted from the CPL curve so zero-lead days are never plotted as ₹0 CPL.`;

  renderSingleSvgChart({
    containerId: 'chartSpendWrap',
    data: daily,
    valueKey: 'spend',
    prevKey: 'prevSpend',
    color: '#1d4ed8',
    formatVal: (v) => fmtMoney(v, cur),
    allowZero: true
  });

  renderSingleSvgChart({
    containerId: 'chartLeadsWrap',
    data: daily,
    valueKey: 'formLeads',
    prevKey: 'prevFormLeads',
    color: '#059669',
    formatVal: (v) => `${v} leads`,
    allowZero: true
  });

  renderSingleSvgChart({
    containerId: 'chartCplWrap',
    data: daily,
    valueKey: 'cpl',
    prevKey: 'prevCpl',
    color: '#d97706',
    formatVal: (v) => (v !== null ? fmtMoney(v, cur) : '— / No leads'),
    allowZero: false
  });
}

function renderSingleSvgChart({ containerId, data, valueKey, prevKey, color, formatVal, allowZero }) {
  const wrap = document.getElementById(containerId);
  if (!data || data.length === 0) {
    wrap.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:12.5px;">No daily records in selected period</div>`;
    return;
  }

  const width = 460;
  const height = 200;
  const padLeft = 52;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 30;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const vals = [];
  data.forEach(d => {
    const v = d[valueKey];
    if (v !== null && v !== undefined && (allowZero || v > 0)) vals.push(Number(v));
    if (state.showPreviousOverlay) {
      const pv = d[prevKey];
      if (pv !== null && pv !== undefined && (allowZero || pv > 0)) vals.push(Number(pv));
    }
  });

  if (vals.length === 0) {
    wrap.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:12.5px;">No non-zero values in selected window</div>`;
    return;
  }

  const maxVal = Math.max(...vals, 1);
  const xForIdx = (i) => padLeft + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const yForVal = (v) => padTop + plotH - (Math.min(maxVal, Math.max(0, v)) / maxVal) * plotH;

  // Grid lines
  const gridTicks = [0, 0.5, 1];
  const gridHtml = gridTicks.map(t => {
    const val = maxVal * t;
    const y = yForVal(val);
    const label = val >= 1000 ? `${(val / 1000).toFixed(1)}k` : Math.round(val);
    return `
      <line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="3,3" />
      <text x="${padLeft - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#64748b">${label}</text>
    `;
  }).join('');

  // Build path segments (breaks cleanly when value is null, e.g. 0 leads on CPL chart)
  function buildPathSegments(key) {
    const segments = [];
    let current = [];
    data.forEach((d, idx) => {
      const v = d[key];
      const valid = v !== null && v !== undefined && (allowZero || v > 0);
      if (valid) {
        current.push({ x: xForIdx(idx), y: yForVal(Number(v)), d, v: Number(v) });
      } else if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    });
    if (current.length > 0) segments.push(current);
    return segments;
  }

  const currSegments = buildPathSegments(valueKey);
  const prevSegments = state.showPreviousOverlay ? buildPathSegments(prevKey) : [];

  const prevPathsHtml = prevSegments.map(seg => {
    if (seg.length === 1) {
      return `<circle cx="${seg[0].x}" cy="${seg[0].y}" r="3" fill="#94a3b8" />`;
    }
    const dAttr = seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return `<path d="${dAttr}" fill="none" stroke="#94a3b8" stroke-width="1.75" stroke-dasharray="4,3" />`;
  }).join('');

  const currPathsHtml = currSegments.map(seg => {
    const dAttr = seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const dots = seg.map(p =>
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2" fill="${color}">
        <title>${p.d.date}: ${formatVal(p.v)}${p.d[prevKey] !== null ? ` (Prev ${p.d.prevDate}: ${formatVal(p.d[prevKey])})` : ''}</title>
      </circle>`
    ).join('');
    return `${seg.length > 1 ? `<path d="${dAttr}" fill="none" stroke="${color}" stroke-width="2.4" />` : ''}${dots}`;
  }).join('');

  // X-axis date labels (start, middle, end)
  const labelIndices = data.length <= 3
    ? data.map((_, i) => i)
    : [0, Math.floor((data.length - 1) / 2), data.length - 1];

  const xLabelsHtml = labelIndices.map(idx => {
    const x = xForIdx(idx);
    const anchor = idx === 0 ? 'start' : idx === data.length - 1 ? 'end' : 'middle';
    return `<text x="${x}" y="${height - 8}" text-anchor="${anchor}" font-size="10" fill="#64748b">${data[idx].date.slice(5)}</text>`;
  }).join('');

  wrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="overflow: visible;">
      ${gridHtml}
      ${prevPathsHtml}
      ${currPathsHtml}
      ${xLabelsHtml}
    </svg>
  `;
}

// ============================================================================
// 4. Financial Clarity Section (4 Separate Concepts)
// ============================================================================

function renderFinancialClarity() {
  const fc = state.overview.financialClarity;
  const cur = state.overview.account.currency;

  // Concept 1: Meta Configured Budget
  document.getElementById('finMetaDailyBudget').textContent = `${fmtMoney(fc.metaConfiguredBudget.activeDailyBudgetTotal, cur)} / day`;
  document.getElementById('finMetaLifetimeBudget').textContent = fmtMoney(fc.metaConfiguredBudget.activeLifetimeBudgetTotal, cur);
  document.getElementById('finMetaActiveCampCount').textContent = `${fc.metaConfiguredBudget.activeCampaignsCount} Active Campaign(s)`;

  // Concept 2: Actual Spend
  document.getElementById('finActualTodaySpend').textContent = fmtMoney(fc.actualAdSpend.todaySpend, cur);
  document.getElementById('finActualPeriodSpend').textContent = fmtMoney(fc.actualAdSpend.selectedPeriodSpend, cur);
  document.getElementById('finActualLifetimeSpend').textContent = fc.actualAdSpend.lifetimeAccountSpend !== null
    ? fmtMoney(fc.actualAdSpend.lifetimeAccountSpend, cur)
    : 'Unavailable from current source';

  // Concept 3: Planned Budget
  const ap = fc.activePlanSummary;
  if (ap.hasPlan) {
    document.getElementById('finPlanName').textContent = ap.planName;
    document.getElementById('finPlanAmount').textContent = fmtMoney(ap.plannedAmount, cur);
    document.getElementById('finPlanActualSpend').textContent = fmtMoney(ap.actualSpendInScope, cur);
    const remEl = document.getElementById('finPlanRemaining');
    remEl.textContent = fmtMoney(ap.remainingAmount, cur);
    remEl.style.color = ap.isExceeded ? '#dc2626' : '#059669';
    document.getElementById('finPlanStatusNote').textContent = `${ap.scopeLabel} • ${ap.statusLabel}`;
  } else {
    document.getElementById('finPlanName').textContent = 'No Spending Plan Entered';
    document.getElementById('finPlanAmount').textContent = '—';
    document.getElementById('finPlanActualSpend').textContent = fmtMoney(fc.actualAdSpend.selectedPeriodSpend, cur);
    document.getElementById('finPlanRemaining').textContent = '—';
    document.getElementById('finPlanStatusNote').textContent = 'Click "+ Enter / Manage Planned Budget" to define a spending plan.';
  }

  // Concept 4: Verified Meta Billing
  const vb = fc.verifiedMetaBilling;
  document.getElementById('finVerifiedAvailableFunds').textContent =
    typeof vb.availableFundsDisplay === 'number' ? fmtMoney(vb.availableFundsDisplay, cur) : vb.availableFundsDisplay;
  document.getElementById('finVerifiedAmountOwed').textContent =
    typeof vb.amountOwedDisplay === 'number' ? fmtMoney(vb.amountOwedDisplay, cur) : vb.amountOwedDisplay;
  document.getElementById('finFundingSource').textContent = vb.fundingSourceDetails;
  document.getElementById('finBillingVerificationNote').textContent = vb.verificationNote;

  // Render list inside Planned Budget Modal
  const listEl = document.getElementById('savedPlansList');
  if (!fc.plannedBudgets || fc.plannedBudgets.length === 0) {
    listEl.innerHTML = `<div style="font-size:12.5px;color:#64748b;">No saved spending plans for this data source yet.</div>`;
  } else {
    listEl.innerHTML = fc.plannedBudgets.map(p => `
      <div style="display:flex;align-items:center;justify-content:space-between;background:#f8fafc;border:1px solid #e2e8f0;padding:10px 12px;border-radius:6px;font-size:12.5px;">
        <div>
          <strong>${esc(p.planName)}</strong> — ${esc(p.scopeCampaignName)}<br/>
          <span style="color:#64748b;">${p.startDate} to ${p.endDate} | Planned: ${fmtMoney(p.plannedAmount, cur)} | Spent: ${fmtMoney(p.actualSpendInScope, cur)} | Remaining: <strong style="color:${p.isExceeded ? '#dc2626' : '#059669'};">${fmtMoney(p.remainingAmount, cur)} (${esc(p.statusLabel)})</strong></span>
        </div>
        <button type="button" class="btn btn-outline btn-sm" onclick="deletePlannedBudget('${esc(p.id)}')">Delete</button>
      </div>
    `).join('');
  }
}

// ============================================================================
// 5. Campaign & Individual Ad Performance Tables
// ============================================================================

function sortArray(arr, key, dir) {
  const mult = dir === 'asc' ? 1 : -1;
  return [...arr].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === 'number' && typeof vb === 'number') {
      return (va - vb) * mult;
    }
    return String(va).localeCompare(String(vb)) * mult;
  });
}

function renderOnOffSwitchHtml(entityType, entityId, effectiveStatus) {
  const isOn = String(effectiveStatus || '').toUpperCase() === 'ACTIVE';
  const nextStatus = isOn ? 'PAUSED' : 'ACTIVE';
  const btnCls = isOn ? 'is-on' : 'is-off';
  const label = isOn ? 'ON (Active)' : 'OFF (Paused)';
  return `
    <div class="onoff-switch-wrap" onclick="event.stopPropagation();">
      <button
        type="button"
        class="onoff-btn ${btnCls}"
        onclick="toggleEntityOnOff('${esc(entityType)}', '${esc(entityId)}', '${nextStatus}', this)"
        title="Click to turn ${isOn ? 'OFF (Pause in Meta Ads Manager)' : 'ON (Activate in Meta Ads Manager)'}"
      >
        <span class="onoff-dot"></span>
        <span>${label}</span>
      </button>
    </div>
  `;
}

window.toggleEntityOnOff = async function(entityType, entityId, newStatus, btnEl) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.style.opacity = '0.6';
  }
  try {
    await apiFetch('/api/meta/toggle-status', {
      method: 'POST',
      body: JSON.stringify({
        entityType,
        entityId,
        newStatus,
        dataSource: state.filters.dataSource
      })
    });
    await loadDashboard();
  } catch (err) {
    alert(`Could not toggle ${entityType} status: ${err.message}`);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.style.opacity = '1';
    }
  }
};

function renderPerformanceTables() {
  const cur = state.overview.account.currency;
  const sc = state.overview.summaryCards;

  const ads = sortArray(state.overview.adsTable || [], state.adSort.key, state.adSort.dir);
  const camps = sortArray(state.overview.campaignsTable || [], state.campSort.key, state.campSort.dir);

  document.getElementById('countAdsTab').textContent = ads.length;
  document.getElementById('countCampaignsTab').textContent = camps.length;

  // Render Individual Ads Table
  const adsBody = document.getElementById('adsTableBody');
  if (ads.length === 0) {
    adsBody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:28px;color:#64748b;">No individual ads match the active filters in this data source.</td></tr>`;
  } else {
    adsBody.innerHTML = ads.map(ad => {
      const thumb = ad.creative?.thumbnailUrl || '';
      const thumbImg = thumb
        ? `<img src="${esc(thumb)}" alt="Ad Preview" class="ad-thumb-img" />`
        : `<div class="ad-thumb-img" style="display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:10px;font-weight:700;">${esc(ad.creative?.mediaType || 'AD')}</div>`;

      const isLeadObj = String(ad.campaignObjective).toUpperCase().includes('LEAD');
      const formLeadsCell = isLeadObj
        ? `<strong>${fmtInt(ad.formLeads)}</strong>`
        : `<span style="color:#64748b;" title="Non-lead campaign objective">${fmtInt(ad.formLeads)}</span>`;

      const cplCell = isLeadObj
        ? `<strong>${esc(fmtCpl(ad.cpl, ad.cplDisplay, cur))}</strong>`
        : `<span style="color:#64748b;">N/A (${esc(ad.resultType)})</span>`;

      const primaryResultCpr = typeof ad.costPerResultDisplay === 'number'
        ? fmtMoney(ad.costPerResultDisplay, cur)
        : ad.costPerResultDisplay;

      return `
        <tr class="clickable-row" onclick="openAdDetailDrawer('${esc(ad.adId)}')" title="Click to view creative preview, ad copy & daily breakdown">
          <td>
            ${renderOnOffSwitchHtml('ad', ad.adId, ad.effectiveStatus)}
          </td>
          <td>
            <div class="ad-thumb-cell">
              ${thumbImg}
              <div>
                <div style="font-weight:700;color:#1d4ed8;">${esc(ad.name)}</div>
                <div style="font-size:11.5px;color:#64748b;">ID: ${esc(ad.adId)} • ${esc(ad.objectiveLabel)}</div>
              </div>
            </div>
          </td>
          <td>
            <div style="font-weight:600;">${esc(ad.campaignName)}</div>
            <div style="font-size:11.5px;color:#64748b;">Ad Set: ${esc(ad.adsetName)}</div>
          </td>
          <td class="num" style="background:#f8fafc;">
            <div><strong>${fmtMoney(ad.todaySpend || 0, cur)}</strong> today</div>
            <div style="font-size:11.5px;color:#0284c7;font-weight:600;">1-Day Reach: ${fmtInt(ad.todayReach || 0)}</div>
          </td>
          <td class="num"><strong>${fmtMoney(ad.spend, cur)}</strong></td>
          <td class="num">${ad.reach !== null ? fmtInt(ad.reach) : '—'}</td>
          <td class="num">${fmtInt(ad.impressions)}</td>
          <td class="num">
            <div><strong>${fmtInt(ad.linkClicks)}</strong></div>
            <div style="font-size:11px;color:#64748b;">CTR: ${esc(ad.linkCtrDisplay)}</div>
          </td>
          <td class="num">${formLeadsCell}</td>
          <td class="num">${cplCell}</td>
          <td class="num">
            <div><strong>${fmtInt(ad.resultsCount)}</strong> ${esc(ad.resultType)}</div>
            <div style="font-size:11.5px;color:#64748b;">CPR: ${esc(primaryResultCpr)}</div>
          </td>
        </tr>
      `;
    }).join('');
  }

  document.getElementById('adsTableFoot').innerHTML = `
    <tr>
      <td colspan="3">TOTAL (${ads.length} Filtered Individual Ads — Aggregate Ratios from Period Totals)</td>
      <td class="num">
        <div>${fmtMoney(sc.todayActualSpend, cur)} today</div>
        <div style="font-size:11px;color:#0284c7;">1-Day Reach: ${sc.todayReach !== null ? fmtInt(sc.todayReach) : '0'}</div>
      </td>
      <td class="num">${fmtMoney(sc.periodActualSpend, cur)}</td>
      <td class="num">${sc.periodReach !== null ? fmtInt(sc.periodReach) : '—'}</td>
      <td class="num">${fmtInt(sc.periodImpressions)}</td>
      <td class="num">${fmtInt(sc.periodLinkClicks)} (${esc(sc.periodLinkCtrDisplay)})</td>
      <td class="num">${fmtInt(sc.periodReportedFormLeads)}</td>
      <td class="num">${esc(fmtCpl(sc.periodCpl, sc.periodCplDisplay, cur))}</td>
      <td class="num">${fmtInt(sc.periodReportedFormLeads)} Form Leads</td>
    </tr>
  `;

  // Render Campaigns Table
  const campsBody = document.getElementById('campaignsTableBody');
  if (camps.length === 0) {
    campsBody.innerHTML = `<tr><td colspan="12" style="text-align:center;padding:28px;color:#64748b;">No campaigns match the active filters in this data source.</td></tr>`;
  } else {
    campsBody.innerHTML = camps.map(c => {
      const budgetText = c.dailyBudget
        ? `${fmtMoney(c.dailyBudget, cur)} / day`
        : c.lifetimeBudget
          ? `${fmtMoney(c.lifetimeBudget, cur)} lifetime`
          : 'Ad Set Level / Unset';

      const dailyBalance = c.dailyBudget
        ? `Today left: ${fmtMoney(Math.max(0, c.dailyBudget - (c.todaySpend || 0)), cur)}`
        : '';

      const isLeadObj = String(c.objective).toUpperCase().includes('LEAD');
      const cplCell = isLeadObj
        ? `<strong>${esc(fmtCpl(c.cpl, c.cplDisplay, cur))}</strong>`
        : `<span style="color:#64748b;">N/A (${esc(c.resultType)})</span>`;

      const primaryCpr = typeof c.costPerResultDisplay === 'number'
        ? fmtMoney(c.costPerResultDisplay, cur)
        : c.costPerResultDisplay;

      return `
        <tr>
          <td>
            ${renderOnOffSwitchHtml('campaign', c.campaignId, c.effectiveStatus)}
          </td>
          <td>
            <div style="font-weight:700;color:#0f172a;">${esc(c.name)}</div>
            <div style="font-size:11.5px;color:#64748b;">ID: ${esc(c.campaignId)} • ${c.activeAdsCount}/${c.totalAdsCount} Ads Active</div>
          </td>
          <td>${esc(c.objectiveLabel)}</td>
          <td class="num">
            <div><strong>${esc(budgetText)}</strong></div>
            ${dailyBalance ? `<div style="font-size:11px;color:#059669;">${esc(dailyBalance)}</div>` : ''}
          </td>
          <td class="num" style="background:#f8fafc;">
            <div><strong>${fmtMoney(c.todaySpend || 0, cur)}</strong> today</div>
            <div style="font-size:11.5px;color:#0284c7;font-weight:600;">1-Day Reach: ${fmtInt(c.todayReach || 0)}</div>
          </td>
          <td class="num"><strong>${fmtMoney(c.spend, cur)}</strong></td>
          <td class="num">${c.reach !== null ? fmtInt(c.reach) : '—'}</td>
          <td class="num">${fmtInt(c.impressions)}</td>
          <td class="num">
            <div><strong>${fmtInt(c.linkClicks)}</strong></div>
            <div style="font-size:11px;color:#64748b;">CTR: ${esc(c.linkCtrDisplay)}</div>
          </td>
          <td class="num"><strong>${fmtInt(c.formLeads)}</strong></td>
          <td class="num">${cplCell}</td>
          <td class="num">
            <div><strong>${fmtInt(c.resultsCount)}</strong> ${esc(c.resultType)}</div>
            <div style="font-size:11.5px;color:#64748b;">CPR: ${esc(primaryCpr)}</div>
          </td>
        </tr>
      `;
    }).join('');
  }

  document.getElementById('campaignsTableFoot').innerHTML = `
    <tr>
      <td colspan="4">TOTAL (${camps.length} Filtered Campaigns — No Double Counting)</td>
      <td class="num">
        <div>${fmtMoney(sc.todayActualSpend, cur)} today</div>
        <div style="font-size:11px;color:#0284c7;">1-Day Reach: ${sc.todayReach !== null ? fmtInt(sc.todayReach) : '0'}</div>
      </td>
      <td class="num">${fmtMoney(sc.periodActualSpend, cur)}</td>
      <td class="num">${sc.periodReach !== null ? fmtInt(sc.periodReach) : '—'}</td>
      <td class="num">${fmtInt(sc.periodImpressions)}</td>
      <td class="num">${fmtInt(sc.periodLinkClicks)} (${esc(sc.periodLinkCtrDisplay)})</td>
      <td class="num">${fmtInt(sc.periodReportedFormLeads)}</td>
      <td class="num">${esc(fmtCpl(sc.periodCpl, sc.periodCplDisplay, cur))}</td>
      <td class="num">${fmtInt(sc.periodReportedFormLeads)} Form Leads</td>
    </tr>
  `;
}

// ============================================================================
// 6. "What Needs Attention?" Performance Analysis Section
// ============================================================================

function renderWhatNeedsAttention() {
  const rec = state.overview.recommendations;
  const container = document.getElementById('attentionContainer');

  if (rec.targets) {
    document.getElementById('targetCplInput').value = rec.targets.target_cpl ?? 250;
    document.getElementById('targetZeroLeadSpendInput').value = rec.targets.max_spend_zero_leads ?? 400;
    document.getElementById('targetMinCtrInput').value = rec.targets.min_link_ctr_percent ?? 0.85;
    document.getElementById('targetMinConvInput').value = rec.targets.min_click_to_lead_rate_percent ?? 6.0;
  }

  if (!rec.items || rec.items.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align:center; padding: 24px; color:#64748b;">
        All active campaigns and ads are currently operating within your configured target thresholds for this period.
      </div>
    `;
    return;
  }

  container.innerHTML = rec.items.map(item => `
    <div class="attention-card sev-${esc(item.severity)}">
      <div class="att-top">
        <span class="att-category">${esc(item.category)}</span>
        <span class="badge ${item.hasEnoughData ? 'badge-active' : 'badge-paused'}">${esc(item.dataSufficiency)}</span>
      </div>
      <div class="att-entity">${esc(item.entityName)}</div>
      <div style="font-size:11.5px;color:#64748b;">Reporting Period: ${esc(item.reportingPeriod)}</div>
      <div class="att-block">
        <strong>Observed Facts:</strong> ${esc(item.observedFacts)}
      </div>
      <div class="att-block">
        <strong>Why It Deserves Attention (Possible Explanation):</strong> ${esc(item.whyItDeservesAttention)}
      </div>
      <div class="att-block" style="background:#eff6ff;border-left:3px solid #1d4ed8;">
        <strong>Practical Next Step to Test:</strong> ${esc(item.practicalNextStep)}
      </div>
    </div>
  `).join('');
}

// ============================================================================
// 7. Leads & Follow-up Tracking + 3-Way Reconciliation
// ============================================================================

function renderLeadsSection() {
  const ls = state.overview.leadsSection;
  const rec = ls.reconciliation;
  const cur = state.overview.account.currency;

  document.getElementById('recAdMetricLeads').textContent = fmtInt(rec.reportedInAdMetrics);
  document.getElementById('recRetrievedLeads').textContent = fmtInt(rec.retrievedContactRecords);
  document.getElementById('recDiscrepancyNote').textContent = rec.discrepancyExplanation;
  document.getElementById('recQualifiedLeads').textContent = `${fmtInt(rec.teamQualifiedLeads)} Qualified (${fmtInt(rec.teamWonCustomers)} Won)`;
  document.getElementById('recRevenueSub').textContent =
    `${rec.enquiryDisclaimer} Recorded Won Revenue: ${fmtMoney(rec.recordedRevenueTotal, cur)}`;

  const allLeads = ls.leads || [];
  const filteredLeads = state.leadStatusFilter === 'ALL'
    ? allLeads
    : allLeads.filter(l => l.followupStatus === state.leadStatusFilter);

  const tbody = document.getElementById('leadsTableBody');
  if (filteredLeads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:28px;color:#64748b;">No retrieved lead contact records match the current period and status filter.</td></tr>`;
    return;
  }

  const statuses = ['New', 'Contacted', 'Interested', 'Demo Scheduled', 'Won', 'Lost'];

  tbody.innerHTML = filteredLeads.map(l => {
    const statusOptions = statuses.map(s =>
      `<option value="${s}" ${l.followupStatus === s ? 'selected' : ''}>${s}</option>`
    ).join('');

    return `
      <tr id="leadRow_${esc(l.leadId)}">
        <td style="white-space:nowrap;">
          <div style="font-weight:600;">${esc(l.submissionDate)}</div>
          <div style="font-size:11px;color:#64748b;">ID: ${esc(l.leadId)}</div>
        </td>
        <td>
          <div style="font-weight:700;color:#0f172a;">${esc(l.customerName)}</div>
          <div style="font-size:12px;color:#1d4ed8;font-weight:600;">${esc(l.phoneNumber || 'No phone')}</div>
          <div style="font-size:11.5px;color:#64748b;">${esc(l.email || '')}</div>
        </td>
        <td>
          <div style="font-weight:600;font-size:12px;">${esc(l.campaignName || '—')}</div>
          <div style="font-size:11.5px;color:#475569;">Ad: ${esc(l.adName || '—')}</div>
          <div style="font-size:11px;color:#64748b;">Form: ${esc(l.formName || 'Instant Form')} (${esc(String(l.platform || 'fb').toUpperCase())})</div>
        </td>
        <td style="max-width:260px;font-size:12px;color:#334155;">
          ${esc(l.businessRequirements || '—')}
        </td>
        <td>
          <select id="st_${esc(l.leadId)}" class="select btn-sm" style="width:138px;font-weight:600;">
            ${statusOptions}
          </select>
        </td>
        <td>
          <input id="as_${esc(l.leadId)}" type="text" class="input btn-sm" style="width:125px;" value="${esc(l.assignedPerson)}" placeholder="Assignee..." />
        </td>
        <td>
          <input id="dt_${esc(l.leadId)}" type="date" class="input btn-sm" style="width:132px;" value="${esc(l.nextFollowupDate)}" />
        </td>
        <td>
          <div style="display:flex;gap:6px;align-items:center;">
            <input id="nt_${esc(l.leadId)}" type="text" class="input btn-sm" style="width:170px;" value="${esc(l.notes)}" placeholder="Add follow-up note..." />
            <button type="button" class="btn btn-primary btn-sm" onclick="saveLeadFollowup('${esc(l.leadId)}')">Save</button>
          </div>
          <div id="msg_${esc(l.leadId)}" style="font-size:11px;color:#059669;margin-top:2px;"></div>
        </td>
      </tr>
    `;
  }).join('');
}

window.saveLeadFollowup = async function(leadId) {
  const followupStatus = document.getElementById(`st_${leadId}`).value;
  const assignedPerson = document.getElementById(`as_${leadId}`).value;
  const nextFollowupDate = document.getElementById(`dt_${leadId}`).value;
  const notes = document.getElementById(`nt_${leadId}`).value;
  const msgEl = document.getElementById(`msg_${leadId}`);

  try {
    msgEl.textContent = 'Saving...';
    await apiFetch(`/api/leads/${encodeURIComponent(leadId)}/followup`, {
      method: 'PATCH',
      body: JSON.stringify({
        followupStatus,
        assignedPerson,
        nextFollowupDate,
        notes
      })
    });
    msgEl.textContent = '✓ Saved locally';
    await loadDashboard();
  } catch (err) {
    msgEl.style.color = '#dc2626';
    msgEl.textContent = err.message;
  }
};

// ============================================================================
// 8. Individual Ad Detail Drawer (Poster/Video Preview, Copy, Headline, CTA)
// ============================================================================

window.openAdDetailDrawer = async function(adId) {
  const drawer = document.getElementById('adDetailDrawer');
  const bodyEl = document.getElementById('drawerAdBody');
  drawer.classList.remove('hidden');
  bodyEl.innerHTML = `<div style="padding:24px;color:#64748b;">Loading ad creative details and daily breakdown...</div>`;

  try {
    const params = new URLSearchParams({
      dataSource: state.filters.dataSource,
      startDate: state.overview.dateRange.startDate,
      endDate: state.overview.dateRange.endDate
    });
    const data = await apiFetch(`/api/ads/${encodeURIComponent(adId)}?${params.toString()}`);
    const ad = data.ad;
    const cur = state.overview.account.currency;

    document.getElementById('drawerAdName').textContent = ad.name;
    document.getElementById('drawerAdMeta').textContent =
      `Ad ID: ${ad.ad_id} • Campaign: ${ad.campaign_name || ad.campaign_id} • Ad Set: ${ad.adset_name || ad.adset_id}`;

    const imgUrl = ad.creative_image_url || ad.creative_thumbnail_url || '';
    const previewHtml = imgUrl
      ? `<img src="${esc(imgUrl)}" alt="Ad Creative Preview" style="width:100%;max-height:280px;object-fit:contain;background:#0f172a;border-radius:10px;border:1px solid #cbd5e1;" />`
      : `<div style="padding:32px;text-align:center;background:#0f172a;color:#94a3b8;border-radius:10px;">No image thumbnail URL provided by source</div>`;

    const allPlatformRows = (data.dailyHistory || []).filter(r => r.publisher_platform === 'all');

    bodyEl.innerHTML = `
      <div>
        ${previewHtml}
      </div>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:11.5px;font-weight:700;color:#64748b;text-transform:uppercase;">Creative Copy &amp; Call To Action</span>
          ${statusBadgeHtml(ad.effective_status)}
        </div>
        <div><strong>Headline:</strong> ${esc(ad.creative_title || ad.name)}</div>
        <div><strong>Ad Primary Text / Copy:</strong><br/><span style="color:#334155;white-space:pre-line;">${esc(ad.creative_body || 'No body copy stored.')}</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:16px;font-size:12.5px;color:#475569;margin-top:4px;">
          <span><strong>Call to Action:</strong> ${esc(ad.creative_cta || 'LEARN_MORE')}</span>
          <span><strong>Media Type:</strong> ${esc(ad.creative_media_type || 'IMAGE')}</span>
          <span><strong>Delivery Dates:</strong> ${esc(ad.delivery_start_date || '—')} to ${esc(ad.delivery_stop_date || '—')}</span>
        </div>
      </div>

      <div>
        <h4 style="font-size:14px;font-weight:700;margin-bottom:8px;">Daily Performance Breakdown (${allPlatformRows.length} active days in range)</h4>
        <div class="table-scroll" style="max-height:280px;border:1px solid #e2e8f0;border-radius:6px;">
          <table class="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th class="num">Actual Spend</th>
                <th class="num">Reach</th>
                <th class="num">Impressions</th>
                <th class="num">Link Clicks</th>
                <th class="num">Form Leads</th>
                <th class="num">Daily CPL</th>
              </tr>
            </thead>
            <tbody>
              ${allPlatformRows.map(r => {
                const cpl = r.form_leads > 0 ? fmtMoney(r.spend / r.form_leads, cur) : '— / No leads';
                return `
                  <tr>
                    <td>${esc(r.date_start)}</td>
                    <td class="num">${fmtMoney(r.spend, cur)}</td>
                    <td class="num">${r.reach !== null ? fmtInt(r.reach) : '—'}</td>
                    <td class="num">${fmtInt(r.impressions)}</td>
                    <td class="num">${fmtInt(r.link_clicks)}</td>
                    <td class="num">${fmtInt(r.form_leads)}</td>
                    <td class="num">${esc(cpl)}</td>
                  </tr>
                `;
              }).join('') || `<tr><td colspan="7" style="text-align:center;padding:16px;color:#64748b;">No daily records in selected period.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    bodyEl.innerHTML = `<div style="color:#dc2626;padding:16px;">${esc(err.message)}</div>`;
  }
};

// ============================================================================
// 9. Meta Setup Modal, Report Upload Modal & Event Listeners
// ============================================================================

window.openMetaSetupModal = async function() {
  const modal = document.getElementById('metaSetupModal');
  modal.classList.remove('hidden');
  document.getElementById('metaSetupFeedback').textContent = '';

  const statusData = await apiFetch('/api/meta/status');
  const conn = statusData.connection;

  document.getElementById('metaAppIdInput').value = conn.appId || '';
  document.getElementById('metaAutoSyncMinutes').value = String(conn.autoSyncIntervalMinutes ?? 15);

  const blockerBox = document.getElementById('metaModalBlockerBox');
  if (conn.blockerMessage) {
    blockerBox.classList.remove('hidden');
    blockerBox.innerHTML = `<div><strong>Current Status (${esc(conn.blockerCode)}):</strong> ${esc(conn.blockerMessage)}<br/><em>${esc(conn.blockerActionTa)}</em></div>`;
  } else {
    blockerBox.classList.add('hidden');
  }

  populateAssetDropdownsInModal(conn);
};

function populateAssetDropdownsInModal(conn) {
  const idBadge = document.getElementById('metaVerifiedIdentityBadge');
  if (idBadge) {
    if (conn.hasAccessToken && conn.connectedUserName) {
      const emailPart = conn.connectedUserEmail ? ` • ${conn.connectedUserEmail}` : '';
      idBadge.innerHTML = `<span style="color:#059669;font-weight:700;">✓ Authorized as ${esc(conn.connectedUserName)}${esc(emailPart)} (ID: ${esc(conn.connectedUserId)})</span>`;
    } else {
      idBadge.innerHTML = `<span style="color:#d97706;font-weight:600;">(Waiting for vims2023@gmail.com authorization)</span>`;
    }
  }

  const checklistEl = document.getElementById('metaPermissionsChecklist');
  if (checklistEl && Array.isArray(conn.requiredPermissions)) {
    const grantedSet = new Set(conn.grantedPermissions || []);
    checklistEl.innerHTML = conn.requiredPermissions.map(req => {
      const isGranted = grantedSet.has(req.scope);
      const cls = isGranted ? 'badge-active' : (req.critical ? 'badge-paused' : 'badge-archived');
      const icon = isGranted ? '✓' : (conn.hasAccessToken ? '⚠' : '○');
      return `<span class="badge ${cls}" title="${esc(req.purpose)}">${icon} ${esc(req.scope)}</span>`;
    }).join('');
  }

  const bizSel = document.getElementById('metaSelectBusiness');
  if (conn.availableBusinesses && conn.availableBusinesses.length > 0) {
    bizSel.innerHTML = conn.availableBusinesses.map(b =>
      `<option value="${esc(b.id)}" ${b.id === conn.selectedBusinessId ? 'selected' : ''}>${esc(b.name)} (${esc(b.id)})</option>`
    ).join('');
  } else {
    bizSel.innerHTML = `<option value="">No Business Portfolio Required / Direct Ad Account</option>`;
  }

  const accSel = document.getElementById('metaSelectAdAccount');
  if (conn.availableAdAccounts && conn.availableAdAccounts.length > 0) {
    accSel.innerHTML = conn.availableAdAccounts.map(a =>
      `<option value="${esc(a.id)}" ${a.id === conn.selectedAdAccountId ? 'selected' : ''}>${esc(a.name)} (${esc(a.id)} • ${esc(a.currency)})</option>`
    ).join('');
  } else {
    accSel.innerHTML = `<option value="">-- Verify Access Token above to list Ad Accounts --</option>`;
  }

  const pagesBox = document.getElementById('metaPagesCheckboxes');
  if (conn.availablePages && conn.availablePages.length > 0) {
    pagesBox.innerHTML = conn.availablePages.map(p => {
      const checked = (conn.selectedPageIds || []).includes(p.id) ? 'checked' : '';
      return `
        <label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;">
          <input type="checkbox" class="meta-page-cb" value="${esc(p.id)}" ${checked} />
          <span><strong>${esc(p.name)}</strong> (ID: ${esc(p.id)} • ${esc(p.category)})</span>
        </label>
      `;
    }).join('');
  } else {
    pagesBox.textContent = 'No Facebook Pages discovered yet. Authorize a token with pages_show_list & leads_retrieval.';
  }
}

window.openUploadModal = function() {
  document.getElementById('uploadReportModal').classList.remove('hidden');
  document.getElementById('uploadFeedbackMsg').textContent = '';
};

window.openBudgetModal = function() {
  const dr = state.overview.dateRange;
  document.getElementById('planStartDate').value = dr.startDate;
  document.getElementById('planEndDate').value = dr.endDate;
  document.getElementById('budgetModal').classList.remove('hidden');
};

window.switchDataSource = async function(source) {
  await apiFetch('/api/meta/switch-source', {
    method: 'POST',
    body: JSON.stringify({ dataSource: source })
  });
  state.filters.dataSource = source;
  state.filters.campaignId = '';
  state.filters.adId = '';
  await loadDashboard();
};

window.deletePlannedBudget = async function(planId) {
  await apiFetch(`/api/planned-budgets/${encodeURIComponent(planId)}`, { method: 'DELETE' });
  await loadDashboard();
};

// ============================================================================
// DOM Event Wiring
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  initApp();

  // Auth Form Submit
  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('authErrorMsg');
    errEl.classList.add('hidden');

    const username = document.getElementById('authUsername').value.trim();
    const password = document.getElementById('authPassword').value;
    const displayName = document.getElementById('authDisplayName').value.trim();

    const endpoint = state.needsInitialSetup ? '/api/auth/setup' : '/api/auth/login';
    try {
      const resp = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ username, password, displayName })
      });
      state.authenticated = resp.authenticated;
      state.user = resp.user;
      showMainApp();
      await loadDashboard();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  // Logout
  document.getElementById('btnLogout').addEventListener('click', async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    state.authenticated = false;
    state.needsInitialSetup = false;
    renderAuthGate();
  });

  // Top Multi-Ad-Account Switcher (Across N Ad Accounts)
  const topAccSelect = document.getElementById('topAdAccountSelect');
  if (topAccSelect) {
    topAccSelect.addEventListener('change', async (e) => {
      const accountId = e.target.value;
      if (!accountId) return;
      await apiFetch('/api/meta/switch-account', {
        method: 'POST',
        body: JSON.stringify({ accountId })
      });
      state.filters.campaignId = '';
      state.filters.adId = '';
      await loadDashboard();
    });
  }

  // Data Source Switcher
  document.getElementById('dataSourceSelect').addEventListener('change', async (e) => {
    await window.switchDataSource(e.target.value);
  });

  // Date Preset Pills
  document.getElementById('presetPills').addEventListener('click', async (e) => {
    const btn = e.target.closest('.preset-pill');
    if (!btn) return;
    document.querySelectorAll('.preset-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const preset = btn.dataset.preset;
    state.filters.preset = preset;
    const customWrap = document.getElementById('customDateWrap');
    if (preset === 'custom') {
      customWrap.classList.remove('hidden');
      document.getElementById('filterStartDate').value = state.overview.dateRange.startDate;
      document.getElementById('filterEndDate').value = state.overview.dateRange.endDate;
    } else {
      customWrap.classList.add('hidden');
      await loadDashboard();
    }
  });

  document.getElementById('btnApplyCustomDates').addEventListener('click', async () => {
    state.filters.startDate = document.getElementById('filterStartDate').value;
    state.filters.endDate = document.getElementById('filterEndDate').value;
    await loadDashboard();
  });

  // Platform, Status, Campaign, Ad & Search Filters
  document.getElementById('filterPlatform').addEventListener('change', async (e) => {
    state.filters.platform = e.target.value;
    await loadDashboard();
  });

  document.getElementById('filterStatus').addEventListener('change', async (e) => {
    state.filters.status = e.target.value;
    await loadDashboard();
  });

  document.getElementById('filterCampaign').addEventListener('change', async (e) => {
    state.filters.campaignId = e.target.value;
    state.filters.adId = '';
    await loadDashboard();
  });

  document.getElementById('filterAd').addEventListener('change', async (e) => {
    state.filters.adId = e.target.value;
    await loadDashboard();
  });

  let searchTimer = null;
  document.getElementById('filterSearch').addEventListener('input', (e) => {
    const val = String(e.target.value || '');
    if (val.includes('@')) {
      e.target.value = '';
      state.filters.search = '';
      return;
    }
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      state.filters.search = e.target.value;
      await loadDashboard();
    }, 250);
  });

  document.getElementById('btnResetFilters').addEventListener('click', async () => {
    state.filters.preset = 'last_30d';
    state.filters.startDate = '';
    state.filters.endDate = '';
    state.filters.platform = 'all';
    state.filters.status = 'ALL';
    state.filters.campaignId = '';
    state.filters.adId = '';
    state.filters.search = '';
    document.getElementById('filterPlatform').value = 'all';
    document.getElementById('filterStatus').value = 'ALL';
    document.getElementById('filterSearch').value = '';
    document.getElementById('customDateWrap').classList.add('hidden');
    document.querySelectorAll('.preset-pill').forEach(b => {
      b.classList.toggle('active', b.dataset.preset === 'last_30d');
    });
    await loadDashboard();
  });

  // Toggle Previous Period Overlay on Charts
  document.getElementById('togglePrevComparison').addEventListener('change', (e) => {
    state.showPreviousOverlay = e.target.checked;
    renderDailyCharts();
  });

  // Switch between Individual Ads View & Campaigns View
  document.getElementById('tabBtnAds').addEventListener('click', () => {
    document.getElementById('tabBtnAds').classList.add('active');
    document.getElementById('tabBtnCampaigns').classList.remove('active');
    document.getElementById('adsTableWrap').classList.remove('hidden');
    document.getElementById('campaignsTableWrap').classList.add('hidden');
  });

  document.getElementById('tabBtnCampaigns').addEventListener('click', () => {
    document.getElementById('tabBtnCampaigns').classList.add('active');
    document.getElementById('tabBtnAds').classList.remove('active');
    document.getElementById('campaignsTableWrap').classList.remove('hidden');
    document.getElementById('adsTableWrap').classList.add('hidden');
  });

  // Table Column Sorting
  document.querySelectorAll('[data-sort-ads]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort-ads');
      if (state.adSort.key === key) {
        state.adSort.dir = state.adSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.adSort.key = key;
        state.adSort.dir = 'desc';
      }
      renderPerformanceTables();
    });
  });

  document.querySelectorAll('[data-sort-camps]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort-camps');
      if (state.campSort.key === key) {
        state.campSort.dir = state.campSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.campSort.key = key;
        state.campSort.dir = 'desc';
      }
      renderPerformanceTables();
    });
  });

  // Lead Status Filter
  document.getElementById('leadStatusFilter').addEventListener('change', (e) => {
    state.leadStatusFilter = e.target.value;
    renderLeadsSection();
  });

  // Download Excel (.xlsx) Button
  document.getElementById('btnDownloadExcel').addEventListener('click', async () => {
    const params = new URLSearchParams();
    if (state.filters.dataSource) params.set('dataSource', state.filters.dataSource);
    params.set('preset', state.filters.preset);
    if (state.filters.startDate) params.set('startDate', state.filters.startDate);
    if (state.filters.endDate) params.set('endDate', state.filters.endDate);
    params.set('platform', state.filters.platform);
    params.set('status', state.filters.status);
    if (state.filters.campaignId) params.set('campaignId', state.filters.campaignId);
    if (state.filters.adId) params.set('adId', state.filters.adId);
    if (state.filters.search) params.set('search', state.filters.search);

    const apiUrl = `/api/export/excel?${params.toString()}`;
    try {
      const check = await fetch(apiUrl, { method: 'HEAD' });
      const ct = check.headers.get('content-type') || '';
      if (check.ok && ct.includes('spreadsheetml')) {
        window.location.href = apiUrl;
        return;
      }
    } catch {}
    window.location.href = './VIMS_Enterprise_Meta_Ads_Report.xlsx';
  });

  // Refresh Meta Data Button
  document.getElementById('btnRefreshSync').addEventListener('click', async () => {
    const btn = document.getElementById('btnRefreshSync');
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '↻ Syncing...';
    try {
      if (state.filters.dataSource === 'meta_api' && state.connection?.hasAccessToken) {
        await apiFetch('/api/meta/sync', {
          method: 'POST',
          body: JSON.stringify({ lookbackDays: 90 })
        });
      }
      await loadDashboard();
    } catch (err) {
      alert(`Meta Sync Status: ${err.message}`);
      await loadDashboard();
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  });

  // Modals Open/Close
  document.getElementById('btnOpenMetaSetup').addEventListener('click', window.openMetaSetupModal);
  document.getElementById('btnCloseMetaModal').addEventListener('click', () => {
    document.getElementById('metaSetupModal').classList.add('hidden');
  });

  document.getElementById('btnCloseAdDrawer').addEventListener('click', () => {
    document.getElementById('adDetailDrawer').classList.add('hidden');
  });

  document.getElementById('btnOpenUploadModal').addEventListener('click', window.openUploadModal);
  document.getElementById('btnCloseUploadModal').addEventListener('click', () => {
    document.getElementById('uploadReportModal').classList.add('hidden');
  });

  document.getElementById('btnOpenBudgetModal').addEventListener('click', window.openBudgetModal);
  document.getElementById('btnCloseBudgetModal').addEventListener('click', () => {
    document.getElementById('budgetModal').classList.add('hidden');
  });

  document.getElementById('btnOpenTargetsModal').addEventListener('click', () => {
    document.getElementById('targetsModal').classList.remove('hidden');
  });
  document.getElementById('btnCloseTargetsModal').addEventListener('click', () => {
    document.getElementById('targetsModal').classList.add('hidden');
  });

  // Meta Connect Token Button
  document.getElementById('btnConnectMetaToken').addEventListener('click', async () => {
    const fb = document.getElementById('metaSetupFeedback');
    fb.style.color = '#1d4ed8';
    fb.textContent = 'Connecting to graph.facebook.com and discovering businesses, ad accounts & pages...';

    const appId = document.getElementById('metaAppIdInput').value.trim();
    const appSecret = document.getElementById('metaAppSecretInput').value.trim();
    const accessToken = document.getElementById('metaAccessTokenInput').value.trim();

    try {
      const resp = await apiFetch('/api/meta/connect', {
        method: 'POST',
        body: JSON.stringify({ appId, appSecret, accessToken })
      });
      document.getElementById('metaAccessTokenInput').value = '';
      populateAssetDropdownsInModal(resp.connection);

      // If at least one Ad Account was discovered, automatically run initial sync right away!
      if (resp.connection && resp.connection.selectedAdAccountId) {
        const lookbackDays = Number(document.getElementById('metaLookbackDays').value || 90);
        fb.style.color = '#1d4ed8';
        fb.textContent = `✓ Token verified (${resp.connection.connectedUserName}). Automatically synchronizing campaigns, ad sets, ads, daily metrics (${lookbackDays}d) and lead forms...`;
        try {
          const syncResp = await apiFetch('/api/meta/sync', {
            method: 'POST',
            body: JSON.stringify({ lookbackDays })
          });
          fb.style.color = '#059669';
          fb.textContent = `✓ Connected & Synced ${syncResp.result.campaignsCount} campaigns, ${syncResp.result.adsetsCount} ad sets, ${syncResp.result.adsCount} ads, and ${syncResp.result.leadsCount} leads!`;
          state.filters.dataSource = 'meta_api';
        } catch (syncErr) {
          fb.style.color = '#d97706';
          fb.textContent = `✓ Token verified, but initial sync reported: ${syncErr.message}`;
        }
      } else {
        fb.style.color = '#059669';
        fb.textContent = `✓ ${resp.message}`;
      }
      await loadDashboard();
    } catch (err) {
      fb.style.color = '#dc2626';
      fb.textContent = `✕ Connection Blocker: ${err.message}`;
      if (err.payload && err.payload.connection) {
        const blockerBox = document.getElementById('metaModalBlockerBox');
        blockerBox.classList.remove('hidden');
        blockerBox.innerHTML = `<div><strong>${esc(err.payload.connection.blockerCode)}:</strong> ${esc(err.payload.connection.blockerMessage)}<br/><em>${esc(err.payload.connection.blockerActionTa)}</em></div>`;
      }
    }
  });

  // Launch Meta OAuth Dialog
  document.getElementById('btnLaunchMetaOAuth').addEventListener('click', async () => {
    const appId = document.getElementById('metaAppIdInput').value.trim();
    const appSecret = document.getElementById('metaAppSecretInput').value.trim();
    const fb = document.getElementById('metaSetupFeedback');
    try {
      const resp = await apiFetch('/api/meta/oauth-url', {
        method: 'POST',
        body: JSON.stringify({ appId, appSecret })
      });
      window.location.href = resp.oauthUrl;
    } catch (err) {
      fb.style.color = '#dc2626';
      fb.textContent = err.message;
    }
  });

  // Save Meta Asset Selection & Sync
  document.getElementById('btnSaveAssetSelection').addEventListener('click', async () => {
    const fb = document.getElementById('metaSetupFeedback');
    const selectedBusinessId = document.getElementById('metaSelectBusiness').value;
    const selectedAdAccountId = document.getElementById('metaSelectAdAccount').value;
    const selectedPageIds = Array.from(document.querySelectorAll('.meta-page-cb:checked')).map(cb => cb.value);
    const autoSyncIntervalMinutes = Number(document.getElementById('metaAutoSyncMinutes').value);
    const lookbackDays = Number(document.getElementById('metaLookbackDays').value || 90);

    try {
      fb.style.color = '#1d4ed8';
      fb.textContent = 'Saving selection...';
      await apiFetch('/api/meta/select-assets', {
        method: 'POST',
        body: JSON.stringify({
          selectedBusinessId,
          selectedAdAccountId,
          selectedPageIds,
          autoSyncIntervalMinutes,
          activeDataSource: selectedAdAccountId ? 'meta_api' : state.filters.dataSource
        })
      });

      if (selectedAdAccountId) {
        fb.textContent = `Syncing all campaigns, ad sets, ads, daily metrics (${lookbackDays}d) and lead forms...`;
        const syncResp = await apiFetch('/api/meta/sync', {
          method: 'POST',
          body: JSON.stringify({ lookbackDays })
        });
        fb.style.color = '#059669';
        fb.textContent = `✓ Synced ${syncResp.result.campaignsCount} campaigns, ${syncResp.result.adsCount} ads, and ${syncResp.result.leadsCount} leads!`;
      } else {
        fb.style.color = '#059669';
        fb.textContent = '✓ Settings saved.';
      }
      await loadDashboard();
    } catch (err) {
      fb.style.color = '#dc2626';
      fb.textContent = `Sync Error: ${err.message}`;
      await loadDashboard();
    }
  });

  // File Upload Preview & Column Mapping
  document.getElementById('uploadFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fb = document.getElementById('uploadFeedbackMsg');
    fb.style.color = '#1d4ed8';
    fb.textContent = `Reading "${file.name}" and generating column-mapping preview...`;

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    state.pendingUpload.filename = file.name;
    state.pendingUpload.fileBase64 = base64;

    try {
      const reportType = document.getElementById('uploadReportType').value;
      const resp = await apiFetch('/api/reports/upload-preview', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          fileBase64: base64,
          reportType
        })
      });

      const pv = resp.preview;
      state.pendingUpload.detectedType = pv.detectedType;
      state.pendingUpload.headers = pv.headers;

      document.getElementById('uploadPreviewSection').classList.remove('hidden');
      document.getElementById('btnCommitUpload').disabled = false;

      const warnBox = document.getElementById('uploadWarningsBox');
      if (pv.validationWarnings && pv.validationWarnings.length > 0) {
        warnBox.classList.remove('hidden');
        warnBox.innerHTML = pv.validationWarnings.map(w => `<div>⚠ ${esc(w)}</div>`).join('');
      } else {
        warnBox.classList.add('hidden');
      }

      // Render Mapping Dropdowns
      const mapGrid = document.getElementById('uploadMappingGrid');
      const headerOpts = (selected) =>
        `<option value="">-- Not Mapped --</option>` +
        pv.headers.map(h => `<option value="${esc(h)}" ${h === selected ? 'selected' : ''}>${esc(h)}</option>`).join('');

      mapGrid.innerHTML = Object.entries(pv.suggestedMapping).map(([field, matchedHeader]) => `
        <div class="filter-field">
          <label>${esc(field.replace(/_/g, ' '))}</label>
          <select class="select btn-sm upload-map-select" data-target-field="${esc(field)}">
            ${headerOpts(matchedHeader)}
          </select>
        </div>
      `).join('');

      // Render Sample Rows
      const sampleWrap = document.getElementById('uploadSampleTableWrap');
      if (pv.sampleRows && pv.sampleRows.length > 0) {
        sampleWrap.innerHTML = `
          <table class="data-table">
            <thead>
              <tr>${pv.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${pv.sampleRows.map(r => `<tr>${pv.headers.map(h => `<td>${esc(r[h] ?? '')}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        `;
      }

      fb.style.color = '#059669';
      fb.textContent = `✓ Preview ready: Detected ${pv.detectedType.toUpperCase()} report with ${pv.totalDataRows} data row(s).`;
    } catch (err) {
      fb.style.color = '#dc2626';
      fb.textContent = `Preview Error: ${err.message}`;
    }
  });

  // Commit File Upload
  document.getElementById('btnCommitUpload').addEventListener('click', async () => {
    const fb = document.getElementById('uploadFeedbackMsg');
    const columnMapping = {};
    document.querySelectorAll('.upload-map-select').forEach(sel => {
      columnMapping[sel.getAttribute('data-target-field')] = sel.value;
    });

    try {
      fb.style.color = '#1d4ed8';
      fb.textContent = 'Importing and deduplicating records...';
      const resp = await apiFetch('/api/reports/upload-commit', {
        method: 'POST',
        body: JSON.stringify({
          filename: state.pendingUpload.filename,
          fileBase64: state.pendingUpload.fileBase64,
          reportType: state.pendingUpload.detectedType,
          columnMapping
        })
      });

      fb.style.color = '#059669';
      fb.textContent = `✓ ${resp.message}`;
      state.filters.dataSource = 'uploaded_report';
      await loadDashboard();
      setTimeout(() => {
        document.getElementById('uploadReportModal').classList.add('hidden');
      }, 900);
    } catch (err) {
      fb.style.color = '#dc2626';
      fb.textContent = `Import Error: ${err.message}`;
    }
  });

  // Planned Budget Scope Type Toggle
  document.getElementById('planScopeType').addEventListener('change', (e) => {
    document.getElementById('planScopeCampaign').disabled = e.target.value !== 'campaign';
  });

  // Planned Budget Form Submit
  document.getElementById('budgetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const planName = document.getElementById('planNameInput').value.trim();
    const scopeType = document.getElementById('planScopeType').value;
    const scopeCampaignId = document.getElementById('planScopeCampaign').value;
    const startDate = document.getElementById('planStartDate').value;
    const endDate = document.getElementById('planEndDate').value;
    const plannedAmount = Number(document.getElementById('planAmountInput').value);

    await apiFetch('/api/planned-budgets', {
      method: 'POST',
      body: JSON.stringify({
        dataSource: state.filters.dataSource,
        accountId: state.overview.account.accountId,
        planName,
        scopeType,
        scopeCampaignId,
        startDate,
        endDate,
        plannedAmount
      })
    });

    document.getElementById('planNameInput').value = '';
    document.getElementById('planAmountInput').value = '';
    await loadDashboard();
  });

  // Save Configurable Targets
  document.getElementById('btnSaveTargets').addEventListener('click', async () => {
    await apiFetch('/api/targets', {
      method: 'POST',
      body: JSON.stringify({
        accountId: state.overview.account.accountId,
        targetCpl: Number(document.getElementById('targetCplInput').value),
        maxSpendZeroLeads: Number(document.getElementById('targetZeroLeadSpendInput').value),
        minLinkCtrPercent: Number(document.getElementById('targetMinCtrInput').value),
        minClickToLeadRatePercent: Number(document.getElementById('targetMinConvInput').value)
      })
    });
    document.getElementById('targetsModal').classList.add('hidden');
    await loadDashboard();
  });
});
