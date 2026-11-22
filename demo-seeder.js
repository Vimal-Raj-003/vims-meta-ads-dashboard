const { db, nowIso, todayDateStr } = require('./db');

// ============================================================================
// Strictly Separated Demo Mode Seeder (Section 9)
// - All records are tagged with `data_source = 'demo_mode'` and `account_id = 'act_demo_sandbox'`.
// - Clearly labelled as [DEMO SAMPLE] so sample contacts, spending, or results
//   are NEVER presented as actual VIMS Enterprise business data.
// ============================================================================

function seedDemoModeData() {
  const dataSource = 'demo_mode';
  const accountId = 'act_demo_sandbox';
  const ts = nowIso();
  const today = todayDateStr();

  // Clear previous demo_mode records so re-seeding is clean and idempotent
  db.prepare(`DELETE FROM daily_insights WHERE data_source = ?`).run(dataSource);
  db.prepare(`DELETE FROM period_reach_cache WHERE data_source = ?`).run(dataSource);
  db.prepare(`DELETE FROM ads WHERE data_source = ?`).run(dataSource);
  db.prepare(`DELETE FROM adsets WHERE data_source = ?`).run(dataSource);
  db.prepare(`DELETE FROM campaigns WHERE data_source = ?`).run(dataSource);
  db.prepare(`DELETE FROM planned_budgets WHERE data_source = ?`).run(dataSource);
  db.prepare(`DELETE FROM lead_submissions WHERE data_source = ?`).run(dataSource);
  db.prepare(`DELETE FROM ad_accounts WHERE account_id = ? AND data_source = ?`).run(accountId, dataSource);

  // 1. Demo Ad Account
  db.prepare(`
    INSERT INTO ad_accounts (
      account_id, data_source, name, currency, timezone_name, timezone_offset_hours,
      account_status, amount_spent_total, balance_amount_owed, spend_cap,
      is_prepay_account, available_funds_verified, funding_source_details,
      billing_verification_note, attribution_spec, updated_at
    ) VALUES (?, ?, ?, 'INR', 'Asia/Kolkata', 5.5, 1, 148520.00, 4680.00, 250000.00, 0, NULL,
      'Demo Visa Business Card *4412 (Postpay Threshold)',
      'Unavailable from connected data (Postpay account shows verified Amount Owed of INR 4,680.00; prepaid wallet balance is not applicable).',
      '7d_click_1d_view', ?
    )
  `).run(accountId, dataSource, '[DEMO SAMPLE] Sandbox Ad Account (Not Real Business Data)', ts);

  // 2. Demo Campaigns (Active + Paused + Completed + Non-Lead Traffic objective)
  const demoCampaigns = [
    {
      id: 'demo_camp_101',
      name: '[DEMO] Hospital AI Receptionist & HMS — Tamil Nadu Lead Gen',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      objective: 'OUTCOME_LEADS',
      daily_budget: 1500.00,
      lifetime_budget: null
    },
    {
      id: 'demo_camp_102',
      name: '[DEMO] Voice AI Agent Academy — Weekend Workshop Leads',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      objective: 'OUTCOME_LEADS',
      daily_budget: 1200.00,
      lifetime_budget: null
    },
    {
      id: 'demo_camp_103',
      name: '[DEMO] Clinic Appointment Automation — Website Traffic',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      objective: 'OUTCOME_TRAFFIC',
      daily_budget: 600.00,
      lifetime_budget: null
    },
    {
      id: 'demo_camp_104',
      name: '[DEMO] Q3 Healthcare Summit Webinar — Paused Historical',
      status: 'PAUSED',
      effective_status: 'PAUSED',
      objective: 'OUTCOME_LEADS',
      daily_budget: null,
      lifetime_budget: 25000.00
    }
  ];

  const insertCamp = db.prepare(`
    INSERT INTO campaigns (
      campaign_id, data_source, account_id, name, status, effective_status,
      objective, daily_budget, lifetime_budget, first_seen_at, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of demoCampaigns) {
    insertCamp.run(c.id, dataSource, accountId, c.name, c.status, c.effective_status, c.objective, c.daily_budget, c.lifetime_budget, ts, ts);
  }

  // 3. Demo Ad Sets
  const demoAdsets = [
    { id: 'demo_adset_201', campId: 'demo_camp_101', name: '[DEMO] Chennai & Coimbatore Hospital Directors (30-58)', status: 'ACTIVE', goal: 'LEAD_GENERATION' },
    { id: 'demo_adset_202', campId: 'demo_camp_102', name: '[DEMO] IT Professionals & Entrepreneurs — Tamil Nadu', status: 'ACTIVE', goal: 'LEAD_GENERATION' },
    { id: 'demo_adset_203', campId: 'demo_camp_103', name: '[DEMO] Multi-Specialty Clinics — Landing Page Clicks', status: 'ACTIVE', goal: 'LINK_CLICKS' },
    { id: 'demo_adset_204', campId: 'demo_camp_104', name: '[DEMO] Past Webinar Lookalike Audience (Paused)', status: 'PAUSED', goal: 'LEAD_GENERATION' }
  ];

  const insertAdset = db.prepare(`
    INSERT INTO adsets (
      adset_id, data_source, account_id, campaign_id, name, status, effective_status,
      optimization_goal, first_seen_at, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const as of demoAdsets) {
    insertAdset.run(as.id, dataSource, accountId, as.campId, as.name, as.status, as.status, as.goal, ts, ts);
  }

  // 4. Demo Individual Ads (with Creative Details, SVG Posters, Copy, Headline, CTA)
  const makePosterDataUrl = (bgHex, badgeText, titleText, subText) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${bgHex}"/>
          <stop offset="100%" stop-color="#0f172a"/>
        </linearGradient>
      </defs>
      <rect width="600" height="400" rx="16" fill="url(#g)"/>
      <rect x="32" y="32" width="180" height="34" rx="17" fill="#38bdf8" fill-opacity="0.2" stroke="#38bdf8"/>
      <text x="122" y="54" font-family="sans-serif" font-size="13" font-weight="bold" fill="#7dd3fc" text-anchor="middle">${badgeText}</text>
      <text x="36" y="135" font-family="sans-serif" font-size="28" font-weight="bold" fill="#ffffff">${titleText}</text>
      <text x="36" y="185" font-family="sans-serif" font-size="17" fill="#cbd5e1">${subText}</text>
      <rect x="36" y="305" width="210" height="48" rx="10" fill="#2563eb"/>
      <text x="141" y="335" font-family="sans-serif" font-size="15" font-weight="bold" fill="#ffffff" text-anchor="middle">Book Free Live Demo →</text>
    </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  };

  const demoAds = [
    {
      id: 'demo_ad_301',
      campId: 'demo_camp_101',
      adsetId: 'demo_adset_201',
      name: '[DEMO] 24/7 Tamil & English Hospital Voice AI Agent — Video Ad',
      status: 'ACTIVE',
      title: 'Automate Patient Appointment Calls 24/7 in Tamil & English',
      body: 'Missed phone calls cost hospitals 30+ outpatient bookings every week. See how our 24/7 AI Voice Receptionist answers patient enquiries and books OP tokens automatically.',
      cta: 'SIGN_UP',
      mediaType: 'VIDEO',
      thumb: makePosterDataUrl('#1e3a8a', 'DEMO SAMPLE VIDEO AD', '24/7 Hospital AI Voice Agent', 'Tamil + English OP Booking Automation'),
      formId: 'demo_form_501',
      formName: 'Hospital AI Demo Request Form'
    },
    {
      id: 'demo_ad_302',
      campId: 'demo_camp_101',
      adsetId: 'demo_adset_201',
      name: '[DEMO] Hospital OP Queue & WhatsApp Reminder — Static Poster B',
      status: 'ACTIVE',
      title: 'Reduce Patient No-Shows by 45% with Automated Reminders',
      body: 'Still managing hospital appointments in registers? Upgrade to automated WhatsApp + Voice follow-ups tailored for multi-specialty hospitals.',
      cta: 'LEARN_MORE',
      mediaType: 'IMAGE',
      thumb: makePosterDataUrl('#065f46', 'DEMO SAMPLE POSTER', 'Hospital OP & WhatsApp Suite', 'Zero Missed Calls • Instant Integration'),
      formId: 'demo_form_501',
      formName: 'Hospital AI Demo Request Form'
    },
    {
      id: 'demo_ad_303',
      campId: 'demo_camp_101',
      adsetId: 'demo_adset_201',
      name: '[DEMO] Generic Healthcare ERP Brochure — High Spend Zero Leads Test',
      status: 'ACTIVE',
      title: 'Complete Enterprise Hospital Management System',
      body: 'Download our 24-page technical brochure covering pharmacy, lab, billing, and inpatient ward modules.',
      cta: 'DOWNLOAD',
      mediaType: 'IMAGE',
      thumb: makePosterDataUrl('#7f1d1d', 'DEMO SAMPLE POSTER', 'Enterprise HMS Brochure', 'High Spend / Zero Leads Example Ad'),
      formId: 'demo_form_501',
      formName: 'Hospital AI Demo Request Form'
    },
    {
      id: 'demo_ad_304',
      campId: 'demo_camp_102',
      adsetId: 'demo_adset_202',
      name: '[DEMO] Build AI Voice Agents in 2 Days — Tamil Tanglish Workshop Reel',
      status: 'ACTIVE',
      title: 'Hands-on AI Voice Agent Masterclass (Tamil / English)',
      body: 'No coding background needed! Build and deploy real inbound/outbound AI phone agents for clinics, real estate, and academies in one weekend.',
      cta: 'APPLY_NOW',
      mediaType: 'VIDEO',
      thumb: makePosterDataUrl('#4c1d95', 'DEMO ACADEMY REEL', 'AI Voice Agent Masterclass', 'Live Weekend Cohort • Tamil & English'),
      formId: 'demo_form_502',
      formName: 'Voice AI Academy Workshop Registration'
    },
    {
      id: 'demo_ad_305',
      campId: 'demo_camp_103',
      adsetId: 'demo_adset_203',
      name: '[DEMO] Clinic ROI Calculator — Website Traffic Carousel',
      status: 'ACTIVE',
      title: 'Calculate How Much Revenue Your Clinic Loses to Missed Calls',
      body: 'Try our interactive 60-second clinic call calculator on the website.',
      cta: 'LEARN_MORE',
      mediaType: 'IMAGE',
      thumb: makePosterDataUrl('#1e293b', 'DEMO TRAFFIC AD', 'Clinic Missed-Call Calculator', 'Objective: Website Link Clicks (Not Form Leads)'),
      formId: '',
      formName: ''
    },
    {
      id: 'demo_ad_306',
      campId: 'demo_camp_104',
      adsetId: 'demo_adset_204',
      name: '[DEMO] Q3 Healthcare Automation Webinar — Paused Historical Ad',
      status: 'PAUSED',
      title: '[Paused Historical Ad] Live Healthcare AI Roundtable',
      body: 'Historical ad preserved in database after campaign was paused.',
      cta: 'SIGN_UP',
      mediaType: 'IMAGE',
      thumb: makePosterDataUrl('#334155', 'DEMO PAUSED AD', 'Q3 Healthcare AI Roundtable', 'Historical Data Preserved Across Restarts'),
      formId: 'demo_form_501',
      formName: 'Hospital AI Demo Request Form'
    }
  ];

  const insertAd = db.prepare(`
    INSERT INTO ads (
      ad_id, data_source, account_id, campaign_id, adset_id, name, status, effective_status,
      creative_id, creative_name, creative_title, creative_body, creative_cta,
      creative_link_url, creative_thumbnail_url, creative_image_url,
      creative_media_type, lead_form_id, lead_form_name,
      delivery_start_date, delivery_stop_date, first_seen_at, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 5. Generate 45 days of deterministic Daily Insights (Current 30d + Previous 15d)
  const insertInsight = db.prepare(`
    INSERT INTO daily_insights (
      entity_type, entity_id, data_source, account_id, campaign_id, adset_id, ad_id,
      date_start, date_stop, publisher_platform, spend, impressions, reach, frequency,
      clicks_all, link_clicks, form_leads, landing_page_views, result_type, results_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const baseAnchor = new Date(`${today}T00:00:00Z`);
  let earliestStr = '';
  let latestStr = today;

  for (let dayOffset = 44; dayOffset >= 0; dayOffset--) {
    const d = new Date(baseAnchor);
    d.setUTCDate(d.getUTCDate() - dayOffset);
    const dStr = d.toISOString().slice(0, 10);
    if (!earliestStr) earliestStr = dStr;

    // Ad 301: High performing video lead ad (shows slight creative fatigue in last 10 days)
    const isRecent10 = dayOffset < 10;
    const ad301Spend = isRecent10 ? 780 : 690;
    const ad301Imp = isRecent10 ? 4800 : 5400;
    const ad301Lc = isRecent10 ? 52 : 84;
    const ad301Leads = isRecent10 ? 3 : 5;

    // Ad 302: Steady lead poster ad (high clicks, slightly lower form conversion to trigger form dropoff check)
    const ad302Spend = 460;
    const ad302Imp = 3600;
    const ad302Lc = 58;
    const ad302Leads = (dayOffset % 2 === 0) ? 2 : 1;

    // Ad 303: Spend without leads in recent 5 days (triggers "Spend without reported leads" recommendation)
    const ad303Spend = dayOffset < 6 ? 140 : 0;
    const ad303Imp = dayOffset < 6 ? 1450 : 0;
    const ad303Lc = dayOffset < 6 ? 8 : 0;
    const ad303Leads = 0;

    // Ad 304: Academy Masterclass Lead Ad (strong performance on Instagram & Facebook)
    const ad304Spend = 880;
    const ad304Imp = 7200;
    const ad304Lc = 112;
    const ad304Leads = (dayOffset % 3 === 0) ? 6 : 5;

    // Ad 305: Traffic Objective Ad (Landing Page Views, 0 form leads by design)
    const ad305Spend = 420;
    const ad305Imp = 4900;
    const ad305Lc = 135;
    const ad305Lpv = 108;

    // Ad 306: Paused historical ad (only ran 20 to 44 days ago)
    const ad306Spend = dayOffset >= 20 ? 550 : 0;
    const ad306Imp = dayOffset >= 20 ? 3900 : 0;
    const ad306Lc = dayOffset >= 20 ? 48 : 0;
    const ad306Leads = dayOffset >= 20 ? 3 : 0;

    const dailyAdRows = [
      { ad: demoAds[0], spend: ad301Spend, imp: ad301Imp, lc: ad301Lc, leads: ad301Leads, lpv: 0, resType: 'Form Leads', resCount: ad301Leads, fbShare: 0.65 },
      { ad: demoAds[1], spend: ad302Spend, imp: ad302Imp, lc: ad302Lc, leads: ad302Leads, lpv: 0, resType: 'Form Leads', resCount: ad302Leads, fbShare: 0.70 },
      { ad: demoAds[2], spend: ad303Spend, imp: ad303Imp, lc: ad303Lc, leads: ad303Leads, lpv: 0, resType: 'Form Leads', resCount: 0, fbShare: 0.80 },
      { ad: demoAds[3], spend: ad304Spend, imp: ad304Imp, lc: ad304Lc, leads: ad304Leads, lpv: 0, resType: 'Form Leads', resCount: ad304Leads, fbShare: 0.40 },
      { ad: demoAds[4], spend: ad305Spend, imp: ad305Imp, lc: ad305Lc, leads: 0, lpv: ad305Lpv, resType: 'Landing Page Views', resCount: ad305Lpv, fbShare: 0.55 },
      { ad: demoAds[5], spend: ad306Spend, imp: ad306Imp, lc: ad306Lc, leads: ad306Leads, lpv: 0, resType: 'Form Leads', resCount: ad306Leads, fbShare: 0.75 }
    ];

    let dayTotalSpend = 0;
    let dayTotalImp = 0;
    let dayTotalLc = 0;
    let dayTotalLeads = 0;

    for (const item of dailyAdRows) {
      if (item.imp === 0 && item.spend === 0) continue;
      const reachAll = Math.round(item.imp * 0.78);
      const clicksAll = Math.round(item.lc * 1.35);

      dayTotalSpend += item.spend;
      dayTotalImp += item.imp;
      dayTotalLc += item.lc;
      dayTotalLeads += item.leads;

      // 'all' platform row
      insertInsight.run(
        'ad', item.ad.id, dataSource, accountId, item.ad.campId, item.ad.adsetId, item.ad.id,
        dStr, dStr, 'all',
        item.spend, item.imp, reachAll, 1.28,
        clicksAll, item.lc, item.leads, item.lpv,
        item.resType, item.resCount, ts
      );

      // 'facebook' breakdown row
      const fbSpend = Number((item.spend * item.fbShare).toFixed(2));
      const fbImp = Math.round(item.imp * item.fbShare);
      const fbLc = Math.round(item.lc * item.fbShare);
      const fbLeads = Math.round(item.leads * item.fbShare);
      const fbLpv = Math.round(item.lpv * item.fbShare);
      const fbRes = item.resType === 'Landing Page Views' ? fbLpv : fbLeads;

      insertInsight.run(
        'ad', item.ad.id, dataSource, accountId, item.ad.campId, item.ad.adsetId, item.ad.id,
        dStr, dStr, 'facebook',
        fbSpend, fbImp, Math.round(fbImp * 0.8), 1.25,
        Math.round(fbLc * 1.35), fbLc, fbLeads, fbLpv,
        item.resType, fbRes, ts
      );

      // 'instagram' breakdown row
      const igSpend = Number((item.spend - fbSpend).toFixed(2));
      const igImp = item.imp - fbImp;
      const igLc = item.lc - fbLc;
      const igLeads = item.leads - fbLeads;
      const igLpv = item.lpv - fbLpv;
      const igRes = item.resType === 'Landing Page Views' ? igLpv : igLeads;

      insertInsight.run(
        'ad', item.ad.id, dataSource, accountId, item.ad.campId, item.ad.adsetId, item.ad.id,
        dStr, dStr, 'instagram',
        igSpend, igImp, Math.round(igImp * 0.82), 1.22,
        clicksAll - Math.round(fbLc * 1.35), igLc, igLeads, igLpv,
        item.resType, igRes, ts
      );
    }

    // Account-level daily unique reach row
    insertInsight.run(
      'account', accountId, dataSource, accountId, '', '', '',
      dStr, dStr, 'all',
      dayTotalSpend, dayTotalImp, Math.round(dayTotalImp * 0.71), 1.41,
      Math.round(dayTotalLc * 1.35), dayTotalLc, dayTotalLeads, 0,
      'Form Leads', dayTotalLeads, ts
    );
  }

  for (const ad of demoAds) {
    const stopDate = ad.status === 'PAUSED'
      ? new Date(baseAnchor.getTime() - 20 * 86400000).toISOString().slice(0, 10)
      : today;
    insertAd.run(
      ad.id, dataSource, accountId, ad.campId, ad.adsetId, ad.name, ad.status, ad.status,
      `cr_${ad.id}`, ad.name, ad.title, ad.body, ad.cta,
      'https://vims-enterprise-demo.local', ad.thumb, ad.thumb,
      ad.mediaType, ad.formId, ad.formName,
      earliestStr, stopDate, ts, ts
    );
  }

  // 6. Demo Planned Budget
  const monthStart = `${today.slice(0, 7)}-01`;
  db.prepare(`
    INSERT INTO planned_budgets (
      id, account_id, data_source, plan_name, scope_type, scope_campaign_id, scope_campaign_name,
      start_date, end_date, planned_amount, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'account', '', 'All Campaigns (Account-Wide)', ?, ?, 95000.00, ?, ?, ?)
  `).run(
    'demo_plan_01',
    accountId,
    dataSource,
    '[DEMO] Monthly Meta Lead Gen Budget Plan',
    monthStart,
    today,
    'Sample spending plan in Demo Mode to demonstrate remaining planned budget calculation.',
    ts,
    ts
  );

  // 7. Demo Lead Form Submissions (Clearly labelled [DEMO SAMPLE] contacts)
  const sampleLeads = [
    {
      id: 'demo_lead_9001',
      daysAgo: 0,
      name: '[DEMO SAMPLE] Dr. Karthikeyan S.',
      phone: '+919000000101',
      email: 'karthikeyan.demo@sample-hospital.local',
      req: 'Org: Sri Murugan Multi-Specialty Hospital | City: Coimbatore | Requirement: 24/7 Tamil Voice AI for 150 daily OP calls',
      campId: 'demo_camp_101',
      campName: '[DEMO] Hospital AI Receptionist & HMS — Tamil Nadu Lead Gen',
      adId: 'demo_ad_301',
      adName: '[DEMO] 24/7 Tamil & English Hospital Voice AI Agent — Video Ad',
      formName: 'Hospital AI Demo Request Form',
      platform: 'fb',
      status: 'New',
      assigned: '',
      notes: '',
      nextDate: today,
      dealValue: null
    },
    {
      id: 'demo_lead_9002',
      daysAgo: 1,
      name: '[DEMO SAMPLE] Priya Lakshmi R.',
      phone: '+919000000102',
      email: 'priya.demo@sample-academy.local',
      req: 'Org: NextGen Skill Academy | City: Chennai | Requirement: Weekend Voice AI Workshop batch for 4 trainers',
      campId: 'demo_camp_102',
      campName: '[DEMO] Voice AI Agent Academy — Weekend Workshop Leads',
      adId: 'demo_ad_304',
      adName: '[DEMO] Build AI Voice Agents in 2 Days — Tamil Tanglish Workshop Reel',
      formName: 'Voice AI Academy Workshop Registration',
      platform: 'ig',
      status: 'New',
      assigned: '',
      notes: '',
      nextDate: today,
      dealValue: null
    },
    {
      id: 'demo_lead_9003',
      daysAgo: 2,
      name: '[DEMO SAMPLE] Dr. Aravindhan M.',
      phone: '+919000000103',
      email: 'aravindhan.demo@sample-clinic.local',
      req: 'Org: Cauvery Ortho & Eye Centre | City: Trichy | Requirement: Automated WhatsApp + Voice appointment confirmation',
      campId: 'demo_camp_101',
      campName: '[DEMO] Hospital AI Receptionist & HMS — Tamil Nadu Lead Gen',
      adId: 'demo_ad_302',
      adName: '[DEMO] Hospital OP Queue & WhatsApp Reminder — Static Poster B',
      formName: 'Hospital AI Demo Request Form',
      platform: 'fb',
      status: 'Demo Scheduled',
      assigned: 'Vimal Raj',
      notes: 'Spoke on phone; requested live Tamil voice bot demo on Zoom.',
      nextDate: today,
      dealValue: null
    },
    {
      id: 'demo_lead_9004',
      daysAgo: 4,
      name: '[DEMO SAMPLE] Senthil Nathan V.',
      phone: '+919000000104',
      email: 'senthil.demo@sample-tech.local',
      req: 'Org: Kovai Digital Solutions | City: Madurai | Requirement: Voice AI Agent Academy corporate seat',
      campId: 'demo_camp_102',
      campName: '[DEMO] Voice AI Agent Academy — Weekend Workshop Leads',
      adId: 'demo_ad_304',
      adName: '[DEMO] Build AI Voice Agents in 2 Days — Tamil Tanglish Workshop Reel',
      formName: 'Voice AI Academy Workshop Registration',
      platform: 'ig',
      status: 'Interested',
      assigned: 'Divya K.',
      notes: 'Interested in upcoming weekend cohort; sent curriculum brochure.',
      nextDate: today,
      dealValue: null
    },
    {
      id: 'demo_lead_9005',
      daysAgo: 6,
      name: '[DEMO SAMPLE] Dr. Meenakshi Sundaram',
      phone: '+919000000105',
      email: 'meenakshi.demo@sample-care.local',
      req: 'Org: Annai Meenakshi Memorial Hospital | City: Salem | Requirement: Full Inbound Voice AI + OP Token System',
      campId: 'demo_camp_101',
      campName: '[DEMO] Hospital AI Receptionist & HMS — Tamil Nadu Lead Gen',
      adId: 'demo_ad_301',
      adName: '[DEMO] 24/7 Tamil & English Hospital Voice AI Agent — Video Ad',
      formName: 'Hospital AI Demo Request Form',
      platform: 'fb',
      status: 'Won',
      assigned: 'Vimal Raj',
      notes: 'Completed live demo with hospital MD; signed annual voice agent subscription.',
      nextDate: '',
      dealValue: 45000.00
    },
    {
      id: 'demo_lead_9006',
      daysAgo: 8,
      name: '[DEMO SAMPLE] Vigneshwaran P.',
      phone: '+919000000106',
      email: 'vignesh.demo@sample-edu.local',
      req: 'Org: Student / Freelancer | City: Erode | Requirement: Enquired about free workshop recording',
      campId: 'demo_camp_102',
      campName: '[DEMO] Voice AI Agent Academy — Weekend Workshop Leads',
      adId: 'demo_ad_304',
      adName: '[DEMO] Build AI Voice Agents in 2 Days — Tamil Tanglish Workshop Reel',
      formName: 'Voice AI Academy Workshop Registration',
      platform: 'fb',
      status: 'Contacted',
      assigned: 'Divya K.',
      notes: 'Called twice, shared WhatsApp details.',
      nextDate: today,
      dealValue: null
    }
  ];

  const insertLead = db.prepare(`
    INSERT INTO lead_submissions (
      lead_id, data_source, account_id, form_id, form_name,
      campaign_id, campaign_name, ad_id, ad_name,
      platform, created_time, submission_date, customer_name, phone_number,
      email, business_requirements, first_retrieved_at, last_synced_at
    ) VALUES (?, ?, ?, 'demo_form', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFollowup = db.prepare(`
    INSERT INTO lead_followups (
      lead_id, followup_status, assigned_person, notes, next_followup_date, recorded_deal_value, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lead_id) DO UPDATE SET
      followup_status = excluded.followup_status,
      assigned_person = excluded.assigned_person,
      notes = excluded.notes,
      next_followup_date = excluded.next_followup_date,
      recorded_deal_value = excluded.recorded_deal_value,
      updated_at = excluded.updated_at
  `);

  for (const ld of sampleLeads) {
    const d = new Date(baseAnchor);
    d.setUTCDate(d.getUTCDate() - ld.daysAgo);
    const subDate = d.toISOString().slice(0, 10);
    const createdIso = `${subDate}T11:30:00+05:30`;

    insertLead.run(
      ld.id, dataSource, accountId, ld.formName,
      ld.campId, ld.campName, ld.adId, ld.adName,
      ld.platform, createdIso, subDate, ld.name, ld.phone,
      ld.email, ld.req, ts, ts
    );

    insertFollowup.run(
      ld.id, ld.status, ld.assigned, ld.notes, ld.nextDate, ld.dealValue, ts
    );
  }

  return {
    status: 'seeded',
    dataSource,
    accountId,
    campaignsSeeded: demoCampaigns.length,
    adsSeeded: demoAds.length,
    leadsSeeded: sampleLeads.length
  };
}

module.exports = {
  seedDemoModeData
};
