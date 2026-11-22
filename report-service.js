const crypto = require('node:crypto');
const { db, nowIso, todayDateStr } = require('./db');
const { buildXlsxBuffer, parseXlsxBuffer, parseCsvText } = require('./xlsx-builder');
const { getDashboardOverview } = require('./analytics-service');

// ============================================================================
// 1. Excel (.xlsx) Export Service (Section 8)
// Includes worksheets:
//   - Summary
//   - Daily Performance
//   - Campaign Performance
//   - Ad Performance
//   - Leads and Follow-ups
// Honors selected account, period, data source, and filters.
// Preserves phone numbers & IDs as text, sanitizes user content against formula injection,
// and ensures exported totals agree 100% with the dashboard!
// ============================================================================

function generateDashboardExcelReport(filterParams = {}) {
  const overview = getDashboardOverview(filterParams);
  const conn = db.prepare(`SELECT * FROM meta_connections WHERE id = 'default'`).get();

  const acc = overview.account;
  const dr = overview.dateRange;
  const sc = overview.summaryCards;
  const fc = overview.financialClarity;
  const rec = overview.leadsSection.reconciliation;
  const cov = overview.coverage;

  const dataSourceLabel = acc.dataSource === 'meta_api'
    ? 'Connected Meta Graph API (Live Authorized Account)'
    : acc.dataSource === 'uploaded_report'
      ? 'Uploaded Meta Ads Manager Report (CSV/XLSX Import)'
      : 'Separate Demo Mode Dataset (Sample Data - Not Actual Business Data)';

  const lastUpdateStr = conn?.last_sync_at || nowIso();

  // Worksheet 1: Summary
  const summaryPreamble = [
    [{ value: 'VIMS ENTERPRISE — META ADVERTISING PERFORMANCE REPORT', styleId: 2 }],
    [{ value: 'Reporting Period:', styleId: 7 }, { value: `${dr.startDate} to ${dr.endDate} (${dr.label})` }],
    [{ value: 'Ad Account Name & ID:', styleId: 7 }, { value: `${acc.name} (${acc.accountId})` }],
    [{ value: 'Currency & Timezone:', styleId: 7 }, { value: `${acc.currency} | ${acc.timezoneName} (UTC+${acc.timezoneOffsetHours})` }],
    [{ value: 'Data Source:', styleId: 7 }, { value: dataSourceLabel }],
    [{ value: 'Attribution Setting:', styleId: 7 }, { value: acc.attributionSpec }],
    [{ value: 'Last Successful Update:', styleId: 7 }, { value: lastUpdateStr }],
    [{ value: 'Data Coverage & Missing Period Notes:', styleId: 7 }, { value: cov.missingPeriodsNote || `Complete daily coverage from ${cov.earliestDate || dr.startDate} to ${cov.latestDate || dr.endDate}.` }],
    [{ value: 'Active Filters Applied:', styleId: 7 }, { value: `Platform: ${overview.filters.platformFilter.toUpperCase()} | Status: ${overview.filters.statusFilter} | Campaign: ${overview.filters.campaignId || 'ALL'} | Ad: ${overview.filters.adId || 'ALL'}` }],
    []
  ];

  const summaryColumns = [
    { header: 'Metric Category', key: 'category', width: 30, type: 'text' },
    { header: 'Metric Name', key: 'metric', width: 38, type: 'text' },
    { header: 'Value', key: 'value', width: 24, type: 'text' },
    { header: 'Notes & Calculation Basis', key: 'notes', width: 58, type: 'text' }
  ];

  const summaryRows = [
    {
      category: 'Current Live Status',
      metric: 'Active Campaigns Now',
      value: `${sc.activeCampaignsNow} (of ${sc.totalCampaignsStored} total stored)`,
      notes: 'Current delivery status; historical metrics below include paused/completed campaigns.'
    },
    {
      category: 'Current Live Status',
      metric: 'Active Individual Ads Now',
      value: `${sc.activeAdsNow} (of ${sc.totalAdsStored} total stored)`,
      notes: 'Counted separately from campaigns.'
    },
    {
      category: "Today's Snapshot",
      metric: `Today's Actual Ad Spend (${dr.todayDate})`,
      value: `${acc.currency} ${sc.todayActualSpend.toFixed(2)}`,
      notes: 'Actual reported expenditure for today only.'
    },
    {
      category: "Today's Snapshot",
      metric: `Today's Reported Form Leads (${dr.todayDate})`,
      value: String(sc.todayFormLeads),
      notes: `Today's CPL: ${typeof sc.todayCplDisplay === 'number' ? `${acc.currency} ${sc.todayCplDisplay.toFixed(2)}` : sc.todayCplDisplay}`
    },
    {
      category: `Selected Period (${dr.startDate} to ${dr.endDate})`,
      metric: 'Actual Spend for Selected Period',
      value: `${acc.currency} ${sc.periodActualSpend.toFixed(2)}`,
      notes: 'Actual reported expenditure (never configured budget or rounded CPL * leads).'
    },
    {
      category: `Selected Period (${dr.startDate} to ${dr.endDate})`,
      metric: 'Reach (Unique People)',
      value: sc.periodReach !== null ? String(sc.periodReach) : 'Unavailable',
      notes: sc.periodReachNote
    },
    {
      category: `Selected Period (${dr.startDate} to ${dr.endDate})`,
      metric: 'Impressions',
      value: String(sc.periodImpressions),
      notes: 'Total number of times ads were displayed on screen.'
    },
    {
      category: `Selected Period (${dr.startDate} to ${dr.endDate})`,
      metric: 'Link Clicks',
      value: String(sc.periodLinkClicks),
      notes: `Link CTR: ${sc.periodLinkCtrDisplay} | Link CPC: ${typeof sc.periodLinkCpcDisplay === 'number' ? `${acc.currency} ${sc.periodLinkCpcDisplay.toFixed(2)}` : sc.periodLinkCpcDisplay}`
    },
    {
      category: `Selected Period (${dr.startDate} to ${dr.endDate})`,
      metric: 'All Clicks (Including Likes/Profile Clicks)',
      value: String(sc.periodClicksAll),
      notes: 'Kept distinct from Link Clicks so CTR and CPC definitions remain exact.'
    },
    {
      category: `Selected Period (${dr.startDate} to ${dr.endDate})`,
      metric: 'Reported Form Leads (Ad Metrics)',
      value: String(sc.periodReportedFormLeads),
      notes: 'Attributed Instant Form submissions in Meta Ads Insights.'
    },
    {
      category: `Selected Period (${dr.startDate} to ${dr.endDate})`,
      metric: 'Cost Per Form Lead (Aggregate Total Spend / Total Leads)',
      value: typeof sc.periodCplDisplay === 'number' ? `${acc.currency} ${sc.periodCplDisplay.toFixed(2)}` : sc.periodCplDisplay,
      notes: 'Calculated from matching period totals; never an average of row CPLs.'
    },
    {
      category: 'Financial Figures (4 Separate Concepts)',
      metric: '1. Meta Configured Daily Budget (Active Campaigns)',
      value: `${acc.currency} ${fc.metaConfiguredBudget.activeDailyBudgetTotal.toFixed(2)}`,
      notes: fc.metaConfiguredBudget.note
    },
    {
      category: 'Financial Figures (4 Separate Concepts)',
      metric: '2. Actual Advertising Spend (Selected Period)',
      value: `${acc.currency} ${sc.periodActualSpend.toFixed(2)}`,
      notes: fc.actualAdSpend.note
    },
    {
      category: 'Financial Figures (4 Separate Concepts)',
      metric: '3. Manually Entered Planned Budget Remaining',
      value: fc.activePlanSummary.hasPlan
        ? `${acc.currency} ${fc.activePlanSummary.remainingAmount.toFixed(2)} (${fc.activePlanSummary.statusLabel})`
        : 'No Planned Budget Set',
      notes: fc.activePlanSummary.hasPlan
        ? `Plan: ${fc.activePlanSummary.planName} | Planned: ${acc.currency} ${fc.activePlanSummary.plannedAmount.toFixed(2)} | Spent in Plan Scope: ${acc.currency} ${fc.activePlanSummary.actualSpendInScope.toFixed(2)}`
        : 'Enter a spending plan in the dashboard to track remaining planned budget.'
    },
    {
      category: 'Financial Figures (4 Separate Concepts)',
      metric: '4A. Verified Meta Available Prepaid Funds',
      value: typeof fc.verifiedMetaBilling.availableFundsDisplay === 'number'
        ? `${acc.currency} ${fc.verifiedMetaBilling.availableFundsDisplay.toFixed(2)}`
        : fc.verifiedMetaBilling.availableFundsDisplay,
      notes: fc.verifiedMetaBilling.verificationNote
    },
    {
      category: 'Financial Figures (4 Separate Concepts)',
      metric: '4B. Verified Meta Amount Owed (Unpaid Balance)',
      value: typeof fc.verifiedMetaBilling.amountOwedDisplay === 'number'
        ? `${acc.currency} ${fc.verifiedMetaBilling.amountOwedDisplay.toFixed(2)}`
        : fc.verifiedMetaBilling.amountOwedDisplay,
      notes: 'Labelled strictly as an amount owed, never confused with available prepaid funds.'
    },
    {
      category: 'Lead Reconciliation (3 Separate Counts)',
      metric: '1. Form Leads Reported in Advertising Metrics',
      value: String(rec.reportedInAdMetrics),
      notes: 'Attributed by ad interaction date in Meta Insights.'
    },
    {
      category: 'Lead Reconciliation (3 Separate Counts)',
      metric: '2. Lead Contact Records Successfully Retrieved',
      value: String(rec.retrievedContactRecords),
      notes: rec.discrepancyExplanation
    },
    {
      category: 'Lead Reconciliation (3 Separate Counts)',
      metric: '3. Leads Qualified / Marked Won by VIMS Team',
      value: `${rec.teamQualifiedLeads} Qualified (${rec.teamWonCustomers} Won Customers)`,
      notes: rec.enquiryDisclaimer
    }
  ];

  // Worksheet 2: Daily Performance
  const dailyColumns = [
    { header: 'Date', key: 'date', width: 15, type: 'text' },
    { header: `Actual Spend (${acc.currency})`, key: 'spend', width: 18, type: 'currency' },
    { header: 'Impressions', key: 'impressions', width: 16, type: 'integer' },
    { header: 'Link Clicks', key: 'linkClicks', width: 15, type: 'integer' },
    { header: 'Link CTR (%)', key: 'linkCtr', width: 15, type: 'percent' },
    { header: 'Reported Form Leads', key: 'formLeads', width: 20, type: 'integer' },
    { header: `Cost Per Form Lead (${acc.currency})`, key: 'cplValue', width: 24, type: 'currency' },
    { header: 'Data Status', key: 'statusNote', width: 26, type: 'text' }
  ];

  const dailyRowsForSheet = overview.dailyChart.map(d => ({
    date: d.date,
    spend: d.spend,
    impressions: d.impressions,
    linkClicks: d.linkClicks,
    linkCtr: d.impressions > 0 ? Number(((d.linkClicks / d.impressions) * 100).toFixed(2)) : '—',
    formLeads: d.formLeads,
    cplValue: d.formLeads > 0 ? d.cpl : '— / No leads',
    statusNote: d.hasData ? 'Recorded' : 'No delivery / Missing date'
  }));

  dailyRowsForSheet.push({
    _isTotalRow: true,
    date: `TOTAL (${dr.startDate} to ${dr.endDate})`,
    spend: sc.periodActualSpend,
    impressions: sc.periodImpressions,
    linkClicks: sc.periodLinkClicks,
    linkCtr: sc.periodLinkCtr !== null ? sc.periodLinkCtr : '—',
    formLeads: sc.periodReportedFormLeads,
    cplValue: sc.periodReportedFormLeads > 0 ? sc.periodCpl : '— / No leads',
    statusNote: 'Matches Dashboard Period Totals'
  });

  // Worksheet 3: Campaign Performance
  const campColumns = [
    { header: 'Campaign ID (Text)', key: 'campaignId', width: 22, type: 'id' },
    { header: 'Campaign Name', key: 'name', width: 36, type: 'text' },
    { header: 'Current Status', key: 'effectiveStatus', width: 16, type: 'text' },
    { header: 'Objective', key: 'objectiveLabel', width: 26, type: 'text' },
    { header: `Configured Daily Budget (${acc.currency})`, key: 'dailyBudget', width: 24, type: 'currency' },
    { header: `Actual Amount Spent (${acc.currency})`, key: 'spend', width: 22, type: 'currency' },
    { header: 'Reach', key: 'reach', width: 16, type: 'integer' },
    { header: 'Impressions', key: 'impressions', width: 16, type: 'integer' },
    { header: 'Link Clicks', key: 'linkClicks', width: 15, type: 'integer' },
    { header: 'Link CTR (%)', key: 'linkCtr', width: 15, type: 'percent' },
    { header: `Link CPC (${acc.currency})`, key: 'linkCpcDisplay', width: 18, type: 'currency' },
    { header: 'Reported Form Leads', key: 'formLeads', width: 20, type: 'integer' },
    { header: `Cost Per Form Lead (${acc.currency})`, key: 'cplDisplay', width: 24, type: 'currency' },
    { header: 'Primary Result Type', key: 'resultType', width: 22, type: 'text' },
    { header: 'Primary Results Count', key: 'resultsCount', width: 20, type: 'integer' },
    { header: `Cost Per Result (${acc.currency})`, key: 'costPerResultDisplay', width: 22, type: 'currency' }
  ];

  const campRowsForSheet = overview.campaignsTable.map(c => ({
    ...c,
    dailyBudget: c.dailyBudget !== null && c.dailyBudget !== undefined ? c.dailyBudget : '—',
    reach: c.reach !== null && c.reach !== undefined ? c.reach : 'Unavailable',
    linkCtr: c.linkCtr !== null ? c.linkCtr : '—'
  }));

  campRowsForSheet.push({
    _isTotalRow: true,
    campaignId: 'TOTAL',
    name: `ALL FILTERED CAMPAIGNS (${overview.campaignsTable.length})`,
    effectiveStatus: `${sc.activeCampaignsNow} Active Now`,
    objectiveLabel: 'Combined',
    dailyBudget: fc.metaConfiguredBudget.activeDailyBudgetTotal,
    spend: sc.periodActualSpend,
    reach: sc.periodReach !== null ? sc.periodReach : 'Unavailable',
    impressions: sc.periodImpressions,
    linkClicks: sc.periodLinkClicks,
    linkCtr: sc.periodLinkCtr !== null ? sc.periodLinkCtr : '—',
    linkCpcDisplay: sc.periodLinkCpcDisplay,
    formLeads: sc.periodReportedFormLeads,
    cplDisplay: sc.periodCplDisplay,
    resultType: 'Form Leads',
    resultsCount: sc.periodReportedFormLeads,
    costPerResultDisplay: sc.periodCplDisplay
  });

  // Worksheet 4: Ad Performance
  const adColumns = [
    { header: 'Ad ID (Text)', key: 'adId', width: 22, type: 'id' },
    { header: 'Individual Ad Name', key: 'name', width: 34, type: 'text' },
    { header: 'Campaign Name', key: 'campaignName', width: 30, type: 'text' },
    { header: 'Ad Set Name', key: 'adsetName', width: 28, type: 'text' },
    { header: 'Current Status', key: 'effectiveStatus', width: 16, type: 'text' },
    { header: 'Objective', key: 'objectiveLabel', width: 24, type: 'text' },
    { header: 'Creative Headline', key: 'headline', width: 30, type: 'text' },
    { header: 'Call To Action', key: 'cta', width: 18, type: 'text' },
    { header: 'Delivery Start', key: 'deliveryStartDate', width: 15, type: 'text' },
    { header: 'Delivery Last Active', key: 'deliveryStopDate', width: 18, type: 'text' },
    { header: `Actual Amount Spent (${acc.currency})`, key: 'spend', width: 22, type: 'currency' },
    { header: 'Reach', key: 'reach', width: 15, type: 'integer' },
    { header: 'Impressions', key: 'impressions', width: 15, type: 'integer' },
    { header: 'Link Clicks', key: 'linkClicks', width: 15, type: 'integer' },
    { header: 'Link CTR (%)', key: 'linkCtr', width: 15, type: 'percent' },
    { header: `Link CPC (${acc.currency})`, key: 'linkCpcDisplay', width: 18, type: 'currency' },
    { header: 'Reported Form Leads', key: 'formLeads', width: 20, type: 'integer' },
    { header: `Cost Per Form Lead (${acc.currency})`, key: 'cplDisplay', width: 24, type: 'currency' },
    { header: 'Primary Result Type', key: 'resultType', width: 20, type: 'text' },
    { header: 'Primary Results', key: 'resultsCount', width: 16, type: 'integer' },
    { header: `Cost Per Result (${acc.currency})`, key: 'costPerResultDisplay', width: 22, type: 'currency' }
  ];

  const adRowsForSheet = overview.adsTable.map(a => ({
    ...a,
    headline: a.creative?.title || '',
    cta: a.creative?.cta || '',
    reach: a.reach !== null && a.reach !== undefined ? a.reach : 'Unavailable',
    linkCtr: a.linkCtr !== null ? a.linkCtr : '—'
  }));

  adRowsForSheet.push({
    _isTotalRow: true,
    adId: 'TOTAL',
    name: `ALL FILTERED ADS (${overview.adsTable.length})`,
    campaignName: '',
    adsetName: '',
    effectiveStatus: `${sc.activeAdsNow} Active Now`,
    objectiveLabel: '',
    headline: '',
    cta: '',
    deliveryStartDate: dr.startDate,
    deliveryStopDate: dr.endDate,
    spend: sc.periodActualSpend,
    reach: sc.periodReach !== null ? sc.periodReach : 'Unavailable',
    impressions: sc.periodImpressions,
    linkClicks: sc.periodLinkClicks,
    linkCtr: sc.periodLinkCtr !== null ? sc.periodLinkCtr : '—',
    linkCpcDisplay: sc.periodLinkCpcDisplay,
    formLeads: sc.periodReportedFormLeads,
    cplDisplay: sc.periodCplDisplay,
    resultType: 'Form Leads',
    resultsCount: sc.periodReportedFormLeads,
    costPerResultDisplay: sc.periodCplDisplay
  });

  // Worksheet 5: Leads and Follow-ups
  const leadsPreamble = [
    [{ value: 'VIMS ENTERPRISE — RETRIEVED LEAD FORM SUBMISSIONS & SALES FOLLOW-UP TRACKER', styleId: 2 }],
    [{ value: 'Lead Count Reconciliation Note:', styleId: 7 }, { value: rec.discrepancyExplanation }],
    [{ value: 'Enquiry vs Revenue Policy:', styleId: 7 }, { value: rec.enquiryDisclaimer }],
    []
  ];

  const leadColumns = [
    { header: 'Lead ID (Text)', key: 'leadId', width: 22, type: 'id' },
    { header: 'Submission Date & Time', key: 'createdTime', width: 24, type: 'text' },
    { header: 'Customer Name', key: 'customerName', width: 26, type: 'text' },
    { header: 'Phone Number (Text)', key: 'phoneNumber', width: 20, type: 'phone' },
    { header: 'Email Address', key: 'email', width: 28, type: 'text' },
    { header: 'Submitted Business Requirements', key: 'businessRequirements', width: 42, type: 'text' },
    { header: 'Source Campaign', key: 'campaignName', width: 30, type: 'text' },
    { header: 'Source Ad', key: 'adName', width: 30, type: 'text' },
    { header: 'Instant Form Name', key: 'formName', width: 26, type: 'text' },
    { header: 'Platform', key: 'platform', width: 12, type: 'text' },
    { header: 'Follow-up Status', key: 'followupStatus', width: 18, type: 'text' },
    { header: 'Assigned Person', key: 'assignedPerson', width: 22, type: 'text' },
    { header: 'Next Follow-up Date', key: 'nextFollowupDate', width: 18, type: 'text' },
    { header: 'Follow-up Notes', key: 'notes', width: 40, type: 'text' },
    { header: `Recorded Deal Value (${acc.currency})`, key: 'recordedDealValue', width: 22, type: 'currency' }
  ];

  const leadRowsForSheet = overview.leadsSection.leads.map(l => ({
    ...l,
    recordedDealValue: (l.recordedDealValue !== null && l.recordedDealValue !== undefined && l.recordedDealValue !== '')
      ? l.recordedDealValue
      : ''
  }));

  const buffer = buildXlsxBuffer([
    { name: 'Summary', preamble: summaryPreamble, columns: summaryColumns, rows: summaryRows },
    { name: 'Daily Performance', columns: dailyColumns, rows: dailyRowsForSheet },
    { name: 'Campaign Performance', columns: campColumns, rows: campRowsForSheet },
    { name: 'Ad Performance', columns: adColumns, rows: adRowsForSheet },
    { name: 'Leads and Follow-ups', preamble: leadsPreamble, columns: leadColumns, rows: leadRowsForSheet }
  ]);

  const filename = `VIMS_Meta_Report_${dr.startDate}_to_${dr.endDate}.xlsx`;
  return { buffer, filename, overview };
}

// ============================================================================
// 2. Report Upload (CSV / XLSX) Preview, Column Mapping & Deduplicated Import
// Stores uploaded data under data_source = 'uploaded_report' so it is NEVER
// silently combined with connected Meta API data or Demo Mode data.
// ============================================================================

const PERFORMANCE_FIELD_SYNONYMS = {
  date_start: ['reporting starts', 'day', 'date', 'date_start', 'reporting start', 'start date'],
  date_stop: ['reporting ends', 'date_stop', 'reporting end', 'end date'],
  campaign_id: ['campaign id', 'campaign_id'],
  campaign_name: ['campaign name', 'campaign_name', 'campaign'],
  adset_id: ['ad set id', 'adset id', 'adset_id', 'ad_set_id'],
  adset_name: ['ad set name', 'adset name', 'adset_name', 'ad set'],
  ad_id: ['ad id', 'ad_id'],
  ad_name: ['ad name', 'ad_name', 'ad'],
  effective_status: ['delivery status', 'delivery', 'status', 'effective_status', 'ad delivery'],
  objective: ['objective', 'campaign objective'],
  publisher_platform: ['platform', 'publisher_platform', 'publisher platform', 'placement'],
  spend: ['amount spent (inr)', 'amount spent', 'spend', 'cost', 'amount spent (usd)'],
  impressions: ['impressions', 'impr'],
  reach: ['reach', 'unique reach'],
  link_clicks: ['link clicks', 'inline link clicks', 'link_clicks', 'unique link clicks'],
  clicks_all: ['clicks (all)', 'all clicks', 'clicks', 'clicks_all'],
  form_leads: ['leads', 'on-facebook leads', 'meta leads', 'form leads', 'instant form leads', 'lead', 'results'],
  result_type: ['result indicator', 'result type', 'result_type'],
  currency: ['currency']
};

const LEAD_FIELD_SYNONYMS = {
  lead_id: ['id', 'lead id', 'lead_id', 'submission id'],
  created_time: ['created_time', 'created time', 'submission date', 'submitted at', 'date', 'timestamp'],
  customer_name: ['full_name', 'full name', 'customer name', 'name', 'your name', 'contact name'],
  phone_number: ['phone_number', 'phone number', 'phone', 'mobile', 'whatsapp', 'contact number'],
  email: ['email', 'email address', 'work email'],
  business_requirements: ['business_requirements', 'requirements', 'requirement', 'message', 'enquiry', 'what_service_do_you_need', 'hospital_or_academy_requirement', 'notes'],
  city: ['city', 'location', 'district'],
  organization_name: ['company_name', 'organization', 'hospital_name', 'academy_name', 'business name', 'company'],
  campaign_id: ['campaign_id', 'campaign id'],
  campaign_name: ['campaign_name', 'campaign name', 'campaign'],
  adset_id: ['adset_id', 'ad set id'],
  adset_name: ['adset_name', 'ad set name'],
  ad_id: ['ad_id', 'ad id'],
  ad_name: ['ad_name', 'ad name', 'ad'],
  form_id: ['form_id', 'form id'],
  form_name: ['form_name', 'form name', 'form'],
  platform: ['platform', 'source platform']
};

function autoDetectMapping(headers, reportType = 'auto') {
  const normalizedHeaders = headers.map(h => String(h || '').trim().toLowerCase());

  // Decide if this file is a Lead Submissions export or an Ads Manager Performance export
  let detectedType = reportType;
  if (detectedType === 'auto') {
    const hasPhoneOrEmail = normalizedHeaders.some(h => h.includes('phone') || h.includes('email') || h.includes('full_name'));
    const hasSpendOrImpr = normalizedHeaders.some(h => h.includes('amount spent') || h.includes('spend') || h.includes('impressions'));
    detectedType = (hasPhoneOrEmail && !hasSpendOrImpr) ? 'leads' : 'performance';
  }

  const dict = detectedType === 'leads' ? LEAD_FIELD_SYNONYMS : PERFORMANCE_FIELD_SYNONYMS;
  const mapping = {};

  for (const [targetField, synonyms] of Object.entries(dict)) {
    let matchedHeader = '';
    for (const syn of synonyms) {
      const idx = normalizedHeaders.findIndex(h => h === syn || h.startsWith(syn));
      if (idx !== -1) {
        matchedHeader = headers[idx];
        break;
      }
    }
    mapping[targetField] = matchedHeader;
  }

  return { detectedType, mapping };
}

function parseUploadedFileToRows(filename, fileBuffer) {
  const ext = String(filename || '').toLowerCase();
  if (ext.endsWith('.xlsx')) {
    const sheets = parseXlsxBuffer(fileBuffer);
    if (!sheets.length || !sheets[0].rows.length) {
      throw new Error('The uploaded .xlsx file does not contain any non-empty worksheet rows.');
    }
    // Find sheet with data (prefer Ad Performance / Campaign / Sheet1)
    const primarySheet = sheets.find(s => s.rows.length > 1) || sheets[0];
    return {
      sheets: sheets.map(s => ({ name: s.name, rowCount: s.rows.length })),
      rows: primarySheet.rows
    };
  } else {
    const text = fileBuffer.toString('utf8');
    const rows = parseCsvText(text);
    if (!rows.length) {
      throw new Error('The uploaded CSV file is empty.');
    }
    return {
      sheets: [{ name: 'CSV Data', rowCount: rows.length }],
      rows
    };
  }
}

/**
 * Preview an uploaded CSV or XLSX file before committing:
 * Returns headers, auto-detected report type ('performance' or 'leads'), suggested column mapping,
 * validation warnings, and first 5 sample rows.
 */
function previewReportUpload({ filename, fileBuffer, reportType = 'auto' }) {
  const { sheets, rows } = parseUploadedFileToRows(filename, fileBuffer);

  // Locate the header row (skip any preamble rows if the user re-uploaded a report with title rows)
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const nonEmptyCount = rows[i].filter(c => String(c || '').trim() !== '').length;
    if (nonEmptyCount >= 3) {
      const joined = rows[i].join(' ').toLowerCase();
      if (joined.includes('campaign') || joined.includes('spend') || joined.includes('amount spent') || joined.includes('phone') || joined.includes('email') || joined.includes('impressions') || joined.includes('ad name')) {
        headerRowIdx = i;
        break;
      }
    }
  }

  const headers = rows[headerRowIdx].map(h => String(h || '').trim());
  const dataRows = rows.slice(headerRowIdx + 1).filter(r => {
    const firstCell = String(r[0] || '').trim().toUpperCase();
    return !firstCell.startsWith('TOTAL') && r.some(c => String(c || '').trim() !== '');
  });

  const { detectedType, mapping } = autoDetectMapping(headers, reportType);

  const sampleRows = dataRows.slice(0, 5).map(r => {
    const obj = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = r[idx] ?? '';
    });
    return obj;
  });

  const validationWarnings = [];
  if (detectedType === 'performance') {
    if (!mapping.spend) validationWarnings.push('Could not auto-detect "Amount Spent / Spend" column. Please map it manually below.');
    if (!mapping.impressions) validationWarnings.push('Could not auto-detect "Impressions" column. Please map it manually below.');
    if (!mapping.campaign_name && !mapping.ad_name) validationWarnings.push('Please map at least "Campaign Name" or "Ad Name".');
  } else {
    if (!mapping.customer_name) validationWarnings.push('Could not auto-detect "Customer Name" column.');
    if (!mapping.phone_number && !mapping.email) validationWarnings.push('Could not auto-detect "Phone Number" or "Email" column.');
  }

  return {
    filename,
    sheets,
    headerRowIdx,
    headers,
    totalDataRows: dataRows.length,
    detectedType,
    suggestedMapping: mapping,
    validationWarnings,
    sampleRows
  };
}

function stableHashId(prefix, str) {
  const hash = crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, 12);
  return `${prefix}_${hash}`;
}

function cleanNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  const cleaned = String(val).replace(/[₹$,\s%]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function normalizeDateStr(rawDate) {
  const s = String(rawDate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Handle DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return todayDateStr();
}

/**
 * Commit an uploaded CSV or XLSX report with user-confirmed column mappings.
 * Deduplicates by stable IDs (`campaign_id`, `ad_id`, `date_start`, `lead_id`) under `data_source = 'uploaded_report'`.
 */
function commitReportUpload({
  filename,
  fileBuffer,
  reportType = 'performance',
  columnMapping = {},
  accountName = 'VIMS Enterprise (Uploaded Report)',
  currency = 'INR'
}) {
  const preview = previewReportUpload({ filename, fileBuffer, reportType });
  const { rows } = parseUploadedFileToRows(filename, fileBuffer);
  const headers = rows[preview.headerRowIdx].map(h => String(h || '').trim());
  const dataRows = rows.slice(preview.headerRowIdx + 1).filter(r => {
    const firstCell = String(r[0] || '').trim().toUpperCase();
    return !firstCell.startsWith('TOTAL') && r.some(c => String(c || '').trim() !== '');
  });

  const mapping = { ...preview.suggestedMapping, ...columnMapping };
  const colIndexMap = {};
  for (const [field, headerName] of Object.entries(mapping)) {
    if (headerName) {
      const idx = headers.findIndex(h => h === headerName);
      if (idx !== -1) colIndexMap[field] = idx;
    }
  }

  const getCell = (row, field) => {
    const idx = colIndexMap[field];
    return (idx !== undefined && idx >= 0 && idx < row.length) ? String(row[idx] ?? '').trim() : '';
  };

  const dataSource = 'uploaded_report';
  const accountId = 'act_uploaded_vims';
  const ts = nowIso();

  // Ensure uploaded_report ad_account row exists
  db.prepare(`
    INSERT INTO ad_accounts (
      account_id, data_source, name, currency, timezone_name, timezone_offset_hours,
      account_status, billing_verification_note, updated_at
    ) VALUES (?, ?, ?, ?, 'Asia/Kolkata', 5.5, 1, 'Unavailable from connected data (Uploaded CSV/XLSX Report).', ?)
    ON CONFLICT(account_id) DO UPDATE SET
      name = excluded.name,
      currency = excluded.currency,
      updated_at = excluded.updated_at
  `).run(accountId, dataSource, accountName, currency, ts);

  let rowsProcessed = 0;
  let rowsInserted = 0;
  let rowsUpdated = 0;
  let dateMin = '';
  let dateMax = '';

  if (reportType === 'leads') {
    const checkLeadStmt = db.prepare(`SELECT lead_id FROM lead_submissions WHERE lead_id = ? AND data_source = ?`);
    const upsertLeadStmt = db.prepare(`
      INSERT INTO lead_submissions (
        lead_id, data_source, account_id, form_id, form_name,
        campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name,
        platform, created_time, submission_date, customer_name, phone_number,
        email, business_requirements, city, organization_name,
        first_retrieved_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lead_id, data_source) DO UPDATE SET
        customer_name = excluded.customer_name,
        phone_number = excluded.phone_number,
        email = excluded.email,
        business_requirements = excluded.business_requirements,
        campaign_name = COALESCE(NULLIF(excluded.campaign_name, ''), lead_submissions.campaign_name),
        ad_name = COALESCE(NULLIF(excluded.ad_name, ''), lead_submissions.ad_name),
        last_synced_at = excluded.last_synced_at
    `);
    const ensureFollowupStmt = db.prepare(`
      INSERT INTO lead_followups (lead_id, followup_status, updated_at)
      VALUES (?, 'New', ?)
      ON CONFLICT(lead_id) DO NOTHING
    `);

    for (const row of dataRows) {
      const custName = getCell(row, 'customer_name');
      const phone = getCell(row, 'phone_number');
      const email = getCell(row, 'email');
      if (!custName && !phone && !email) continue;

      rowsProcessed++;
      const rawCreated = getCell(row, 'created_time') || todayDateStr();
      const subDate = normalizeDateStr(rawCreated);
      if (!dateMin || subDate < dateMin) dateMin = subDate;
      if (!dateMax || subDate > dateMax) dateMax = subDate;

      const rawId = getCell(row, 'lead_id') || stableHashId('upl_lead', `${subDate}|${phone}|${email}|${custName}`);
      const existed = checkLeadStmt.get(rawId, dataSource);

      const campName = getCell(row, 'campaign_name') || 'Uploaded Campaign';
      const campId = getCell(row, 'campaign_id') || stableHashId('upl_camp', campName);
      const adName = getCell(row, 'ad_name') || 'Uploaded Ad';
      const adId = getCell(row, 'ad_id') || stableHashId('upl_ad', `${campId}|${adName}`);

      upsertLeadStmt.run(
        rawId,
        dataSource,
        accountId,
        getCell(row, 'form_id') || 'form_uploaded',
        getCell(row, 'form_name') || 'Uploaded Instant Form',
        campId,
        campName,
        getCell(row, 'adset_id') || '',
        getCell(row, 'adset_name') || '',
        adId,
        adName,
        getCell(row, 'platform') || 'fb',
        rawCreated.includes('T') ? rawCreated : `${subDate}T10:00:00+05:30`,
        subDate,
        custName || 'Unnamed Lead',
        phone,
        email,
        getCell(row, 'business_requirements'),
        getCell(row, 'city'),
        getCell(row, 'organization_name'),
        ts,
        ts
      );
      ensureFollowupStmt.run(rawId, ts);

      if (existed) rowsUpdated++;
      else rowsInserted++;
    }
  } else {
    // Performance Report Import
    const upsertCampStmt = db.prepare(`
      INSERT INTO campaigns (
        campaign_id, data_source, account_id, name, status, effective_status, objective,
        first_seen_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(campaign_id, data_source) DO UPDATE SET
        name = excluded.name,
        effective_status = excluded.effective_status,
        last_synced_at = excluded.last_synced_at
    `);

    const upsertAdsetStmt = db.prepare(`
      INSERT INTO adsets (
        adset_id, data_source, account_id, campaign_id, name, status, effective_status,
        first_seen_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(adset_id, data_source) DO UPDATE SET
        name = excluded.name,
        last_synced_at = excluded.last_synced_at
    `);

    const upsertAdStmt = db.prepare(`
      INSERT INTO ads (
        ad_id, data_source, account_id, campaign_id, adset_id, name, status, effective_status,
        creative_title, first_seen_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ad_id, data_source) DO UPDATE SET
        name = excluded.name,
        effective_status = excluded.effective_status,
        last_synced_at = excluded.last_synced_at
    `);

    const checkInsightStmt = db.prepare(`
      SELECT entity_id FROM daily_insights
      WHERE entity_type = 'ad' AND entity_id = ? AND date_start = ? AND publisher_platform = ? AND data_source = ?
    `);

    const upsertInsightStmt = db.prepare(`
      INSERT INTO daily_insights (
        entity_type, entity_id, data_source, account_id, campaign_id, adset_id, ad_id,
        date_start, date_stop, publisher_platform, spend, impressions, reach,
        clicks_all, link_clicks, form_leads, result_type, results_count, updated_at
      ) VALUES ('ad', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id, date_start, publisher_platform, data_source) DO UPDATE SET
        spend = excluded.spend,
        impressions = excluded.impressions,
        reach = COALESCE(excluded.reach, daily_insights.reach),
        clicks_all = excluded.clicks_all,
        link_clicks = excluded.link_clicks,
        form_leads = excluded.form_leads,
        results_count = excluded.results_count,
        updated_at = excluded.updated_at
    `);

    for (const row of dataRows) {
      const campName = getCell(row, 'campaign_name') || 'Uploaded Campaign';
      const adName = getCell(row, 'ad_name') || campName;
      const adsetName = getCell(row, 'adset_name') || `${campName} - Ad Set`;

      const campId = getCell(row, 'campaign_id') || stableHashId('upl_camp', campName);
      const adsetId = getCell(row, 'adset_id') || stableHashId('upl_adset', `${campId}|${adsetName}`);
      const adId = getCell(row, 'ad_id') || stableHashId('upl_ad', `${campId}|${adName}`);

      const dStart = normalizeDateStr(getCell(row, 'date_start') || todayDateStr());
      const dStop = normalizeDateStr(getCell(row, 'date_stop') || dStart);

      if (!dateMin || dStart < dateMin) dateMin = dStart;
      if (!dateMax || dStart > dateMax) dateMax = dStart;

      const rawStatus = (getCell(row, 'effective_status') || 'ACTIVE').toUpperCase();
      const effStatus = rawStatus.includes('PAUSE') ? 'PAUSED'
        : rawStatus.includes('ARCHIV') ? 'ARCHIVED'
        : rawStatus.includes('COMPLET') || rawStatus.includes('INACTIVE') ? 'COMPLETED'
        : 'ACTIVE';

      const objective = (getCell(row, 'objective') || 'OUTCOME_LEADS').toUpperCase();
      const rawPlat = (getCell(row, 'publisher_platform') || 'all').toLowerCase();
      const platform = rawPlat.includes('insta') ? 'instagram' : rawPlat.includes('face') ? 'facebook' : 'all';

      const spend = Number(cleanNumber(getCell(row, 'spend')).toFixed(2));
      const impressions = Math.round(cleanNumber(getCell(row, 'impressions')));
      const reachRaw = getCell(row, 'reach');
      const reach = reachRaw !== '' ? Math.round(cleanNumber(reachRaw)) : null;
      const linkClicks = Math.round(cleanNumber(getCell(row, 'link_clicks')));
      const clicksAll = Math.round(cleanNumber(getCell(row, 'clicks_all'))) || linkClicks;
      const formLeads = Math.round(cleanNumber(getCell(row, 'form_leads')));
      const resultType = getCell(row, 'result_type') || 'Form Leads';

      rowsProcessed++;
      upsertCampStmt.run(campId, dataSource, accountId, campName, effStatus, effStatus, objective, ts, ts);
      upsertAdsetStmt.run(adsetId, dataSource, accountId, campId, adsetName, effStatus, effStatus, ts, ts);
      upsertAdStmt.run(adId, dataSource, accountId, campId, adsetId, adName, effStatus, effStatus, adName, ts, ts);

      const existed = checkInsightStmt.get(adId, dStart, platform, dataSource);
      upsertInsightStmt.run(
        adId, dataSource, accountId, campId, adsetId, adId,
        dStart, dStop, platform, spend, impressions, reach,
        clicksAll, linkClicks, formLeads, resultType, formLeads, ts
      );

      // If row was for a specific platform ('facebook' or 'instagram'), also roll up into 'all' for that date & ad
      if (platform !== 'all') {
        const rollup = db.prepare(`
          SELECT
            COALESCE(SUM(spend), 0) AS spend,
            COALESCE(SUM(impressions), 0) AS imp,
            MAX(reach) AS reach,
            COALESCE(SUM(clicks_all), 0) AS ca,
            COALESCE(SUM(link_clicks), 0) AS lc,
            COALESCE(SUM(form_leads), 0) AS fl
          FROM daily_insights
          WHERE entity_type = 'ad' AND ad_id = ? AND date_start = ? AND data_source = ? AND publisher_platform != 'all'
        `).get(adId, dStart, dataSource);

        if (rollup) {
          upsertInsightStmt.run(
            adId, dataSource, accountId, campId, adsetId, adId,
            dStart, dStop, 'all',
            Number(rollup.spend.toFixed(2)), rollup.imp, rollup.reach,
            rollup.ca, rollup.lc, rollup.fl, resultType, rollup.fl, ts
          );
        }
      }

      if (existed) rowsUpdated++;
      else rowsInserted++;
    }
  }

  const batchId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO uploaded_reports (
      batch_id, filename, report_type, account_id,
      rows_processed, rows_inserted, rows_updated,
      date_min, date_max, column_mapping_json, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    batchId,
    filename,
    reportType,
    accountId,
    rowsProcessed,
    rowsInserted,
    rowsUpdated,
    dateMin,
    dateMax,
    JSON.stringify(mapping),
    ts
  );

  // Switch active data source to uploaded_report so user immediately sees their uploaded data clearly labelled
  db.prepare(`
    UPDATE meta_connections SET active_data_source = 'uploaded_report', updated_at = ? WHERE id = 'default'
  `).run(ts);

  return {
    batchId,
    filename,
    reportType,
    dataSource,
    accountId,
    rowsProcessed,
    rowsInserted,
    rowsUpdated,
    dateMin,
    dateMax
  };
}

module.exports = {
  generateDashboardExcelReport,
  previewReportUpload,
  commitReportUpload
};
