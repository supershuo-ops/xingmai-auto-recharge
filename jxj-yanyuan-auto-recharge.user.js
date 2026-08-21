// ==UserScript==
// @name         星脉自动充值
// @namespace    local.jxj.yanyuan.auto-recharge-full
// @version      5.8.0
// @description  数据看板工作台：子账号分时充值、店铺当天预算、分时上限、队列、提交记录和版本中心
// @match        *://jxj.hnyjyx.cn/*
// @match        *://*.hnyjyx.cn/*
// @match        *://jzt.jd.com/*
// @match        *://*.jzt.jd.com/*
// @include      *://jxj.hnyjyx.cn/*
// @include      *://jzt.jd.com/*
// @updateURL    https://raw.githubusercontent.com/supershuo-ops/xingmai-auto-recharge/main/jxj-yanyuan-auto-recharge.user.js
// @downloadURL  https://raw.githubusercontent.com/supershuo-ops/xingmai-auto-recharge/main/jxj-yanyuan-auto-recharge.user.js
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      oapi.dingtalk.com
// @connect      *.dingtalk.com
// ==/UserScript==

(function () {
  'use strict';

  // =========================
  // 可调整总配置
  // 时间单位说明：1000 = 1秒，60 * 1000 = 1分钟，30 * 60 * 1000 = 30分钟。
  // 优先改这里；除非页面特别慢或流程卡住，再去改后面函数里的等待次数。
  // =========================
  const CONFIG = {
    shopName: '', // 默认店铺名留空；请在工作台「运行设置」里填写或从页面抓取。
    minBalance: 50, // 自动条件：子账号余额小于50时，才可能触发自动充值。
    minRoi: 2.7, // 自动条件：子账号ROI大于2.7时，才可能触发自动充值。
    rechargeAmount: 100, // 默认充值金额：命中规则后默认给子账号充值100元。
    intervalMs: 10 * 60 * 1000, // 京小洁页面默认查询间隔：面板未设置时默认每10分钟执行一次。
    searchDelayMs: 8000, // 进入查询流程后先等8秒再点“搜索”，页面慢可以调大。
    expandedAccountReadDelayMs: 10 * 1000, // 展开子账号后等待10秒再读取余额/花费/投产；余额加载慢就调大，例如15 * 1000。
    assignUrl: 'https://jzt.jd.com/account/#/assign', // 京准通“投放账户分配金额”页面地址，一般不要改。
    nextAccountDelayMs: 7000, // 一个账号提交后等7秒再处理下一个账号，防止页面抽屉/确认框还没收起。
    assignPollMs: 3000, // 充值页轮询间隔：每3秒检查一次有没有待充值任务。
    assignAliveMs: 15000, // 充值页存活标记：15秒内检测到充值页在线，就不重复打开新充值窗口。
    taskQueueLockMs: 10 * 1000, // 写入充值任务队列时的锁，10秒内防止多个页面同时写队列。
    taskDedupMs: 2 * 60 * 1000, // 加入任务防重复：同账号2分钟内不重复加入充值队列。
    submitDedupMs: 2 * 60 * 1000, // 提交充值防重复：同账号2分钟内不重复点击“转入”提交。
    maxTaskRetryCount: 3, // 失败任务最多重试次数：单个账号处理失败后最多重新排队3次，超过后记录失败并跳过。
    failedTaskCooldownMs: 30 * 60 * 1000, // 失败冷却时间：超过重试上限的账号30分钟内不再重新加入队列，避免每轮查询都反复失败。
    arrivalConfirmRatio: 0.8, // 到账核对宽松度：实际余额达到「应有余额」的这个比例即判定到账。
    arrivalToleranceMin: 5, // 到账核对最小容差，单位元，避免小数和零星消耗导致误判。
    arrivalConfirmTimeoutMinutes: 25, // 超过这个时间还对不上，才标记「疑似未到账」。
    rechargeLogLimit: 200, // 充值动作日志保留条数：只记已提交、失败、预算未提交、跨天重置这类真实动作。
    skipChangeLogLimit: 200, // 未充值原因变化日志保留条数：同一账号原因不变时只累加轮数，不新增记录。
    scanSnapshotVisibleRows: 6, // 本轮未充值原因默认显示行数，其余点“展开全部”再看。
    staleSpendGuardUntilHour: 3, // 跨天保护：凌晨这个点之前，如果页面花费和昨天总花费几乎一样，判为页面还没切到新一天，不采用。
    staleSpendRatio: 0.95, // 跨天保护判定比例：花费达到昨天总花费的该比例即视为过期读数。
    autoSyncAccountRoster: true, // 每轮自动查询后，是否自动把读到的子账号同步进名单。
    dingTalkEnabled: true, // 默认开启钉钉通知；实际是否发送还要看工作台里是否填写了机器人地址。
    dingTalkWebhook: '', // 钉钉机器人地址请在工作台「运行设置」填写，不要写在代码里。
    dingTalkSecret: '', // 钉钉加签密钥请在工作台填写；没开加签就留空。
    dingTalkKeyword: '自动充值', // 钉钉关键词默认值；可在工作台修改。
    targetShopRoi: 2.7, // 店铺投产达标值：当前店铺投产大于等于该值时，允许当天充值超过预算。
    budgetSlots: [ // 分时预算累计上限：到该时段时，当天已充值金额不能超过“当天预算 × 该比例”。
      { startHour: 0, endHour: 9, percent: 15 }, // 00:00-09:00，上限为当天预算的 15%。
      { startHour: 9, endHour: 14, percent: 45 }, // 09:00-14:00，上限为当天预算的 45%。
      { startHour: 14, endHour: 18, percent: 60 }, // 14:00-18:00，上限为当天预算的 60%。
      { startHour: 18, endHour: 24, percent: 100 } // 18:00-24:00，上限为当天预算的 100%。
    ],
    ruleTimeSlots: [ // 子账号分时充值默认规则：到点后按当前时段的一次充值金额和 ROI 判断。
      { startHour: 0, endHour: 9, amount: 100, minRoi: 2.9 }, // 00:00-09:00，一次充值100，ROI大于2.9才充。
      { startHour: 9, endHour: 18, amount: 100, minRoi: 2.5 }, // 09:00-18:00，一次充值100，ROI大于2.5才充。
      { startHour: 18, endHour: 24, amount: 200, minRoi: 2.2 } // 18:00-24:00，一次充值200，ROI大于2.2才充。
    ]
  };

  const STORAGE_QUEUE = 'jxj_yanyuan_recharge_queue_auto_v23';
  const STORAGE_CURRENT = 'jxj_yanyuan_recharge_current_auto_v23';
  const STORAGE_LAST_SEARCH = 'jxj_yanyuan_last_search_time_auto_v23';
  const STORAGE_MIDNIGHT_REFRESH_DATE = 'jxj_yanyuan_midnight_refresh_date_auto_v23';
  const STORAGE_ASSIGN_PAGE_READY = 'jxj_yanyuan_assign_page_ready_auto_v23';
  const STORAGE_ASSIGN_OPENING_UNTIL = 'jxj_yanyuan_assign_opening_until_auto_v23';
  const STORAGE_ASSIGN_LOCK = 'jxj_yanyuan_assign_lock_auto_v23';
  const STORAGE_RULES = 'jxj_yanyuan_recharge_rules_auto_v23';
  const STORAGE_RULE_DONE_MAP = 'jxj_yanyuan_recharge_rule_done_map_auto_v23';
  const STORAGE_RULE_SCHEDULE_LOCK = 'jxj_yanyuan_recharge_rule_schedule_lock_auto_v23';
  const STORAGE_RECHARGE_LOGS = 'jxj_yanyuan_recharge_logs_auto_v23';
  const STORAGE_TASK_QUEUE_LOCK = 'jxj_yanyuan_recharge_task_queue_lock_auto_v23';
  const STORAGE_TASK_DEDUP_MAP = 'jxj_yanyuan_recharge_task_dedup_map_auto_v23';
  const STORAGE_TASK_FAILED_UNTIL_MAP = 'jxj_yanyuan_recharge_task_failed_until_map_auto_v23';
  const STORAGE_ACCOUNT_SUBMIT_GUARD = 'jxj_yanyuan_recharge_account_submit_guard_auto_v23';
  const STORAGE_SCRIPT_VERSION = 'jxj_yanyuan_recharge_script_version_auto_v23';
  const STORAGE_RUNTIME_SETTINGS = 'jxj_yanyuan_recharge_runtime_settings_auto_v23';
  const STORAGE_SIMULATION_RESULTS = 'jxj_yanyuan_recharge_simulation_results_auto_v23';
  const STORAGE_DRY_RUN_SCHEDULE_NOTICE = 'jxj_yanyuan_recharge_dry_run_schedule_notice_auto_v23';
  const STORAGE_BUDGET_SETTINGS = 'jxj_yanyuan_recharge_budget_settings_auto_v23';
  const STORAGE_SHOP_METRIC_SNAPSHOT = 'jxj_yanyuan_recharge_shop_metric_snapshot_auto_v23';
  const STORAGE_SHOP_DAILY_GMV = 'jxj_yanyuan_recharge_shop_daily_gmv_auto_v23';
  const STORAGE_LAST_SEEN_VERSION = 'jxj_yanyuan_recharge_last_seen_version_auto_v23';
  const STORAGE_BUDGET_USED_SEED = 'jxj_yanyuan_recharge_budget_used_seed_auto_v23';
  const STORAGE_ACTIVE_DATE = 'jxj_yanyuan_recharge_active_date_auto_v23';
  const STORAGE_SCAN_SNAPSHOT = 'jxj_yanyuan_recharge_scan_snapshot_auto_v23';
  const STORAGE_SKIP_REASON_STATS = 'jxj_yanyuan_recharge_skip_reason_stats_auto_v23';
  const STORAGE_SKIP_REASON_STATE = 'jxj_yanyuan_recharge_skip_reason_state_auto_v23';
  const STORAGE_SKIP_REASON_CHANGES = 'jxj_yanyuan_recharge_skip_reason_changes_auto_v23';
  const STORAGE_ACCOUNT_ROSTER = 'jxj_yanyuan_recharge_account_roster_auto_v23';
  const STORAGE_ACCOUNT_GROUPS = 'jxj_yanyuan_recharge_account_groups_auto_v23';
  const STORAGE_ASSIGN_STATE = 'jxj_yanyuan_recharge_assign_state_auto_v23';

  const UNGROUPED_ID = 'ungrouped'; // 未分组的固定分组ID，不能删除。

  // 到账核对状态
  const ARRIVAL_PENDING = 'pending'; // 已提交，等下一轮读余额核对
  const ARRIVAL_CONFIRMED = 'confirmed'; // 余额对得上，判定到账
  const ARRIVAL_MISSING = 'missing'; // 超时仍对不上，疑似未到账
  const ARRIVAL_UNKNOWN = 'unknown'; // 没有余额基准，无法核对
  const ARRIVAL_NA = 'na'; // 失败或系统记录，不需要核对

  const TAB_ID = String(Date.now()) + '_' + Math.random().toString(16).slice(2);
  const SCRIPT_VERSION = '5.8.0';
  const SCRIPT_DISPLAY_NAME = '星脉自动充值';
  const SCRIPT_NAME = SCRIPT_DISPLAY_NAME + ' v' + SCRIPT_VERSION;
  const SCRIPT_UPDATE_URL = 'https://raw.githubusercontent.com/supershuo-ops/xingmai-auto-recharge/main/jxj-yanyuan-auto-recharge.user.js';

  // 每次发版：只提高 @version 和 SCRIPT_VERSION，并在 VERSION_HISTORY 追加一条。
  // 不要改 @name / @namespace，否则油猴会当成新脚本，自动更新和本机规则/设置都会断。
  const VERSION_HISTORY = [
    {
      version: '5.8.0',
      date: '2026-08-21',
      type: 'feature',
      title: '充值到账核对',
      items: [
        '提交记录新增「到账」列：已到账 / 待确认 / 疑似未到账 / 无法核对，并写出判定依据',
        '判定方式：下一轮读到的余额比充值前高就算到账',
        '如果这期间花得比充值还多、余额反而下降，会按「充值前余额 − 期间消耗 + 充值金额」再兜一次，避免误报',
        '同一账号短时间内多笔充值合并核对，超过 25 分钟仍对不上才标「疑似未到账」',
        '顶部当天汇总：已提交几笔、已到账几笔、待确认几笔、疑似未到账几笔'
      ]
    },
    {
      version: '5.7.1',
      date: '2026-08-21',
      type: 'fix',
      title: '修复队列有任务但充值页不充的问题',
      items: [
        '扫平台页面时排除工作台自己的表格，之前工作台里第一列是账号名的表格会被当成平台页面的行',
        '充值队列页新增「充值页状态」：能看到充值页在处理谁、是不是被暂停或模拟运行挡住、有没有在运行',
        '队列里有任务但检测不到充值页时，会直接给出橙色提醒'
      ]
    },
    {
      version: '5.7.0',
      date: '2026-08-20',
      type: 'feature',
      title: '子账号名单、账号分组和逐级额度分配',
      items: [
        '左侧导航按设置顺序排列：① 店铺预算 → ② 分时预算 → ③ 子账号与分组 → ④ 分组与账号额度 → ⑤ 充值规则',
        '新增「子账号与分组」页：一键从页面拉取本店所有子账号，存成名单并可自定义分组',
        '新增「分组与账号额度」页：分组和单账号都能设额度，支持按店铺预算百分比或固定金额',
        '额度从大到小卡：店铺当天预算 → 当前分时上限 → 分组额度 → 账号当天上限，取最小',
        '条件从小到大找：账号单独设置 > 所在分组 > 全店规则',
        '未充值原因会写清是哪一级挡住的，例如「被分组额度挡住」',
        '各分组额度合计超过店铺预算只提示，仍可保存，实际以上一级为硬上限'
      ]
    },
    {
      version: '5.6.0',
      date: '2026-08-20',
      type: 'feature',
      title: '充值日志、跨天预算和店铺分时规则',
      items: [
        '提交记录页新增「本轮未充值原因」「当天原因统计」「未充值原因变化」，没充值也能看到原因',
        '日志量和扫描频率无关：本轮快照每轮覆盖，统计只累加次数，原因不变时只加轮数',
        '修复过 0 点后当天预算没有重置、导致一整天充不了的问题，并在日志里留一条跨天重置',
        '凌晨页面还显示昨天花费时不再当成今日已消耗',
        '新增「店铺分时规则」页：时段和累计上限都能改，可增删时段、恢复默认',
        '总览「时段对照」改为读取店铺分时规则，不再写死四个时段'
      ]
    },
    {
      version: '5.5.5',
      date: '2026-08-20',
      type: 'feature',
      title: '改为公开地址自动更新',
      items: [
        '安装和更新改为公开仓库 raw 链接，不登录 GitHub 也能打开',
        '你这边更新并提高版本号后，所有人的油猴会自动更新',
        '本机规则、预算、店铺名和钉钉设置会保留',
        '请用公开链接再安装一次；若还有旧脚本请删掉，只留「星脉自动充值」'
      ]
    },
    {
      version: '5.5.4',
      date: '2026-08-19',
      type: 'feature',
      title: '油猴脚本改为自动更新',
      items: [
        '脚本名称固定为「星脉自动充值」，版本号只显示在右下角和工作台',
        '从 GitHub main 的 raw 链接安装一次后，Tampermonkey 会按版本号自动更新',
        '自动更新只换代码，本机已保存的规则、预算、店铺名和钉钉设置会保留',
        '若油猴列表里还有「星脉自动充值V5.5.x」，请删掉旧的，只保留这一份'
      ]
    },
    {
      version: '5.5.3',
      date: '2026-08-19',
      type: 'feature',
      title: '店铺名和钉钉机器人改到工作台填写',
      items: [
        '运行设置可填写店铺名称，也可从当前京小洁页面抓取',
        '钉钉机器人链接、开关、加签和关键词都在运行设置里保存，不再写进代码',
        '未填写店铺名时不会开始自动查询'
      ]
    },
    {
      version: '5.5.2',
      date: '2026-08-19',
      type: 'improve',
      title: '脚本改名为星脉自动充值V版本号',
      items: [
        '油猴脚本名称改为「星脉自动充值V」加版本号，例如当前为 星脉自动充值V5.5.2',
        '不再使用「终版测试2-规则面板版」',
        '以后每次发版都按这个规则改名，方便对照正在运行的版本'
      ]
    },
    {
      version: '5.5.1',
      date: '2026-08-19',
      type: 'improve',
      title: '新店已用金额按消耗起算，投产达标即可超预算',
      items: [
        '新店铺没有脚本充值记录时，当天已用金额按页面已消耗金额起算，可充金额 = 预算 − 已消耗',
        '当天一旦有脚本充值记录，已用金额取「脚本已充」和「起算消耗」中的较大值，避免把已消耗清零',
        '超过预算的条件改为：只要店铺投产达标即可，不再要求销售额增长'
      ]
    },
    {
      version: '5.5.0',
      date: '2026-08-19',
      type: 'feature',
      title: '版本中心',
      items: [
        '新增「版本中心」页，每次版本更新和新增功能都会在这里留下记录',
        '安装新版本后，侧栏「版本中心」会显示「新」，点进去即可查看本次更新',
        '总览页增加当前版本入口，方便对照正在运行的脚本版本'
      ]
    },
    {
      version: '5.4.3',
      date: '2026-08-18',
      type: 'improve',
      title: '全店规则和分账号规则分开显示',
      items: [
        '充值规则页顶部增加全店 / 分账号说明卡',
        '每条规则显示绿色「全店规则」或蓝色「分账号规则」标签',
        '底部改为「新增全店规则」「新增分账号规则」「导入为分账号规则」',
        '优先级说明：精确 > 前缀 > 包含 > 全店'
      ]
    },
    {
      version: '5.4.2',
      date: '2026-08-18',
      type: 'fix',
      title: '分时规则 0 点不显示',
      items: [
        '修复起始小时为 0 时输入框空白的问题',
        '冷却分钟、余额等待为 0 时也会正常显示'
      ]
    },
    {
      version: '5.4.1',
      date: '2026-08-18',
      type: 'fix',
      title: '脚本安装后不运行',
      items: [
        '扩大京小洁 / 京准通页面匹配范围',
        '单页跳转不刷新时也能自动识别工作页并启动',
        '工作台按钮先出现，避免总览渲染失败时整段脚本退出',
        '右下角按钮显示当前版本号，便于确认是否覆盖安装成功'
      ]
    },
    {
      version: '5.4',
      date: '2026-08-18',
      type: 'feature',
      title: '数据看板工作台',
      items: [
        '右下角「工作台 / 记录」打开左侧导航面板',
        '总览：分时预算进度、今日预算使用、时段对照表',
        '店铺预算、充值规则、充值队列、提交记录、运行设置分页管理'
      ]
    },
    {
      version: '5.3',
      date: '2026-08-18',
      type: 'feature',
      title: '子账号分时充值规则',
      items: [
        '每条规则可开启分时充值：按当前时段使用不同的一次金额和 ROI',
        '默认时段：0-9 点 100 元 / ROI>2.9，9-18 点 100 元 / ROI>2.5，18-24 点 200 元 / ROI>2.2',
        '未开启分时时，仍用规则上的统一金额和 ROI',
        '自动条件和分时规则不冲突：自动条件管余额，分时只替换金额和 ROI'
      ]
    },
    {
      version: '5.2',
      date: '2026-08-18',
      type: 'feature',
      title: '分时累计预算上限',
      items: [
        '当天充值按时间段设置累计上限，不是四段相加',
        '默认：0-9 点 15%，9-14 点 45%，14-18 点 60%，18-24 点 100%',
        '店铺投产达标时，允许超过分时上限和当天预算'
      ]
    },
    {
      version: '5.1',
      date: '2026-08-18',
      type: 'feature',
      title: '店铺当天推广预算',
      items: [
        '按近七天平均业绩、推广+退货合计费比、店铺退货率计算当天预算',
        '公式：当天预算 = 近七天平均业绩 ×（合计费比 − 退货率）',
        '当天已用和队列中的充值不能超过当天预算；无脚本记录时已用按已消耗起算'
      ]
    },
    {
      version: '5.0',
      date: '2026-08-17',
      type: 'feature',
      title: '京小洁 / 京准通自动充值',
      items: [
        '京小洁广告投放明细自动查店铺、展开子账号、按余额和 ROI 投递充值任务',
        '京准通分配金额页精确匹配账号并提交转入',
        '支持规则面板、固定时间充值、模拟运行、钉钉通知、提交记录'
      ]
    }
  ];

  console.log('[' + SCRIPT_NAME + '] 已注入', location.href, window.top === window ? 'top' : 'iframe');

  let isChecking = false;
  let isAssigning = false;
  let lastAssignIdleStatus = 0;
  let rulePanelVisible = false;
  let logPanelVisible = false;
  let scheduleTimerStarted = false;
  let adCheckTimer = null;
  let nextAdCheckAt = 0;
  let activeWorkspacePage = 'overview';
  let pageMode = '';
  let urlWatchStarted = false;
  let rechargeLogFilter = 'all';
  let scanSnapshotExpanded = false;
  let dailyResetTimerStarted = false;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function migrateRuntimeStateIfNeeded() {
    const savedVersion = String(GM_getValue(STORAGE_SCRIPT_VERSION, ''));
    if (savedVersion === SCRIPT_VERSION) return;

    GM_deleteValue(STORAGE_QUEUE);
    GM_deleteValue(STORAGE_CURRENT);
    GM_deleteValue(STORAGE_ASSIGN_LOCK);
    GM_deleteValue(STORAGE_ASSIGN_OPENING_UNTIL);
    GM_deleteValue(STORAGE_TASK_QUEUE_LOCK);
    GM_deleteValue(STORAGE_TASK_DEDUP_MAP);
    GM_deleteValue(STORAGE_TASK_FAILED_UNTIL_MAP);
    GM_deleteValue(STORAGE_ACCOUNT_SUBMIT_GUARD);
    GM_setValue(STORAGE_SCRIPT_VERSION, SCRIPT_VERSION);
  }

  // 过 0 点后必须把昨天的已用金额和花费快照清掉，否则昨天的消耗会被当成今天已用，导致一整天充不了。
  function resetDailyStateIfNewDay() {
    const today = todayKey();
    const savedDate = String(GM_getValue(STORAGE_ACTIVE_DATE, ''));
    if (savedDate === today) return false;

    const seed = readJsonValue(STORAGE_BUDGET_USED_SEED, {});
    const clearedAmount = Math.max(0, Number((seed && seed.amount) || 0));

    GM_deleteValue(STORAGE_BUDGET_USED_SEED);
    GM_deleteValue(STORAGE_SHOP_METRIC_SNAPSHOT);
    GM_deleteValue(STORAGE_SCAN_SNAPSHOT);
    GM_deleteValue(STORAGE_SKIP_REASON_STATS);
    GM_deleteValue(STORAGE_SKIP_REASON_STATE);
    GM_setValue(STORAGE_ACTIVE_DATE, today);

    if (savedDate) {
      addRechargeLog({
        accountName: '系统',
        amount: 0,
        ruleName: '—',
        triggerReason: `进入 ${today}，已清空 ${savedDate} 的已用金额 ${formatMoney(clearedAmount)} 元和花费快照，当天预算重新开始计算`
      }, '跨天重置');
      showStatus(`已跨天重置：清空 ${savedDate} 的已用金额 ${formatMoney(clearedAmount)} 元，${today} 预算重新开始计算`);
    }

    refreshBudgetPanel();
    return true;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }

  function getRefreshWindow() {
    return {
      startHour: 0, // 强制刷新开始小时：0代表凌晨0点。
      startMinute: 1, // 强制刷新开始分钟：1代表00:01开始。
      endHour: 1, // 强制刷新结束小时：1代表凌晨1点。
      endMinute: 20 // 强制刷新结束分钟：20代表01:20前有效；结束时间不包含01:20整。
    };
  }

  function minutesOfDay(hour, minute) {
    return hour * 60 + minute;
  }

  function formatClock(hour, minute) {
    return `${pad2(hour)}:${pad2(minute)}`;
  }

  function getRefreshWindowKey(today) {
    const windowConfig = getRefreshWindow();
    const startText = formatClock(windowConfig.startHour, windowConfig.startMinute);
    const endText = formatClock(windowConfig.endHour, windowConfig.endMinute);
    return `${today}_${startText}-${endText}`;
  }

  function getRefreshWindowText() {
    const windowConfig = getRefreshWindow();
    return `${formatClock(windowConfig.startHour, windowConfig.startMinute)}-${formatClock(windowConfig.endHour, windowConfig.endMinute)}`;
  }

  function isMidnightRefreshWindow() {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const windowConfig = getRefreshWindow();
    const startMinutes = minutesOfDay(windowConfig.startHour, windowConfig.startMinute);
    const endMinutes = minutesOfDay(windowConfig.endHour, windowConfig.endMinute);

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  function normalizeText(text) {
    return String(text || '')
      .normalize('NFKC') // 统一全角/半角字符，避免肉眼一样但脚本认为是不同账号。
      .replace(/[\u200B-\u200D\uFEFF]/g, '') // 删除零宽字符，页面复制/渲染时偶尔会混入。
      .replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, '-') // 统一各种短横线为普通“-”。
      .replace(/\s+/g, '')
      .trim();
  }

  function sameAccount(a, b) {
    return normalizeText(a) === normalizeText(b);
  }

  function parseNumber(text) {
    if (!text) return 0;
    return Number(String(text).replace(/,/g, '').replace(/[^\d.-]/g, '')) || 0;
  }

  function simpleClick(el) {
    if (!el) return false;
    if (typeof el.click === 'function') {
      el.click();
      return true;
    }

    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }));

    return true;
  }

  function clickPointOnce(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return false;

    el.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y
    }));

    el.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y
    }));

    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y
    }));

    return true;
  }

  function setInputValue(input, value) {
    input.focus();

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(value));

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  function dedupeTasksByAccount(tasks) {
    const seen = new Set();
    const result = [];

    for (const item of tasks || []) {
      if (!item || !item.accountName) continue;

      const key = taskDedupKey(item.accountName);
      if (!key || seen.has(key)) continue;

      seen.add(key);
      result.push(item);
    }

    return result;
  }

  function getQueue() {
    const value = GM_getValue(STORAGE_QUEUE, '[]');
    try {
      return dedupeTasksByAccount(typeof value === 'string' ? JSON.parse(value) : value);
    } catch (e) {
      return [];
    }
  }

  function setQueue(queue) {
    GM_setValue(STORAGE_QUEUE, JSON.stringify(dedupeTasksByAccount(queue)));
  }

  function setCurrent(item) {
    GM_setValue(STORAGE_CURRENT, JSON.stringify(item || null));
  }

  function getCurrent() {
    const value = GM_getValue(STORAGE_CURRENT, 'null');
    try {
      return typeof value === 'string' ? JSON.parse(value) : value;
    } catch (e) {
      return null;
    }
  }

  function isCurrentTaskStillActive(task) {
    const current = getCurrent();
    if (!task || !current) return false;

    return sameAccount(current.accountName, task.accountName) &&
      Number(current.amount || 0) === Number(task.amount || 0) &&
      String(current.ruleId || '') === String(task.ruleId || '');
  }

  function clearCurrent() {
    GM_deleteValue(STORAGE_CURRENT);
  }

  function hasPendingTask() {
    return !!getCurrent() || getQueue().length > 0;
  }

  // 记录充值页当前在干什么，方便队列卡住时一眼看出是哪一步停下的。
  function setAssignState(text) {
    writeJsonValue(STORAGE_ASSIGN_STATE, { time: Date.now(), text: String(text || '') });
    refreshQueuePanel();
  }

  function getAssignState() {
    const saved = readJsonValue(STORAGE_ASSIGN_STATE, null);
    if (!saved || !saved.time) return null;
    return saved;
  }

  function queueHasAccount(queue, accountName) {
    return queue.some(item => sameAccount(item.accountName, accountName));
  }

  function taskDedupKey(accountName) {
    return normalizeText(accountName);
  }

  function getTaskDedupMap() {
    return readJsonValue(STORAGE_TASK_DEDUP_MAP, {});
  }

  function setTaskDedupMap(map) {
    writeJsonValue(STORAGE_TASK_DEDUP_MAP, map || {});
  }

  function pruneTaskDedupMap(map, now) {
    Object.keys(map || {}).forEach(key => {
      const taskTime = Number(map[key] || 0);
      if (!taskTime || now - taskTime > CONFIG.taskDedupMs) {
        delete map[key];
      }
    });
  }

  function hasRecentTaskDedup(accountName, map, now) {
    const key = taskDedupKey(accountName);
    const taskTime = Number((map || {})[key] || 0);
    return !!taskTime && now - taskTime <= CONFIG.taskDedupMs;
  }

  function markTaskDedup(accountName, map, now) {
    const key = taskDedupKey(accountName);
    if (!key) return;
    map[key] = now;
  }

  function getTaskFailedUntilMap() {
    return readJsonValue(STORAGE_TASK_FAILED_UNTIL_MAP, {});
  }

  function setTaskFailedUntilMap(map) {
    writeJsonValue(STORAGE_TASK_FAILED_UNTIL_MAP, map || {});
  }

  function pruneTaskFailedUntilMap(map, now) {
    Object.keys(map || {}).forEach(key => {
      const item = map[key];
      const failedUntil = typeof item === 'object' ? Number(item.failedUntil || 0) : Number(item || 0);
      if (!failedUntil || failedUntil <= now) {
        delete map[key];
      }
    });
  }

  function hasRecentTaskFailure(accountName, map, now) {
    const key = taskDedupKey(accountName);
    const item = (map || {})[key];
    const failedUntil = typeof item === 'object' ? Number(item.failedUntil || 0) : Number(item || 0);
    return !!failedUntil && failedUntil > now;
  }

  function markTaskFailureCooldown(accountName, reason) {
    const key = taskDedupKey(accountName);
    if (!key) return;

    const now = Date.now();
    const map = getTaskFailedUntilMap();
    pruneTaskFailedUntilMap(map, now);
    map[key] = {
      failedUntil: now + Math.max(0, Number(CONFIG.failedTaskCooldownMs || 0)),
      reason: reason || '未知失败',
      time: now
    };
    setTaskFailedUntilMap(map);
  }

  function acquireTaskQueueLock() {
    const now = Date.now();
    const lock = readJsonValue(STORAGE_TASK_QUEUE_LOCK, {});

    if (lock.owner && lock.expiresAt && lock.expiresAt > now && lock.owner !== TAB_ID) {
      return false;
    }

    writeJsonValue(STORAGE_TASK_QUEUE_LOCK, {
      owner: TAB_ID,
      expiresAt: now + CONFIG.taskQueueLockMs
    });

    const check = readJsonValue(STORAGE_TASK_QUEUE_LOCK, {});
    return check.owner === TAB_ID;
  }

  function releaseTaskQueueLock() {
    const lock = readJsonValue(STORAGE_TASK_QUEUE_LOCK, {});
    if (lock.owner === TAB_ID) {
      GM_deleteValue(STORAGE_TASK_QUEUE_LOCK);
    }
  }

  function getAccountSubmitGuardMap() {
    return readJsonValue(STORAGE_ACCOUNT_SUBMIT_GUARD, {});
  }

  function setAccountSubmitGuardMap(map) {
    writeJsonValue(STORAGE_ACCOUNT_SUBMIT_GUARD, map || {});
  }

  function pruneAccountSubmitGuardMap(map, now) {
    Object.keys(map || {}).forEach(key => {
      const item = map[key];
      const expiresAt = typeof item === 'object' ? Number(item.expiresAt || 0) : Number(item || 0);
      if (!expiresAt || expiresAt <= now) {
        delete map[key];
      }
    });
  }

  async function acquireAccountSubmitGuard(accountName) {
    const key = taskDedupKey(accountName);
    if (!key) return false;

    const now = Date.now();
    const map = getAccountSubmitGuardMap();
    pruneAccountSubmitGuardMap(map, now);

    const current = map[key];
    const currentExpiresAt = typeof current === 'object' ? Number(current.expiresAt || 0) : Number(current || 0);
    if (currentExpiresAt && currentExpiresAt > now) return false;

    map[key] = {
      owner: TAB_ID,
      expiresAt: now + CONFIG.submitDedupMs,
      lockedAt: now
    };
    setAccountSubmitGuardMap(map);

    await sleep(80 + Math.floor(Math.random() * 120));

    const check = getAccountSubmitGuardMap()[key];
    return !!check && check.owner === TAB_ID && Number(check.lockedAt || 0) === now;
  }

  function markAccountSubmitFinished(accountName) {
    const key = taskDedupKey(accountName);
    if (!key) return;

    const now = Date.now();
    const map = getAccountSubmitGuardMap();
    pruneAccountSubmitGuardMap(map, now);
    map[key] = {
      owner: TAB_ID,
      expiresAt: now + CONFIG.submitDedupMs,
      submittedAt: now
    };
    setAccountSubmitGuardMap(map);
  }

  function releaseAccountSubmitGuard(accountName) {
    const key = taskDedupKey(accountName);
    if (!key) return;

    const map = getAccountSubmitGuardMap();
    const item = map[key];
    if (item && item.owner === TAB_ID && !item.submittedAt) {
      delete map[key];
      setAccountSubmitGuardMap(map);
    }
  }

  // 返回 { added, skipRows }，skipRows 说明命中规则却没进队列的原因。
  function addTasks(targets) {
    const empty = { added: 0, skipRows: [] };
    if (!Array.isArray(targets) || !targets.length) return empty;
    if (isPaused()) return empty;

    const budgeted = prepareTasksWithDailyBudget(targets);
    const pendingTargets = budgeted.tasks;

    if (isDryRun()) {
      setSimulationResults(pendingTargets, '模拟投递', budgeted);
      return empty;
    }

    if (!pendingTargets.length) {
      refreshBudgetPanel();
      return empty;
    }

    if (!acquireTaskQueueLock()) {
      showStatus('另一个页面正在写入充值任务队列，本次跳过重复投递');
      return empty;
    }

    try {
      const current = getCurrent();
      const queue = getQueue();
      const dedupMap = getTaskDedupMap();
      const failedUntilMap = getTaskFailedUntilMap();
      const now = Date.now();
      const skipRows = [];
      let added = 0;

      pruneTaskDedupMap(dedupMap, now);
      pruneTaskFailedUntilMap(failedUntilMap, now);

      for (const item of pendingTargets) {
        if (!item || !item.accountName) continue;

        if (current && sameAccount(current.accountName, item.accountName)) {
          skipRows.push(makeSkipRow(item, { key: SKIP_IN_QUEUE, detail: '该账号正在充值页处理中' }));
          continue;
        }

        if (queueHasAccount(queue, item.accountName)) {
          skipRows.push(makeSkipRow(item, { key: SKIP_IN_QUEUE, detail: '该账号已在充值队列里等待' }));
          continue;
        }

        if (hasRecentTaskDedup(item.accountName, dedupMap, now)) {
          skipRows.push(makeSkipRow(item, {
            key: SKIP_RECENT_TASK,
            detail: `${formatRatio(CONFIG.taskDedupMs / 60000)} 分钟内已投递过，避免重复充值`
          }));
          continue;
        }

        if (hasRecentTaskFailure(item.accountName, failedUntilMap, now)) {
          skipRows.push(makeSkipRow(item, {
            key: SKIP_FAILED_COOLDOWN,
            detail: `之前充值失败次数已达上限，${formatRatio(CONFIG.failedTaskCooldownMs / 60000)} 分钟冷却内不再排队`
          }));
          continue;
        }

        queue.push(item);
        markTaskDedup(item.accountName, dedupMap, now);
        added += 1;
      }

      setQueue(queue);
      setTaskDedupMap(dedupMap);
      setTaskFailedUntilMap(failedUntilMap);

      if (!getCurrent() && queue.length > 0) {
        const first = queue.shift();
        setQueue(queue);
        setCurrent(first);
      }

      refreshQueuePanel();
      return { added, skipRows };
    } finally {
      releaseTaskQueueLock();
    }
  }

  function readJsonValue(key, fallback) {
    const value = GM_getValue(key, JSON.stringify(fallback));
    try {
      return typeof value === 'string' ? JSON.parse(value) : value;
    } catch (e) {
      return fallback;
    }
  }

  function writeJsonValue(key, value) {
    GM_setValue(key, JSON.stringify(value));
  }

  function getRuntimeSettings() {
    return Object.assign({
      paused: false,
      dryRun: false,
      intervalMinutes: Math.max(1, Math.round(CONFIG.intervalMs / 60 / 1000)),
      expandedAccountReadDelaySeconds: Math.max(0, Math.round(CONFIG.expandedAccountReadDelayMs / 1000)),
      shopName: '',
      dingTalkEnabled: CONFIG.dingTalkEnabled !== false,
      dingTalkWebhook: '',
      dingTalkSecret: '',
      dingTalkKeyword: CONFIG.dingTalkKeyword || '自动充值'
    }, readJsonValue(STORAGE_RUNTIME_SETTINGS, {}));
  }

  function setRuntimeSettings(settings) {
    writeJsonValue(STORAGE_RUNTIME_SETTINGS, Object.assign(getRuntimeSettings(), settings || {}));
    refreshRuntimeControls();
  }

  function isPaused() {
    return !!getRuntimeSettings().paused;
  }

  function isDryRun() {
    return !!getRuntimeSettings().dryRun;
  }

  function getAdCheckIntervalMinutes() {
    return Math.max(1, Number(getRuntimeSettings().intervalMinutes || CONFIG.intervalMs / 60 / 1000));
  }

  function getAdCheckIntervalMs() {
    return getAdCheckIntervalMinutes() * 60 * 1000;
  }

  function getExpandedAccountReadDelaySeconds() {
    const settings = getRuntimeSettings();
    return Math.max(0, Number(settings.expandedAccountReadDelaySeconds ?? CONFIG.expandedAccountReadDelayMs / 1000));
  }

  function getExpandedAccountReadDelayMs() {
    return getExpandedAccountReadDelaySeconds() * 1000;
  }

  function getShopName() {
    return String(getRuntimeSettings().shopName || '').trim();
  }

  function getDingTalkConfig() {
    const settings = getRuntimeSettings();
    const keyword = String(settings.dingTalkKeyword || CONFIG.dingTalkKeyword || '自动充值').trim();
    return {
      enabled: settings.dingTalkEnabled !== false,
      webhook: String(settings.dingTalkWebhook || '').trim(),
      secret: String(settings.dingTalkSecret || '').trim(),
      keyword: keyword || '自动充值'
    };
  }

  function startAdCheckTimer() {
    if (adCheckTimer) clearInterval(adCheckTimer);
    nextAdCheckAt = Date.now() + getAdCheckIntervalMs();
    refreshNextRunPanel();
    adCheckTimer = setInterval(() => {
      nextAdCheckAt = Date.now() + getAdCheckIntervalMs();
      refreshNextRunPanel();
      checkAdPage();
    }, getAdCheckIntervalMs());
  }

  function getNextAdCheckText() {
    if (!isJxjAdPage()) {
      return '当前不在京小洁查询页';
    }

    if (!nextAdCheckAt) return '等待计时器启动';
    return `${formatDateTime(nextAdCheckAt)}（每${getAdCheckIntervalMinutes()}分钟）`;
  }

  function getNextScheduleText() {
    const rules = getRules().filter(rule =>
      rule.enabled &&
      rule.useSchedule &&
      rule.matchType === 'exact' &&
      rule.accountPattern
    );

    if (!rules.length) return '暂无固定时间任务';

    const now = new Date();
    const currentMinutes = minutesOfDay(now.getHours(), now.getMinutes());
    let best = null;

    for (const rule of rules) {
      const plans = parseSchedulePlans(rule.scheduleTimes, rule.amount);

      for (const plan of plans) {
        const parts = plan.text.split(':').map(Number);
        const candidate = new Date(now);
        candidate.setHours(parts[0], parts[1], 0, 0);

        const isCurrentMinute = plan.minutes === currentMinutes;
        if (!isCurrentMinute && candidate.getTime() <= now.getTime()) {
          candidate.setDate(candidate.getDate() + 1);
        }

        const time = isCurrentMinute ? now.getTime() : candidate.getTime();
        if (!best || time < best.time) {
          best = {
            time,
            text: isCurrentMinute ? `当前分钟 ${plan.text}` : formatDateTime(candidate),
            accountName: rule.accountPattern,
            amount: plan.amount
          };
        }
      }
    }

    if (!best) return '暂无有效固定时间任务';
    return `${best.text}：${best.accountName}，${best.amount}元`;
  }

  function nextRunInfoHtml() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px;line-height:1.45;">
        <div style="padding:9px 10px;background:#fff;border:1px solid #e6eaf0;border-left:3px solid #1677ff;border-radius:6px;">
          <div style="font-weight:700;color:#3b4350;margin-bottom:3px;">下次自动查询</div>
          <div style="color:#111827;">${escapeHtml(getNextAdCheckText())}</div>
        </div>
        <div style="padding:9px 10px;background:#fff;border:1px solid #e6eaf0;border-left:3px solid #13c2c2;border-radius:6px;">
          <div style="font-weight:700;color:#3b4350;margin-bottom:3px;">下个固定时间充值</div>
          <div style="color:#111827;">${escapeHtml(getNextScheduleText())}</div>
        </div>
      </div>
    `;
  }

  function refreshNextRunPanel() {
    const box = document.getElementById('jxj-next-run-info');
    if (box) box.innerHTML = nextRunInfoHtml();
    refreshOverviewDashboard();
  }

  function getSimulationResults() {
    const value = readJsonValue(STORAGE_SIMULATION_RESULTS, null);
    return value && Array.isArray(value.targets) ? value : null;
  }

  function setSimulationResults(targets, source, extra) {
    writeJsonValue(STORAGE_SIMULATION_RESULTS, {
      time: Date.now(),
      source: source || '规则检测',
      targets: (targets || []).map(item => ({
        accountName: item.accountName,
        amount: item.amount,
        originalAmount: item.originalAmount,
        balance: item.balance,
        spend: item.spend,
        roi: item.roi,
        ruleName: item.ruleName,
        triggerReason: item.triggerReason
      })),
      skipped: ((extra && extra.skipped) || []).map(item => ({
        accountName: item.accountName,
        amount: item.amount,
        skipReason: item.skipReason || '超出当日推广预算'
      })),
      budgetMessages: (extra && extra.messages) || []
    });
    refreshSimulationPanel();
  }

  function clearPendingTasks() {
    setQueue([]);
    clearCurrent();
    GM_deleteValue(STORAGE_TASK_DEDUP_MAP);
    GM_deleteValue(STORAGE_TASK_FAILED_UNTIL_MAP);
    GM_deleteValue(STORAGE_TASK_QUEUE_LOCK);
    GM_deleteValue(STORAGE_ASSIGN_OPENING_UNTIL);
    refreshQueuePanel();
  }

  function getTaskRetryCount(task) {
    return Math.max(0, Number(task && task.retryCount || 0));
  }

  function getMaxTaskRetryCount() {
    return Math.max(0, Number(CONFIG.maxTaskRetryCount || 0));
  }

  function getTaskRetryText(task) {
    const retryCount = getTaskRetryCount(task);
    const maxRetry = getMaxTaskRetryCount();
    return retryCount > 0 ? `重试${retryCount}/${maxRetry}` : '';
  }

  function moveFailedCurrentTask(current, reason) {
    const task = current || getCurrent();
    if (!task || !task.accountName) return false;

    const retryCount = getTaskRetryCount(task);
    const maxRetry = getMaxTaskRetryCount();
    clearCurrent();

    if (retryCount < maxRetry) {
      const retryTask = Object.assign({}, task, {
        retryCount: retryCount + 1,
        lastFailureReason: reason || '未知失败'
      });
      const queue = getQueue();
      queue.push(retryTask);
      setQueue(queue);
      refreshQueuePanel();
      showStatus(`任务失败，已重新排到队列尾部：${task.accountName}\n原因：${reason || '未知失败'}\n重试次数：${retryTask.retryCount}/${maxRetry}`);
      return true;
    }

    markTaskFailureCooldown(task.accountName, reason);
    addRechargeLog(Object.assign({}, task, {
      triggerReason: `${task.triggerReason || '余额/ROI规则'}；失败原因：${reason || '未知失败'}`
    }), `失败，已跳过（重试${retryCount}/${maxRetry}）`);
    refreshQueuePanel();
    showStatus(`任务失败次数已达上限，已跳过：${task.accountName}\n原因：${reason || '未知失败'}\n重试次数：${retryCount}/${maxRetry}`);
    return false;
  }

  async function retryOrContinueCurrentTask(current, reason) {
    moveFailedCurrentTask(current, reason);

    const queue = getQueue();
    if (queue.length > 0) {
      await sleep(CONFIG.nextAccountDelayMs);
      return true;
    }

    return false;
  }

  function makeRuleId() {
    return 'rule_' + Date.now() + '_' + Math.random().toString(16).slice(2);
  }

  function defaultRule() {
    return {
      id: 'default_shop_all_rule', // 默认规则ID，一般不要改；改了会被当成一条新规则。
      enabled: true, // 默认启用这条规则；false表示默认关闭。
      name: '全店默认规则', // 规则面板里显示的规则名称；这条是全店规则，不是某个子账号专用。
      matchType: 'all', // 匹配方式：all=本店全部子账号，exact=精确匹配，prefix=前缀匹配，contains=包含匹配。
      accountPattern: '', // all模式不需要填写账号名；脚本只会读取工作台里填写的店铺名称下面的子账号。
      amount: CONFIG.rechargeAmount, // 默认充值金额，来自顶部CONFIG.rechargeAmount。
      useThreshold: true, // 是否启用“余额/ROI自动条件”；false表示只按固定时间等其他方式处理。
      minBalance: CONFIG.minBalance, // 自动条件：余额小于这个值才触发，默认来自CONFIG.minBalance。
      minRoi: CONFIG.minRoi, // 自动条件：ROI大于这个值才触发，默认来自CONFIG.minRoi。
      useSchedule: false, // 是否默认启用固定时间充值；建议在面板里按账号单独开启。
      scheduleTimes: '', // 固定时间格式示例：10:58=100, 14:30=200；空字符串表示不设置固定时间。
      scheduleWindowMinutes: 30, // 旧字段保留；当前固定时间按准确分钟触发，面板里隐藏为1。
      cooldownMinutes: 0, // 自动条件冷却分钟数；0表示不额外冷却，主要依赖顶部2分钟防重复。
      useTimeSlots: false, // 是否按时间段使用不同的一次充值金额和ROI；false时仍用上面的金额和minRoi。
      timeSlots: defaultRuleTimeSlots() // 分时充值默认三段：0-9 / 9-18 / 18-24。
    };
  }

  function defaultRuleTimeSlots() {
    return (CONFIG.ruleTimeSlots || []).map(slot => ({
      startHour: Number(slot.startHour),
      endHour: Number(slot.endHour),
      amount: Number(slot.amount),
      minRoi: Number(slot.minRoi)
    }));
  }

  function normalizeRuleTimeSlots(slots, fallbackAmount, fallbackRoi) {
    const defaults = defaultRuleTimeSlots();
    const list = typeof slots === 'string'
      ? parseRuleTimeSlotText(slots, fallbackAmount, fallbackRoi)
      : (Array.isArray(slots) && slots.length ? slots : defaults);
    const source = list.length >= defaults.length
      ? list
      : defaults.map((base, index) => list[index] || base);

    return source.map((item, index) => {
      const base = defaults[index] || defaults[defaults.length - 1] || {
        startHour: 0,
        endHour: 24,
        amount: CONFIG.rechargeAmount,
        minRoi: CONFIG.minRoi
      };
      const startHour = Number(item && item.startHour != null ? item.startHour : base.startHour);
      let endHour = Number(item && item.endHour != null ? item.endHour : base.endHour);
      if (endHour === 0 && startHour > 0) endHour = 24;

      return {
        startHour: Math.max(0, Math.min(24, startHour)),
        endHour: Math.max(0, Math.min(24, endHour)),
        amount: Math.max(1, Number(item && item.amount || fallbackAmount || base.amount || CONFIG.rechargeAmount)),
        minRoi: Math.max(0, Number(item && item.minRoi != null ? item.minRoi : (fallbackRoi != null ? fallbackRoi : base.minRoi)))
      };
    });
  }

  function stringifyRuleTimeSlots(slots) {
    return normalizeRuleTimeSlots(slots).map(slot =>
      `${slot.startHour}-${slot.endHour}=${slot.amount}@${slot.minRoi}`
    ).join(', ');
  }

  function parseRuleTimeSlotText(text, fallbackAmount, fallbackRoi) {
    const parsed = String(text || '')
      .split(/[,，;；]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const match = item.match(/^(\d{1,2})(?::00)?\s*[-~到至]\s*(\d{1,2})(?::00)?\s*[=:：]\s*(\d+(?:\.\d+)?)(?:\s*[@/／]\s*(\d+(?:\.\d+)?))?$/);
        if (!match) return null;

        const startHour = Number(match[1]);
        let endHour = Number(match[2]);
        if (endHour === 0 && startHour > 0) endHour = 24;

        const amount = Number(match[3]);
        const minRoi = match[4] != null ? Number(match[4]) : Number(fallbackRoi != null ? fallbackRoi : CONFIG.minRoi);
        if (!Number.isFinite(startHour) || !Number.isFinite(endHour) || !(amount > 0)) return null;

        return { startHour, endHour, amount, minRoi };
      })
      .filter(Boolean);

    return parsed.length ? parsed : defaultRuleTimeSlots();
  }

  function getCurrentRuleTimeSlot(rule, now) {
    if (!rule || !rule.useTimeSlots) return null;

    const slots = normalizeRuleTimeSlots(rule.timeSlots, rule.amount, rule.minRoi)
      .filter(slot => Number(slot.endHour) > Number(slot.startHour) && Number(slot.amount) > 0);
    const date = now || new Date();
    const currentMinutes = date.getHours() * 60 + date.getMinutes();

    for (const slot of slots) {
      const startMinutes = Number(slot.startHour) * 60;
      const endMinutes = Number(slot.endHour) >= 24 ? 24 * 60 : Number(slot.endHour) * 60;
      if (currentMinutes >= startMinutes && currentMinutes < endMinutes) return slot;
    }

    return null;
  }

  function normalizeRule(rule) {
    const base = defaultRule();
    const item = Object.assign({}, base, rule || {});

    item.id = item.id || makeRuleId();
    item.enabled = item.enabled !== false;
    item.name = String(item.name || '未命名规则');
    if (item.id === 'default_prefix_rule') {
      item.id = 'default_shop_all_rule';
      item.matchType = 'all';
      item.accountPattern = '';
    }

    item.matchType = ['all', 'exact', 'prefix', 'contains'].includes(item.matchType) ? item.matchType : 'exact';
    item.accountPattern = String(item.accountPattern || '').trim();
    item.amount = Number(item.amount || CONFIG.rechargeAmount);
    item.useThreshold = item.useThreshold !== false;
    item.minBalance = Number(item.minBalance || CONFIG.minBalance);
    item.minRoi = Number(item.minRoi || CONFIG.minRoi);
    item.useSchedule = !!item.useSchedule;
    item.scheduleTimes = String(item.scheduleTimes || '');
    item.scheduleWindowMinutes = Math.max(1, Number(item.scheduleWindowMinutes || 30));
    item.cooldownMinutes = Math.max(0, Number(item.cooldownMinutes || 0));
    item.useTimeSlots = !!item.useTimeSlots;
    item.timeSlots = normalizeRuleTimeSlots(item.timeSlots, item.amount, item.minRoi);

    return item;
  }

  function getRules() {
    const rules = readJsonValue(STORAGE_RULES, null);

    if (!Array.isArray(rules) || rules.length === 0) {
      return [defaultRule()];
    }

    return rules.map(normalizeRule);
  }

  function saveRules(rules) {
    writeJsonValue(STORAGE_RULES, (rules || []).map(normalizeRule));
  }

  function getRuleDoneMap() {
    return readJsonValue(STORAGE_RULE_DONE_MAP, {});
  }

  function setRuleDoneMap(doneMap) {
    writeJsonValue(STORAGE_RULE_DONE_MAP, doneMap || {});
  }

  function matchRuleAccount(rule, accountName) {
    if (rule.matchType === 'all') return !!normalizeText(accountName);

    const pattern = normalizeText(rule.accountPattern);
    const account = normalizeText(accountName);

    if (!pattern || !account) return false;
    if (rule.matchType === 'prefix') return account.startsWith(pattern);
    if (rule.matchType === 'contains') return account.includes(pattern);
    return account === pattern;
  }

  function getAccountRules(accountName) {
    const matchedRules = getRules().filter(rule =>
      rule.enabled &&
      matchRuleAccount(rule, accountName)
    );

    const exactRules = matchedRules.filter(rule => rule.matchType === 'exact');
    if (exactRules.length > 0) return exactRules;

    const prefixRules = matchedRules.filter(rule => rule.matchType === 'prefix');
    if (prefixRules.length > 0) return prefixRules;

    const containsRules = matchedRules.filter(rule => rule.matchType === 'contains');
    if (containsRules.length > 0) return containsRules;

    return matchedRules.filter(rule => rule.matchType === 'all');
  }

  function parseSchedulePlans(text, defaultAmount) {
    return String(text || '')
      .split(/[,，\s]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const match = item.match(/^(\d{1,2}):(\d{1,2})(?:\s*[=:：]\s*(\d+(?:\.\d+)?))?$/);
        if (!match) return null;

        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

        const amount = match[3] ? Number(match[3]) : Number(defaultAmount || CONFIG.rechargeAmount);
        if (!amount || amount <= 0) return null;

        return {
          text: `${pad2(hour)}:${pad2(minute)}`,
          minutes: minutesOfDay(hour, minute),
          amount
        };
      })
      .filter(Boolean);
  }

  function makeRuleDoneKey(accountName, rule, slot) {
    return [
      rule.id,
      normalizeText(accountName),
      slot || 'threshold'
    ].join('|');
  }

  function wasRuleRecentlyDone(accountName, rule, slot) {
    const done = getRuleDoneMap();
    const doneTime = Number(done[makeRuleDoneKey(accountName, rule, slot)] || 0);

    if (!doneTime) return false;
    if (slot) return true;
    if (!rule.cooldownMinutes) return false;

    return Date.now() - doneTime < rule.cooldownMinutes * 60 * 1000;
  }

  function markRuleDone(task) {
    if (!task || !task.ruleDoneKey) return;

    const done = getRuleDoneMap();
    done[task.ruleDoneKey] = Date.now();
    setRuleDoneMap(done);
  }

  // 返回 { task } 或 { skip: { key, detail } }，让没充值的账号也能说清原因。
  function decideAccountRecharge(account) {
    const rules = getAccountRules(account.accountName);

    if (!rules.length) {
      return { skip: { key: SKIP_NO_RULE, detail: '没有匹配到启用中的充值规则' } };
    }

    const candidates = [];
    const override = resolveAccountCondition(account.accountName);
    let thresholdRuleCount = 0;

    for (const rule of rules) {
      if (!rule.useThreshold) continue;
      thresholdRuleCount += 1;

      let amount = Number(rule.amount || CONFIG.rechargeAmount);
      let minRoi = Number(rule.minRoi || CONFIG.minRoi);
      let timeSlot = null;

      if (rule.useTimeSlots) {
        timeSlot = getCurrentRuleTimeSlot(rule);
        if (!timeSlot) {
          candidates.push({
            key: SKIP_NO_SLOT,
            detail: `规则「${rule.name}」开启了分时充值，但当前时间没有对应时段`
          });
          continue;
        }
        amount = Number(timeSlot.amount || amount);
        minRoi = Number(timeSlot.minRoi);
      }

      // 账号单独设置优先于分组，分组优先于规则本身。
      if (override.amount !== null) amount = override.amount;
      if (override.minRoi !== null) minRoi = override.minRoi;

      if (!(account.balance < rule.minBalance)) {
        candidates.push({
          key: SKIP_BALANCE,
          detail: `余额 ${formatMoney(account.balance)} ≥ ${formatMoney(rule.minBalance)}，未达到充值门槛`
        });
        continue;
      }

      if (!(account.roi > minRoi)) {
        candidates.push({
          key: SKIP_ROI,
          detail: `投产 ${formatRatio(account.roi)} ≤ ${formatRatio(minRoi)}，投产不达标`
        });
        continue;
      }

      if (wasRuleRecentlyDone(account.accountName, rule, null)) {
        candidates.push({
          key: SKIP_COOLDOWN,
          detail: `规则「${rule.name}」冷却 ${formatRatio(rule.cooldownMinutes)} 分钟内已充过`
        });
        continue;
      }

      return {
        task: Object.assign({}, account, {
          amount,
          ruleId: rule.id,
          ruleName: rule.name,
          ruleDoneKey: makeRuleDoneKey(account.accountName, rule, null),
          triggerReason: timeSlot
            ? `分时规则 ${formatSlotRange(timeSlot)}，ROI>${formatRatio(minRoi)}，一次${formatMoney(amount)}`
            : `余额/ROI规则`,
          scheduleSlot: null,
          timeSlotRange: timeSlot ? formatSlotRange(timeSlot) : null
        })
      };
    }

    if (!thresholdRuleCount) {
      return { skip: { key: SKIP_NO_RULE, detail: '匹配到的规则都没有开启「余额/ROI 自动条件」' } };
    }

    return { skip: pickSkipReason(candidates) };
  }

  function buildRechargeTask(account) {
    return decideAccountRecharge(account).task || null;
  }

  function acquireAssignLock() {
    const now = Date.now();
    const lock = readJsonValue(STORAGE_ASSIGN_LOCK, {});

    if (lock.owner && lock.expiresAt && lock.expiresAt > now && lock.owner !== TAB_ID) {
      return false;
    }

    writeJsonValue(STORAGE_ASSIGN_LOCK, {
      owner: TAB_ID,
      expiresAt: now + 120 * 1000
    });

    const check = readJsonValue(STORAGE_ASSIGN_LOCK, {});
    return check.owner === TAB_ID;
  }

  function releaseAssignLock() {
    const lock = readJsonValue(STORAGE_ASSIGN_LOCK, {});
    if (lock.owner === TAB_ID) {
      GM_deleteValue(STORAGE_ASSIGN_LOCK);
    }
  }

  function acquireRuleScheduleLock() {
    const now = Date.now();
    const lock = readJsonValue(STORAGE_RULE_SCHEDULE_LOCK, {});

    if (lock.owner && lock.expiresAt && lock.expiresAt > now && lock.owner !== TAB_ID) {
      return false;
    }

    writeJsonValue(STORAGE_RULE_SCHEDULE_LOCK, {
      owner: TAB_ID,
      expiresAt: now + 30 * 1000
    });

    const check = readJsonValue(STORAGE_RULE_SCHEDULE_LOCK, {});
    return check.owner === TAB_ID;
  }

  function releaseRuleScheduleLock() {
    const lock = readJsonValue(STORAGE_RULE_SCHEDULE_LOCK, {});
    if (lock.owner === TAB_ID) {
      GM_deleteValue(STORAGE_RULE_SCHEDULE_LOCK);
    }
  }

  function popNextToCurrentIfNeeded() {
    let current = getCurrent();
    if (current) return current;

    const queue = getQueue();
    if (!queue.length) return null;

    current = queue.shift();
    setQueue(queue);
    setCurrent(current);
    return current;
  }

  function showStatus(text) {
    console.log('[京小洁全自动脚本]', text);

    let box = document.getElementById('jxj-auto-status-box');

    if (!box) {
      box = document.createElement('div');
      box.id = 'jxj-auto-status-box';
      box.style.cssText = [
        'position: fixed',
        'right: 20px',
        'top: 80px',
        'z-index: 999999',
        'background: #1677ff',
        'color: #fff',
        'padding: 10px 14px',
        'border-radius: 6px',
        'font-size: 14px',
        'line-height: 1.5',
        'max-width: 600px',
        'white-space: pre-line',
        'box-shadow: 0 4px 16px rgba(0,0,0,.18)'
      ].join(';');

      const textDiv = document.createElement('div');
      textDiv.id = 'jxj-auto-status-text';

      box.appendChild(textDiv);
      document.body.appendChild(box);
    }

    const textDiv = document.getElementById('jxj-auto-status-text');
    if (textDiv) textDiv.innerText = text;
  }

  function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDateTime(time) {
    const date = new Date(time || Date.now());
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';

    bytes.forEach(byte => {
      binary += String.fromCharCode(byte);
    });

    return btoa(binary);
  }

  async function signDingTalkUrl(webhook, secret) {
    if (!secret) return webhook;

    const timestamp = Date.now();
    const text = `${timestamp}\n${secret}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(text)
    );
    const sign = encodeURIComponent(arrayBufferToBase64(signature));
    const joiner = webhook.includes('?') ? '&' : '?';

    return `${webhook}${joiner}timestamp=${timestamp}&sign=${sign}`;
  }

  function postDingTalkJson(url, payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json;charset=utf-8'
        },
        data: JSON.stringify(payload),
        timeout: 8000,
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`钉钉通知HTTP状态异常：${response.status}`));
            return;
          }

          try {
            const body = JSON.parse(response.responseText || '{}');
            if (body.errcode && body.errcode !== 0) {
              reject(new Error(`钉钉通知失败：${body.errmsg || body.errcode}`));
              return;
            }
          } catch (e) {
            // 有些环境返回空内容；HTTP成功时不因为解析失败阻断流程。
          }

          resolve(true);
        },
        onerror: error => reject(error),
        ontimeout: () => reject(new Error('钉钉通知超时'))
      });
    });
  }

  function formatNotifyMetric(value, suffix) {
    if (value === null || value === undefined || value === '') return '-';
    const number = Number(value);
    if (!Number.isFinite(number)) return '-';
    const text = number.toFixed(2).replace(/\.?0+$/, '');
    return suffix ? `${text}${suffix}` : text;
  }

  function buildDingTalkRechargeSummary(tasks) {
    const list = (tasks || []).filter(task => task && task.accountName);
    const totalAmount = list.reduce((sum, task) => sum + Number(task.amount || 0), 0);

    const lines = [
      `${getDingTalkConfig().keyword} 批量提交提醒`,
      `时间：${formatDateTime(Date.now())}`,
      `提交账号数：${list.length}`,
      `提交总金额：${formatNotifyMetric(totalAmount, '元')}`,
      '',
      '明细：'
    ];

    list.forEach((task, index) => {
      lines.push(
        `${index + 1}. ${task.accountName}`,
        `   充值金额：${formatNotifyMetric(task.amount, '元')}`,
        `   充值前余额：${formatNotifyMetric(task.balance, '元')}，花费：${formatNotifyMetric(task.spend, '元')}，投产：${formatNotifyMetric(task.roi, '')}`,
        `   规则：${task.ruleName || '默认'} / ${task.triggerReason || '余额/ROI规则'}`
      );
    });

    lines.push(
      '',
      '说明：这是脚本已提交转入操作的汇总提醒，请以京准通后台最终成功记录为准。'
    );

    return lines.join('\n');
  }

  async function notifyDingTalkRechargeBatch(tasks) {
    const ding = getDingTalkConfig();
    if (!ding.enabled) {
      showStatus('钉钉通知未开启：请在运行设置里勾选「开启钉钉通知」');
      return;
    }

    if (!ding.webhook) {
      showStatus('钉钉通知未发送：请在运行设置里填写钉钉机器人链接');
      return;
    }

    const list = (tasks || []).filter(task => task && task.accountName);
    if (!list.length) return;

    try {
      const url = await signDingTalkUrl(ding.webhook, ding.secret);
      const content = buildDingTalkRechargeSummary(list);

      await postDingTalkJson(url, {
        msgtype: 'text',
        text: {
          content
        }
      });

      showStatus(`钉钉汇总通知已发送：${list.length}个账号`);
    } catch (err) {
      console.error('钉钉通知发送失败', err);
      showStatus(`钉钉通知发送失败：${err && err.message ? err.message : err}`);
    }
  }

  async function notifyDingTalkRecharge(task) {
    return notifyDingTalkRechargeBatch([task]);
  }

  async function sendDingTalkTestMessage() {
    const ding = getDingTalkConfig();
    if (!ding.webhook) {
      showStatus('钉钉测试失败：请先在运行设置里填写钉钉机器人链接');
      window.alert('请先在工作台「运行设置」填写钉钉机器人链接。');
      return;
    }

    try {
      const url = await signDingTalkUrl(ding.webhook, ding.secret);
      const content = [
        `${ding.keyword} 测试消息`,
        `时间：${formatDateTime(Date.now())}`,
        '如果你能看到这条消息，说明钉钉机器人链接配置成功。',
        ding.enabled ? '当前正式充值通知：已开启' : '当前正式充值通知：未开启，请在运行设置里勾选「开启钉钉通知」'
      ].join('\n');

      await postDingTalkJson(url, {
        msgtype: 'text',
        text: {
          content
        }
      });

      showStatus('钉钉测试消息已发送成功');
      window.alert('钉钉测试消息已发送成功，请到钉钉群里查看。');
    } catch (err) {
      console.error('钉钉测试消息发送失败', err);
      showStatus(`钉钉测试消息发送失败：${err && err.message ? err.message : err}`);
      window.alert(`钉钉测试消息发送失败：${err && err.message ? err.message : err}`);
    }
  }

  function getRechargeLogs() {
    const logs = readJsonValue(STORAGE_RECHARGE_LOGS, []);
    return Array.isArray(logs) ? logs : [];
  }

  function setRechargeLogs(logs) {
    writeJsonValue(STORAGE_RECHARGE_LOGS, (logs || []).slice(0, CONFIG.rechargeLogLimit));
  }

  function makeLogId() {
    return String(Date.now()) + '_' + Math.random().toString(16).slice(2);
  }

  function addRechargeLog(task, status) {
    if (!task || !task.accountName) return;

    const finalStatus = status || '已提交';
    const submitted = String(finalStatus).indexOf('已提交') === 0;
    const hasBaseline = Number.isFinite(Number(task.balance)) && Number.isFinite(Number(task.spend));

    const logs = getRechargeLogs();
    logs.unshift({
      id: makeLogId(),
      time: Date.now(),
      accountName: task.accountName,
      amount: task.amount,
      ruleName: task.ruleName || '默认',
      triggerReason: task.triggerReason || '余额/ROI规则',
      status: finalStatus,
      // 到账核对用的基准：提交那一刻这个子账号的余额和今日累计花费。
      balanceBefore: hasBaseline ? Number(task.balance) : null,
      spendBefore: hasBaseline ? Number(task.spend) : null,
      arrivalState: submitted ? (hasBaseline ? ARRIVAL_PENDING : ARRIVAL_UNKNOWN) : ARRIVAL_NA,
      arrivalNote: submitted && !hasBaseline ? '这笔没有余额基准（例如固定时间充值），无法自动核对' : '',
      arrivalCheckedAt: 0
    });

    setRechargeLogs(logs);
    refreshRechargeLogPanel();
    refreshBudgetPanel();
  }

  // =========================
  // 到账核对
  // 主判据：下一轮读到的余额比充值前高，就判定充上了。
  // 备用判据：这期间花得比充值还多时余额会反而下降，此时用
  //   应有余额 = 充值前余额 − 期间消耗 + 充值金额
  // 兜一下，避免把已经到账的误判成没到账。
  // =========================
  function isArrivalPendingLog(log) {
    return !!log && log.arrivalState === ARRIVAL_PENDING;
  }

  function updateArrivalConfirmations(accounts) {
    const list = (accounts || []).filter(item => item && item.accountName);
    if (!list.length) return { confirmed: 0, missing: 0 };

    const logs = getRechargeLogs();
    const pending = logs.filter(isArrivalPendingLog);
    if (!pending.length) return { confirmed: 0, missing: 0 };

    const freshByName = new Map();
    list.forEach(item => freshByName.set(normalizeText(item.accountName), item));

    const now = Date.now();
    const timeoutMs = CONFIG.arrivalConfirmTimeoutMinutes * 60 * 1000;
    const byAccount = new Map();

    pending.forEach(log => {
      const key = normalizeText(log.accountName);
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key).push(log);
    });

    let confirmed = 0;
    let missing = 0;

    byAccount.forEach((accountLogs, key) => {
      const fresh = freshByName.get(key);
      if (!fresh) return; // 本轮没读到这个账号，留到下一轮再核对。

      const ordered = accountLogs.slice().sort((a, b) => Number(a.time) - Number(b.time));
      const baseline = ordered[0];
      const balanceBefore = Number(baseline.balanceBefore || 0);
      const freshBalance = Number(fresh.balance || 0);
      const freshSpend = Number(fresh.spend || 0);
      const spendBefore = Number(baseline.spendBefore || 0);
      const totalAmount = ordered.reduce((sum, log) => sum + Number(log.amount || 0), 0);

      // 主判据：余额比充值前高，就算充上了。
      const balanceRose = freshBalance > balanceBefore;

      // 备用判据：如果这期间花得比充值还多，余额反而会降，用「应有余额」兜住这种情况。
      // 跨天后今日花费会归零，拿不到有效消耗差，这时只认主判据。
      const spendUsable = freshSpend >= spendBefore;
      const spendDelta = spendUsable ? freshSpend - spendBefore : 0;
      const expected = balanceBefore - spendDelta + totalAmount;
      const tolerance = Math.max(CONFIG.arrivalToleranceMin, totalAmount * (1 - CONFIG.arrivalConfirmRatio));
      const expectedOk = spendUsable && spendDelta > 0 && freshBalance >= expected - tolerance;

      const arrived = balanceRose || expectedOk;
      const note = balanceRose
        ? `充值前余额 ${formatMoney(balanceBefore)} 元，现在 ${formatMoney(freshBalance)} 元，余额已上升，已提交 ${formatMoney(totalAmount)} 元`
        : `充值前余额 ${formatMoney(balanceBefore)} 元，期间消耗 ${formatMoney(spendDelta)} 元，` +
          `已提交 ${formatMoney(totalAmount)} 元，应有余额约 ${formatMoney(expected)} 元，实际 ${formatMoney(freshBalance)} 元`;

      if (arrived) {
        ordered.forEach(log => {
          log.arrivalState = ARRIVAL_CONFIRMED;
          log.arrivalNote = note;
          log.arrivalCheckedAt = now;
        });
        confirmed += ordered.length;
        return;
      }

      ordered.forEach(log => {
        log.arrivalCheckedAt = now;
        if (now - Number(log.time || 0) < timeoutMs) {
          log.arrivalNote = `${note}（还在观察，超过 ${CONFIG.arrivalConfirmTimeoutMinutes} 分钟仍对不上才会标记）`;
          return;
        }
        log.arrivalState = ARRIVAL_MISSING;
        log.arrivalNote = `${note}。超过 ${CONFIG.arrivalConfirmTimeoutMinutes} 分钟仍对不上，请到京准通后台核对这一笔`;
        missing += 1;
      });
    });

    if (confirmed || missing) {
      setRechargeLogs(logs);
      refreshRechargeLogPanel();
    } else {
      setRechargeLogs(logs);
    }

    return { confirmed, missing };
  }

  function arrivalStateMeta(state) {
    if (state === ARRIVAL_CONFIRMED) return { text: '已到账', bg: '#dcfce7', color: '#15803d' };
    if (state === ARRIVAL_MISSING) return { text: '疑似未到账', bg: '#fef3c7', color: '#b45309' };
    if (state === ARRIVAL_PENDING) return { text: '待确认', bg: '#e2e8f0', color: '#475569' };
    if (state === ARRIVAL_UNKNOWN) return { text: '无法核对', bg: '#f1f5f9', color: '#94a3b8' };
    return { text: '—', bg: 'transparent', color: '#94a3b8' };
  }

  // =========================
  // 未充值原因记录
  // 三块数据都不随扫描次数增长：本轮快照每轮覆盖，当天统计只累加次数，原因不变时只累加轮数。
  // =========================
  const SKIP_NO_RULE = '未匹配到启用规则';
  const SKIP_NO_SLOT = '当前时段无分时规则';
  const SKIP_BALANCE = '余额未达门槛';
  const SKIP_ROI = '投产不达标';
  const SKIP_COOLDOWN = '充值冷却中';
  const SKIP_SLOT_BUDGET = '超出时段累计上限';
  const SKIP_DAILY_BUDGET = '超出当日推广预算';
  const SKIP_GROUP_QUOTA = '超出分组额度';
  const SKIP_ACCOUNT_CAP = '超出账号当天上限';
  const SKIP_IN_QUEUE = '已在充值队列中';
  const SKIP_RECENT_TASK = '刚投递过，防重复';
  const SKIP_FAILED_COOLDOWN = '失败冷却中';

  // 同一账号可能命中多条规则，取信息量最大的那个原因展示。
  const SKIP_REASON_PRIORITY = [
    SKIP_DAILY_BUDGET,
    SKIP_SLOT_BUDGET,
    SKIP_GROUP_QUOTA,
    SKIP_ACCOUNT_CAP,
    SKIP_FAILED_COOLDOWN,
    SKIP_IN_QUEUE,
    SKIP_RECENT_TASK,
    SKIP_COOLDOWN,
    SKIP_ROI,
    SKIP_BALANCE,
    SKIP_NO_SLOT,
    SKIP_NO_RULE
  ];

  function pickSkipReason(candidates) {
    const list = (candidates || []).filter(Boolean);
    if (!list.length) return { key: SKIP_NO_RULE, detail: '本轮没有命中任何充值条件' };

    for (const key of SKIP_REASON_PRIORITY) {
      const hit = list.find(item => item.key === key);
      if (hit) return hit;
    }

    return list[0];
  }

  function getScanSnapshot() {
    const snapshot = readJsonValue(STORAGE_SCAN_SNAPSHOT, null);
    if (!snapshot || !snapshot.time) return null;
    return todayKeyFromTime(snapshot.time) === todayKey() ? snapshot : null;
  }

  function getSkipReasonStats() {
    const saved = readJsonValue(STORAGE_SKIP_REASON_STATS, {});
    if (!saved || saved.date !== todayKey()) return { date: todayKey(), items: {} };
    return { date: saved.date, items: saved.items || {} };
  }

  function getSkipReasonState() {
    const saved = readJsonValue(STORAGE_SKIP_REASON_STATE, {});
    if (!saved || saved.date !== todayKey()) return { date: todayKey(), map: {} };
    return { date: saved.date, map: saved.map || {} };
  }

  function getSkipReasonChanges() {
    const list = readJsonValue(STORAGE_SKIP_REASON_CHANGES, []);
    return Array.isArray(list) ? list : [];
  }

  function setSkipReasonChanges(list) {
    writeJsonValue(STORAGE_SKIP_REASON_CHANGES, (list || []).slice(0, CONFIG.skipChangeLogLimit));
  }

  function recordScanOutcome(result) {
    const now = Date.now();
    const rows = (result && result.skipRows ? result.skipRows : []).filter(row => row && row.accountName);

    writeJsonValue(STORAGE_SCAN_SNAPSHOT, {
      time: now,
      scanned: Math.max(0, Number((result && result.scanned) || 0)),
      matched: Math.max(0, Number((result && result.matched) || 0)),
      submitted: Math.max(0, Number((result && result.submitted) || 0)),
      mode: (result && result.mode) || '正常运行',
      rows
    });

    const stats = getSkipReasonStats();
    const state = getSkipReasonState();
    const changes = getSkipReasonChanges();
    const seen = {};

    rows.forEach(row => {
      const key = row.reasonKey || SKIP_NO_RULE;
      const item = stats.items[key] || { count: 0, lastTime: 0, accounts: [] };
      item.count = Number(item.count || 0) + 1;
      item.lastTime = now;
      if (item.accounts.indexOf(row.accountName) < 0) item.accounts.push(row.accountName);
      stats.items[key] = item;

      const nameKey = normalizeText(row.accountName);
      seen[nameKey] = true;
      const previous = state.map[nameKey];

      if (previous && previous.reasonKey === key) {
        previous.rounds = Number(previous.rounds || 1) + 1;
        previous.lastTime = now;
        const entry = changes.find(change => change.id === previous.changeId);
        if (entry) {
          entry.rounds = previous.rounds;
          entry.detail = row.reasonDetail || entry.detail;
        }
        return;
      }

      const changeId = makeLogId();
      changes.unshift({
        id: changeId,
        time: now,
        accountName: row.accountName,
        fromReason: previous ? previous.reasonKey : '',
        toReason: key,
        detail: row.reasonDetail || '',
        rounds: 1
      });
      state.map[nameKey] = { reasonKey: key, rounds: 1, changeId, lastTime: now };
    });

    // 本轮已充值或已不在跳过名单里的账号，结束它的原因状态，下次再跳过会重新记一条。
    Object.keys(state.map).forEach(nameKey => {
      if (!seen[nameKey]) delete state.map[nameKey];
    });

    writeJsonValue(STORAGE_SKIP_REASON_STATS, stats);
    writeJsonValue(STORAGE_SKIP_REASON_STATE, state);
    setSkipReasonChanges(changes);
    refreshRechargeLogPanel();
  }

  // =========================
  // 子账号名单与分组
  // 名单来自京小洁页面，分组只是给子账号打标签，用来做第 4 级额度分配。
  // =========================
  function defaultAccountGroups() {
    return [
      { id: UNGROUPED_ID, name: '未分组', quotaMode: 'none', quotaValue: 0, amount: null, minRoi: null }
    ];
  }

  function normalizeAccountGroup(group) {
    const item = group || {};
    const mode = ['percent', 'fixed', 'none'].indexOf(item.quotaMode) >= 0 ? item.quotaMode : 'none';
    const value = Math.max(0, Number(item.quotaValue || 0));

    return {
      id: String(item.id || makeLogId()),
      name: String(item.name || '未命名分组').trim() || '未命名分组',
      quotaMode: mode,
      quotaValue: mode === 'percent' ? Math.min(1000, value) : value,
      amount: item.amount === null || item.amount === '' || item.amount === undefined ? null : Math.max(0, Number(item.amount)),
      minRoi: item.minRoi === null || item.minRoi === '' || item.minRoi === undefined ? null : Math.max(0, Number(item.minRoi))
    };
  }

  function getAccountGroups() {
    const saved = readJsonValue(STORAGE_ACCOUNT_GROUPS, null);
    const list = Array.isArray(saved) && saved.length ? saved.map(normalizeAccountGroup) : defaultAccountGroups();

    if (!list.some(group => group.id === UNGROUPED_ID)) {
      list.unshift(defaultAccountGroups()[0]);
    }

    // 未分组固定排在最前面。
    return list.sort((a, b) => (a.id === UNGROUPED_ID ? -1 : b.id === UNGROUPED_ID ? 1 : 0));
  }

  function saveAccountGroups(groups) {
    writeJsonValue(STORAGE_ACCOUNT_GROUPS, (groups || []).map(normalizeAccountGroup));
  }

  function getAccountGroup(groupId) {
    const groups = getAccountGroups();
    return groups.find(group => group.id === groupId) || groups.find(group => group.id === UNGROUPED_ID);
  }

  function normalizeRosterAccount(account) {
    const item = account || {};
    const optionalNumber = value =>
      value === null || value === '' || value === undefined ? null : Math.max(0, Number(value));

    return {
      accountName: String(item.accountName || '').trim(),
      groupId: String(item.groupId || UNGROUPED_ID),
      dailyCap: optionalNumber(item.dailyCap),
      amount: optionalNumber(item.amount),
      minRoi: optionalNumber(item.minRoi),
      balance: Number(item.balance || 0),
      spend: Number(item.spend || 0),
      roi: Number(item.roi || 0),
      updatedAt: Number(item.updatedAt || 0)
    };
  }

  function getAccountRoster() {
    const saved = readJsonValue(STORAGE_ACCOUNT_ROSTER, null);
    const list = Array.isArray(saved && saved.accounts) ? saved.accounts : [];
    const groupIds = getAccountGroups().map(group => group.id);

    return list
      .map(normalizeRosterAccount)
      .filter(item => item.accountName)
      .map(item => (groupIds.indexOf(item.groupId) >= 0 ? item : Object.assign({}, item, { groupId: UNGROUPED_ID })));
  }

  function getAccountRosterMeta() {
    const saved = readJsonValue(STORAGE_ACCOUNT_ROSTER, null);
    return {
      time: Number((saved && saved.time) || 0),
      count: getAccountRoster().length
    };
  }

  function saveAccountRoster(accounts, options) {
    writeJsonValue(STORAGE_ACCOUNT_ROSTER, {
      time: (options && options.keepTime) ? getAccountRosterMeta().time : Date.now(),
      accounts: (accounts || []).map(normalizeRosterAccount).filter(item => item.accountName)
    });
  }

  function findRosterAccount(accountName) {
    const key = normalizeText(accountName);
    if (!key) return null;
    return getAccountRoster().find(item => normalizeText(item.accountName) === key) || null;
  }

  // 把页面读到的子账号并进名单，保留已有的分组和额度设置。
  function mergeAccountsIntoRoster(accounts) {
    const list = (accounts || []).filter(item => item && item.accountName);
    if (!list.length) return { added: 0, updated: 0 };

    const roster = getAccountRoster();
    const indexByName = new Map(roster.map((item, index) => [normalizeText(item.accountName), index]));
    const now = Date.now();
    let added = 0;
    let updated = 0;

    list.forEach(account => {
      const key = normalizeText(account.accountName);
      const patch = {
        balance: Number(account.balance || 0),
        spend: Number(account.spend || 0),
        roi: Number(account.roi || 0),
        updatedAt: now
      };

      if (indexByName.has(key)) {
        roster[indexByName.get(key)] = normalizeRosterAccount(Object.assign({}, roster[indexByName.get(key)], patch));
        updated += 1;
        return;
      }

      roster.push(normalizeRosterAccount(Object.assign({
        accountName: account.accountName,
        groupId: UNGROUPED_ID
      }, patch)));
      indexByName.set(key, roster.length - 1);
      added += 1;
    });

    saveAccountRoster(roster);
    return { added, updated };
  }

  function getGroupAccountNames(groupId) {
    return getAccountRoster()
      .filter(item => item.groupId === groupId)
      .map(item => item.accountName);
  }

  // 分组当天额度：百分比按店铺当天预算折算，固定金额直接用，none 表示不限。
  function getGroupDailyQuota(group, settings) {
    const item = group || getAccountGroup(UNGROUPED_ID);
    if (item.quotaMode === 'none') return null;
    if (item.quotaMode === 'fixed') return Math.max(0, Number(item.quotaValue || 0));

    const budget = getDailyBudgetAmount(settings || getBudgetSettings());
    if (!(budget > 0)) return null;
    return budget * Math.max(0, Number(item.quotaValue || 0)) / 100;
  }

  // 分组沿用店铺那套分时比例，不单独配置。
  function getGroupSlotQuota(group, settings, slot) {
    const daily = getGroupDailyQuota(group, settings);
    if (daily === null) return null;

    const item = settings || getBudgetSettings();
    const currentSlot = slot || getCurrentBudgetSlot(item);
    const percent = Number((currentSlot && currentSlot.percent) || 0);
    if (!(percent > 0)) return 0;

    return daily * percent / 100;
  }

  // 一次扫完当天日志，避免每个账号都重新遍历一遍。
  function getTodaySubmittedAmountMap() {
    const today = todayKey();
    const map = new Map();

    getRechargeLogs().forEach(log => {
      if (!log || !isSubmittedRechargeLog(log)) return;
      if (todayKeyFromTime(log.time) !== today) return;
      const key = normalizeText(log.accountName);
      map.set(key, Number(map.get(key) || 0) + Number(log.amount || 0));
    });

    return map;
  }

  function getTodaySubmittedAmountByAccount(accountName, submittedMap) {
    const map = submittedMap || getTodaySubmittedAmountMap();
    return Number(map.get(normalizeText(accountName)) || 0);
  }

  function getPendingAmountByAccount(accountName, excludeAccountName) {
    const key = normalizeText(accountName);
    if (excludeAccountName && normalizeText(excludeAccountName) === key) return 0;

    const rows = [];
    const current = getCurrent();
    if (current) rows.push(current);
    getQueue().forEach(item => rows.push(item));

    return rows.reduce((sum, item) => {
      if (!item || normalizeText(item.accountName) !== key) return sum;
      return sum + Number(item.amount || 0);
    }, 0);
  }

  function getGroupUsedAmount(groupId, options) {
    const exclude = options && options.excludeAccountName;
    const includePending = !options || options.includePending !== false;
    const submittedMap = (options && options.submittedMap) || getTodaySubmittedAmountMap();

    return getGroupAccountNames(groupId).reduce((sum, name) => {
      const submitted = getTodaySubmittedAmountByAccount(name, submittedMap);
      const pending = includePending ? getPendingAmountByAccount(name, exclude) : 0;
      return sum + submitted + pending;
    }, 0);
  }

  function getAccountUsedAmount(accountName, options) {
    const exclude = options && options.excludeAccountName;
    const includePending = !options || options.includePending !== false;
    const submittedMap = (options && options.submittedMap) || getTodaySubmittedAmountMap();
    const submitted = getTodaySubmittedAmountByAccount(accountName, submittedMap);
    const pending = includePending ? getPendingAmountByAccount(accountName, exclude) : 0;
    return submitted + pending;
  }

  // 第 3 / 第 4 级：分组额度和账号当天上限，返回还能充多少以及是谁卡住的。
  function evaluateAccountAllocation(accountName, options) {
    const settings = (options && options.settings) || getBudgetSettings();
    const slot = (options && options.slot) || getCurrentBudgetSlot(settings);
    const rosterAccount = findRosterAccount(accountName);
    const group = getAccountGroup(rosterAccount ? rosterAccount.groupId : UNGROUPED_ID);
    const groupQuota = getGroupSlotQuota(group, settings, slot);
    const groupUsed = groupQuota === null ? 0 : getGroupUsedAmount(group.id, options);
    const groupRemaining = groupQuota === null ? null : Math.max(0, groupQuota - groupUsed);
    const accountCap = rosterAccount && rosterAccount.dailyCap !== null ? Number(rosterAccount.dailyCap) : null;
    const accountUsed = accountCap === null ? 0 : getAccountUsedAmount(accountName, options);
    const accountRemaining = accountCap === null ? null : Math.max(0, accountCap - accountUsed);

    return {
      group,
      rosterAccount,
      groupQuota,
      groupUsed,
      groupRemaining,
      accountCap,
      accountUsed,
      accountRemaining
    };
  }

  // 条件覆盖：账号单独设置 > 所在分组 > 全店规则。
  function resolveAccountCondition(accountName) {
    const rosterAccount = findRosterAccount(accountName);
    const group = getAccountGroup(rosterAccount ? rosterAccount.groupId : UNGROUPED_ID);
    const result = { amount: null, minRoi: null, amountSource: '', minRoiSource: '', group, rosterAccount };

    if (group && group.amount !== null) {
      result.amount = group.amount;
      result.amountSource = `分组「${group.name}」`;
    }
    if (group && group.minRoi !== null) {
      result.minRoi = group.minRoi;
      result.minRoiSource = `分组「${group.name}」`;
    }
    if (rosterAccount && rosterAccount.amount !== null) {
      result.amount = rosterAccount.amount;
      result.amountSource = '账号单独设置';
    }
    if (rosterAccount && rosterAccount.minRoi !== null) {
      result.minRoi = rosterAccount.minRoi;
      result.minRoiSource = '账号单独设置';
    }

    return result;
  }

  function makeSkipRow(account, reason, extraDetail) {
    return {
      accountName: (account && account.accountName) || '',
      balance: Number((account && account.balance) || 0),
      roi: Number((account && account.roi) || 0),
      reasonKey: reason.key,
      reasonDetail: extraDetail ? `${reason.detail}${extraDetail}` : reason.detail
    };
  }

  function formatMoney(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return '0';
    return (Math.round(num * 100) / 100).toFixed(2).replace(/\.00$/, '');
  }

  function formatRatio(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return '0';
    return String(Math.round(num * 1000) / 1000);
  }

  function yesterdayKey(today) {
    const parts = String(today || todayKey()).split('-').map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    date.setDate(date.getDate() - 1);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function defaultBudgetSlots() {
    return (CONFIG.budgetSlots || []).map(slot => ({
      startHour: Number(slot.startHour),
      endHour: Number(slot.endHour),
      percent: Number(slot.percent)
    }));
  }

  // 时段和累计上限都可以在工作台「店铺分时规则」页自行修改，这里只做清洗和排序。
  function normalizeBudgetSlots(slots) {
    const list = Array.isArray(slots) ? slots : [];

    const cleaned = list.map(item => {
      const startRaw = Number((item || {}).startHour);
      const endRaw = Number((item || {}).endHour);
      const percentRaw = Number((item || {}).percent);
      const startHour = Math.max(0, Math.min(23, Number.isFinite(startRaw) ? Math.round(startRaw) : 0));
      const endHour = Math.max(startHour + 1, Math.min(24, Number.isFinite(endRaw) ? Math.round(endRaw) : startHour + 1));

      return {
        startHour,
        endHour,
        percent: Math.max(0, Math.min(100, Number.isFinite(percentRaw) ? percentRaw : 0))
      };
    }).filter(slot => slot.endHour > slot.startHour);

    if (!cleaned.length) return defaultBudgetSlots();

    return cleaned.sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour);
  }

  function getBudgetSlotIssues(slots) {
    const list = normalizeBudgetSlots(slots);
    const issues = [];

    list.forEach((slot, index) => {
      const previous = list[index - 1];
      if (!previous) return;
      if (slot.startHour !== previous.endHour) {
        issues.push(`${formatSlotRange(previous)} 和 ${formatSlotRange(slot)} 之间时间不连续`);
      }
      if (slot.percent < previous.percent) {
        issues.push(`${formatSlotRange(slot)} 的累计上限 ${formatRatio(slot.percent)}% 低于上一个时段，累计上限应逐段增大`);
      }
    });

    if (list.length && list[0].startHour !== 0) {
      issues.push('第一个时段建议从 00:00 开始，否则 00:00 之后到第一个时段之前不受预算控制');
    }

    if (list.length && list[list.length - 1].endHour !== 24) {
      issues.push('最后一个时段建议到 24:00 结束，否则当天最后一段不受预算控制');
    }

    return issues;
  }

  function defaultBudgetSettings() {
    return {
      enabled: true, // 是否启用店铺当天预算控制。
      avgGmv7d: 0, // 近七天平均业绩，单位元。
      combinedFeePercent: 0, // 推广和退货合计费比，按百分数填写，例如 15 表示 15%。
      returnRatePercent: 0, // 店铺退货率，按百分数填写，例如 8 表示 8%。
      targetShopRoi: CONFIG.targetShopRoi, // 店铺投产达标值，当前店铺投产大于等于该值才可能允许超预算。
      budgetSlots: defaultBudgetSlots() // 分时累计上限，百分比对应当天预算。
    };
  }

  function normalizeBudgetSettings(settings) {
    const item = Object.assign({}, defaultBudgetSettings(), settings || {});
    item.enabled = item.enabled !== false;
    item.avgGmv7d = Math.max(0, Number(item.avgGmv7d || 0));
    item.combinedFeePercent = Math.max(0, Number(item.combinedFeePercent || 0));
    item.returnRatePercent = Math.max(0, Number(item.returnRatePercent || 0));
    item.targetShopRoi = Math.max(0, Number(item.targetShopRoi || CONFIG.targetShopRoi));
    item.budgetSlots = normalizeBudgetSlots(item.budgetSlots);
    return item;
  }

  function getBudgetSettings() {
    return normalizeBudgetSettings(readJsonValue(STORAGE_BUDGET_SETTINGS, {}));
  }

  function saveBudgetSettings(settings) {
    writeJsonValue(STORAGE_BUDGET_SETTINGS, normalizeBudgetSettings(settings));
    refreshBudgetPanel({ fillInputs: true });
  }

  function getPromotionFeePercent(settings) {
    const item = settings || getBudgetSettings();
    return Number(item.combinedFeePercent || 0) - Number(item.returnRatePercent || 0);
  }

  function getDailyBudgetAmount(settings) {
    const item = settings || getBudgetSettings();
    const feePercent = getPromotionFeePercent(item);
    if (!(item.avgGmv7d > 0) || !(feePercent > 0)) return 0;
    return item.avgGmv7d * feePercent / 100;
  }

  function getBudgetSlots(settings) {
    return normalizeBudgetSlots((settings || getBudgetSettings()).budgetSlots);
  }

  function formatSlotRange(slot) {
    if (!slot) return '';
    const endHour = Number(slot.endHour);
    const endText = endHour >= 24 ? '24:00' : formatClock(endHour, 0);
    return `${formatClock(slot.startHour, 0)}-${endText}`;
  }

  function sameBudgetSlot(a, b) {
    return !!a && !!b && Number(a.startHour) === Number(b.startHour) && Number(a.endHour) === Number(b.endHour);
  }

  function getCurrentBudgetSlot(settings, now) {
    const slots = getBudgetSlots(settings);
    const date = now || new Date();
    const currentMinutes = date.getHours() * 60 + date.getMinutes();

    for (const slot of slots) {
      const startMinutes = Number(slot.startHour) * 60;
      const endMinutes = Number(slot.endHour) >= 24 ? 24 * 60 : Number(slot.endHour) * 60;
      if (currentMinutes >= startMinutes && currentMinutes < endMinutes) return slot;
    }

    return slots[slots.length - 1] || null;
  }

  function getSlotBudgetAmount(settings, slot) {
    const daily = getDailyBudgetAmount(settings);
    const percent = Number((slot || getCurrentBudgetSlot(settings)).percent || 0);
    if (!(daily > 0) || !(percent > 0)) return 0;
    return daily * percent / 100;
  }

  function isBudgetConfigured(settings) {
    const item = settings || getBudgetSettings();
    return Number(item.avgGmv7d) > 0 && Number(item.combinedFeePercent) > 0;
  }

  function isBudgetControlActive(settings) {
    const item = settings || getBudgetSettings();
    return item.enabled !== false && isBudgetConfigured(item);
  }

  function isSubmittedRechargeLog(log) {
    const status = String((log && log.status) || '已提交');
    return status === '已提交' || status.indexOf('已提交') === 0;
  }

  function getTodaySubmittedAmount() {
    const today = todayKey();
    return getRechargeLogs().reduce((sum, log) => {
      if (!log || !isSubmittedRechargeLog(log)) return sum;
      if (todayKeyFromTime(log.time) !== today) return sum;
      return sum + Number(log.amount || 0);
    }, 0);
  }

  function isMetricsFromToday(metrics) {
    const snapshot = metrics || getShopMetricsSnapshot();
    if (!snapshot) return false;
    const snapshotDate = snapshot.date || (snapshot.time ? todayKeyFromTime(snapshot.time) : '');
    return !snapshotDate || snapshotDate === todayKey();
  }

  // 跨天后京小洁页面常常还显示昨天的数据。凌晨读到的花费和昨天总花费几乎一样时，判为过期读数。
  function isStaleSpendReading(metrics) {
    const spend = Number((metrics && metrics.spend) || 0);
    if (!(spend > 0)) return false;
    if (new Date().getHours() >= CONFIG.staleSpendGuardUntilHour) return false;

    const yesterday = getShopDailyGmvMap()[yesterdayKey(todayKey())];
    const yesterdaySpend = Number((yesterday && yesterday.spend) || 0);
    if (!(yesterdaySpend > 0)) return false;

    return spend >= yesterdaySpend * CONFIG.staleSpendRatio;
  }

  function getTodaySpendAmount(metrics) {
    const snapshot = metrics || getShopMetricsSnapshot();
    if (!snapshot) return 0;
    if (!isMetricsFromToday(snapshot)) return 0;
    if (snapshot.staleSpend) return 0;
    const spend = Number(snapshot.spend || 0);
    return Number.isFinite(spend) && spend > 0 ? spend : 0;
  }

  function getTodayUsedSeed(metrics) {
    const today = todayKey();
    const spend = getTodaySpendAmount(metrics);
    const submitted = getTodaySubmittedAmount();
    const saved = readJsonValue(STORAGE_BUDGET_USED_SEED, {});
    let amount = saved.date === today ? Math.max(0, Number(saved.amount || 0)) : 0;

    if (!(submitted > 0)) {
      // 当天还没有脚本充值记录时，已用基数跟随页面已消耗；页面切到新一天后要能跟着降下来。
      amount = spend;
    } else if (spend > amount) {
      amount = spend;
    }

    if (saved.date !== today || Number(saved.amount || 0) !== amount) {
      writeJsonValue(STORAGE_BUDGET_USED_SEED, {
        date: today,
        amount
      });
    }

    return amount;
  }

  function getTodayCountedUsedAmount(metrics) {
    return Math.max(getTodaySubmittedAmount(), getTodayUsedSeed(metrics));
  }

  function todayKeyFromTime(time) {
    const date = new Date(time || Date.now());
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function getPendingRechargeAmount(excludeAccountName) {
    const rows = [];
    const current = getCurrent();
    const queue = getQueue();

    if (current) rows.push(current);
    queue.forEach(item => rows.push(item));

    return rows.reduce((sum, item) => {
      if (!item || !item.accountName) return sum;
      if (excludeAccountName && sameAccount(item.accountName, excludeAccountName)) return sum;
      return sum + Number(item.amount || 0);
    }, 0);
  }

  function getShopMetricsSnapshot() {
    return readJsonValue(STORAGE_SHOP_METRIC_SNAPSHOT, null);
  }

  function getShopDailyGmvMap() {
    return readJsonValue(STORAGE_SHOP_DAILY_GMV, {});
  }

  function readShopRowMetrics() {
    if (!isJxjSite()) return null;

    const shopRow = getVisibleRows().find(isTargetShopRow);
    if (!shopRow) return null;

    const cells = getCells(shopRow);
    if (cells.length < 5) return null;

    const spend = parseNumber(cells[3]);
    const roi = parseNumber(cells[4]);
    if (!(spend > 0) && !(roi > 0)) return null;

    return {
      source: 'shop_row',
      spend,
      roi,
      gmv: spend * roi,
      accountCount: 0,
      time: Date.now(),
      date: todayKey()
    };
  }

  function aggregateChildMetrics(accounts) {
    let spend = 0;
    let gmv = 0;
    let count = 0;

    for (const item of accounts || []) {
      const itemSpend = Number(item.spend || 0);
      const itemRoi = Number(item.roi || 0);
      spend += itemSpend;
      gmv += itemSpend * itemRoi;
      count += 1;
    }

    return {
      source: 'child_sum',
      spend,
      roi: spend > 0 ? gmv / spend : 0,
      gmv,
      accountCount: count,
      time: Date.now(),
      date: todayKey()
    };
  }

  function updateShopMetricsSnapshot(accounts) {
    const childMetrics = aggregateChildMetrics(accounts);
    const shopRowMetrics = readShopRowMetrics();
    const metrics = shopRowMetrics && (shopRowMetrics.spend > 0 || shopRowMetrics.gmv > 0)
      ? Object.assign({}, shopRowMetrics, { accountCount: childMetrics.accountCount })
      : childMetrics;

    if (isStaleSpendReading(metrics)) {
      showStatus(
        `当前页面花费 ${formatMoney(metrics.spend)} 元和昨天总花费几乎一致，判断页面还没切到新的一天。\n` +
        '本次不更新店铺花费数据，今日已用金额仍按 0 起算。'
      );
      return Object.assign({}, metrics, { staleSpend: true });
    }

    writeJsonValue(STORAGE_SHOP_METRIC_SNAPSHOT, metrics);

    const daily = getShopDailyGmvMap();
    daily[metrics.date] = {
      gmv: metrics.gmv,
      spend: metrics.spend,
      roi: metrics.roi,
      time: metrics.time
    };
    writeJsonValue(STORAGE_SHOP_DAILY_GMV, daily);
    refreshBudgetPanel();
    return metrics;
  }

  function getElapsedDayFraction() {
    const now = new Date();
    return (now.getHours() * 60 + now.getMinutes()) / (24 * 60);
  }

  function isShopRoiQualified(metrics, settings) {
    const item = settings || getBudgetSettings();
    const snapshot = metrics || getShopMetricsSnapshot();
    if (!snapshot) return false;
    if (!isMetricsFromToday(snapshot)) return false; // 昨天的投产不能用来放开今天的预算。
    return Number(snapshot.roi || 0) >= Number(item.targetShopRoi || 0);
  }

  function isSalesGrowing(metrics, settings) {
    const item = settings || getBudgetSettings();
    const snapshot = metrics || getShopMetricsSnapshot();
    const avgGmv7d = Number(item.avgGmv7d || 0);
    const currentGmv = Number(snapshot && snapshot.gmv || 0);

    if (!(avgGmv7d > 0) || !(currentGmv > 0)) return false;
    if (currentGmv > avgGmv7d) return true;

    const elapsedFraction = getElapsedDayFraction();
    if (elapsedFraction < (2 * 60) / (24 * 60)) return false;

    return currentGmv > avgGmv7d * elapsedFraction;
  }

  function canExceedDailyBudget(metrics, settings) {
    return isShopRoiQualified(metrics, settings);
  }

  function evaluateDailyBudget(options) {
    const settings = normalizeBudgetSettings((options && options.settings) || getBudgetSettings());
    const metrics = (options && options.metrics) || getShopMetricsSnapshot();
    const excludeAccountName = options && options.excludeAccountName;
    const includePending = !options || options.includePending !== false;
    const submitted = getTodaySubmittedAmount();
    const consumed = getTodaySpendAmount(metrics);
    const counted = getTodayCountedUsedAmount(metrics);
    const pending = includePending ? getPendingRechargeAmount(excludeAccountName) : 0;
    const used = counted + pending;
    const budget = getDailyBudgetAmount(settings);
    const slot = getCurrentBudgetSlot(settings);
    const slotBudget = getSlotBudgetAmount(settings, slot);
    const cap = Math.min(Number(budget || 0), Number(slotBudget || 0));
    const remaining = Math.max(0, cap - used);
    const dailyRemaining = Math.max(0, Number(budget || 0) - used);
    const configured = isBudgetConfigured(settings);
    const active = isBudgetControlActive(settings);
    const roiOk = isShopRoiQualified(metrics, settings);
    const salesGrowing = isSalesGrowing(metrics, settings);
    const canExceed = canExceedDailyBudget(metrics, settings);
    const usedFromSpend = counted > submitted;

    return {
      settings,
      metrics,
      submitted,
      consumed,
      counted,
      pending,
      used,
      usedFromSpend,
      budget,
      slot,
      slotBudget,
      cap,
      remaining,
      dailyRemaining,
      configured,
      active,
      roiOk,
      salesGrowing,
      canExceed,
      promotionFeePercent: getPromotionFeePercent(settings)
    };
  }

  function prepareTasksWithDailyBudget(tasks, options) {
    const list = (tasks || []).filter(item => item && item.accountName);
    const decision = evaluateDailyBudget(options);
    const skipped = [];
    const messages = [];

    // 店铺这一级放行时，分组额度和账号上限仍然要卡。
    const passShopLevel = () => {
      const allocated = applyGroupAndAccountQuota(list, decision, options);
      return {
        tasks: allocated.tasks,
        skipped: skipped.concat(allocated.skipped),
        messages: messages.concat(allocated.messages),
        decision
      };
    };

    if (!decision.active) {
      if (decision.settings.enabled === false) {
        messages.push('店铺预算控制已关闭，本次不限制店铺总额，仍按分组额度和账号上限控制');
      } else {
        messages.push('尚未填写近七天平均业绩和合计费比，本次不限制店铺总额，仍按分组额度和账号上限控制');
      }
      return passShopLevel();
    }

    if (decision.canExceed) {
      messages.push(`店铺投产达标（${formatRatio(decision.metrics && decision.metrics.roi)} ≥ ${formatRatio(decision.settings.targetShopRoi)}），允许超过当前时段上限 ${formatMoney(decision.slotBudget)} 元和当天预算 ${formatMoney(decision.budget)} 元；分组额度和账号上限仍然生效`);
      return passShopLevel();
    }

    if (!(decision.cap > 0) && !decision.canExceed) {
      const slotText = decision.slot ? `，当前时段 ${formatSlotRange(decision.slot)} 上限 ${formatMoney(decision.slotBudget)} 元` : '';
      messages.push(`当日推广预算为 ${formatMoney(decision.budget)} 元${slotText}，且投产未达标，本次不投递充值任务`);
      return {
        tasks: [],
        skipped: list.map(task => Object.assign({}, task, {
          skipReason: `超出当前时段 ${formatSlotRange(decision.slot)} 预算上限`,
          skipLevel: 'slot'
        })),
        messages,
        decision
      };
    }

    let remaining = decision.remaining;
    const kept = [];
    const shopSkipReason = decision.used >= decision.budget
      ? '超出当日推广预算'
      : `超出当前时段 ${formatSlotRange(decision.slot)} 预算上限`;
    const shopSkipLevel = decision.used >= decision.budget ? 'daily' : 'slot';

    for (const task of list) {
      const amount = Number(task.amount || 0);

      if (amount <= remaining) {
        kept.push(task);
        remaining -= amount;
        continue;
      }

      if (remaining >= 1) {
        const adjustedAmount = Math.floor(remaining);
        kept.push(Object.assign({}, task, {
          amount: adjustedAmount,
          originalAmount: amount,
          budgetAdjusted: true,
          triggerReason: `${task.triggerReason || '余额/ROI规则'}（${formatSlotRange(decision.slot)} 预算截断 ${formatMoney(amount)}→${formatMoney(adjustedAmount)}）`
        }));
        messages.push(`${task.accountName} 受当前时段预算限制，充值金额从 ${formatMoney(amount)} 元调整为 ${formatMoney(adjustedAmount)} 元`);
        remaining = 0;
        continue;
      }

      skipped.push(Object.assign({}, task, {
        skipReason: shopSkipReason,
        skipLevel: shopSkipLevel
      }));
    }

    const slotText = `当前时段 ${formatSlotRange(decision.slot)} 上限 ${formatMoney(decision.slotBudget)} 元（当天预算 ${formatMoney(decision.budget)} 的 ${formatRatio(decision.slot && decision.slot.percent)}%）`;
    if (skipped.length) {
      messages.push(`${slotText}，已用 ${formatMoney(decision.counted)} 元，队列中 ${formatMoney(decision.pending)} 元，剩余不足，已跳过 ${skipped.length} 个账号`);
    } else if (decision.used > 0 || kept.length) {
      messages.push(`${slotText}，已用 ${formatMoney(decision.counted)} 元，当前可充值 ${formatMoney(Math.max(0, remaining))} 元`);
    }

    const allocated = applyGroupAndAccountQuota(kept, decision, options);
    return {
      tasks: allocated.tasks,
      skipped: skipped.concat(allocated.skipped),
      messages: messages.concat(allocated.messages),
      decision
    };
  }

  // 第 3 / 第 4 级：分组额度和账号当天上限。店铺和分时已经卡过一轮，这里继续往下卡。
  function applyGroupAndAccountQuota(tasks, decision, options) {
    const list = (tasks || []).filter(item => item && item.accountName);
    const kept = [];
    const skipped = [];
    const messages = [];

    if (!list.length) return { tasks: kept, skipped, messages };

    const settings = decision.settings;
    const slot = decision.slot;
    const groupRemaining = new Map();
    const accountRemaining = new Map();

    for (const task of list) {
      const info = evaluateAccountAllocation(task.accountName, {
        settings,
        slot,
        excludeAccountName: options && options.excludeAccountName,
        includePending: !options || options.includePending !== false
      });

      const groupKey = info.group.id;
      const accountKey = normalizeText(task.accountName);

      if (info.groupRemaining !== null && !groupRemaining.has(groupKey)) {
        groupRemaining.set(groupKey, info.groupRemaining);
      }
      if (info.accountRemaining !== null && !accountRemaining.has(accountKey)) {
        accountRemaining.set(accountKey, info.accountRemaining);
      }

      const limits = [];
      if (groupRemaining.has(groupKey)) {
        limits.push({
          level: 'group',
          value: groupRemaining.get(groupKey),
          reason: SKIP_GROUP_QUOTA,
          text: `分组「${info.group.name}」当前时段额度 ${formatMoney(info.groupQuota)} 元，已用 ${formatMoney(info.groupUsed)} 元`
        });
      }
      if (accountRemaining.has(accountKey)) {
        limits.push({
          level: 'account',
          value: accountRemaining.get(accountKey),
          reason: SKIP_ACCOUNT_CAP,
          text: `账号当天上限 ${formatMoney(info.accountCap)} 元，已用 ${formatMoney(info.accountUsed)} 元`
        });
      }

      if (!limits.length) {
        kept.push(task);
        continue;
      }

      const tightest = limits.reduce((a, b) => (a.value <= b.value ? a : b));
      const amount = Number(task.amount || 0);
      const deduct = value => {
        if (groupRemaining.has(groupKey)) groupRemaining.set(groupKey, Math.max(0, groupRemaining.get(groupKey) - value));
        if (accountRemaining.has(accountKey)) accountRemaining.set(accountKey, Math.max(0, accountRemaining.get(accountKey) - value));
      };

      if (amount <= tightest.value) {
        deduct(amount);
        kept.push(task);
        continue;
      }

      if (tightest.value >= 1) {
        const adjustedAmount = Math.floor(tightest.value);
        deduct(adjustedAmount);
        kept.push(Object.assign({}, task, {
          amount: adjustedAmount,
          originalAmount: amount,
          budgetAdjusted: true,
          triggerReason: `${task.triggerReason || '余额/ROI规则'}（${tightest.level === 'group' ? '分组额度' : '账号上限'}截断 ${formatMoney(amount)}→${formatMoney(adjustedAmount)}）`
        }));
        messages.push(`${task.accountName} 受${tightest.level === 'group' ? '分组额度' : '账号当天上限'}限制，充值金额从 ${formatMoney(amount)} 元调整为 ${formatMoney(adjustedAmount)} 元`);
        continue;
      }

      skipped.push(Object.assign({}, task, {
        skipReason: `${tightest.reason}：${tightest.text}`,
        skipLevel: tightest.level
      }));
      messages.push(`${task.accountName} 被${tightest.level === 'group' ? '分组额度' : '账号当天上限'}挡住：${tightest.text}`);
    }

    return { tasks: kept, skipped, messages };
  }

  function gateTaskByDailyBudget(task) {
    if (!task || !task.accountName) {
      return { skip: true, reason: '任务无效', amount: 0 };
    }

    const budgeted = prepareTasksWithDailyBudget([task], {
      excludeAccountName: task.accountName,
      includePending: true
    });

    if (budgeted.tasks.length > 0) {
      return {
        skip: false,
        amount: Number(budgeted.tasks[0].amount || 0),
        task: budgeted.tasks[0],
        messages: budgeted.messages
      };
    }

    return {
      skip: true,
      reason: (budgeted.skipped[0] && budgeted.skipped[0].skipReason) || '超出当前时段推广预算',
      amount: 0,
      messages: budgeted.messages
    };
  }

  function skipCurrentTaskForBudget(current, reason) {
    clearCurrent();
    addRechargeLog(current, reason || '超出当前时段推广预算未提交');
    refreshQueuePanel();
  }

  function budgetSummaryHtml(previewSettings) {
    const decision = evaluateDailyBudget({
      includePending: true,
      settings: previewSettings || getBudgetSettings()
    });
    const settings = decision.settings;
    const metrics = decision.metrics;
    const lines = [];

    lines.push(`推广费比 ${formatRatio(decision.promotionFeePercent)}% ＝ 合计费比 ${formatRatio(settings.combinedFeePercent)}% − 退货率 ${formatRatio(settings.returnRatePercent)}%`);
    lines.push(`当天预算 ${formatMoney(decision.budget)} 元 ＝ 近七天平均业绩 ${formatMoney(settings.avgGmv7d)} × 推广费比 ${formatRatio(decision.promotionFeePercent)}%`);

    const slotLines = getBudgetSlots(settings).map(slot => {
      const amount = getSlotBudgetAmount(settings, slot);
      const currentMark = sameBudgetSlot(slot, decision.slot) ? '（当前）' : '';
      return `${formatSlotRange(slot)} ${formatRatio(slot.percent)}% / ${formatMoney(amount)}元${currentMark}`;
    });
    if (slotLines.length) {
      lines.push(`分时累计上限：${slotLines.join('；')}`);
    }

    if (!decision.configured) {
      lines.push('请先填写近七天平均业绩和合计费比；未填写时不限制充值金额。');
    } else if (!decision.active) {
      lines.push('预算控制已关闭，当前不限制当天充值总额。');
    } else {
      lines.push(`当前时段 ${formatSlotRange(decision.slot)} 正常上限 ${formatMoney(decision.slotBudget)} 元（当天预算的 ${formatRatio(decision.slot && decision.slot.percent)}%）`);
      const usedText = decision.usedFromSpend
        ? `今日已用 ${formatMoney(decision.counted)} 元（无脚本充值记录，按已消耗 ${formatMoney(decision.consumed)} 元起算），队列中 ${formatMoney(decision.pending)} 元`
        : `今日已用 ${formatMoney(decision.counted)} 元（脚本已充 ${formatMoney(decision.submitted)} 元，已消耗 ${formatMoney(decision.consumed)} 元），队列中 ${formatMoney(decision.pending)} 元`;
      lines.push(`${usedText}，当前可充 ${formatMoney(decision.remaining)} 元，全天还剩 ${formatMoney(decision.dailyRemaining)} 元`);
    }

    if (metrics && (metrics.gmv > 0 || metrics.spend > 0 || metrics.roi > 0)) {
      const metricTime = metrics.time ? `，更新于 ${formatDateTime(metrics.time)}` : '';
      const yesterday = getShopDailyGmvMap()[yesterdayKey(todayKey())];
      lines.push(`当前店铺花费 ${formatMoney(metrics.spend)}，投产 ${formatRatio(metrics.roi)}，预估销售额 ${formatMoney(metrics.gmv)}${metricTime}`);
      if (yesterday && yesterday.gmv > 0) {
        lines.push(`昨日预估销售额 ${formatMoney(yesterday.gmv)}`);
      }
      lines.push(`投产达标：${decision.roiOk ? '是' : '否'}（目标 ≥ ${formatRatio(settings.targetShopRoi)}）`);
      lines.push(decision.canExceed
        ? '店铺投产已达标，允许超过当前时段上限和当天预算。'
        : '店铺投产未达标，按分时累计上限控制充值，18:00 后可用满当天预算。');
    } else {
      lines.push('尚未读取到店铺花费/投产数据；可在京小洁投放明细页执行一次查询后刷新这里。');
    }

    const color = !decision.configured ? '#6b7280' : decision.canExceed ? '#ad6800' : '#374151';

    return `<div style="color:${color};">${lines.map(item => `<div>${escapeHtml(item)}</div>`).join('')}</div>`;
  }

  function budgetSlotSummaryHtml() {
    const settings = getBudgetSettings();
    const slots = getBudgetSlots(settings);

    return `
      <div style="margin-top:10px;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
        <div style="font-size:12px;color:#475569;line-height:1.6;margin-bottom:6px;">
          分时累计上限已移到左侧「店铺分时规则」页，可自行增删时段、修改时间和比例。当前设置：
        </div>
        <div style="font-size:12px;color:#334155;line-height:1.7;">
          ${slots.map(slot => `${escapeHtml(formatSlotRange(slot))} ${escapeHtml(formatRatio(slot.percent))}% / ${escapeHtml(formatMoney(getSlotBudgetAmount(settings, slot)))} 元`).join('；')}
        </div>
        <button type="button" data-action="goto-slots" style="margin-top:8px;padding:6px 10px;border:1px solid #0f766e;background:#fff;color:#0f766e;border-radius:6px;cursor:pointer;font-size:12px;">去修改分时规则</button>
      </div>
    `;
  }

  function budgetSlotRowsHtml(slots) {
    const settings = getBudgetSettings();
    const list = slots || getBudgetSlots(settings);

    return list.map((slot, index) => `
      <div class="jxj-slot-row" data-slot-index="${index}" style="display:grid;grid-template-columns:88px 88px 104px minmax(0,1fr) 72px;gap:8px;align-items:center;margin-bottom:8px;">
        <input type="number" min="0" max="23" step="1" data-slot-field="startHour" value="${escapeHtml(slot.startHour)}" style="height:32px;box-sizing:border-box;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;">
        <input type="number" min="1" max="24" step="1" data-slot-field="endHour" value="${escapeHtml(slot.endHour)}" style="height:32px;box-sizing:border-box;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;">
        <input type="number" min="0" max="100" step="1" data-slot-field="percent" value="${escapeHtml(slot.percent)}" style="height:32px;box-sizing:border-box;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;">
        <div class="jxj-slot-amount" style="font-size:12px;color:#334155;line-height:1.5;">${escapeHtml(formatSlotRange(slot))} 累计不超过 <b>${escapeHtml(formatMoney(getSlotBudgetAmount(settings, slot)))}</b> 元</div>
        <button type="button" data-action="delete-slot" style="padding:6px 8px;border:1px solid #fca5a5;background:#fff;color:#b91c1c;border-radius:6px;cursor:pointer;font-size:12px;">删除</button>
      </div>
    `).join('');
  }

  function budgetSlotHintHtml(slots) {
    const issues = getBudgetSlotIssues(slots);

    if (!issues.length) {
      return '<span style="color:#15803d;">时段连续、累计上限逐段增大，可以保存。保存后总览「时段对照」会同步更新。</span>';
    }

    return `<span style="color:#b45309;">保存前请检查：${issues.map(escapeHtml).join('；')}</span>`;
  }

  // =========================
  // ③ 子账号与分组
  // =========================
  function accountRosterPageHtml() {
    return `
      ${workspaceStepBarHtml('accounts')}
      <div style="background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.6;margin-bottom:10px;">
        第 3 步：把这个店的子账号从页面拉下来存成名单，再按需要分组。分好组，第 4 步才能按组分配额度。
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:10px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
          <button type="button" data-action="pull-accounts" style="padding:7px 12px;border:1px solid #0f766e;background:#fff;color:#0f766e;border-radius:6px;cursor:pointer;font-weight:700;">从页面拉取子账号</button>
          <span id="jxj-roster-meta" style="font-size:12px;color:#64748b;margin-left:auto;"></span>
        </div>
        <div id="jxj-roster-rows">${accountRosterRowsHtml()}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px;">
          <span style="font-size:12px;color:#64748b;">批量：</span>
          <select id="jxj-roster-bulk-group" style="height:32px;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;">
            <option value="">移入分组…</option>
            ${getAccountGroups().map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('')}
          </select>
          <button type="button" data-action="bulk-move-group" style="padding:7px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">应用</button>
          <button type="button" data-action="bulk-make-rules" style="padding:7px 10px;border:1px solid #2563eb;background:#fff;color:#2563eb;border-radius:6px;cursor:pointer;">为选中账号生成充值规则</button>
          <button type="button" data-action="bulk-remove-accounts" style="padding:7px 10px;border:1px solid #fca5a5;background:#fff;color:#b91c1c;border-radius:6px;cursor:pointer;">从名单移除</button>
          <button type="button" data-action="save-roster" style="margin-left:auto;padding:7px 14px;border:0;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer;font-weight:700;">保存名单</button>
        </div>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;">
        <div style="font-weight:800;margin-bottom:6px;">分组管理</div>
        <div style="font-size:12px;color:#64748b;line-height:1.6;margin-bottom:8px;">分组只是给子账号打标签，用来做第 4 步的额度分配。一个子账号同时只属于一个分组。</div>
        <div id="jxj-group-rows">${accountGroupRowsHtml()}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px;">
          <input id="jxj-new-group-name" type="text" placeholder="新分组名称，例如 搜索类" style="width:220px;height:32px;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;">
          <button type="button" data-action="add-group" style="padding:7px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">新增分组</button>
        </div>
        ${nextStepButtonHtml('accounts')}
      </div>
    `;
  }

  function accountRosterRowsHtml() {
    const roster = getAccountRoster();
    const groups = getAccountGroups();

    if (!roster.length) {
      return '<div style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;color:#64748b;line-height:1.6;">名单还是空的。请先在京小洁投放明细页搜索并展开店铺子账号，再点「从页面拉取子账号」。开启自动查询后，每轮也会自动同步名单。</div>';
    }

    return `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr>
            <th style="${logThStyle()}width:32px;"><input id="jxj-roster-check-all" type="checkbox"></th>
            <th style="${logThStyle()}">子账号</th>
            <th style="${logThStyle()}text-align:right;width:84px;">余额</th>
            <th style="${logThStyle()}text-align:right;width:92px;">今日花费</th>
            <th style="${logThStyle()}text-align:right;width:70px;">投产</th>
            <th style="${logThStyle()}width:150px;">所属分组</th>
            <th style="${logThStyle()}width:130px;">最后更新</th>
          </tr>
        </thead>
        <tbody>
          ${roster.map((item, index) => `
            <tr class="jxj-roster-row" data-account="${escapeHtml(item.accountName)}">
              <td style="${logTdStyle()}"><input type="checkbox" class="jxj-roster-check" data-index="${index}"></td>
              <td style="${logTdStyle()}">${escapeHtml(item.accountName)}</td>
              <td style="${logTdStyle()}text-align:right;">${escapeHtml(formatMoney(item.balance))}</td>
              <td style="${logTdStyle()}text-align:right;">${escapeHtml(formatMoney(item.spend))}</td>
              <td style="${logTdStyle()}text-align:right;">${escapeHtml(formatRatio(item.roi))}</td>
              <td style="${logTdStyle()}">
                <select data-roster-field="groupId" style="width:100%;height:30px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;">
                  ${groups.map(group => `<option value="${escapeHtml(group.id)}" ${group.id === item.groupId ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}
                </select>
              </td>
              <td style="${logTdStyle()}color:#64748b;">${escapeHtml(item.updatedAt ? formatDateTime(item.updatedAt) : '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function accountGroupRowsHtml() {
    const groups = getAccountGroups();
    const roster = getAccountRoster();

    return `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr>
            <th style="${logThStyle()}width:220px;">分组</th>
            <th style="${logThStyle()}width:90px;">账号数</th>
            <th style="${logThStyle()}">说明</th>
            <th style="${logThStyle()}width:150px;">操作</th>
          </tr>
        </thead>
        <tbody>
          ${groups.map(group => {
            const count = roster.filter(item => item.groupId === group.id).length;
            const fixed = group.id === UNGROUPED_ID;
            return `
              <tr>
                <td style="${logTdStyle()}font-weight:700;">${escapeHtml(group.name)}</td>
                <td style="${logTdStyle()}">${escapeHtml(count)} 个</td>
                <td style="${logTdStyle()}color:#64748b;">${fixed ? '没有指定分组的子账号自动归到这里' : '可重命名或删除，删除后组内账号回到未分组'}</td>
                <td style="${logTdStyle()}">
                  ${fixed ? '<span style="color:#94a3b8;">—</span>' : `
                    <button type="button" data-action="rename-group" data-group="${escapeHtml(group.id)}" style="padding:5px 8px;border:1px solid #cbd5e1;background:#fff;border-radius:4px;cursor:pointer;">重命名</button>
                    <button type="button" data-action="delete-group" data-group="${escapeHtml(group.id)}" style="padding:5px 8px;border:1px solid #fca5a5;background:#fff;color:#b91c1c;border-radius:4px;cursor:pointer;">删除</button>
                  `}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function refreshAccountRosterPanel() {
    const rows = document.getElementById('jxj-roster-rows');
    if (rows) rows.innerHTML = accountRosterRowsHtml();

    const groupRows = document.getElementById('jxj-group-rows');
    if (groupRows) groupRows.innerHTML = accountGroupRowsHtml();

    const meta = document.getElementById('jxj-roster-meta');
    if (meta) {
      const info = getAccountRosterMeta();
      meta.innerText = info.count
        ? `名单共 ${info.count} 个子账号${info.time ? `，${formatDateTime(info.time)} 更新` : ''}`
        : '尚未拉取子账号';
    }

    const bulkSelect = document.getElementById('jxj-roster-bulk-group');
    if (bulkSelect) {
      const current = bulkSelect.value;
      bulkSelect.innerHTML = '<option value="">移入分组…</option>' +
        getAccountGroups().map(group => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('');
      bulkSelect.value = current;
    }
  }

  function readRosterFromPanel() {
    const roster = getAccountRoster();
    const rows = [...document.querySelectorAll('.jxj-roster-row')];
    if (!rows.length) return roster;

    const byName = new Map(roster.map(item => [normalizeText(item.accountName), item]));

    rows.forEach(row => {
      const item = byName.get(normalizeText(row.getAttribute('data-account')));
      if (!item) return;
      const select = row.querySelector('[data-roster-field="groupId"]');
      if (select) item.groupId = select.value;
    });

    return roster;
  }

  function getSelectedRosterAccounts() {
    return [...document.querySelectorAll('.jxj-roster-check:checked')]
      .map(box => box.closest('.jxj-roster-row'))
      .filter(Boolean)
      .map(row => row.getAttribute('data-account'))
      .filter(Boolean);
  }

  // =========================
  // ④ 分组与账号额度
  // =========================
  function allocationPageHtml() {
    return `
      ${workspaceStepBarHtml('alloc')}
      <div style="background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.6;margin-bottom:10px;">
        第 4 步：在店铺预算和分时上限之内，从大到小往下分配。分组和单账号都可以设额度，也可以只设条件。
      </div>
      <div id="jxj-alloc-chain">${allocationChainHtml()}</div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <span style="padding:2px 8px;border-radius:999px;background:#dbeafe;color:#1e40af;font-size:11px;font-weight:700;">第 3 级</span>
          <div style="font-weight:800;">分组额度与条件</div>
          <span style="font-size:12px;color:#64748b;margin-left:auto;">优先于全店规则</span>
        </div>
        <div id="jxj-group-quota-rows">${groupQuotaRowsHtml()}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">
          <span id="jxj-group-quota-sum" style="font-size:12px;line-height:1.6;"></span>
          <button type="button" data-action="save-allocation" style="margin-left:auto;padding:7px 14px;border:0;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer;font-weight:700;">保存额度设置</button>
        </div>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <span style="padding:2px 8px;border-radius:999px;background:#dcfce7;color:#15803d;font-size:11px;font-weight:700;">第 4 级</span>
          <div style="font-weight:800;">单个账号额度与条件</div>
          <span style="font-size:12px;color:#64748b;margin-left:auto;">优先级最高，只影响这一个账号</span>
        </div>
        <div id="jxj-account-quota-rows">${accountQuotaRowsHtml()}</div>
        <div style="font-size:12px;color:#64748b;line-height:1.6;margin-top:8px;">
          留空就跟随所在分组；分组也没设就跟随全店规则。额度从大到小卡：店铺当天预算 → 当前分时上限 → 分组额度 → 账号当天上限，取最小。
        </div>
        ${nextStepButtonHtml('alloc')}
      </div>
    `;
  }

  function allocationChainHtml() {
    const settings = getBudgetSettings();
    const decision = evaluateDailyBudget({ includePending: true, settings });

    const node = (level, name, value, sub) => `
      <div style="flex:1;min-width:170px;border:1px solid #e2e8f0;border-radius:10px;padding:10px;background:#fff;">
        <div style="font-size:11px;color:#94a3b8;font-weight:700;">${escapeHtml(level)}</div>
        <div style="font-weight:800;margin-top:2px;">${escapeHtml(name)}</div>
        <div style="font-size:18px;font-weight:800;color:#1d4ed8;margin-top:6px;">${escapeHtml(value)}</div>
        <div style="font-size:11px;color:#64748b;margin-top:4px;line-height:1.5;">${escapeHtml(sub)}</div>
      </div>
    `;

    return `
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:10px;">
        <div style="font-weight:800;margin-bottom:8px;">当前可分配额度</div>
        <div style="display:flex;align-items:stretch;gap:8px;flex-wrap:wrap;">
          ${node('第 1 级 · 店铺', '当天总预算', `${formatMoney(decision.budget)} 元`, '近七天平均业绩 × 推广费比')}
          <div style="align-self:center;color:#94a3b8;font-weight:800;">›</div>
          ${node('第 2 级 · 分时', `当前时段 ${formatSlotRange(decision.slot)}`, `${formatMoney(decision.slotBudget)} 元`, `已用 ${formatMoney(decision.counted)} 元，还能分配 ${formatMoney(decision.remaining)} 元`)}
        </div>
      </div>
    `;
  }

  function groupQuotaRowsHtml() {
    const settings = getBudgetSettings();
    const slot = getCurrentBudgetSlot(settings);
    const groups = getAccountGroups();
    const roster = getAccountRoster();

    return `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr>
            <th style="${logThStyle()}width:140px;">分组</th>
            <th style="${logThStyle()}width:70px;">账号数</th>
            <th style="${logThStyle()}width:150px;">额度方式</th>
            <th style="${logThStyle()}width:90px;">数值</th>
            <th style="${logThStyle()}width:110px;">当天额度</th>
            <th style="${logThStyle()}width:90px;">一次充值</th>
            <th style="${logThStyle()}width:90px;">投产高于</th>
            <th style="${logThStyle()}">当前时段还能充</th>
          </tr>
        </thead>
        <tbody>
          ${groups.map(group => {
            const count = roster.filter(item => item.groupId === group.id).length;
            const daily = getGroupDailyQuota(group, settings);
            const slotQuota = getGroupSlotQuota(group, settings, slot);
            const used = slotQuota === null ? 0 : getGroupUsedAmount(group.id, { includePending: true });
            const left = slotQuota === null ? null : Math.max(0, slotQuota - used);

            return `
              <tr class="jxj-group-quota-row" data-group="${escapeHtml(group.id)}">
                <td style="${logTdStyle()}font-weight:700;">${escapeHtml(group.name)}</td>
                <td style="${logTdStyle()}">${escapeHtml(count)} 个</td>
                <td style="${logTdStyle()}">
                  <select data-group-field="quotaMode" style="width:100%;height:30px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;">
                    <option value="percent" ${group.quotaMode === 'percent' ? 'selected' : ''}>按店铺预算百分比</option>
                    <option value="fixed" ${group.quotaMode === 'fixed' ? 'selected' : ''}>固定金额</option>
                    <option value="none" ${group.quotaMode === 'none' ? 'selected' : ''}>不限制</option>
                  </select>
                </td>
                <td style="${logTdStyle()}">
                  <input type="number" min="0" step="1" data-group-field="quotaValue" value="${escapeHtml(group.quotaValue)}" ${group.quotaMode === 'none' ? 'disabled' : ''} style="width:100%;height:30px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;">
                </td>
                <td style="${logTdStyle()}" class="jxj-group-quota-amount">${daily === null ? '<span style="color:#94a3b8;">不限</span>' : `${escapeHtml(formatMoney(daily))} 元`}</td>
                <td style="${logTdStyle()}">
                  <input type="number" min="0" step="1" data-group-field="amount" value="${group.amount === null ? '' : escapeHtml(group.amount)}" placeholder="跟随" style="width:100%;height:30px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;">
                </td>
                <td style="${logTdStyle()}">
                  <input type="number" min="0" step="0.1" data-group-field="minRoi" value="${group.minRoi === null ? '' : escapeHtml(group.minRoi)}" placeholder="跟随" style="width:100%;height:30px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;">
                </td>
                <td style="${logTdStyle()}color:#64748b;" class="jxj-group-quota-left">
                  ${left === null
                    ? '只受上一级约束'
                    : `时段上限 ${escapeHtml(formatMoney(slotQuota))} 元，已用 ${escapeHtml(formatMoney(used))} 元，还能充 <b>${escapeHtml(formatMoney(left))}</b> 元`}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function accountQuotaRowsHtml() {
    const roster = getAccountRoster();

    if (!roster.length) {
      return '<div style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;color:#64748b;">先在第 3 步「子账号与分组」拉取子账号，这里才能逐个设置。</div>';
    }

    return `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr>
            <th style="${logThStyle()}">子账号</th>
            <th style="${logThStyle()}width:130px;">所属分组</th>
            <th style="${logThStyle()}width:110px;">当天上限</th>
            <th style="${logThStyle()}width:100px;">一次充值</th>
            <th style="${logThStyle()}width:100px;">投产高于</th>
            <th style="${logThStyle()}">说明</th>
          </tr>
        </thead>
        <tbody>
          ${roster.map(item => {
            const group = getAccountGroup(item.groupId);
            const custom = item.dailyCap !== null || item.amount !== null || item.minRoi !== null;
            return `
              <tr class="jxj-account-quota-row" data-account="${escapeHtml(item.accountName)}">
                <td style="${logTdStyle()}">${escapeHtml(item.accountName)}</td>
                <td style="${logTdStyle()}">${escapeHtml(group.name)}</td>
                <td style="${logTdStyle()}">
                  <input type="number" min="0" step="1" data-account-field="dailyCap" value="${item.dailyCap === null ? '' : escapeHtml(item.dailyCap)}" placeholder="不限" style="width:100%;height:30px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;">
                </td>
                <td style="${logTdStyle()}">
                  <input type="number" min="0" step="1" data-account-field="amount" value="${item.amount === null ? '' : escapeHtml(item.amount)}" placeholder="跟随" style="width:100%;height:30px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;">
                </td>
                <td style="${logTdStyle()}">
                  <input type="number" min="0" step="0.1" data-account-field="minRoi" value="${item.minRoi === null ? '' : escapeHtml(item.minRoi)}" placeholder="跟随" style="width:100%;height:30px;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;">
                </td>
                <td style="${logTdStyle()}color:#64748b;">${custom ? '已单独设置，优先于分组' : `跟随「${escapeHtml(group.name)}」`}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function refreshAllocationPanel(options) {
    const rerender = !!(options && options.rerender);

    const chain = document.getElementById('jxj-alloc-chain');
    if (chain) chain.innerHTML = allocationChainHtml();

    if (rerender) {
      const groupRows = document.getElementById('jxj-group-quota-rows');
      if (groupRows) groupRows.innerHTML = groupQuotaRowsHtml();

      const accountRows = document.getElementById('jxj-account-quota-rows');
      if (accountRows) accountRows.innerHTML = accountQuotaRowsHtml();
    } else {
      // 输入过程中只更新换算金额，不重建输入框。
      const settings = getBudgetSettings();
      const slot = getCurrentBudgetSlot(settings);
      [...document.querySelectorAll('.jxj-group-quota-row')].forEach(row => {
        const group = readGroupRowFromPanel(row);
        if (!group) return;
        const daily = getGroupDailyQuota(group, settings);
        const slotQuota = getGroupSlotQuota(group, settings, slot);
        const used = slotQuota === null ? 0 : getGroupUsedAmount(group.id, { includePending: true });
        const amountCell = row.querySelector('.jxj-group-quota-amount');
        const leftCell = row.querySelector('.jxj-group-quota-left');
        if (amountCell) amountCell.innerHTML = daily === null ? '<span style="color:#94a3b8;">不限</span>' : `${escapeHtml(formatMoney(daily))} 元`;
        if (leftCell) {
          leftCell.innerHTML = slotQuota === null
            ? '只受上一级约束'
            : `时段上限 ${escapeHtml(formatMoney(slotQuota))} 元，已用 ${escapeHtml(formatMoney(used))} 元，还能充 <b>${escapeHtml(formatMoney(Math.max(0, slotQuota - used)))}</b> 元`;
        }
      });
    }

    refreshGroupQuotaSum();
  }

  function refreshGroupQuotaSum() {
    const box = document.getElementById('jxj-group-quota-sum');
    if (!box) return;

    const settings = getBudgetSettings();
    const budget = getDailyBudgetAmount(settings);
    const groups = readGroupsFromPanel();
    const total = groups.reduce((sum, group) => sum + (getGroupDailyQuota(group, settings) || 0), 0);

    if (!(budget > 0)) {
      box.innerHTML = '<span style="color:#64748b;">还没设置店铺当天预算，百分比暂时算不出金额。可以先填固定金额，或回第 1 步设置预算。</span>';
      return;
    }

    box.innerHTML = total > budget
      ? `<span style="color:#b45309;">各分组额度合计 ${escapeHtml(formatMoney(total))} 元，超过店铺当天预算 ${escapeHtml(formatMoney(budget))} 元。仍可保存，实际以上一级为硬上限，先到先用。</span>`
      : `<span style="color:#15803d;">各分组额度合计 ${escapeHtml(formatMoney(total))} 元，未超过店铺当天预算 ${escapeHtml(formatMoney(budget))} 元。</span>`;
  }

  function readGroupRowFromPanel(row) {
    if (!row) return null;
    const groupId = row.getAttribute('data-group');
    const saved = getAccountGroups().find(group => group.id === groupId);
    if (!saved) return null;

    const readValue = field => {
      const el = row.querySelector(`[data-group-field="${field}"]`);
      return el ? el.value : '';
    };

    return normalizeAccountGroup({
      id: groupId,
      name: saved.name,
      quotaMode: readValue('quotaMode') || saved.quotaMode,
      quotaValue: readValue('quotaValue'),
      amount: readValue('amount'),
      minRoi: readValue('minRoi')
    });
  }

  function readGroupsFromPanel() {
    const rows = [...document.querySelectorAll('.jxj-group-quota-row')];
    if (!rows.length) return getAccountGroups();
    return rows.map(readGroupRowFromPanel).filter(Boolean);
  }

  function readAccountQuotaFromPanel() {
    const roster = getAccountRoster();
    const rows = [...document.querySelectorAll('.jxj-account-quota-row')];
    if (!rows.length) return roster;

    const byName = new Map(roster.map(item => [normalizeText(item.accountName), item]));

    rows.forEach(row => {
      const item = byName.get(normalizeText(row.getAttribute('data-account')));
      if (!item) return;
      const readValue = field => {
        const el = row.querySelector(`[data-account-field="${field}"]`);
        return el ? el.value : '';
      };
      item.dailyCap = readValue('dailyCap') === '' ? null : Math.max(0, Number(readValue('dailyCap')));
      item.amount = readValue('amount') === '' ? null : Math.max(0, Number(readValue('amount')));
      item.minRoi = readValue('minRoi') === '' ? null : Math.max(0, Number(readValue('minRoi')));
    });

    return roster;
  }

  function budgetSlotPageHtml() {
    const settings = getBudgetSettings();

    return `
      ${workspaceStepBarHtml('slots')}
      <div style="background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.6;margin-bottom:10px;">
        第 2 步：把全店预算按时段切开。这是累计上限，到某个时段为止最多花多少，不是各段相加。
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;">
        <div style="font-weight:800;margin-bottom:6px;">分时累计上限</div>
        <div style="font-size:12px;color:#64748b;line-height:1.6;margin-bottom:10px;">
          这是<b>累计</b>上限，不是各时段相加。例如到 09:00-14:00 这一段，当天累计充值不超过当天预算的对应比例。
          当天预算 <b id="jxj-slot-daily-budget">${escapeHtml(formatMoney(getDailyBudgetAmount(settings)))}</b> 元，改动会实时换算金额。
        </div>
        <div style="display:grid;grid-template-columns:88px 88px 104px minmax(0,1fr) 72px;gap:8px;font-size:12px;color:#475569;font-weight:700;margin-bottom:6px;">
          <div>开始</div><div>结束</div><div>累计上限%</div><div>累计金额</div><div>操作</div>
        </div>
        <div id="jxj-slot-rows">${budgetSlotRowsHtml()}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center;">
          <button type="button" data-action="add-slot" style="padding:7px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">新增时段</button>
          <button type="button" data-action="reset-slots" style="padding:7px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">恢复默认</button>
          <button type="button" data-action="save-slots" style="margin-left:auto;padding:7px 14px;border:0;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer;font-weight:700;">保存分时规则</button>
        </div>
        <div id="jxj-slot-hint" style="font-size:12px;line-height:1.6;margin-top:10px;">${budgetSlotHintHtml()}</div>
        ${nextStepButtonHtml('slots')}
      </div>
    `;
  }

  function readBudgetSlotsFromPanel(panel) {
    const box = panel && panel.querySelector('#jxj-slot-rows');
    if (!box) return getBudgetSlots();

    const rows = [...box.querySelectorAll('.jxj-slot-row')];
    if (!rows.length) return getBudgetSlots();

    return rows.map(row => ({
      startHour: Number((row.querySelector('[data-slot-field="startHour"]') || {}).value || 0),
      endHour: Number((row.querySelector('[data-slot-field="endHour"]') || {}).value || 0),
      percent: Number((row.querySelector('[data-slot-field="percent"]') || {}).value || 0)
    }));
  }

  function refreshBudgetSlotPage(options) {
    const panel = document.getElementById('jxj-rule-panel');
    if (!panel) return;

    const rowsBox = panel.querySelector('#jxj-slot-rows');
    const rerender = !!(options && options.rerender);
    const slots = rerender ? (options.slots || getBudgetSlots()) : readBudgetSlotsFromPanel(panel);

    if (rowsBox && rerender) {
      rowsBox.innerHTML = budgetSlotRowsHtml(normalizeBudgetSlots(slots));
    } else if (rowsBox) {
      // 输入过程中不重建输入框，只更新每行右侧的换算金额，避免打字被打断，也不按排序错位。
      const settings = getBudgetSettings();
      [...rowsBox.querySelectorAll('.jxj-slot-row')].forEach(row => {
        const label = row.querySelector('.jxj-slot-amount');
        if (!label) return;

        const slot = {
          startHour: Number((row.querySelector('[data-slot-field="startHour"]') || {}).value || 0),
          endHour: Number((row.querySelector('[data-slot-field="endHour"]') || {}).value || 0),
          percent: Number((row.querySelector('[data-slot-field="percent"]') || {}).value || 0)
        };

        label.innerHTML = slot.endHour > slot.startHour
          ? `${escapeHtml(formatSlotRange(slot))} 累计不超过 <b>${escapeHtml(formatMoney(getSlotBudgetAmount(settings, slot)))}</b> 元`
          : '<span style="color:#b91c1c;">结束时间要大于开始时间</span>';
      });
    }

    const budgetBox = panel.querySelector('#jxj-slot-daily-budget');
    if (budgetBox) budgetBox.innerText = formatMoney(getDailyBudgetAmount(getBudgetSettings()));

    const hint = panel.querySelector('#jxj-slot-hint');
    if (hint) hint.innerHTML = budgetSlotHintHtml(slots);
  }

  function fillBudgetSettingsInputs(panel, settings) {
    const item = normalizeBudgetSettings(settings || getBudgetSettings());
    const enabled = panel && panel.querySelector('#jxj-budget-enabled');
    const avgGmv = panel && panel.querySelector('#jxj-budget-avg-gmv');
    const combinedFee = panel && panel.querySelector('#jxj-budget-combined-fee');
    const returnRate = panel && panel.querySelector('#jxj-budget-return-rate');
    const targetRoi = panel && panel.querySelector('#jxj-budget-target-roi');

    if (enabled) enabled.checked = item.enabled !== false;
    if (avgGmv && document.activeElement !== avgGmv) avgGmv.value = item.avgGmv7d ? String(item.avgGmv7d) : '';
    if (combinedFee && document.activeElement !== combinedFee) combinedFee.value = item.combinedFeePercent ? String(item.combinedFeePercent) : '';
    if (returnRate && document.activeElement !== returnRate) returnRate.value = item.returnRatePercent ? String(item.returnRatePercent) : '';
    if (targetRoi && document.activeElement !== targetRoi) targetRoi.value = String(item.targetShopRoi);

    const summary = panel && panel.querySelector('#jxj-budget-slot-summary');
    if (summary) summary.innerHTML = budgetSlotSummaryHtml();
  }

  function readBudgetSettingsFromPanel(panel) {
    if (!panel) return getBudgetSettings();

    return normalizeBudgetSettings({
      enabled: !!(panel.querySelector('#jxj-budget-enabled') && panel.querySelector('#jxj-budget-enabled').checked),
      avgGmv7d: Number((panel.querySelector('#jxj-budget-avg-gmv') || {}).value || 0),
      combinedFeePercent: Number((panel.querySelector('#jxj-budget-combined-fee') || {}).value || 0),
      returnRatePercent: Number((panel.querySelector('#jxj-budget-return-rate') || {}).value || 0),
      targetShopRoi: Number((panel.querySelector('#jxj-budget-target-roi') || {}).value || CONFIG.targetShopRoi),
      // 分时上限只由「店铺分时规则」页的保存按钮写入，避免在预算页误存未确认的改动。
      budgetSlots: getBudgetSettings().budgetSlots
    });
  }

  function refreshBudgetPreview(panel) {
    const box = document.getElementById('jxj-budget-summary');
    if (!box) return;
    box.innerHTML = budgetSummaryHtml(panel ? readBudgetSettingsFromPanel(panel) : getBudgetSettings());
  }

  function refreshBudgetPanel(options) {
    const panel = document.getElementById('jxj-rule-panel');
    const box = document.getElementById('jxj-budget-summary');
    const fillInputs = !!(options && options.fillInputs);

    if (panel && fillInputs) fillBudgetSettingsInputs(panel, getBudgetSettings());

    if (box) {
      const activeId = document.activeElement && document.activeElement.id;
      const editingBudget = activeId && String(activeId).indexOf('jxj-budget-') === 0;
      box.innerHTML = budgetSummaryHtml(editingBudget && panel ? readBudgetSettingsFromPanel(panel) : getBudgetSettings());
    }
    refreshOverviewDashboard();
  }

  function logCardStyle() {
    return 'background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:10px;';
  }

  function logTableStyle() {
    return 'width:100%;border-collapse:collapse;font-size:12px;';
  }

  function logThStyle() {
    return 'text-align:left;padding:7px 8px;border-bottom:1px solid #e2e8f0;background:#f8fafc;color:#475569;font-weight:700;';
  }

  function logTdStyle() {
    return 'padding:7px 8px;border-bottom:1px solid #eef2f7;vertical-align:top;';
  }

  function scanSnapshotHtml() {
    const snapshot = getScanSnapshot();

    if (!snapshot) {
      return `
        <div style="${logCardStyle()}">
          <div style="font-weight:800;margin-bottom:6px;">本轮未充值原因（每轮覆盖，不累积）</div>
          <div style="font-size:12px;color:#64748b;line-height:1.6;">今天还没有扫描记录。在京小洁投放明细页执行一次查询后，这里会显示每个子账号本轮为什么没充。</div>
        </div>
      `;
    }

    const rows = snapshot.rows || [];
    const limit = CONFIG.scanSnapshotVisibleRows;
    const visibleRows = scanSnapshotExpanded ? rows : rows.slice(0, limit);
    const hiddenCount = rows.length - visibleRows.length;

    const body = rows.length
      ? `
        <table style="${logTableStyle()}">
          <thead>
            <tr>
              <th style="${logThStyle()}">子账号</th>
              <th style="${logThStyle()}text-align:right;">余额</th>
              <th style="${logThStyle()}text-align:right;">投产</th>
              <th style="${logThStyle()}">本轮为什么没充</th>
            </tr>
          </thead>
          <tbody>
            ${visibleRows.map(row => `
              <tr>
                <td style="${logTdStyle()}">${escapeHtml(row.accountName)}</td>
                <td style="${logTdStyle()}text-align:right;">${escapeHtml(formatMoney(row.balance))}</td>
                <td style="${logTdStyle()}text-align:right;">${escapeHtml(formatRatio(row.roi))}</td>
                <td style="${logTdStyle()}color:#334155;">${escapeHtml(row.reasonDetail || row.reasonKey || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${rows.length > limit ? `
          <div style="margin-top:8px;">
            <button type="button" data-action="toggle-scan-rows" style="padding:6px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;">
              ${scanSnapshotExpanded ? '收起' : `展开全部 ${rows.length} 个`}${hiddenCount > 0 ? `（还有 ${hiddenCount} 个）` : ''}
            </button>
          </div>
        ` : ''}
      `
      : '<div style="font-size:12px;color:#15803d;">本轮所有账号都已按规则处理，没有被跳过的账号。</div>';

    return `
      <div style="${logCardStyle()}">
        <div style="font-weight:800;margin-bottom:6px;">本轮未充值原因（每轮覆盖，不累积）</div>
        <div style="font-size:12px;color:#64748b;line-height:1.6;margin-bottom:8px;">
          ${escapeHtml(formatDateTime(snapshot.time))} ${escapeHtml(snapshot.mode || '正常运行')}：
          扫描 ${escapeHtml(snapshot.scanned)} 个子账号，命中规则 ${escapeHtml(snapshot.matched)} 个，投递 ${escapeHtml(snapshot.submitted)} 个，未充值 ${escapeHtml(rows.length)} 个。下一轮会覆盖这一块。
        </div>
        ${body}
      </div>
    `;
  }

  function skipReasonStatsHtml() {
    const stats = getSkipReasonStats();
    const keys = Object.keys(stats.items || {});

    if (!keys.length) {
      return `
        <div style="${logCardStyle()}">
          <div style="font-weight:800;margin-bottom:6px;">当天未充值原因统计（按原因聚合）</div>
          <div style="font-size:12px;color:#64748b;line-height:1.6;">今天还没有未充值记录。</div>
        </div>
      `;
    }

    const sorted = keys
      .map(key => Object.assign({ key }, stats.items[key]))
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0));

    return `
      <div style="${logCardStyle()}">
        <div style="font-weight:800;margin-bottom:6px;">当天未充值原因统计（按原因聚合）</div>
        <table style="${logTableStyle()}">
          <thead>
            <tr>
              <th style="${logThStyle()}">原因</th>
              <th style="${logThStyle()}text-align:right;">出现次数</th>
              <th style="${logThStyle()}">最后一次</th>
              <th style="${logThStyle()}">涉及账号</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map(item => {
              const accounts = item.accounts || [];
              const accountText = accounts.length > 3
                ? `${accounts.slice(0, 3).join('、')} 等 ${accounts.length} 个`
                : accounts.join('、');
              return `
                <tr>
                  <td style="${logTdStyle()}font-weight:700;color:#0f172a;">${escapeHtml(item.key)}</td>
                  <td style="${logTdStyle()}text-align:right;">${escapeHtml(item.count)}</td>
                  <td style="${logTdStyle()}">${escapeHtml(item.lastTime ? formatDateTime(item.lastTime) : '')}</td>
                  <td style="${logTdStyle()}color:#334155;">${escapeHtml(accountText)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
        <div style="font-size:12px;color:#64748b;line-height:1.6;margin-top:8px;">一天固定就这几行，扫描再多也不会变长，次数只累加数字。</div>
      </div>
    `;
  }

  function skipReasonChangesHtml() {
    const changes = getSkipReasonChanges();

    if (!changes.length) {
      return `
        <div style="${logCardStyle()}">
          <div style="font-weight:800;margin-bottom:6px;">未充值原因变化（只在原因变化时记一条）</div>
          <div style="font-size:12px;color:#64748b;line-height:1.6;">还没有原因变化记录。</div>
        </div>
      `;
    }

    return `
      <div style="${logCardStyle()}">
        <div style="font-weight:800;margin-bottom:6px;">未充值原因变化（只在原因变化时记一条）</div>
        <div style="font-size:12px;color:#64748b;line-height:1.6;margin-bottom:8px;">
          同一个账号连续多轮都是同一个原因时不重复记录，只累加「持续轮数」；原因换了才追加一条。保留最近 ${escapeHtml(CONFIG.skipChangeLogLimit)} 条。
        </div>
        <table style="${logTableStyle()}">
          <thead>
            <tr>
              <th style="${logThStyle()}">时间</th>
              <th style="${logThStyle()}">子账号</th>
              <th style="${logThStyle()}">原因变化</th>
              <th style="${logThStyle()}text-align:right;">持续</th>
            </tr>
          </thead>
          <tbody>
            ${changes.map(change => `
              <tr>
                <td style="${logTdStyle()}white-space:nowrap;">${escapeHtml(formatDateTime(change.time))}</td>
                <td style="${logTdStyle()}">${escapeHtml(change.accountName)}</td>
                <td style="${logTdStyle()}color:#334155;">
                  ${change.fromReason ? `${escapeHtml(change.fromReason)} → ` : '（首次记录）'}<b>${escapeHtml(change.toReason)}</b>
                  ${change.detail ? `<div style="color:#64748b;margin-top:2px;">${escapeHtml(change.detail)}</div>` : ''}
                </td>
                <td style="${logTdStyle()}text-align:right;white-space:nowrap;">已 ${escapeHtml(change.rounds || 1)} 轮</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function rechargeLogKind(log) {
    const status = String((log && log.status) || '已提交');
    if (status.indexOf('已提交') === 0) return 'ok';
    if (status.indexOf('失败') === 0) return 'fail';
    return 'system';
  }

  function rechargeLogKindMeta(kind) {
    if (kind === 'ok') return { text: '已提交', bg: '#dcfce7', color: '#15803d' };
    if (kind === 'fail') return { text: '失败', bg: '#fee2e2', color: '#b91c1c' };
    return { text: '系统', bg: '#dbeafe', color: '#1e40af' };
  }

  function rechargeLogTodaySummaryHtml() {
    const today = todayKey();
    const todayLogs = getRechargeLogs().filter(log => log && todayKeyFromTime(log.time) === today);

    if (!todayLogs.length) {
      return '<div style="padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;color:#64748b;line-height:1.6;margin-bottom:8px;">今天还没有充值动作记录。</div>';
    }

    const submitted = todayLogs.filter(log => rechargeLogKind(log) === 'ok');
    const failed = todayLogs.filter(log => rechargeLogKind(log) === 'fail');
    const amount = submitted.reduce((sum, log) => sum + Number(log.amount || 0), 0);
    const confirmed = submitted.filter(log => log.arrivalState === ARRIVAL_CONFIRMED);
    const missing = submitted.filter(log => log.arrivalState === ARRIVAL_MISSING);
    const pending = submitted.filter(log => log.arrivalState === ARRIVAL_PENDING);
    const confirmedAmount = confirmed.reduce((sum, log) => sum + Number(log.amount || 0), 0);

    return `
      <div style="padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;color:#334155;line-height:1.7;margin-bottom:8px;">
        今天到账核对：已提交 ${escapeHtml(submitted.length)} 笔 / ${escapeHtml(formatMoney(amount))} 元，
        <b style="color:#15803d;">已到账 ${escapeHtml(confirmed.length)} 笔 / ${escapeHtml(formatMoney(confirmedAmount))} 元</b>，
        待确认 ${escapeHtml(pending.length)} 笔，
        <b style="color:${missing.length ? '#b45309' : '#64748b'};">疑似未到账 ${escapeHtml(missing.length)} 笔</b>
        ${missing.length ? '<br><span style="color:#b45309;">疑似未到账的这几笔请到京准通后台核对一下。</span>' : ''}
      </div>
    `;
  }

  function rechargeLogFilterHtml() {
    const items = [
      { id: 'all', label: '全部' },
      { id: 'ok', label: '已充值' },
      { id: 'fail', label: '失败' },
      { id: 'system', label: '系统' }
    ];

    return `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
        ${items.map(item => {
          const active = rechargeLogFilter === item.id;
          return `<button type="button" data-action="filter-logs" data-filter="${item.id}" style="padding:5px 12px;border:1px solid ${active ? '#2563eb' : '#cbd5e1'};background:${active ? '#2563eb' : '#fff'};color:${active ? '#fff' : '#334155'};border-radius:999px;font-size:12px;cursor:pointer;font-weight:${active ? 700 : 500};">${escapeHtml(item.label)}</button>`;
        }).join('')}
      </div>
    `;
  }

  function rechargeLogRowsHtml() {
    const logs = getRechargeLogs()
      .filter(log => rechargeLogFilter === 'all' || rechargeLogKind(log) === rechargeLogFilter);

    if (!logs.length) {
      return `
        ${rechargeLogTodaySummaryHtml()}
        ${rechargeLogFilterHtml()}
        <div style="padding:10px;color:#64748b;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;">
          ${rechargeLogFilter === 'all' ? '暂无充值动作记录' : '当前筛选下没有记录，点上面的「全部」看全部'}
        </div>
      `;
    }

    return `
      ${rechargeLogTodaySummaryHtml()}
      ${rechargeLogFilterHtml()}
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e5e5;font-size:12px;">
        <thead>
          <tr style="background:#fafafa;">
            <th style="text-align:left;padding:6px;border-bottom:1px solid #eee;">时间</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid #eee;">子账号</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid #eee;">金额</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid #eee;">规则/来源</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid #eee;">动作</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid #eee;">到账</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map(log => {
            const meta = rechargeLogKindMeta(rechargeLogKind(log));
            const arrival = arrivalStateMeta(log.arrivalState);
            return `
            <tr>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;white-space:nowrap;">${escapeHtml(formatDateTime(log.time))}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;">${escapeHtml(log.accountName)}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;">${escapeHtml(log.amount)}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;">${escapeHtml(log.ruleName)} / ${escapeHtml(log.triggerReason)}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;white-space:nowrap;"><span style="padding:2px 8px;border-radius:999px;background:${meta.bg};color:${meta.color};font-weight:700;">${escapeHtml(log.status || '已提交')}</span></td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;">
                <span style="padding:2px 8px;border-radius:999px;background:${arrival.bg};color:${arrival.color};font-weight:700;white-space:nowrap;">${escapeHtml(arrival.text)}</span>
                ${log.arrivalNote ? `<div style="color:#94a3b8;margin-top:3px;line-height:1.5;">${escapeHtml(log.arrivalNote)}</div>` : ''}
              </td>
            </tr>
          `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function refreshRechargeLogPanel() {
    const scanBox = document.getElementById('jxj-scan-snapshot');
    if (scanBox) scanBox.innerHTML = scanSnapshotHtml();

    const statsBox = document.getElementById('jxj-skip-reason-stats');
    if (statsBox) statsBox.innerHTML = skipReasonStatsHtml();

    const changesBox = document.getElementById('jxj-skip-reason-changes');
    if (changesBox) changesBox.innerHTML = skipReasonChangesHtml();

    const box = document.getElementById('jxj-recharge-log-rows');
    if (box) box.innerHTML = rechargeLogRowsHtml();

    const hint = document.getElementById('jxj-recharge-budget-hint');
    if (hint) {
      const decision = evaluateDailyBudget({ includePending: true });
      hint.innerText = decision.configured
        ? `今日已用 ${formatMoney(decision.used)} 元 / 当天预算 ${formatMoney(decision.budget)} 元 / 当前时段 ${formatSlotRange(decision.slot)} 上限 ${formatMoney(decision.slotBudget)} 元 / 当前可充 ${formatMoney(decision.remaining)} 元`
        : '尚未设置店铺当天推广预算，当前不限制充值总额。';
    }
  }

  function pendingQueueHtml() {
    const current = getCurrent();
    const queue = getQueue();
    const rows = [];

    if (current) {
      rows.push(Object.assign({ queueStatus: '当前处理' }, current));
    }

    queue.forEach((item, index) => {
      rows.push(Object.assign({ queueStatus: `等待${index + 1}` }, item));
    });

    if (!rows.length) {
      return '<div style="padding:8px;color:#777;background:#fff;border:1px solid #eee;border-radius:6px;">当前没有待充值任务</div>';
    }

    return `
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e5e5;font-size:12px;">
        <thead>
          <tr style="background:#fafafa;">
            <th style="text-align:left;padding:6px;border-bottom:1px solid #eee;">状态</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid #eee;">子账号</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid #eee;">金额</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid #eee;">规则/来源</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(item => `
            <tr>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;white-space:nowrap;">${escapeHtml([item.queueStatus, getTaskRetryText(item)].filter(Boolean).join(' / '))}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;">${escapeHtml(item.accountName)}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;">${escapeHtml(item.amount)}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;">${escapeHtml(item.ruleName || '默认')} / ${escapeHtml(item.triggerReason || '余额/ROI规则')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function assignStateHtml() {
    const state = getAssignState();
    const alive = isAssignPageAlive();
    const queued = hasPendingTask();

    if (!alive && queued) {
      return `
        <div style="padding:9px 10px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:12px;color:#92400e;line-height:1.6;">
          <b>充值页没有在运行</b>：队列里有任务，但没检测到京准通「投放账户分配金额」页。
          请确认那个标签页还开着、已登录，并且脚本在上面跑起来了（页面上应能看到蓝色状态提示）。
          ${state ? `<br>充值页最后一次动作：${escapeHtml(state.text)}（${escapeHtml(formatDateTime(state.time))}）` : ''}
        </div>
      `;
    }

    if (!state) {
      return '<div style="padding:9px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;color:#64748b;">充值页还没有上报状态。</div>';
    }

    const stale = Date.now() - Number(state.time || 0) > 5 * 60 * 1000;
    return `
      <div style="padding:9px 10px;background:${stale ? '#fffbeb' : '#eff6ff'};border:1px solid ${stale ? '#fde68a' : '#bfdbfe'};border-radius:8px;font-size:12px;color:${stale ? '#92400e' : '#1e3a8a'};line-height:1.6;">
        <b>充值页状态</b>：${escapeHtml(state.text)}
        <br>更新于 ${escapeHtml(formatDateTime(state.time))}${stale ? '（超过 5 分钟没动静，建议看一下那个标签页）' : ''}
      </div>
    `;
  }

  function refreshQueuePanel() {
    const box = document.getElementById('jxj-pending-queue-rows');
    if (box) box.innerHTML = pendingQueueHtml();

    const stateBox = document.getElementById('jxj-assign-state');
    if (stateBox) stateBox.innerHTML = assignStateHtml();

    refreshBudgetPanel();
  }

  function simulationResultsHtml() {
    const result = getSimulationResults();

    if (!result) {
      return '<div style="padding:8px;color:#777;background:#fff;border:1px solid #eee;border-radius:6px;">暂无模拟结果；开启模拟运行后执行一次全流程即可查看</div>';
    }

    if (!result.targets.length) {
      const skippedHtml = simulationSkippedHtml(result);
      const messageHtml = simulationBudgetMessageHtml(result);
      return `<div style="padding:8px;color:#777;background:#fff;border:1px solid #eee;border-radius:6px;">${escapeHtml(formatDateTime(result.time))} 模拟检测：没有账号可投递充值任务</div>${messageHtml}${skippedHtml}`;
    }

    return `
      <div style="font-size:12px;color:#555;margin-bottom:6px;">${escapeHtml(formatDateTime(result.time))} / ${escapeHtml(result.source)} / 可投递 ${result.targets.length} 个账号</div>
      ${simulationBudgetMessageHtml(result)}
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e5e5;font-size:12px;">
        <thead>
          <tr style="background:#fafafa;">
            <th style="text-align:left;padding:6px;border-bottom:1px solid #eee;">子账号</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid #eee;">余额</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid #eee;">花费</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid #eee;">ROI</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid #eee;">预计充值</th>
            <th style="text-align:left;padding:6px;border-bottom:1px solid #eee;">规则</th>
          </tr>
        </thead>
        <tbody>
          ${result.targets.map(item => `
            <tr>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;">${escapeHtml(item.accountName)}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;">${escapeHtml(item.balance)}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;">${escapeHtml(item.spend)}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;">${escapeHtml(item.roi)}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;">${escapeHtml(item.amount)}${item.originalAmount ? `（原${escapeHtml(item.originalAmount)}）` : ''}</td>
              <td style="padding:6px;border-bottom:1px solid #f0f0f0;">${escapeHtml(item.ruleName || '默认')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${simulationSkippedHtml(result)}
    `;
  }

  function simulationBudgetMessageHtml(result) {
    const messages = (result && result.budgetMessages) || [];
    if (!messages.length) return '';
    return `<div style="padding:8px;margin:6px 0;color:#ad6800;background:#fffbe6;border:1px solid #ffe58f;border-radius:6px;font-size:12px;line-height:1.5;">${messages.map(item => `<div>${escapeHtml(item)}</div>`).join('')}</div>`;
  }

  function simulationSkippedHtml(result) {
    const skipped = (result && result.skipped) || [];
    if (!skipped.length) return '';
    return `
      <div style="margin-top:8px;padding:8px;color:#a8071a;background:#fff1f0;border:1px solid #ffa39e;border-radius:6px;font-size:12px;line-height:1.5;">
        <div style="font-weight:700;margin-bottom:4px;">因当日预算跳过 ${skipped.length} 个账号</div>
        ${skipped.map(item => `<div>${escapeHtml(item.accountName)} ${escapeHtml(item.amount)} 元：${escapeHtml(item.skipReason || '超出当日推广预算')}</div>`).join('')}
      </div>
    `;
  }

  function refreshSimulationPanel() {
    const box = document.getElementById('jxj-simulation-result');
    if (box) box.innerHTML = simulationResultsHtml();
  }

  function getRuleConflictMessages(rules) {
    const enabledRules = (rules || getRules())
      .map(normalizeRule)
      .filter(rule => rule.enabled && (rule.matchType === 'all' || normalizeText(rule.accountPattern)));

    const messages = [];
    const groups = new Map();

    for (const rule of enabledRules) {
      const key = rule.matchType === 'all'
        ? 'all|__shop_children__'
        : `${rule.matchType}|${normalizeText(rule.accountPattern)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rule);
    }

    groups.forEach(group => {
      if (group.length <= 1) return;

      const first = group[0];
      const typeText = first.matchType === 'all' ? '全店规则'
        : first.matchType === 'exact' ? '分账号·精确'
          : first.matchType === 'prefix' ? '分账号·前缀'
            : '分账号·包含';
      const patternText = first.matchType === 'all' ? (getShopName() || '未设置店铺') : first.accountPattern;
      messages.push(`${typeText}匹配「${patternText}」存在 ${group.length} 条启用规则，建议只保留一条`);
    });

    return messages;
  }

  function ruleConflictHtml(rules) {
    const messages = getRuleConflictMessages(rules);

    if (!messages.length) {
      return '<div style="padding:8px;color:#389e0d;background:#f6ffed;border:1px solid #b7eb8f;border-radius:6px;font-size:12px;">未发现重复启用规则。同一个子账号只会用一条规则：分账号精确 &gt; 前缀 &gt; 包含 &gt; 全店规则。</div>';
    }

    return `
      <div style="padding:8px;color:#ad4e00;background:#fff7e6;border:1px solid #ffd591;border-radius:6px;font-size:12px;line-height:1.5;">
        <div style="font-weight:700;margin-bottom:4px;">规则冲突提醒</div>
        ${messages.map(item => `<div>${escapeHtml(item)}</div>`).join('')}
      </div>
    `;
  }

  function refreshRuleConflictPanel(rules) {
    const box = document.getElementById('jxj-rule-conflicts');
    const panel = document.getElementById('jxj-rule-panel');
    const currentRules = rules || (panel ? readRulesFromPanel(panel) : getRules());
    if (box) box.innerHTML = ruleConflictHtml(currentRules);
  }

  function refreshRuntimeControls() {
    const settings = getRuntimeSettings();
    const paused = document.getElementById('jxj-setting-paused');
    const dryRun = document.getElementById('jxj-setting-dry-run');
    const intervalInput = document.getElementById('jxj-setting-interval-minutes');
    const readDelayInput = document.getElementById('jxj-setting-expanded-read-delay-seconds');
    const shopNameInput = document.getElementById('jxj-setting-shop-name');
    const dingEnabled = document.getElementById('jxj-setting-dingtalk-enabled');
    const dingWebhook = document.getElementById('jxj-setting-dingtalk-webhook');
    const dingSecret = document.getElementById('jxj-setting-dingtalk-secret');
    const dingKeyword = document.getElementById('jxj-setting-dingtalk-keyword');
    const sidebarShop = document.getElementById('jxj-sidebar-shop-name');
    const labels = document.querySelectorAll('.jxj-runtime-state-label');
    const shopName = getShopName();
    const ding = getDingTalkConfig();

    if (paused) paused.checked = !!settings.paused;
    if (dryRun) dryRun.checked = !!settings.dryRun;
    if (intervalInput && document.activeElement !== intervalInput) {
      intervalInput.value = String(getAdCheckIntervalMinutes());
    }
    if (readDelayInput && document.activeElement !== readDelayInput) {
      readDelayInput.value = String(getExpandedAccountReadDelaySeconds());
    }
    if (shopNameInput && document.activeElement !== shopNameInput) {
      shopNameInput.value = shopName;
    }
    if (dingEnabled) dingEnabled.checked = ding.enabled;
    if (dingWebhook && document.activeElement !== dingWebhook) {
      dingWebhook.value = ding.webhook;
    }
    if (dingSecret && document.activeElement !== dingSecret) {
      dingSecret.value = ding.secret;
    }
    if (dingKeyword && document.activeElement !== dingKeyword) {
      dingKeyword.value = ding.keyword;
    }
    if (sidebarShop) sidebarShop.innerText = shopName || '未设置店铺';

    labels.forEach(label => {
      label.innerText = settings.paused
        ? '已暂停'
        : settings.dryRun
          ? '模拟运行'
          : '正常运行';
      label.style.color = settings.paused ? '#fca5a5' : settings.dryRun ? '#fcd34d' : '#86efac';
    });

    refreshNextRunPanel();
  }

  function isShopWideRule(rule) {
    return (rule && rule.matchType) === 'all';
  }

  function ruleScopeMeta(matchType) {
    if (matchType === 'all') {
      return {
        badge: '全店规则',
        badgeBg: '#ecfeff',
        badgeColor: '#0f766e',
        border: '#14b8a6',
        hint: '覆盖本店所有子账号，不用填账号名。某个账号如果另有分账号规则，则以分账号规则为准。',
        placeholder: '全店规则不用填账号'
      };
    }

    if (matchType === 'prefix') {
      return {
        badge: '分账号规则 · 前缀',
        badgeBg: '#eff6ff',
        badgeColor: '#1d4ed8',
        border: '#2563eb',
        hint: '填写账号名前缀。名称以该前缀开头的子账号都用这条规则。',
        placeholder: '填写账号名前缀，例如 HYEG'
      };
    }

    if (matchType === 'contains') {
      return {
        badge: '分账号规则 · 包含',
        badgeBg: '#eff6ff',
        badgeColor: '#1d4ed8',
        border: '#2563eb',
        hint: '填写关键字。账号名里包含该字的子账号都用这条规则。',
        placeholder: '填写账号名关键字'
      };
    }

    return {
      badge: '分账号规则 · 精确',
      badgeBg: '#eff6ff',
      badgeColor: '#1d4ed8',
      border: '#2563eb',
      hint: '填写完整子账号名称，只对这一个账号生效。可用底部「导入为分账号规则」批量生成。',
      placeholder: '填写完整子账号名称，必须和页面显示一致'
    };
  }

  function syncRuleRowScopeUi(row) {
    if (!row) return;
    const matchType = ((row.querySelector('[data-field="matchType"]') || {}).value || 'exact');
    const meta = ruleScopeMeta(matchType);
    const badge = row.querySelector('.jxj-rule-scope-badge');
    const hint = row.querySelector('.jxj-rule-scope-hint');
    const input = row.querySelector('[data-field="accountPattern"]');
    const label = row.querySelector('.jxj-rule-account-label');
    const shopWide = matchType === 'all';

    row.setAttribute('data-rule-scope', shopWide ? 'shop' : 'account');
    row.style.borderLeftColor = meta.border;

    if (badge) {
      badge.innerText = meta.badge;
      badge.style.background = meta.badgeBg;
      badge.style.color = meta.badgeColor;
    }
    if (hint) hint.innerText = meta.hint;
    if (label) label.innerText = shopWide ? '适用账号' : '指定账号';
    if (input) {
      input.disabled = shopWide;
      input.placeholder = meta.placeholder;
      input.style.background = shopWide ? '#f8fafc' : '#fff';
    }
  }

  function ruleScopeGuideHtml() {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
        <div style="border:1px solid #99f6e4;background:#f0fdfa;border-radius:10px;padding:10px 12px;">
          <div style="font-weight:800;color:#0f766e;">全店规则</div>
          <div style="font-size:12px;color:#334155;line-height:1.55;margin-top:4px;">规则类型选「全店规则」，账号留空。一条就能管本店所有子账号。适合统一余额、ROI、分时充值。</div>
        </div>
        <div style="border:1px solid #bfdbfe;background:#eff6ff;border-radius:10px;padding:10px 12px;">
          <div style="font-weight:800;color:#1d4ed8;">分账号规则</div>
          <div style="font-size:12px;color:#334155;line-height:1.55;margin-top:4px;">规则类型选「分账号」，并填写子账号。只改个别账号时用这个。优先级：精确 &gt; 前缀 &gt; 包含 &gt; 全店。</div>
        </div>
      </div>
    `;
  }

  function ruleRowHtml(rule, index, total) {
    const item = normalizeRule(rule);
    const meta = ruleScopeMeta(item.matchType);
    const shopWide = isShopWideRule(item);

    return `
      <div class="jxj-rule-row" data-rule-id="${escapeHtml(item.id)}" data-index="${index}" data-rule-scope="${shopWide ? 'shop' : 'account'}" style="border:1px solid #cbd5e1;border-left:4px solid ${item.enabled ? meta.border : '#cbd5e1'};border-radius:7px;padding:11px 12px;margin:12px 0;background:#fff;box-shadow:0 2px 6px rgba(15,23,42,.07);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
          <span class="jxj-rule-scope-badge" style="display:inline-block;padding:3px 10px;border-radius:999px;background:${meta.badgeBg};color:${meta.badgeColor};font-size:12px;font-weight:800;">${escapeHtml(meta.badge)}</span>
          <div class="jxj-rule-scope-hint" style="flex:1;min-width:220px;font-size:12px;color:#64748b;line-height:1.45;">${escapeHtml(meta.hint)}</div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="display:grid;grid-template-columns:70px 64px minmax(140px,1fr) 148px 88px;gap:8px;align-items:center;flex:1;min-width:0;">
            <label style="font-size:12px;color:#4b5563;white-space:nowrap;">移到<input data-field="moveToIndex" type="number" min="1" step="1" value="${index + 1}" style="width:42px;margin-left:4px;padding:5px;border:1px solid #d1d5db;border-radius:4px;"></label>
            <label style="font-size:13px;white-space:nowrap;"><input type="checkbox" data-field="enabled" ${item.enabled ? 'checked' : ''}> 启用</label>
            <input data-field="name" value="${escapeHtml(item.name)}" placeholder="规则名称，仅用于识别" style="height:32px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;">
            <select data-field="matchType" title="全店规则覆盖所有子账号；分账号规则只作用于填写的账号" style="height:32px;padding:5px 8px;border:1px solid #d1d5db;border-radius:4px;background:#fff;">
            <option value="all" ${item.matchType === 'all' ? 'selected' : ''}>全店规则</option>
            <option value="exact" ${item.matchType === 'exact' ? 'selected' : ''}>分账号 · 精确</option>
            <option value="prefix" ${item.matchType === 'prefix' ? 'selected' : ''}>分账号 · 前缀</option>
            <option value="contains" ${item.matchType === 'contains' ? 'selected' : ''}>分账号 · 包含</option>
            </select>
            <label style="font-size:12px;color:#4b5563;white-space:nowrap;">金额<input data-field="amount" type="number" min="1" step="1" value="${escapeHtml(item.amount)}" title="未开启分时充值时的一次充值金额" style="width:54px;margin-left:4px;height:32px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;"></label>
          </div>
          <div style="display:flex;gap:4px;flex:0 0 auto;">
            <button type="button" data-action="move-rule-to" title="移动到左侧填写的位置" style="height:32px;padding:0 9px;border:1px solid #13c2c2;background:#fff;color:#08979c;border-radius:4px;cursor:pointer;">移动</button>
            <button type="button" data-action="move-rule-top" title="置顶规则" ${index === 0 ? 'disabled' : ''} style="height:32px;padding:0 8px;border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:4px;cursor:pointer;">顶</button>
            <button type="button" data-action="move-rule-bottom" title="置底规则" ${index >= total - 1 ? 'disabled' : ''} style="height:32px;padding:0 8px;border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:4px;cursor:pointer;">底</button>
            <button type="button" data-action="delete-rule" style="height:32px;padding:0 10px;border:1px solid #ff7875;background:#fff;color:#cf1322;border-radius:4px;cursor:pointer;">删除</button>
          </div>
        </div>
        <div class="jxj-rule-account-wrap" style="display:grid;grid-template-columns:88px 1fr;gap:8px;align-items:center;margin-top:8px;">
          <div class="jxj-rule-account-label" style="font-size:12px;color:#6b7280;">${shopWide ? '适用账号' : '指定账号'}</div>
          <input data-field="accountPattern" value="${escapeHtml(item.accountPattern)}" ${shopWide ? 'disabled' : ''} placeholder="${escapeHtml(meta.placeholder)}" style="width:100%;height:32px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;background:${shopWide ? '#f8fafc' : '#fff'};">
        </div>
        <div style="display:grid;grid-template-columns:86px 96px 96px 100px minmax(160px,1fr) 82px;gap:8px;align-items:center;margin-top:8px;font-size:13px;">
          <label style="white-space:nowrap;"><input type="checkbox" data-field="useThreshold" ${item.useThreshold ? 'checked' : ''}> 自动条件</label>
          <label style="white-space:nowrap;">余额&lt;<input data-field="minBalance" type="number" min="0" step="1" value="${escapeHtml(item.minBalance)}" style="width:54px;margin-left:4px;padding:5px;border:1px solid #d1d5db;border-radius:4px;"></label>
          <label style="white-space:nowrap;">ROI&gt;<input data-field="minRoi" type="number" min="0" step="0.1" value="${escapeHtml(item.minRoi)}" style="width:54px;margin-left:4px;padding:5px;border:1px solid #d1d5db;border-radius:4px;"></label>
          <label style="white-space:nowrap;"><input type="checkbox" data-field="useSchedule" ${item.useSchedule ? 'checked' : ''}> 固定时间</label>
          <input data-field="scheduleTimes" value="${escapeHtml(item.scheduleTimes)}" placeholder="10:58=100, 14:30=200" style="height:32px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;">
          <input data-field="scheduleWindowMinutes" type="hidden" value="1">
          <label style="white-space:nowrap;">冷却<input data-field="cooldownMinutes" type="number" min="0" step="1" value="${escapeHtml(item.cooldownMinutes)}" style="width:44px;margin-left:4px;padding:5px;border:1px solid #d1d5db;border-radius:4px;">分</label>
        </div>
        <div style="margin-top:8px;padding:8px 10px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:6px;">
          <label style="font-size:13px;white-space:nowrap;"><input type="checkbox" data-field="useTimeSlots" ${item.useTimeSlots ? 'checked' : ''}> 分时充值规则</label>
          <div style="font-size:12px;color:#6b7280;line-height:1.45;margin:4px 0 6px;">开启后，自动条件按当前时段的一次充值金额和 ROI 判断；未开启时仍用上面的金额和 ROI。</div>
          ${normalizeRuleTimeSlots(item.timeSlots, item.amount, item.minRoi).map((slot, slotIndex) => `
            <div class="jxj-rule-timeslot" data-slot-index="${slotIndex}" style="display:grid;grid-template-columns:58px 18px 58px 108px 110px;gap:8px;align-items:center;margin-top:6px;font-size:12px;color:#4b5563;">
              <label style="white-space:nowrap;"><input data-slot-field="startHour" type="number" min="0" max="24" step="1" value="${escapeHtml(slot.startHour)}" style="width:42px;margin-right:2px;padding:5px;border:1px solid #d1d5db;border-radius:4px;">点</label>
              <span>至</span>
              <label style="white-space:nowrap;"><input data-slot-field="endHour" type="number" min="0" max="24" step="1" value="${escapeHtml(slot.endHour)}" style="width:42px;margin-right:2px;padding:5px;border:1px solid #d1d5db;border-radius:4px;">点</label>
              <label style="white-space:nowrap;">一次<input data-slot-field="amount" type="number" min="1" step="1" value="${escapeHtml(slot.amount)}" style="width:54px;margin:0 4px;padding:5px;border:1px solid #d1d5db;border-radius:4px;">元</label>
              <label style="white-space:nowrap;">ROI&gt;<input data-slot-field="minRoi" type="number" min="0" step="0.1" value="${escapeHtml(slot.minRoi)}" style="width:54px;margin-left:4px;padding:5px;border:1px solid #d1d5db;border-radius:4px;"></label>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function readRulesFromPanel(panel) {
    return [...panel.querySelectorAll('.jxj-rule-row')].map(row => ({
      id: row.getAttribute('data-rule-id') || makeRuleId(),
      enabled: row.querySelector('[data-field="enabled"]').checked,
      name: row.querySelector('[data-field="name"]').value.trim() || '未命名规则',
      matchType: row.querySelector('[data-field="matchType"]').value,
      accountPattern: row.querySelector('[data-field="accountPattern"]').value.trim(),
      amount: Number(row.querySelector('[data-field="amount"]').value || CONFIG.rechargeAmount),
      useThreshold: row.querySelector('[data-field="useThreshold"]').checked,
      minBalance: Number(row.querySelector('[data-field="minBalance"]').value || CONFIG.minBalance),
      minRoi: Number(row.querySelector('[data-field="minRoi"]').value || CONFIG.minRoi),
      useSchedule: row.querySelector('[data-field="useSchedule"]').checked,
      scheduleTimes: row.querySelector('[data-field="scheduleTimes"]').value.trim(),
      scheduleWindowMinutes: Number(row.querySelector('[data-field="scheduleWindowMinutes"]').value || 30),
      cooldownMinutes: Number(row.querySelector('[data-field="cooldownMinutes"]').value || 0),
      useTimeSlots: !!(row.querySelector('[data-field="useTimeSlots"]') && row.querySelector('[data-field="useTimeSlots"]').checked),
      timeSlots: [...row.querySelectorAll('.jxj-rule-timeslot')].map(slotRow => ({
        startHour: Number((slotRow.querySelector('[data-slot-field="startHour"]') || {}).value || 0),
        endHour: Number((slotRow.querySelector('[data-slot-field="endHour"]') || {}).value || 0),
        amount: Number((slotRow.querySelector('[data-slot-field="amount"]') || {}).value || CONFIG.rechargeAmount),
        minRoi: Number((slotRow.querySelector('[data-slot-field="minRoi"]') || {}).value || CONFIG.minRoi)
      }))
    }));
  }

  function isSavableRule(rule) {
    return !!rule && (rule.matchType === 'all' || !!String(rule.accountPattern || '').trim());
  }

  function moveRuleToPanel(panel, index, targetIndex) {
    const rules = readRulesFromPanel(panel);
    targetIndex = Math.max(0, Math.min(rules.length - 1, targetIndex));
    if (targetIndex < 0 || targetIndex >= rules.length) return;
    if (targetIndex === index) return;

    const [item] = rules.splice(index, 1);
    rules.splice(targetIndex, 0, item);

    refreshRulePanelRows(panel, rules);
    refreshRuleConflictPanel(rules);
    showStatus('规则顺序已调整，点击“保存规则”后生效');
  }

  function refreshRulePanelRows(panel, rules) {
    const rows = panel.querySelector('#jxj-rule-panel-rows');
    const items = rules || getRules();
    rows.innerHTML = items
      .map((rule, index) => ruleRowHtml(rule, index, items.length))
      .join('');
    rows.querySelectorAll('.jxj-rule-row').forEach(syncRuleRowScopeUi);

    rows.querySelectorAll('[data-action="delete-rule"]').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.jxj-rule-row').remove();
        refreshRuleConflictPanel(readRulesFromPanel(panel));
      });
    });

    rows.querySelectorAll('[data-action="move-rule-top"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.jxj-rule-row');
        const index = [...rows.querySelectorAll('.jxj-rule-row')].indexOf(row);
        moveRuleToPanel(panel, index, 0);
      });
    });

    rows.querySelectorAll('[data-action="move-rule-to"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.jxj-rule-row');
        const currentRows = [...rows.querySelectorAll('.jxj-rule-row')];
        const index = currentRows.indexOf(row);
        const input = row.querySelector('[data-field="moveToIndex"]');
        const targetPosition = Math.max(1, Number(input?.value || index + 1));
        moveRuleToPanel(panel, index, targetPosition - 1);
      });
    });

    rows.querySelectorAll('[data-action="move-rule-bottom"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.jxj-rule-row');
        const index = [...rows.querySelectorAll('.jxj-rule-row')].indexOf(row);
        moveRuleToPanel(panel, index, rows.querySelectorAll('.jxj-rule-row').length - 1);
      });
    });

  }

  function bulkRuleFieldOptions() {
    return [
      {
        field: 'enabled',
        label: '启用状态',
        type: 'boolean',
        trueText: '全部启用',
        falseText: '全部关闭'
      },
      {
        field: 'matchType',
        label: '匹配方式',
        type: 'select',
        options: [
          { value: 'all', label: '全店规则' },
          { value: 'exact', label: '分账号 · 精确' },
          { value: 'prefix', label: '分账号 · 前缀' },
          { value: 'contains', label: '分账号 · 包含' }
        ]
      },
      {
        field: 'amount',
        label: '充值金额',
        type: 'number',
        min: 1,
        step: 1,
        defaultValue: CONFIG.rechargeAmount,
        suffix: '元'
      },
      {
        field: 'useThreshold',
        label: '自动条件',
        type: 'boolean',
        trueText: '开启',
        falseText: '关闭'
      },
      {
        field: 'minBalance',
        label: '余额阈值',
        type: 'number',
        min: 0,
        step: 1,
        defaultValue: CONFIG.minBalance
      },
      {
        field: 'minRoi',
        label: 'ROI阈值',
        type: 'number',
        min: 0,
        step: 0.1,
        defaultValue: CONFIG.minRoi
      },
      {
        field: 'useSchedule',
        label: '固定时间开关',
        type: 'boolean',
        trueText: '开启',
        falseText: '关闭'
      },
      {
        field: 'scheduleTimes',
        label: '固定时间内容',
        type: 'text',
        placeholder: '10:58=100, 14:30=200'
      },
      {
        field: 'cooldownMinutes',
        label: '冷却分钟',
        type: 'number',
        min: 0,
        step: 1,
        defaultValue: 1,
        suffix: '分钟'
      },
      {
        field: 'useTimeSlots',
        label: '分时充值开关',
        type: 'boolean',
        trueText: '开启',
        falseText: '关闭'
      },
      {
        field: 'timeSlots',
        label: '分时充值内容',
        type: 'text',
        placeholder: '0-9=100@2.9, 9-18=100@2.5, 18-24=200@2.2'
      }
    ];
  }

  function getBulkRuleFieldConfig(field) {
    return bulkRuleFieldOptions().find(item => item.field === field) || bulkRuleFieldOptions()[0];
  }

  function bulkRuleValueInputHtml(field) {
    const config = getBulkRuleFieldConfig(field);

    if (config.type === 'boolean') {
      return `
        <select id="jxj-bulk-rule-value" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:4px;">
          <option value="true">${escapeHtml(config.trueText || '开启')}</option>
          <option value="false">${escapeHtml(config.falseText || '关闭')}</option>
        </select>
      `;
    }

    if (config.type === 'select') {
      return `
        <select id="jxj-bulk-rule-value" style="width:100%;padding:6px;border:1px solid #ccc;border-radius:4px;">
          ${(config.options || []).map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')}
        </select>
      `;
    }

    if (config.type === 'text') {
      return `<input id="jxj-bulk-rule-value" type="text" placeholder="${escapeHtml(config.placeholder || '')}" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px;">`;
    }

    return `<input id="jxj-bulk-rule-value" type="number" min="${escapeHtml(config.min || 0)}" step="${escapeHtml(config.step || 1)}" value="${escapeHtml(config.defaultValue || 0)}" style="width:100%;box-sizing:border-box;padding:6px;border:1px solid #ccc;border-radius:4px;">`;
  }

  function bulkRuleControlHtml() {
    const options = bulkRuleFieldOptions();
    const defaultField = options.find(item => item.field === 'minRoi') || options[0];

    return `
      <div style="padding:9px 10px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:8px;">
        <div style="display:grid;grid-template-columns:92px 150px minmax(180px,1fr) 112px;gap:8px;align-items:center;">
          <div>
            <div style="font-weight:700;color:#111827;">批量调整</div>
            <div style="font-size:11px;color:#6b7280;white-space:nowrap;">只改条件，不改规则类型</div>
          </div>
          <select id="jxj-bulk-rule-field" style="padding:6px;border:1px solid #ccc;border-radius:4px;">
            ${options.map(item => `<option value="${escapeHtml(item.field)}" ${item.field === defaultField.field ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
          </select>
          <span id="jxj-bulk-rule-value-wrap">${bulkRuleValueInputHtml(defaultField.field)}</span>
          <button type="button" data-action="apply-bulk-rule" style="padding:7px 10px;border:1px solid #13c2c2;background:#13c2c2;color:#fff;border-radius:4px;cursor:pointer;font-weight:700;">批量应用</button>
        </div>
      </div>
    `;
  }

  function refreshBulkRuleValueInput(panel) {
    const field = panel.querySelector('#jxj-bulk-rule-field')?.value || 'minRoi';
    const wrap = panel.querySelector('#jxj-bulk-rule-value-wrap');
    if (wrap) wrap.innerHTML = bulkRuleValueInputHtml(field);
  }

  function getBulkRuleValue(panel) {
    const field = panel.querySelector('#jxj-bulk-rule-field')?.value || 'minRoi';
    const config = getBulkRuleFieldConfig(field);
    const input = panel.querySelector('#jxj-bulk-rule-value');

    if (!input) return null;

    if (config.type === 'boolean') {
      const value = input.value === 'true';
      return {
        field,
        label: config.label,
        value,
        valueText: value ? (config.trueText || '开启') : (config.falseText || '关闭')
      };
    }

    if (config.type === 'select') {
      const option = (config.options || []).find(item => item.value === input.value);
      return {
        field,
        label: config.label,
        value: input.value,
        valueText: option ? option.label : input.value
      };
    }

    if (config.type === 'text') {
      if (field === 'timeSlots' && !input.value.trim()) {
        window.alert('请填写分时充值内容，例如 0-9=100@2.9, 9-18=100@2.5, 18-24=200@2.2');
        return null;
      }

      return {
        field,
        label: config.label,
        value: input.value.trim(),
        valueText: input.value.trim() || '空'
      };
    }

    if (input.value === '') {
      window.alert(`请先填写${config.label}。`);
      return null;
    }

    const value = Number(input.value);
    if (!Number.isFinite(value) || value < Number(config.min || 0)) {
      window.alert(`${config.label}格式不正确。`);
      return null;
    }

    return {
      field,
      label: config.label,
      value,
      valueText: `${value}${config.suffix || ''}`
    };
  }

  function applyBulkRuleUpdate(panel) {
    const bulk = getBulkRuleValue(panel);
    if (!bulk) return;

    const rules = readRulesFromPanel(panel).filter(isSavableRule);
    if (!rules.length) {
      window.alert('当前没有可批量调整的规则。');
      return;
    }

    const confirmed = window.confirm(`将全部 ${rules.length} 条规则的「${bulk.label}」改为「${bulk.valueText}」，确认吗？`);
    if (!confirmed) return;

    const nextRules = rules.map(rule => {
      const patch = { [bulk.field]: bulk.value };
      if (bulk.field === 'timeSlots') {
        patch.timeSlots = parseRuleTimeSlotText(String(bulk.value || ''), rule.amount, rule.minRoi);
      }
      return normalizeRule(Object.assign({}, rule, patch));
    });

    saveRules(nextRules);
    refreshRulePanelRows(panel, getRules());
    refreshRuleConflictPanel(getRules());
    refreshNextRunPanel();
    showStatus(`已批量修改并保存：${rules.length}条规则，${bulk.label}=${bulk.valueText}`);
  }

  function makeExactAccountRule(accountName) {
    return normalizeRule({
      id: makeRuleId(), // 导入子账号时自动生成唯一ID，不要手动改。
      enabled: true, // 导入的新子账号规则默认启用。
      name: accountName, // 规则名称默认等于子账号名称，方便识别。
      matchType: 'exact', // 导入的子账号默认精确匹配，避免前缀误匹配到其他账号。
      accountPattern: accountName, // 精确匹配的子账号名称。
      amount: CONFIG.rechargeAmount, // 导入规则的默认充值金额，来自顶部CONFIG.rechargeAmount。
      useThreshold: true, // 导入规则默认启用余额/ROI自动条件。
      minBalance: CONFIG.minBalance, // 导入规则默认余额阈值，来自顶部CONFIG.minBalance。
      minRoi: CONFIG.minRoi, // 导入规则默认ROI阈值，来自顶部CONFIG.minRoi。
      useSchedule: false, // 导入规则默认不启用固定时间充值，需要你在面板里手动勾选。
      scheduleTimes: '', // 固定时间充值配置，示例：10:58=100, 14:30=200。
      scheduleWindowMinutes: 30, // 旧字段保留；当前固定时间按准确分钟触发，面板里隐藏为1。
      cooldownMinutes: 1, // 余额/ROI自动条件冷却1分钟；想更频繁自动补钱可以调小，想更稳可以调大。
      useTimeSlots: false, // 导入规则默认不启用分时充值，需要在面板里勾选。
      timeSlots: defaultRuleTimeSlots()
    });
  }

  function importCurrentExpandedAccountRules(panel) {
    const accounts = collectExpandedAccounts();

    if (!accounts.length) {
      window.alert('当前页面没有读取到已展开的子账号。请先在京小洁页面搜索并展开店铺子账号，再点击导入。');
      return;
    }

    const rules = readRulesFromPanel(panel);
    const exactAccountSet = new Set(
      rules
        .filter(rule => rule.matchType === 'exact')
        .map(rule => normalizeText(rule.accountPattern))
    );

    let added = 0;

    for (const account of accounts) {
      const accountName = account.accountName;
      if (!accountName) continue;
      if (exactAccountSet.has(normalizeText(accountName))) continue;

      rules.push(makeExactAccountRule(accountName));
      exactAccountSet.add(normalizeText(accountName));
      added += 1;
    }

    refreshRulePanelRows(panel, rules);
    refreshNextRunPanel();
    showStatus(`已导入 ${added} 条分账号精确规则。调整后请点击“保存规则”。`);
  }

  function buildDirectRuleTask(rule, amount, reason, doneKey) {
    return {
      accountName: rule.accountPattern,
      balance: null,
      spend: null,
      roi: null,
      amount: Number(amount || rule.amount || CONFIG.rechargeAmount),
      ruleId: rule.id,
      ruleName: rule.name,
      ruleDoneKey: doneKey || null,
      triggerReason: reason || '手动单次充值',
      scheduleSlot: null
    };
  }

  function enqueueDueScheduleRules() {
    if (isPaused()) return;
    if (!acquireRuleScheduleLock()) return;

    try {
      const rules = getRules().filter(rule =>
        rule.enabled &&
        rule.useSchedule &&
        rule.matchType === 'exact' &&
        rule.accountPattern
      );

      if (!rules.length) return;

      const now = new Date();
      const currentMinutes = minutesOfDay(now.getHours(), now.getMinutes());
      const today = todayKey();
      const done = getRuleDoneMap();
      const tasks = [];

      for (const rule of rules) {
        const plans = parseSchedulePlans(rule.scheduleTimes, rule.amount);

        for (const plan of plans) {
          if (plan.minutes !== currentMinutes) continue;

          const slot = `${today}_${plan.text}`;
          const doneKey = makeRuleDoneKey(rule.accountPattern, rule, slot);
          if (done[doneKey]) continue;

          tasks.push(buildDirectRuleTask(
            rule,
            plan.amount,
            `固定时间 ${plan.text}`,
            doneKey
          ));
        }
      }

      if (!tasks.length) {
        setRuleDoneMap(done);
        return;
      }

      const budgeted = prepareTasksWithDailyBudget(tasks);
      const pendingTasks = budgeted.tasks;
      const budgetText = budgeted.messages.length ? `\n${budgeted.messages.join('\n')}` : '';
      const skippedText = budgeted.skipped.length
        ? `\n预算跳过：${budgeted.skipped.map(item => `${item.accountName} ${item.amount}元`).join('、')}`
        : '';

      if (isDryRun()) {
        const noticeMap = readJsonValue(STORAGE_DRY_RUN_SCHEDULE_NOTICE, {});
        const noticeKey = `${today}_${currentMinutes}`;

        if (!noticeMap[noticeKey]) {
          noticeMap[noticeKey] = Date.now();
          writeJsonValue(STORAGE_DRY_RUN_SCHEDULE_NOTICE, noticeMap);
          setSimulationResults(pendingTasks, '固定时间模拟', budgeted);
          showStatus(
            `模拟运行：固定时间到点，原本会投递 ${tasks.length} 个，预算后 ${pendingTasks.length} 个充值任务：\n` +
            pendingTasks.map(task => `${task.accountName}，${task.amount}元`).join('\n') +
            skippedText +
            budgetText
          );
        }

        return;
      }

      if (!pendingTasks.length) {
        showStatus('固定时间到点，但受当日推广预算限制，未投递充值任务' + skippedText + budgetText);
        return;
      }

      pendingTasks.forEach(task => {
        if (task.ruleDoneKey) done[task.ruleDoneKey] = Date.now();
      });
      setRuleDoneMap(done);
      const added = addTasks(pendingTasks).added;

      showStatus(
        `固定时间到点，已投递 ${added}/${pendingTasks.length} 个充值任务：\n` +
        pendingTasks.map(task => `${task.accountName}，${task.amount}元`).join('\n') +
        skippedText +
        budgetText
      );

      openAssignTabIfNeeded();
    } finally {
      releaseRuleScheduleLock();
    }
  }

  function startRuleScheduler() {
    if (scheduleTimerStarted) return;
    scheduleTimerStarted = true;

    enqueueDueScheduleRules();
    refreshNextRunPanel();
    setInterval(() => {
      enqueueDueScheduleRules();
      refreshNextRunPanel();
    }, 15 * 1000); // 固定时间充值检查频率：每15秒检查一次是否到点。
  }

  // 从大到小逐级设置：店铺预算 → 分时预算 → 子账号与分组 → 分组和账号额度 → 充值规则。
  const WORKSPACE_PAGES = [
    { id: 'overview', label: '总览' },
    { id: 'budget', label: '① 店铺预算', step: 1 },
    { id: 'slots', label: '② 分时预算', step: 2 },
    { id: 'accounts', label: '③ 子账号与分组', step: 3 },
    { id: 'alloc', label: '④ 分组与账号额度', step: 4 },
    { id: 'rules', label: '⑤ 充值规则', step: 5 },
    { id: 'queue', label: '充值队列' },
    { id: 'logs', label: '提交记录' },
    { id: 'settings', label: '运行设置' },
    { id: 'versions', label: '版本中心' }
  ];

  const WORKSPACE_STEPS = WORKSPACE_PAGES.filter(page => page.step);

  function workspaceStepBarHtml(activeId) {
    const active = WORKSPACE_STEPS.find(page => page.id === activeId);
    if (!active) return '';

    return `
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
        ${WORKSPACE_STEPS.map((page, index) => {
          const on = page.id === activeId;
          const dot = `<span style="width:16px;height:16px;border-radius:50%;background:${on ? '#2563eb' : '#cbd5e1'};color:#fff;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;">${page.step}</span>`;
          const label = page.label.replace(/^[①②③④⑤]\s*/, '');
          return `
            <button type="button" data-workspace-nav="${page.id}" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:0;border-radius:999px;background:${on ? '#dbeafe' : '#f1f5f9'};color:${on ? '#1e40af' : '#64748b'};font-size:12px;font-weight:${on ? 700 : 500};cursor:pointer;">${dot}${escapeHtml(label)}</button>
            ${index < WORKSPACE_STEPS.length - 1 ? '<span style="color:#cbd5e1;font-size:12px;">›</span>' : ''}
          `;
        }).join('')}
      </div>
    `;
  }

  function nextStepButtonHtml(currentId) {
    const index = WORKSPACE_STEPS.findIndex(page => page.id === currentId);
    if (index < 0) return '';

    const previous = WORKSPACE_STEPS[index - 1];
    const next = WORKSPACE_STEPS[index + 1];

    return `
      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:12px;flex-wrap:wrap;">
        <div>${previous ? `<button type="button" data-workspace-nav="${previous.id}" style="padding:7px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">上一步 · ${escapeHtml(previous.label.replace(/^[①②③④⑤]\s*/, ''))}</button>` : ''}</div>
        <div>${next ? `<button type="button" data-workspace-nav="${next.id}" style="padding:7px 12px;border:0;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer;font-weight:700;">下一步 · ${escapeHtml(next.label.replace(/^[①②③④⑤]\s*/, ''))}</button>` : ''}</div>
      </div>
    `;
  }

  function getLatestVersionEntry() {
    return VERSION_HISTORY[0] || { version: SCRIPT_VERSION, date: '', type: 'feature', title: '当前版本', items: [] };
  }

  function getLastSeenVersion() {
    try {
      return String(GM_getValue(STORAGE_LAST_SEEN_VERSION, ''));
    } catch (e) {
      return '';
    }
  }

  function hasUnreadVersion() {
    return getLastSeenVersion() !== SCRIPT_VERSION;
  }

  function markVersionSeen() {
    try {
      GM_setValue(STORAGE_LAST_SEEN_VERSION, SCRIPT_VERSION);
    } catch (e) {}
  }

  function versionTypeMeta(type) {
    if (type === 'fix') return { text: '修复', bg: '#fef2f2', color: '#b91c1c' };
    if (type === 'improve') return { text: '优化', bg: '#ecfeff', color: '#0f766e' };
    return { text: '新增', bg: '#eff6ff', color: '#1d4ed8' };
  }

  function versionCenterHtml() {
    const latest = getLatestVersionEntry();
    return `
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <div>
            <div style="font-size:12px;color:#64748b;">当前运行版本</div>
            <div style="font-size:22px;font-weight:800;color:#0f172a;margin-top:2px;">${escapeHtml(SCRIPT_NAME)}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:12px;color:#64748b;">${escapeHtml(latest.date || '')}</div>
            <div style="font-size:13px;font-weight:700;color:#1e40af;margin-top:2px;">${escapeHtml(latest.title || '')}</div>
          </div>
        </div>
        <div style="font-size:12px;color:#475569;line-height:1.5;margin-top:8px;">油猴脚本名称固定为「${escapeHtml(SCRIPT_DISPLAY_NAME)}」，请以右下角「工作台 ${escapeHtml(SCRIPT_VERSION)}」确认当前版本。从下面这个地址安装一次后，Tampermonkey 会自动检查更新；本机规则和设置会保留。</div>
        <div style="margin-top:8px;padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;line-height:1.5;word-break:break-all;color:#334155;">${escapeHtml(SCRIPT_UPDATE_URL)}</div>
      </div>
      ${VERSION_HISTORY.map((entry, index) => {
        const type = versionTypeMeta(entry.type);
        const current = String(entry.version) === SCRIPT_VERSION;
        return `
          <div style="background:#fff;border:1px solid ${current ? '#93c5fd' : '#e2e8f0'};border-radius:12px;padding:12px 14px;margin-bottom:8px;${current ? 'box-shadow:0 0 0 1px #bfdbfe;' : ''}">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
              <span style="font-weight:800;color:#0f172a;">v${escapeHtml(entry.version)}</span>
              <span style="padding:2px 8px;border-radius:999px;background:${type.bg};color:${type.color};font-size:11px;font-weight:700;">${escapeHtml(type.text)}</span>
              ${current ? '<span style="padding:2px 8px;border-radius:999px;background:#dbeafe;color:#1e40af;font-size:11px;font-weight:700;">当前</span>' : ''}
              <span style="font-size:12px;color:#64748b;">${escapeHtml(entry.date || '')}</span>
              <span style="font-size:13px;font-weight:700;color:#334155;">${escapeHtml(entry.title || '')}</span>
            </div>
            <div style="font-size:13px;color:#334155;line-height:1.55;">
              ${(entry.items || []).map(item => `<div style="display:flex;gap:6px;"><span style="color:#94a3b8;">${index === 0 ? '•' : '•'}</span><span>${escapeHtml(item)}</span></div>`).join('')}
            </div>
          </div>
        `;
      }).join('')}
    `;
  }

  function refreshVersionCenter() {
    const box = document.getElementById('jxj-version-center');
    if (box) box.innerHTML = versionCenterHtml();
  }

  function refreshWorkspaceNav() {
    const nav = document.getElementById('jxj-workspace-nav');
    if (nav) nav.innerHTML = workspaceNavHtml();
    const versionBtn = document.getElementById('jxj-sidebar-version');
    if (versionBtn) {
      versionBtn.innerText = 'v' + SCRIPT_VERSION + (hasUnreadVersion() ? ' · 有更新' : '');
    }
  }

  function getDashboardRule() {
    const rules = getRules().filter(rule => rule.enabled);
    return rules.find(rule => rule.useTimeSlots) || rules[0] || defaultRule();
  }

  function getHourRangeStatus(startHour, endHour) {
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    const start = Number(startHour) * 60;
    const end = Number(endHour) >= 24 ? 24 * 60 : Number(endHour) * 60;
    if (current < start) return { text: '未到', color: '#64748b', bg: '#f8fafc' };
    if (current >= end) return { text: '已过', color: '#94a3b8', bg: '#f8fafc' };
    return { text: '进行中', color: '#1d4ed8', bg: '#eff6ff' };
  }

  function findRuleSlotCovering(rule, startHour, endHour) {
    const slots = normalizeRuleTimeSlots((rule || {}).timeSlots, (rule || {}).amount, (rule || {}).minRoi);
    const mid = (Number(startHour) + (Number(endHour) >= 24 ? 24 : Number(endHour))) / 2 * 60;

    return slots.find(slot => {
      const start = Number(slot.startHour) * 60;
      const end = Number(slot.endHour) >= 24 ? 24 * 60 : Number(slot.endHour) * 60;
      return mid >= start && mid < end;
    }) || null;
  }

  function budgetProgressHtml(decision) {
    const slots = getBudgetSlots(decision.settings);
    const totalMinutes = 24 * 60;
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const markerLeft = Math.max(0, Math.min(100, currentMinutes / totalMinutes * 100));
    const colors = ['#93c5fd', '#60a5fa', '#3b82f6', '#1d4ed8'];

    return `
      <div style="position:relative;padding-top:4px;">
        <div style="display:flex;height:42px;border-radius:10px;overflow:hidden;background:#e2e8f0;">
          ${slots.map((slot, index) => {
            const start = Number(slot.startHour) * 60;
            const end = Number(slot.endHour) >= 24 ? 24 * 60 : Number(slot.endHour) * 60;
            const width = Math.max(4, (end - start) / totalMinutes * 100);
            const active = currentMinutes >= start && currentMinutes < end;
            return `<div style="width:${width}%;background:${colors[index % colors.length]};display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;box-shadow:${active ? 'inset 0 0 0 2px #1e3a8a' : 'none'};">${escapeHtml(formatSlotRange(slot))}<br>${escapeHtml(formatRatio(slot.percent))}%</div>`;
          }).join('')}
        </div>
        <div title="当前时间" style="position:absolute;left:${markerLeft}%;top:0;bottom:0;width:2px;background:#ef4444;transform:translateX(-1px);"></div>
      </div>
    `;
  }

  function budgetRingHtml(decision) {
    const budget = Number(decision.budget || 0);
    const used = Number(decision.used || 0);
    const percent = budget > 0 ? Math.min(100, Math.round(used / budget * 100)) : 0;

    return `
      <div style="width:132px;height:132px;border-radius:50%;background:conic-gradient(#2563eb 0 ${percent}%, #e2e8f0 ${percent}% 100%);display:flex;align-items:center;justify-content:center;margin:0 auto;">
        <div style="width:92px;height:92px;border-radius:50%;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;">
          <div style="font-size:20px;font-weight:800;color:#0f172a;line-height:1;">${percent}%</div>
          <div style="font-size:11px;color:#64748b;margin-top:4px;">${escapeHtml(formatMoney(used))}/${escapeHtml(formatMoney(budget))}</div>
        </div>
      </div>
    `;
  }

  function overviewSlotTableHtml(decision) {
    const rule = getDashboardRule();
    const slots = getBudgetSlots(decision.settings);

    return `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#f8fafc;color:#475569;">
            <th style="text-align:left;padding:8px;border-bottom:1px solid #e2e8f0;">时段</th>
            <th style="text-align:right;padding:8px;border-bottom:1px solid #e2e8f0;">预算上限</th>
            <th style="text-align:left;padding:8px;border-bottom:1px solid #e2e8f0;">分时充值规则</th>
            <th style="text-align:left;padding:8px;border-bottom:1px solid #e2e8f0;">状态</th>
          </tr>
        </thead>
        <tbody>
          ${slots.map(slot => {
            const status = getHourRangeStatus(slot.startHour, slot.endHour);
            const ruleSlot = rule.useTimeSlots ? findRuleSlotCovering(rule, slot.startHour, slot.endHour) : null;
            const ruleText = rule.useTimeSlots
              ? (ruleSlot ? `一次 ${formatMoney(ruleSlot.amount)} 元，ROI > ${formatRatio(ruleSlot.minRoi)}` : '当前时段无分时规则')
              : `统一一次 ${formatMoney(rule.amount)} 元，ROI > ${formatRatio(rule.minRoi)}`;
            return `
              <tr style="background:${status.bg};">
                <td style="padding:8px;border-bottom:1px solid #eef2f7;font-weight:700;color:#0f172a;">${escapeHtml(formatSlotRange(slot))}</td>
                <td style="padding:8px;border-bottom:1px solid #eef2f7;text-align:right;">${escapeHtml(formatRatio(slot.percent))}% / ${escapeHtml(formatMoney(getSlotBudgetAmount(decision.settings, slot)))} 元</td>
                <td style="padding:8px;border-bottom:1px solid #eef2f7;">${escapeHtml(ruleText)}</td>
                <td style="padding:8px;border-bottom:1px solid #eef2f7;color:${status.color};font-weight:700;">${escapeHtml(status.text)}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function overviewGroupTableHtml(decision) {
    const settings = decision.settings;
    const slot = decision.slot;
    const groups = getAccountGroups();
    const roster = getAccountRoster();

    if (!roster.length) {
      return '<div style="font-size:12px;color:#64748b;line-height:1.6;">还没有子账号名单。到「③ 子账号与分组」点「从页面拉取子账号」，就能按分组分配额度。</div>';
    }

    return `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#f8fafc;color:#475569;">
            <th style="text-align:left;padding:8px;border-bottom:1px solid #e2e8f0;">分组</th>
            <th style="text-align:right;padding:8px;border-bottom:1px solid #e2e8f0;">账号数</th>
            <th style="text-align:right;padding:8px;border-bottom:1px solid #e2e8f0;">当天额度</th>
            <th style="text-align:right;padding:8px;border-bottom:1px solid #e2e8f0;">已用</th>
            <th style="text-align:left;padding:8px;border-bottom:1px solid #e2e8f0;">当前时段还能充</th>
          </tr>
        </thead>
        <tbody>
          ${groups.map(group => {
            const count = roster.filter(item => item.groupId === group.id).length;
            const daily = getGroupDailyQuota(group, settings);
            const slotQuota = getGroupSlotQuota(group, settings, slot);
            const used = getGroupUsedAmount(group.id, { includePending: true });
            const left = slotQuota === null ? null : Math.max(0, slotQuota - used);

            return `
              <tr>
                <td style="padding:8px;border-bottom:1px solid #eef2f7;font-weight:700;color:#0f172a;">${escapeHtml(group.name)}</td>
                <td style="padding:8px;border-bottom:1px solid #eef2f7;text-align:right;">${escapeHtml(count)}</td>
                <td style="padding:8px;border-bottom:1px solid #eef2f7;text-align:right;">${daily === null ? '不限' : `${escapeHtml(formatMoney(daily))} 元`}</td>
                <td style="padding:8px;border-bottom:1px solid #eef2f7;text-align:right;">${escapeHtml(formatMoney(used))} 元</td>
                <td style="padding:8px;border-bottom:1px solid #eef2f7;color:#334155;">${left === null ? '只受店铺和分时约束' : `${escapeHtml(formatMoney(left))} 元`}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function overviewDashboardHtml() {
    try {
      return buildOverviewDashboardHtml();
    } catch (error) {
      console.error('[京小洁全自动脚本] 总览渲染失败', error);
      return `<div style="padding:12px;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">总览页渲染失败：${escapeHtml(error && error.message ? error.message : error)}。请先打开「店铺预算 / 充值规则」页使用，并查看 Console。</div>`;
    }
  }

  function buildOverviewDashboardHtml() {
    const decision = evaluateDailyBudget({ includePending: true });
    const settings = getRuntimeSettings();
    const currentRule = getDashboardRule();
    const currentRuleSlot = currentRule.useTimeSlots ? getCurrentRuleTimeSlot(currentRule) : null;

    return `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
        <span style="padding:4px 10px;border-radius:999px;background:#dbeafe;color:#1e40af;font-size:12px;font-weight:700;">今日</span>
        <span style="padding:4px 10px;border-radius:999px;background:${settings.dryRun ? '#fef3c7' : '#e2e8f0'};color:${settings.dryRun ? '#92400e' : '#334155'};font-size:12px;">模拟运行 ${settings.dryRun ? '开' : '关'}</span>
        <span style="padding:4px 10px;border-radius:999px;background:#e2e8f0;color:#334155;font-size:12px;">查询间隔 ${escapeHtml(getAdCheckIntervalMinutes())} 分</span>
        <span style="padding:4px 10px;border-radius:999px;background:#e2e8f0;color:#334155;font-size:12px;">下次查询 ${escapeHtml(getNextAdCheckText())}</span>
        <button type="button" data-action="goto-versions" style="padding:4px 10px;border:0;border-radius:999px;background:${hasUnreadVersion() ? '#dbeafe' : '#e2e8f0'};color:${hasUnreadVersion() ? '#1e40af' : '#334155'};font-size:12px;cursor:pointer;font-weight:${hasUnreadVersion() ? 700 : 500};">版本 v${escapeHtml(SCRIPT_VERSION)}${hasUnreadVersion() ? ' · 有更新' : ''}</button>
      </div>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:12px;margin-bottom:12px;">
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px;">
            <div style="font-weight:800;color:#0f172a;">分时预算进度</div>
            <div style="font-size:12px;color:#64748b;">当前上限 ${escapeHtml(formatMoney(decision.slotBudget))} 元，已用 ${escapeHtml(formatMoney(decision.used))} 元</div>
          </div>
          ${budgetProgressHtml(decision)}
        </div>
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;text-align:center;">
          <div style="font-weight:800;color:#0f172a;margin-bottom:8px;">今日预算使用</div>
          ${budgetRingHtml(decision)}
        </div>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:12px;">
        <div style="font-weight:800;color:#0f172a;margin-bottom:8px;">时段对照</div>
        ${overviewSlotTableHtml(decision)}
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:12px;">
        <div style="font-weight:800;color:#0f172a;margin-bottom:8px;">分组额度进度</div>
        ${overviewGroupTableHtml(decision)}
      </div>
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:10px 12px;font-size:13px;color:#1e3a8a;line-height:1.5;">
        ${currentRule.useTimeSlots && currentRuleSlot
          ? `当前分时规则：${escapeHtml(formatSlotRange(currentRuleSlot))}，一次 ${escapeHtml(formatMoney(currentRuleSlot.amount))} 元，需 ROI &gt; ${escapeHtml(formatRatio(currentRuleSlot.minRoi))}。`
          : `当前未开启分时充值，使用「${escapeHtml(currentRule.name)}」统一规则：一次 ${escapeHtml(formatMoney(currentRule.amount))} 元，ROI &gt; ${escapeHtml(formatRatio(currentRule.minRoi))}。`}
        当前可充 ${escapeHtml(formatMoney(decision.remaining))} 元${decision.usedFromSpend ? `；无脚本充值记录，已用按已消耗 ${escapeHtml(formatMoney(decision.consumed))} 元起算` : ''}${decision.canExceed ? '；店铺投产达标，允许超预算。' : '。'}
      </div>
    `;
  }

  let overviewRefreshing = false;

  function refreshOverviewDashboard() {
    if (overviewRefreshing) return;
    const box = document.getElementById('jxj-overview-dashboard');
    if (!box) return;
    overviewRefreshing = true;
    try {
      box.innerHTML = overviewDashboardHtml();
    } finally {
      overviewRefreshing = false;
    }
  }

  function workspaceNavHtml() {
    const unread = hasUnreadVersion();
    return WORKSPACE_PAGES.map(page => {
      const active = page.id === activeWorkspacePage;
      const badge = page.id === 'versions' && unread
        ? '<span style="margin-left:6px;padding:1px 6px;border-radius:999px;background:#ef4444;color:#fff;font-size:10px;font-weight:700;vertical-align:middle;">新</span>'
        : '';
      return `<button type="button" data-workspace-nav="${page.id}" style="display:block;width:100%;text-align:left;border:0;border-radius:8px;padding:9px 10px;margin:0 0 6px;background:${active ? '#2563eb' : 'transparent'};color:#fff;font-size:13px;font-weight:${active ? 700 : 500};cursor:pointer;">${escapeHtml(page.label)}${badge}</button>`;
    }).join('');
  }

  function switchWorkspacePage(pageId) {
    if (!WORKSPACE_PAGES.some(page => page.id === pageId)) return;
    activeWorkspacePage = pageId;
    const panel = document.getElementById('jxj-rule-panel');
    if (!panel) return;

    panel.querySelectorAll('[data-workspace-page]').forEach(page => {
      page.style.display = page.getAttribute('data-workspace-page') === pageId ? 'block' : 'none';
    });

    if (pageId === 'versions') markVersionSeen();
    refreshWorkspaceNav();

    const title = document.getElementById('jxj-workspace-title');
    const current = WORKSPACE_PAGES.find(page => page.id === pageId);
    if (title && current) title.innerText = current.label;

    const footer = document.getElementById('jxj-workspace-footer');
    if (footer) footer.style.display = pageId === 'rules' ? 'flex' : 'none';

    if (pageId === 'overview') refreshOverviewDashboard();
    if (pageId === 'budget') refreshBudgetPanel({ fillInputs: true });
    if (pageId === 'slots') refreshBudgetSlotPage({ rerender: true });
    if (pageId === 'accounts') refreshAccountRosterPanel();
    if (pageId === 'alloc') refreshAllocationPanel({ rerender: true });
    if (pageId === 'queue') {
      refreshQueuePanel();
      refreshSimulationPanel();
    }
    if (pageId === 'logs') refreshRechargeLogPanel();
    if (pageId === 'settings' || pageId === 'overview') refreshRuntimeControls();
    if (pageId === 'versions') {
      refreshVersionCenter();
    }
    if (pageId === 'rules') refreshRuleConflictPanel();
  }

  function openWorkspace(pageId) {
    const panel = document.getElementById('jxj-rule-panel');
    if (!panel) return;
    rulePanelVisible = true;
    panel.style.display = 'block';
    switchWorkspacePage(pageId || activeWorkspacePage || 'overview');
  }

  function addBlankRuleToPanel(panel, matchType) {
    const shopWide = matchType === 'all';
    const rules = readRulesFromPanel(panel);
    rules.push(normalizeRule({
      id: makeRuleId(),
      enabled: true,
      name: shopWide ? '全店规则' : '分账号规则',
      matchType: shopWide ? 'all' : 'exact',
      accountPattern: '',
      amount: CONFIG.rechargeAmount,
      useThreshold: true,
      minBalance: CONFIG.minBalance,
      minRoi: CONFIG.minRoi,
      useSchedule: false,
      scheduleTimes: '',
      scheduleWindowMinutes: 30,
      cooldownMinutes: 1,
      useTimeSlots: false,
      timeSlots: defaultRuleTimeSlots()
    }));
    refreshRulePanelRows(panel, rules);
    refreshRuleConflictPanel(rules);
    refreshNextRunPanel();
    showStatus(shopWide ? '已新增一条全店规则，保存后对本店所有子账号生效' : '已新增一条分账号规则，请填写完整子账号名称后保存');
  }

  function handleWorkspaceAction(panel, action, actionEl) {
    if (action === 'close-panel') {
      rulePanelVisible = false;
      panel.style.display = 'none';
      return;
    }
    if (action === 'goto-rules') return switchWorkspacePage('rules');
    if (action === 'goto-logs') return switchWorkspacePage('logs');
    if (action === 'goto-budget') return switchWorkspacePage('budget');
    if (action === 'goto-slots') return switchWorkspacePage('slots');
    if (action === 'goto-accounts') return switchWorkspacePage('accounts');
    if (action === 'goto-alloc') return switchWorkspacePage('alloc');

    if (action === 'pull-accounts') {
      if (!isJxjAdPage()) {
        window.alert('请在京小洁「广告投放明细」页面拉取子账号。\n当前地址：' + location.href);
        return;
      }

      const accounts = collectExpandedAccounts();
      if (!accounts.length) {
        window.alert('当前页面没有读取到已展开的子账号。请先搜索店铺并展开子账号，或先点「立即执行全流程」跑一轮，再来拉取。');
        return;
      }

      const result = mergeAccountsIntoRoster(accounts);
      refreshAccountRosterPanel();
      refreshAllocationPanel({ rerender: true });
      showStatus(`已拉取子账号：新增 ${result.added} 个，更新 ${result.updated} 个，名单共 ${getAccountRosterMeta().count} 个。`);
      return;
    }

    if (action === 'save-roster') {
      saveAccountRoster(readRosterFromPanel(), { keepTime: true });
      refreshAccountRosterPanel();
      refreshAllocationPanel({ rerender: true });
      showStatus('已保存子账号名单和分组归属');
      return;
    }

    if (action === 'bulk-move-group') {
      const select = panel.querySelector('#jxj-roster-bulk-group');
      const groupId = select ? select.value : '';
      const names = getSelectedRosterAccounts();

      if (!groupId) {
        window.alert('请先在下拉框里选择要移入的分组。');
        return;
      }
      if (!names.length) {
        window.alert('请先勾选要移动的子账号。');
        return;
      }

      const keys = new Set(names.map(normalizeText));
      const roster = readRosterFromPanel().map(item =>
        keys.has(normalizeText(item.accountName)) ? Object.assign({}, item, { groupId }) : item
      );

      saveAccountRoster(roster, { keepTime: true });
      refreshAccountRosterPanel();
      refreshAllocationPanel({ rerender: true });
      showStatus(`已把 ${names.length} 个子账号移入「${getAccountGroup(groupId).name}」`);
      return;
    }

    if (action === 'bulk-remove-accounts') {
      const names = getSelectedRosterAccounts();
      if (!names.length) {
        window.alert('请先勾选要移除的子账号。');
        return;
      }
      if (!window.confirm(`确定从名单移除 ${names.length} 个子账号吗？下次拉取还会重新出现。`)) return;

      const keys = new Set(names.map(normalizeText));
      saveAccountRoster(readRosterFromPanel().filter(item => !keys.has(normalizeText(item.accountName))), { keepTime: true });
      refreshAccountRosterPanel();
      refreshAllocationPanel({ rerender: true });
      showStatus(`已从名单移除 ${names.length} 个子账号`);
      return;
    }

    if (action === 'bulk-make-rules') {
      const names = getSelectedRosterAccounts();
      if (!names.length) {
        window.alert('请先勾选要生成充值规则的子账号。');
        return;
      }

      const rules = getRules();
      const exists = new Set(rules.filter(rule => rule.matchType === 'exact').map(rule => normalizeText(rule.accountPattern)));
      let added = 0;

      names.forEach(name => {
        if (exists.has(normalizeText(name))) return;
        rules.push(makeExactAccountRule(name));
        exists.add(normalizeText(name));
        added += 1;
      });

      saveRules(rules);
      refreshRulePanelRows(panel, getRules());
      refreshRuleConflictPanel(getRules());
      showStatus(`已生成 ${added} 条分账号充值规则，可到「⑤ 充值规则」页继续调整。`);
      return;
    }

    if (action === 'add-group') {
      const input = panel.querySelector('#jxj-new-group-name');
      const name = input ? String(input.value || '').trim() : '';

      if (!name) {
        window.alert('请先填写分组名称。');
        return;
      }

      const groups = getAccountGroups();
      if (groups.some(group => group.name === name)) {
        window.alert('已经有同名分组了，请换一个名称。');
        return;
      }

      groups.push(normalizeAccountGroup({ id: makeLogId(), name, quotaMode: 'none', quotaValue: 0 }));
      saveAccountGroups(groups);
      if (input) input.value = '';
      refreshAccountRosterPanel();
      refreshAllocationPanel({ rerender: true });
      showStatus(`已新增分组「${name}」。到第 4 步可以给它设额度。`);
      return;
    }

    if (action === 'rename-group') {
      const groupId = actionEl && actionEl.getAttribute('data-group');
      const group = getAccountGroup(groupId);
      if (!group || group.id === UNGROUPED_ID) return;

      const name = window.prompt('新的分组名称', group.name);
      if (!name || !String(name).trim()) return;

      saveAccountGroups(getAccountGroups().map(item =>
        item.id === groupId ? Object.assign({}, item, { name: String(name).trim() }) : item
      ));
      refreshAccountRosterPanel();
      refreshAllocationPanel({ rerender: true });
      showStatus('已重命名分组');
      return;
    }

    if (action === 'delete-group') {
      const groupId = actionEl && actionEl.getAttribute('data-group');
      const group = getAccountGroup(groupId);
      if (!group || group.id === UNGROUPED_ID) return;

      const count = getGroupAccountNames(groupId).length;
      if (!window.confirm(`确定删除分组「${group.name}」吗？组内 ${count} 个子账号会回到「未分组」。`)) return;

      saveAccountGroups(getAccountGroups().filter(item => item.id !== groupId));
      saveAccountRoster(getAccountRoster().map(item =>
        item.groupId === groupId ? Object.assign({}, item, { groupId: UNGROUPED_ID }) : item
      ), { keepTime: true });
      refreshAccountRosterPanel();
      refreshAllocationPanel({ rerender: true });
      showStatus(`已删除分组「${group.name}」，${count} 个子账号回到未分组`);
      return;
    }

    if (action === 'save-allocation') {
      const groups = readGroupsFromPanel();
      const roster = readAccountQuotaFromPanel();
      const settings = getBudgetSettings();
      const budget = getDailyBudgetAmount(settings);
      const total = groups.reduce((sum, group) => sum + (getGroupDailyQuota(group, settings) || 0), 0);

      saveAccountGroups(groups);
      saveAccountRoster(roster, { keepTime: true });
      refreshAllocationPanel({ rerender: true });
      refreshOverviewDashboard();

      const overText = budget > 0 && total > budget
        ? `\n提醒：各分组额度合计 ${formatMoney(total)} 元，超过店铺当天预算 ${formatMoney(budget)} 元。已保存，实际以上一级为硬上限、先到先用。`
        : '';
      showStatus(`已保存分组额度和账号额度设置。${overText}`);
      return;
    }
    if (action === 'goto-queue') return switchWorkspacePage('queue');
    if (action === 'goto-versions') return switchWorkspacePage('versions');

    if (action === 'toggle-scan-rows') {
      scanSnapshotExpanded = !scanSnapshotExpanded;
      refreshRechargeLogPanel();
      return;
    }

    if (action === 'filter-logs') {
      rechargeLogFilter = (actionEl && actionEl.getAttribute('data-filter')) || 'all';
      refreshRechargeLogPanel();
      return;
    }

    if (action === 'add-slot') {
      const slots = readBudgetSlotsFromPanel(panel);
      const last = slots[slots.length - 1];
      const startHour = last ? Number(last.endHour) : 0;

      if (startHour >= 24) {
        showStatus('已经排到 24:00，无法再新增时段。可以先把最后一个时段的结束时间改小。');
        return;
      }

      slots.push({
        startHour,
        endHour: Math.min(24, startHour + 2),
        percent: last ? Number(last.percent) : 20
      });
      refreshBudgetSlotPage({ rerender: true, slots });
      showStatus('已新增一个时段，改好时间和累计上限后请点「保存分时规则」。');
      return;
    }

    if (action === 'delete-slot') {
      const row = actionEl && actionEl.closest('.jxj-slot-row');
      if (!row) return;

      const slots = readBudgetSlotsFromPanel(panel);
      const index = Number(row.getAttribute('data-slot-index'));

      if (slots.length <= 1) {
        showStatus('至少要保留一个时段。');
        return;
      }

      slots.splice(index, 1);
      refreshBudgetSlotPage({ rerender: true, slots });
      showStatus('已删除该时段，请点「保存分时规则」生效。');
      return;
    }

    if (action === 'reset-slots') {
      if (!window.confirm('确定把分时规则恢复成默认的 0-9 点 15%、9-14 点 45%、14-18 点 60%、18-24 点 100% 吗？')) return;
      refreshBudgetSlotPage({ rerender: true, slots: defaultBudgetSlots() });
      showStatus('已恢复默认分时规则，请点「保存分时规则」生效。');
      return;
    }

    if (action === 'save-slots') {
      const slots = normalizeBudgetSlots(readBudgetSlotsFromPanel(panel));
      const issues = getBudgetSlotIssues(slots);

      if (issues.length && !window.confirm(`分时规则存在以下问题：\n${issues.join('\n')}\n\n仍要保存吗？`)) {
        return;
      }

      saveBudgetSettings(Object.assign({}, getBudgetSettings(), { budgetSlots: slots }));
      refreshBudgetSlotPage({ rerender: true });
      refreshOverviewDashboard();
      showStatus(
        `已保存 ${slots.length} 个分时上限：\n` +
        slots.map(slot => `${formatSlotRange(slot)} ${formatRatio(slot.percent)}% / ${formatMoney(getSlotBudgetAmount(getBudgetSettings(), slot))} 元`).join('\n')
      );
      return;
    }
    if (action === 'import-accounts') return importCurrentExpandedAccountRules(panel);
    if (action === 'apply-bulk-rule') return applyBulkRuleUpdate(panel);
    if (action === 'save-budget') {
      const settings = readBudgetSettingsFromPanel(panel);
      saveBudgetSettings(settings);
      fillBudgetSettingsInputs(panel, settings);
      refreshBudgetPreview(panel);
      showStatus(
        settings.enabled === false
          ? '已关闭店铺当天预算控制'
          : `已保存店铺当天预算：近七天平均业绩 ${formatMoney(settings.avgGmv7d)} 元，合计费比 ${formatRatio(settings.combinedFeePercent)}%，退货率 ${formatRatio(settings.returnRatePercent)}%，当天预算 ${formatMoney(getDailyBudgetAmount(settings))} 元；当前时段 ${formatSlotRange(getCurrentBudgetSlot(settings))} 上限 ${formatMoney(getSlotBudgetAmount(settings, getCurrentBudgetSlot(settings)))} 元`
      );
      return;
    }
    if (action === 'manual-full-flow') {
      const rules = readRulesFromPanel(panel).filter(isSavableRule);
      saveRules(rules);
      saveBudgetSettings(readBudgetSettingsFromPanel(panel));
      refreshRulePanelRows(panel, getRules());
      refreshNextRunPanel();
      showStatus(`已保存 ${rules.length} 条规则和店铺当天预算，开始立即执行完整流程`);
      runManualFullFlow();
      return;
    }
    if (action === 'test-dingtalk') return sendDingTalkTestMessage();
    if (action === 'capture-shop-name') return captureShopNameFromPage();
    if (action === 'add-rule' || action === 'add-account-rule' || action === 'add-shop-rule') {
      addBlankRuleToPanel(panel, action === 'add-shop-rule' ? 'all' : 'exact');
      return;
    }
    if (action === 'save-rules') {
      const rules = readRulesFromPanel(panel).filter(isSavableRule);
      saveRules(rules);
      saveBudgetSettings(readBudgetSettingsFromPanel(panel));
      refreshRulePanelRows(panel, getRules());
      refreshRuleConflictPanel(getRules());
      refreshNextRunPanel();
      refreshBudgetPanel({ fillInputs: true });
      showStatus(`已保存 ${rules.length} 条子账号自动充值规则，并同步保存店铺当天预算`);
      return;
    }
    if (action === 'clear-simulation') {
      GM_deleteValue(STORAGE_SIMULATION_RESULTS);
      refreshSimulationPanel();
      showStatus('已清空模拟运行结果');
      return;
    }
    if (action === 'refresh-queue') {
      refreshQueuePanel();
      showStatus('已刷新当前充值队列');
      return;
    }
    if (action === 'clear-queue') {
      if (!window.confirm('确定清空当前充值队列吗？建议先勾选“暂停自动充值”，再清空队列。')) return;
      clearPendingTasks();
      showStatus('已清空当前充值队列和当前任务');
      return;
    }
    if (action === 'clear-done') {
      if (!window.confirm('确定清除定时/冷却执行记录吗？清除后符合规则的账号可能再次触发充值。')) return;
      setRuleDoneMap({});
      showStatus('已清除规则执行记录');
      return;
    }
    if (action === 'clear-logs') {
      if (!window.confirm('确定清空这一页的所有记录吗？包括本轮未充值原因、当天原因统计、原因变化和充值动作日志。')) return;
      setRechargeLogs([]);
      GM_deleteValue(STORAGE_SCAN_SNAPSHOT);
      GM_deleteValue(STORAGE_SKIP_REASON_STATS);
      GM_deleteValue(STORAGE_SKIP_REASON_STATE);
      GM_deleteValue(STORAGE_SKIP_REASON_CHANGES);
      scanSnapshotExpanded = false;
      refreshRechargeLogPanel();
      showStatus('已清空充值动作日志和未充值原因记录');
    }
  }

  function renderRulePanel() {
    if (document.getElementById('jxj-rule-panel')) return;
    const existingToggle = document.getElementById('jxj-rule-panel-toggle');
    if (existingToggle && !document.getElementById('jxj-rule-panel')) {
      existingToggle.remove();
    }

    const toggle = document.createElement('button');
    toggle.id = 'jxj-rule-panel-toggle';
    toggle.type = 'button';
    toggle.innerText = '工作台 ' + SCRIPT_VERSION;
    toggle.style.cssText = [
      'position: fixed',
      'right: 20px',
      'bottom: 20px',
      'z-index: 1000000',
      'background: #2563eb',
      'color: #fff',
      'border: 0',
      'border-radius: 6px',
      'padding: 8px 12px',
      'cursor: pointer',
      'box-shadow: 0 4px 14px rgba(0,0,0,.18)'
    ].join(';');
    if (document.body) document.body.appendChild(toggle);
    toggle.addEventListener('click', () => {
      const existing = document.getElementById('jxj-rule-panel');
      if (!existing) {
        showStatus('工作台还在加载，请稍后再点。如果一直没有面板，请打开 Console 查看报错。');
        return;
      }
      if (rulePanelVisible) {
        rulePanelVisible = false;
        existing.style.display = 'none';
        return;
      }
      openWorkspace(activeWorkspacePage || 'overview');
    });

    const panel = document.createElement('div');
    panel.id = 'jxj-rule-panel';
    panel.style.cssText = [
      'display: none',
      'position: fixed',
      'right: 16px',
      'bottom: 58px',
      'width: 1180px',
      'max-width: calc(100vw - 32px)',
      'height: 82vh',
      'overflow: hidden',
      'z-index: 1000000',
      'background: #f1f5f9',
      'color: #0f172a',
      'border: 1px solid #cbd5e1',
      'border-radius: 14px',
      'box-shadow: 0 18px 40px rgba(15,23,42,.25)',
      'padding: 0',
      'font-size: 14px'
    ].join(';');

    try {
    panel.innerHTML = `
      <div style="display:flex;height:82vh;">
        <div style="width:186px;flex:0 0 186px;background:#1e293b;color:#fff;padding:14px 10px;display:flex;flex-direction:column;">
          <div style="font-weight:800;font-size:14px;padding:4px 8px 12px;">充值工作台</div>
          <div id="jxj-workspace-nav">${workspaceNavHtml()}</div>
          <div style="margin-top:auto;padding:8px;">
            <div class="jxj-runtime-state-label" style="font-size:12px;color:#86efac;">正常运行</div>
            <div id="jxj-sidebar-shop-name" style="font-size:11px;color:#94a3b8;margin-top:4px;line-height:1.4;">${escapeHtml(getShopName() || '未设置店铺')}</div>
            <button type="button" data-action="goto-versions" id="jxj-sidebar-version" style="margin-top:8px;width:100%;text-align:left;border:0;background:transparent;color:#93c5fd;font-size:11px;padding:0;cursor:pointer;">v${escapeHtml(SCRIPT_VERSION)}${hasUnreadVersion() ? ' · 有更新' : ''}</button>
          </div>
        </div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;background:#fff;border-bottom:1px solid #e2e8f0;">
            <div id="jxj-workspace-title" style="font-weight:800;font-size:16px;">总览</div>
            <div style="display:flex;align-items:center;gap:8px;">
              <button type="button" data-action="manual-full-flow" style="padding:7px 12px;border:0;background:#16a34a;color:#fff;border-radius:6px;cursor:pointer;font-weight:700;">立即执行全流程</button>
              <button type="button" data-action="close-panel" style="width:28px;height:28px;border:0;background:#f1f5f9;border-radius:6px;font-size:18px;cursor:pointer;line-height:1;">×</button>
            </div>
          </div>
          <div style="flex:1;overflow:auto;padding:12px 14px;">
            <div data-workspace-page="overview">
              <div id="jxj-overview-dashboard">${overviewDashboardHtml()}</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
                <button type="button" data-action="manual-full-flow" style="padding:8px 12px;border:0;background:#16a34a;color:#fff;border-radius:6px;cursor:pointer;font-weight:700;">立即执行</button>
                <button type="button" data-action="goto-budget" style="padding:8px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">从第 1 步开始设置</button>
                <button type="button" data-action="goto-accounts" style="padding:8px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">子账号与分组</button>
                <button type="button" data-action="goto-alloc" style="padding:8px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">分组与账号额度</button>
                <button type="button" data-action="goto-rules" style="padding:8px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">去改规则</button>
                <button type="button" data-action="goto-logs" style="padding:8px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">查看记录</button>
                <button type="button" data-action="goto-versions" style="padding:8px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:6px;cursor:pointer;">版本中心</button>
              </div>
            </div>
            <div data-workspace-page="budget" style="display:none;">
              ${workspaceStepBarHtml('budget')}
              <div style="background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.6;margin-bottom:10px;">
                第 1 步：先定全店当天能花多少。这是最高一级上限，后面的分时、分组、账号都不能超过它。
              </div>
              <div style="border:1px solid #e2e8f0;border-radius:12px;background:#fff;padding:14px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
                  <div>
                    <div style="font-weight:800;color:#0f172a;">店铺当天推广预算</div>
                    <div style="font-size:12px;color:#64748b;line-height:1.45;margin-top:2px;">推广费比 = 合计费比 − 店铺退货率；当天预算 = 近七天平均业绩 × 推广费比。无脚本充值记录时，已用金额按页面已消耗起算，可充金额 = 当前上限 − 已消耗。店铺投产达标后允许超过预算。</div>
                  </div>
                  <label style="font-size:13px;white-space:nowrap;"><input id="jxj-budget-enabled" type="checkbox"> 启用预算控制</label>
                </div>
                <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;align-items:end;">
                  <label style="font-size:12px;color:#475569;">近七天平均业绩
                    <input id="jxj-budget-avg-gmv" type="number" min="0" step="1" placeholder="例如 10000" style="width:100%;margin-top:4px;height:32px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;">
                  </label>
                  <label style="font-size:12px;color:#475569;">推广+退货合计费比 %
                    <input id="jxj-budget-combined-fee" type="number" min="0" step="0.1" placeholder="例如 15" style="width:100%;margin-top:4px;height:32px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;">
                  </label>
                  <label style="font-size:12px;color:#475569;">店铺退货率 %
                    <input id="jxj-budget-return-rate" type="number" min="0" step="0.1" placeholder="例如 8" style="width:100%;margin-top:4px;height:32px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;">
                  </label>
                  <label style="font-size:12px;color:#475569;">店铺投产达标值
                    <input id="jxj-budget-target-roi" type="number" min="0" step="0.1" style="width:100%;margin-top:4px;height:32px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;">
                  </label>
                </div>
                <div id="jxj-budget-slot-summary">${budgetSlotSummaryHtml()}</div>
                <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-top:8px;flex-wrap:wrap;">
                  <div id="jxj-budget-summary" style="font-size:12px;line-height:1.55;color:#334155;flex:1;"></div>
                  <button type="button" data-action="save-budget" style="padding:7px 12px;border:0;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer;">保存预算</button>
                </div>
                ${nextStepButtonHtml('budget')}
              </div>
            </div>
            <div data-workspace-page="slots" style="display:none;">
              ${budgetSlotPageHtml()}
            </div>
            <div data-workspace-page="accounts" style="display:none;">
              <div id="jxj-accounts-page">${accountRosterPageHtml()}</div>
            </div>
            <div data-workspace-page="alloc" style="display:none;">
              <div id="jxj-alloc-page">${allocationPageHtml()}</div>
            </div>
            <div data-workspace-page="rules" style="display:none;">
              ${workspaceStepBarHtml('rules')}
              <div style="background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.6;margin-bottom:10px;">
                第 5 步：设置什么时候充、充多少。条件从小到大找：账号单独设置 &gt; 所在分组 &gt; 这里的全店规则。分组和账号的设置在第 4 步。
              </div>
              ${ruleScopeGuideHtml()}
              ${bulkRuleControlHtml()}
              <div id="jxj-rule-conflicts" style="margin-bottom:8px;"></div>
              <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:7px 10px;margin-bottom:8px;font-size:12px;color:#64748b;line-height:1.45;">
                看每条规则顶部的绿色「全店规则」或蓝色「分账号规则」标签即可区分。改完后请点“保存规则”。勾选分时充值后，按当前时段的一次金额和 ROI 判断。
              </div>
              <div id="jxj-rule-panel-rows"></div>
            </div>
            <div data-workspace-page="queue" style="display:none;">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div style="border:1px solid #e2e8f0;border-radius:12px;background:#fff;padding:12px;">
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
                    <div style="font-weight:800;">模拟运行结果</div>
                    <button type="button" data-action="clear-simulation" style="padding:5px 8px;border:1px solid #d1d5db;background:#fff;border-radius:4px;cursor:pointer;">清空</button>
                  </div>
                  <div id="jxj-simulation-result">${simulationResultsHtml()}</div>
                </div>
                <div style="border:1px solid #e2e8f0;border-radius:12px;background:#fff;padding:12px;">
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
                    <div style="font-weight:800;">当前充值队列</div>
                    <div style="display:flex;gap:6px;">
                      <button type="button" data-action="refresh-queue" style="padding:5px 8px;border:1px solid #d1d5db;background:#fff;border-radius:4px;cursor:pointer;">刷新</button>
                      <button type="button" data-action="clear-queue" style="padding:5px 8px;border:1px solid #ff7875;background:#fff;color:#cf1322;border-radius:4px;cursor:pointer;">清空</button>
                    </div>
                  </div>
                  <div id="jxj-assign-state" style="margin-bottom:8px;">${assignStateHtml()}</div>
                  <div id="jxj-pending-queue-rows">${pendingQueueHtml()}</div>
                </div>
              </div>
            </div>
            <div data-workspace-page="logs" style="display:none;">
              <div id="jxj-scan-snapshot">${scanSnapshotHtml()}</div>
              <div id="jxj-skip-reason-stats">${skipReasonStatsHtml()}</div>
              <div id="jxj-skip-reason-changes">${skipReasonChangesHtml()}</div>
              <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;">
                <div style="font-weight:800;margin-bottom:6px;">充值动作日志（只记真实动作）</div>
                <div style="font-size:12px;color:#64748b;line-height:1.5;margin-bottom:8px;">只有已提交、失败、预算未提交、跨天重置会写进这里，保留最近 ${escapeHtml(CONFIG.rechargeLogLimit)} 条。这里是脚本已提交的转入操作，不是平台最终到账确认。</div>
                <div id="jxj-recharge-budget-hint" style="font-size:12px;color:#475569;line-height:1.5;margin-bottom:8px;"></div>
                <div id="jxj-recharge-log-rows">${rechargeLogRowsHtml()}</div>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
                  <button type="button" data-action="clear-logs" style="padding:7px 10px;border:1px solid #ff7875;background:#fff;color:#cf1322;border-radius:4px;cursor:pointer;">清空记录</button>
                </div>
              </div>
            </div>
            <div data-workspace-page="versions" style="display:none;">
              <div id="jxj-version-center">${versionCenterHtml()}</div>
            </div>
            <div data-workspace-page="settings" style="display:none;">
              <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:10px;">
                <div style="font-weight:800;margin-bottom:8px;">店铺名称</div>
                <div style="font-size:12px;color:#64748b;line-height:1.5;margin-bottom:8px;">必须和京小洁广告投放明细里显示的店铺主账号名称一致。可以手动填写，也可以先搜索页面后点「从页面抓取」。</div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                  <input id="jxj-setting-shop-name" type="text" placeholder="例如 HYEGIIR医疗保健旗舰店" style="flex:1;min-width:240px;height:34px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;">
                  <button type="button" data-action="capture-shop-name" style="padding:7px 10px;border:1px solid #0f766e;background:#fff;color:#0f766e;border-radius:6px;cursor:pointer;">从页面抓取</button>
                </div>
              </div>
              <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:10px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
                  <div style="font-weight:800;">钉钉机器人</div>
                  <label style="font-size:13px;white-space:nowrap;"><input id="jxj-setting-dingtalk-enabled" type="checkbox"> 开启钉钉通知</label>
                </div>
                <div style="font-size:12px;color:#64748b;line-height:1.5;margin-bottom:8px;">把钉钉自定义机器人的 Webhook 链接贴到这里保存即可，不用改代码。如果机器人开了加签，再填加签密钥。</div>
                <label style="display:block;font-size:12px;color:#475569;margin-bottom:8px;">机器人链接
                  <input id="jxj-setting-dingtalk-webhook" type="text" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." style="width:100%;margin-top:4px;height:34px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;">
                </label>
                <div style="display:grid;grid-template-columns:1fr 160px;gap:8px;">
                  <label style="font-size:12px;color:#475569;">加签密钥（没有就留空）
                    <input id="jxj-setting-dingtalk-secret" type="text" placeholder="SEC 开头的密钥" style="width:100%;margin-top:4px;height:34px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;">
                  </label>
                  <label style="font-size:12px;color:#475569;">关键词
                    <input id="jxj-setting-dingtalk-keyword" type="text" placeholder="自动充值" style="width:100%;margin-top:4px;height:34px;box-sizing:border-box;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;">
                  </label>
                </div>
              </div>
              <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;">
                <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px;">
                  <label style="font-size:13px;white-space:nowrap;"><input id="jxj-setting-paused" type="checkbox"> 暂停自动充值</label>
                  <label style="font-size:13px;white-space:nowrap;"><input id="jxj-setting-dry-run" type="checkbox"> 模拟运行</label>
                  <label style="font-size:13px;white-space:nowrap;">查询间隔<input id="jxj-setting-interval-minutes" type="number" min="1" step="1" value="${escapeHtml(getAdCheckIntervalMinutes())}" style="width:54px;margin:0 4px;padding:5px;border:1px solid #d1d5db;border-radius:4px;">分</label>
                  <label style="font-size:13px;white-space:nowrap;">余额等待<input id="jxj-setting-expanded-read-delay-seconds" type="number" min="0" step="1" value="${escapeHtml(getExpandedAccountReadDelaySeconds())}" style="width:54px;margin:0 4px;padding:5px;border:1px solid #d1d5db;border-radius:4px;">秒</label>
                </div>
                <div id="jxj-next-run-info" style="margin-bottom:12px;">${nextRunInfoHtml()}</div>
                <div style="font-size:12px;color:#64748b;line-height:1.5;margin-bottom:10px;">脚本会从公开安装地址自动检查更新，本机规则、预算、店铺名和钉钉设置不会被清掉。急需更新时可在油猴图标里点「检查脚本更新」。</div>
                <button type="button" data-action="test-dingtalk" style="padding:7px 10px;border:1px solid #7c3aed;background:#fff;color:#7c3aed;border-radius:4px;cursor:pointer;">测试钉钉通知</button>
                <button type="button" data-action="goto-versions" style="margin-left:8px;padding:7px 10px;border:1px solid #2563eb;background:#fff;color:#2563eb;border-radius:4px;cursor:pointer;">打开版本中心</button>
              </div>
            </div>
          </div>
          <div id="jxj-workspace-footer" style="display:none;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 14px;background:#fff;border-top:1px solid #e2e8f0;">
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button type="button" data-action="import-accounts" style="padding:7px 10px;border:1px solid #14b8a6;background:#fff;color:#0f766e;border-radius:4px;cursor:pointer;">导入为分账号规则</button>
              <button type="button" data-action="clear-done" style="padding:7px 10px;border:1px solid #f59e0b;background:#fff;color:#b45309;border-radius:4px;cursor:pointer;">清除执行记录</button>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button type="button" data-action="add-shop-rule" style="padding:7px 10px;border:1px solid #0f766e;background:#fff;color:#0f766e;border-radius:4px;cursor:pointer;">新增全店规则</button>
              <button type="button" data-action="add-account-rule" style="padding:7px 10px;border:1px solid #2563eb;background:#fff;color:#2563eb;border-radius:4px;cursor:pointer;">新增分账号规则</button>
              <button type="button" data-action="save-rules" style="padding:7px 14px;border:0;background:#2563eb;color:#fff;border-radius:4px;cursor:pointer;font-weight:700;">保存规则</button>
            </div>
          </div>
        </div>
      </div>
    `;
    } catch (error) {
      console.error('[京小洁全自动脚本] 工作台界面构建失败', error);
      panel.innerHTML = `<div style="padding:16px;line-height:1.6;">工作台界面构建失败：${escapeHtml(error && error.message ? error.message : error)}<br>右下角「工作台」按钮仍可点击。请打开 Console 查看报错。</div>`;
    }

    if (!toggle.parentNode && document.body) document.body.appendChild(toggle);
    document.body.appendChild(panel);

    try {
    refreshRulePanelRows(panel, getRules());
    refreshRuntimeControls();
    refreshRuleConflictPanel(getRules());
    refreshNextRunPanel();
    refreshQueuePanel();
    refreshSimulationPanel();
    refreshBudgetPanel({ fillInputs: true });
    refreshRechargeLogPanel();
    switchWorkspacePage('overview');

    panel.addEventListener('click', event => {
      const nav = event.target.closest('[data-workspace-nav]');
      if (nav) {
        switchWorkspacePage(nav.getAttribute('data-workspace-nav'));
        return;
      }

      const actionEl = event.target.closest('[data-action]');
      if (!actionEl || !panel.contains(actionEl)) return;
      handleWorkspaceAction(panel, actionEl.getAttribute('data-action'), actionEl);
    });

    const bulkField = panel.querySelector('#jxj-bulk-rule-field');
    if (bulkField) {
      bulkField.addEventListener('change', () => {
        refreshBulkRuleValueInput(panel);
      });
    }

    const onSettingChange = (id, handler) => {
      const el = panel.querySelector('#' + id);
      if (el) el.addEventListener('change', handler);
    };

    onSettingChange('jxj-setting-paused', event => {
      setRuntimeSettings({ paused: event.target.checked });
      showStatus(event.target.checked ? '已暂停自动充值：不会查询、投递或处理充值任务' : '已恢复自动充值');
    });

    onSettingChange('jxj-setting-dry-run', event => {
      setRuntimeSettings({ dryRun: event.target.checked });
      showStatus(event.target.checked ? '已开启模拟运行：只显示命中账号，不打开充值页、不提交充值' : '已关闭模拟运行');
    });

    onSettingChange('jxj-setting-interval-minutes', event => {
      const minutes = Math.max(1, Number(event.target.value || 1));
      event.target.value = String(minutes);
      setRuntimeSettings({ intervalMinutes: minutes });

      if (isJxjAdPage()) {
        startAdCheckTimer();
      }

      showStatus(`已设置京小洁自动查询间隔：${minutes}分钟`);
    });

    onSettingChange('jxj-setting-expanded-read-delay-seconds', event => {
      const seconds = Math.max(0, Number(event.target.value || 0));
      event.target.value = String(seconds);
      setRuntimeSettings({ expandedAccountReadDelaySeconds: seconds });
      showStatus(`已设置展开子账号后的余额读取等待时间：${seconds}秒`);
    });

    onSettingChange('jxj-setting-shop-name', event => {
      const shopName = String(event.target.value || '').trim();
      event.target.value = shopName;
      setRuntimeSettings({ shopName });
      showStatus(shopName ? '已保存店铺名称：' + shopName : '店铺名称已清空，自动查询前请先填写或抓取');
    });

    onSettingChange('jxj-setting-dingtalk-enabled', event => {
      setRuntimeSettings({ dingTalkEnabled: event.target.checked });
      showStatus(event.target.checked ? '已开启钉钉通知' : '已关闭钉钉通知');
    });

    onSettingChange('jxj-setting-dingtalk-webhook', event => {
      const dingTalkWebhook = String(event.target.value || '').trim();
      event.target.value = dingTalkWebhook;
      setRuntimeSettings({ dingTalkWebhook });
      showStatus(dingTalkWebhook ? '已保存钉钉机器人链接' : '钉钉机器人链接已清空');
    });

    onSettingChange('jxj-setting-dingtalk-secret', event => {
      setRuntimeSettings({ dingTalkSecret: String(event.target.value || '').trim() });
      showStatus('已保存钉钉加签密钥');
    });

    onSettingChange('jxj-setting-dingtalk-keyword', event => {
      const dingTalkKeyword = String(event.target.value || '').trim() || '自动充值';
      event.target.value = dingTalkKeyword;
      setRuntimeSettings({ dingTalkKeyword });
      showStatus('已保存钉钉关键词：' + dingTalkKeyword);
    });

    ['jxj-budget-enabled', 'jxj-budget-avg-gmv', 'jxj-budget-combined-fee', 'jxj-budget-return-rate', 'jxj-budget-target-roi']
      .forEach(id => {
      const input = panel.querySelector('#' + id);
      if (!input) return;
      input.addEventListener('input', () => refreshBudgetPreview(panel));
      input.addEventListener('change', () => refreshBudgetPreview(panel));
    });

    panel.addEventListener('change', event => {
      if (event.target.id !== 'jxj-roster-check-all') return;
      panel.querySelectorAll('.jxj-roster-check').forEach(box => { box.checked = event.target.checked; });
    });

    panel.addEventListener('input', event => {
      if (event.target.closest('.jxj-group-quota-row')) {
        refreshAllocationPanel();
        return;
      }
      if (event.target.closest('.jxj-slot-row')) {
        refreshBudgetSlotPage();
        return;
      }
      if (event.target.closest('.jxj-rule-row')) {
        refreshRuleConflictPanel(readRulesFromPanel(panel));
      }
    });

    panel.addEventListener('change', event => {
      const row = event.target.closest('.jxj-rule-row');
      if (!row) return;
      if (event.target.matches('[data-field="matchType"]')) {
        syncRuleRowScopeUi(row);
      }
      refreshRuleConflictPanel(readRulesFromPanel(panel));
    });
    } catch (error) {
      console.error('[京小洁全自动脚本] 工作台事件绑定失败', error);
      showStatus('工作台已出现，但部分按钮可能不可用：' + (error && error.message ? error.message : error));
    }
  }

  function renderRechargeLogPanel() {
    if (document.getElementById('jxj-recharge-log-toggle')) return;

    const toggle = document.createElement('button');
    toggle.id = 'jxj-recharge-log-toggle';
    toggle.type = 'button';
    toggle.innerText = '记录';
    toggle.style.cssText = [
      'position: fixed',
      'right: 86px',
      'bottom: 20px',
      'z-index: 1000000',
      'background: #7c3aed',
      'color: #fff',
      'border: 0',
      'border-radius: 6px',
      'padding: 8px 12px',
      'cursor: pointer',
      'box-shadow: 0 4px 14px rgba(0,0,0,.18)'
    ].join(';');

    document.body.appendChild(toggle);

    toggle.addEventListener('click', () => {
      const panel = document.getElementById('jxj-rule-panel');
      if (rulePanelVisible && activeWorkspacePage === 'logs') {
        rulePanelVisible = false;
        if (panel) panel.style.display = 'none';
        return;
      }
      openWorkspace('logs');
    });
  }


  async function forceRefreshOnceAfterMidnight() {
    if (!isJxjSite()) return true;
    if (!isMidnightRefreshWindow()) return true;

    const today = todayKey();
    const refreshKey = getRefreshWindowKey(today);
    const refreshedKey = localStorage.getItem(STORAGE_MIDNIGHT_REFRESH_DATE);

    if (refreshedKey === refreshKey) return true;

    localStorage.setItem(STORAGE_MIDNIGHT_REFRESH_DATE, refreshKey);
    localStorage.removeItem(STORAGE_LAST_SEARCH);

    showStatus(`设定时间段 ${getRefreshWindowText()} 内首次查询，强制刷新一次页面：${today}`);
    await sleep(1000); // 强制刷新前等待1秒，让提示先显示出来。
    location.reload();
    return false;
  }

  // 工作台面板和状态框也在同一个页面里。扫平台页面元素时必须排除它们，
  // 否则「本轮未充值原因」「单个账号额度」这些表格的第一列也是账号名，会被当成平台页面的行。
  const SCRIPT_UI_SELECTOR = '#jxj-rule-panel, #jxj-auto-status-box, #jxj-rule-panel-toggle, #jxj-recharge-log-toggle';

  function isScriptUiNode(node) {
    if (!node || typeof node.closest !== 'function') return false;
    return !!node.closest(SCRIPT_UI_SELECTOR);
  }

  function queryPageElements(selectors) {
    const list = [];

    (Array.isArray(selectors) ? selectors : [selectors]).forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        if (!isScriptUiNode(el)) list.push(el);
      });
    });

    return [...new Set(list)];
  }

  function getVisibleRows() {
    const rows = queryPageElements([
      'table tbody tr',
      '.el-table__body-wrapper tbody tr',
      '.ant-table-tbody tr'
    ]);

    return rows.filter(row => {
      const rect = row.getBoundingClientRect();
      return row.offsetParent !== null &&
        rect.width > 0 &&
        rect.height > 0 &&
        normalizeText(row.innerText);
    });
  }

  function getCells(row) {
    return [...row.children].map(td => td.innerText.trim());
  }

  function getAccountName(row) {
    const cells = getCells(row);
    return cells[0]?.split('\n')[0]?.trim() || '';
  }

  function detectPageShopName() {
    const rows = getVisibleRows().filter(row => {
      const name = normalizeText(getAccountName(row));
      if (!name) return false;
      return hasExpandControl(row) || /(?:旗舰店|专营店|专卖店|自营店|官方店)$/.test(name);
    });

    if (!rows.length) return '';

    const preferred = rows.filter(hasExpandControl);
    const source = preferred.length ? preferred : rows;
    const shopRow = source.sort((a, b) =>
      a.getBoundingClientRect().left - b.getBoundingClientRect().left
    )[0];

    return getAccountName(shopRow).trim();
  }

  function captureShopNameFromPage() {
    if (!isJxjAdPage()) {
      showStatus('请先打开京小洁广告投放明细页，搜索出店铺后再点「从页面抓取」。');
      window.alert('请先打开京小洁广告投放明细页，搜索出店铺后再点「从页面抓取」。\n当前地址：' + location.href);
      return '';
    }

    const name = detectPageShopName();
    if (!name) {
      showStatus('当前页面没有抓到店铺名。请先打开京小洁广告投放明细并搜索，再点「从页面抓取」。');
      window.alert('没有抓到店铺名。请先在京小洁广告投放明细页搜索，看到店铺行后再试。');
      return '';
    }

    setRuntimeSettings({ shopName: name });
    showStatus('已抓取并保存店铺名称：' + name);
    return name;
  }

  function isTargetShopRow(row) {
    const shopName = getShopName();
    if (!shopName) return false;
    return sameAccount(getAccountName(row), shopName);
  }

  function hasExpandControl(row) {
    return [
      ...row.querySelectorAll('.el-table__expand-icon'),
      ...row.querySelectorAll('.ant-table-row-expand-icon'),
      ...row.querySelectorAll('[aria-label*="展开"]'),
      ...row.querySelectorAll('[class*="expand"]')
    ].some(el => el.offsetParent !== null);
  }

  function isShopLikeRow(row) {
    const name = normalizeText(getAccountName(row));
    if (!name) return false;
    if (isTargetShopRow(row)) return true;
    return hasExpandControl(row) || /(?:旗舰店|专营店|专卖店|自营店|官方店)$/.test(name);
  }

  function isReadableChildAccountRow(row) {
    const name = normalizeText(getAccountName(row));
    const shopName = normalizeText(getShopName());
    return !!name && name !== shopName && !isShopLikeRow(row);
  }

  function readAccountFromFullRow(row) {
    const cells = getCells(row);

    return {
      accountName: cells[0]?.split('\n')[0]?.trim() || '',
      balance: parseNumber(cells[1]),
      spend: parseNumber(cells[3]),
      roi: parseNumber(cells[4]),
      amount: CONFIG.rechargeAmount
    };
  }

  function collectExpandedAccounts() {
    const rows = getVisibleRows();
    const targetShopIndex = rows.findIndex(isTargetShopRow);
    const scopedRows = [];

    if (targetShopIndex >= 0) {
      for (let i = targetShopIndex + 1; i < rows.length; i++) {
        if (isShopLikeRow(rows[i])) break;
        scopedRows.push(rows[i]);
      }
    }

    if (targetShopIndex < 0) {
      return [];
    }

    const fullRows = scopedRows.filter(row => {
      const cells = getCells(row);
      if (cells.length < 5) return false;
      return isReadableChildAccountRow(row);
    });

    const accounts = fullRows.map(readAccountFromFullRow);

    const map = new Map();
    for (const item of accounts) {
      if (item.accountName) map.set(item.accountName, item);
    }

    return [...map.values()];
  }

  function scrollPageDown() {
    window.scrollBy({
      top: Math.floor(window.innerHeight * 0.65),
      behavior: 'smooth'
    });
  }

  function resetScrollPosition() {
    window.scrollTo({
      top: 0,
      behavior: 'auto'
    });

    [
      ...document.querySelectorAll('.el-table__body-wrapper'),
      ...document.querySelectorAll('.ant-table-body')
    ].forEach(el => {
      el.scrollTop = 0;
    });
  }

  function clickShopExpandControl(shopRow) {
    const controls = [
      ...shopRow.querySelectorAll('.el-table__expand-icon'),
      ...shopRow.querySelectorAll('.ant-table-row-expand-icon'),
      ...shopRow.querySelectorAll('[aria-label*="展开"]'),
      ...shopRow.querySelectorAll('[class*="expand"]')
    ].filter(el => el.offsetParent !== null);

    if (controls.length > 0) {
      return simpleClick(controls[0]);
    }

    const firstCell = shopRow.children[0] || shopRow;
    const rect = firstCell.getBoundingClientRect();
    const y = rect.top + rect.height / 2;

    return clickPointOnce(rect.left + 14, y) ||
      clickPointOnce(rect.left + 28, y) ||
      clickPointOnce(rect.left + 42, y);
  }

  async function scrollUntilShopVisible() {
    resetScrollPosition();
    await sleep(500); // 重置滚动条后等0.5秒，避免页面还没回到顶部就开始找店铺。

    for (let i = 0; i < 20; i++) { // 最多向下滚动找店铺20次；页面店铺很多时可以调大。
      const row = getVisibleRows().find(isTargetShopRow);

      if (row) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(800);
        showStatus('已滚动到店铺');
        return true;
      }

      showStatus(`正在向下滚动寻找店铺... ${i + 1}/20`);
      scrollPageDown();
      await sleep(1000); // 每次滚动后等1秒，让表格新内容加载出来。
    }

    return false;
  }

  async function waitNoProcessingToast() {
    for (let i = 0; i < 20; i++) { // 最多等待“数据正在处理”消失20秒。
      if (!document.body.innerText.includes('数据正在处理')) return true;
      showStatus(`页面正在处理数据，等待中... ${i + 1}/20`);
      await sleep(1000); // 每1秒检查一次页面是否还在处理数据。
    }
    return false;
  }

  async function clickSearchButton(options = {}) {
    showStatus(`等待 ${CONFIG.searchDelayMs / 1000} 秒后点击搜索`);
    await sleep(CONFIG.searchDelayMs); // 搜索前等待时间，改顶部CONFIG.searchDelayMs即可。

    const last = Number(localStorage.getItem(STORAGE_LAST_SEARCH) || 0);
    const now = Date.now();

    if (!options.forceSearch && now - last < 30000) { // 30秒内已经搜索过就不重复点，防止连续触发查询。
      showStatus('30秒内已经点过搜索，本次不重复点击，直接等待数据');
      await sleep(6000); // 跳过重复搜索后仍等6秒，让已有查询结果加载完成。
      return true;
    }

    await waitNoProcessingToast();

    for (let i = 0; i < 20; i++) { // 最多找搜索按钮20秒。
      const btn = queryPageElements(['button', 'a', 'span']).find(el =>
        normalizeText(el.innerText) === '搜索' &&
        el.offsetParent !== null
      );

      if (btn) {
        localStorage.setItem(STORAGE_LAST_SEARCH, String(Date.now()));
        simpleClick(btn);
        showStatus('已点击搜索，等待表格加载...');
        await sleep(8000); // 点击搜索后等8秒让表格加载；页面慢可以调大。
        return true;
      }

      showStatus(`正在寻找搜索按钮... ${i + 1}/20`);
      await sleep(1000); // 每1秒找一次搜索按钮。
    }

    showStatus('没有找到搜索按钮');
    return false;
  }

  async function waitForShopVisible() {
    const foundByScroll = await scrollUntilShopVisible();
    if (foundByScroll) return true;

    for (let i = 0; i < 20; i++) { // 滚动没找到时，最多再等表格加载20秒。
      const hasShop = getVisibleRows().some(isTargetShopRow);

      if (hasShop) {
        showStatus('已找到店铺');
        return true;
      }

      showStatus(`等待表格加载，寻找店铺名... ${i + 1}/20`);
      await sleep(1000); // 每1秒检查一次店铺是否出现在表格里。
    }

    return false;
  }

  function findLeftMostShopRow() {
    const rows = getVisibleRows().filter(isTargetShopRow);

    return rows.sort((a, b) =>
      a.getBoundingClientRect().left - b.getBoundingClientRect().left
    )[0];
  }

  async function expandShop() {
    if (collectExpandedAccounts().length > 0) {
      showStatus('已经检测到子账号，无需展开');
      return true;
    }

    const visible = await scrollUntilShopVisible();
    if (!visible) return false;

    const shopRow = findLeftMostShopRow();

    if (!shopRow) {
      showStatus('没有找到店铺行，无法展开');
      return false;
    }

    showStatus('正在点击店铺左侧小箭头');
    clickShopExpandControl(shopRow);

    for (let i = 0; i < 25; i++) { // 展开店铺后最多等待25秒读取子账号。
      await sleep(1000); // 每1秒检查一次子账号是否已经展开。

      const accounts = collectExpandedAccounts();

      if (accounts.length > 0) {
        showStatus(`展开成功，读取到 ${accounts.length} 个店铺子账号`);
        return true;
      }

      if ((i + 1) % 5 === 0) { // 每5秒仍未展开，就重新点一次展开箭头。
        const retryRow = findLeftMostShopRow();
        if (retryRow) {
          showStatus(`子账号暂未展开，重新点击展开箭头... ${i + 1}/25`);
          clickShopExpandControl(retryRow);
          continue;
        }
      }

      showStatus(`等待子账号展开... ${i + 1}/25`);
    }

    return false;
  }

  function markAssignPageReady() {
    GM_setValue(STORAGE_ASSIGN_PAGE_READY, Date.now());
    GM_deleteValue(STORAGE_ASSIGN_OPENING_UNTIL);
  }

  function isAssignPageAlive() {
    const readyTime = Number(GM_getValue(STORAGE_ASSIGN_PAGE_READY, 0));
    return Date.now() - readyTime < CONFIG.assignAliveMs;
  }

  function isAssignPageOpening() {
    const openingUntil = Number(GM_getValue(STORAGE_ASSIGN_OPENING_UNTIL, 0));
    return openingUntil > Date.now();
  }

  function openAssignTabIfNeeded() {
    if (isPaused() || isDryRun()) return;

    if (isJztSite()) {
      markAssignPageReady();
      return;
    }

    if (isAssignPageAlive()) {
      showStatus('已检测到充值页打开中，本次不再新开充值窗口');
      return;
    }

    if (isAssignPageOpening()) {
      showStatus('充值页刚刚打开过，等待它响应，本次不重复开窗口');
      return;
    }

    GM_setValue(STORAGE_ASSIGN_OPENING_UNTIL, Date.now() + CONFIG.assignAliveMs);
    GM_openInTab(CONFIG.assignUrl, {
      active: true,
      insert: true,
      setParent: true
    });
  }

  function handleAccounts(accounts) {
    updateShopMetricsSnapshot(accounts);

    const list = accounts || [];

    if (CONFIG.autoSyncAccountRoster && list.length) {
      mergeAccountsIntoRoster(list); // 名单跟着每轮查询更新，余额和投产保持最新。
      refreshAccountRosterPanel();
    }

    const arrival = updateArrivalConfirmations(list); // 用本轮余额核对上一轮提交的充值有没有到账。
    if (arrival.missing > 0) {
      showStatus(`到账核对：有 ${arrival.missing} 笔提交超过 ${CONFIG.arrivalConfirmTimeoutMinutes} 分钟仍对不上余额，请到京准通后台核对。详见「提交记录」。`);
    }

    const decisions = list.map(account => ({ account, result: decideAccountRecharge(account) }));
    const matched = decisions.filter(item => item.result.task).map(item => item.result.task);
    const skipRows = decisions
      .filter(item => item.result.skip)
      .map(item => makeSkipRow(item.account, item.result.skip));

    const budgeted = prepareTasksWithDailyBudget(matched);
    const targets = budgeted.tasks;
    const budgetText = budgeted.messages.length ? `\n${budgeted.messages.join('\n')}` : '';
    const skippedText = budgeted.skipped.length
      ? `\n预算跳过：${budgeted.skipped.map(item => `${item.accountName} ${item.amount}元`).join('、')}`
      : '';

    budgeted.skipped.forEach(item => {
      const reason = String(item.skipReason || '');
      const levelKey = item.skipLevel === 'group'
        ? SKIP_GROUP_QUOTA
        : item.skipLevel === 'account'
          ? SKIP_ACCOUNT_CAP
          : reason.indexOf('当日') >= 0
            ? SKIP_DAILY_BUDGET
            : SKIP_SLOT_BUDGET;
      const levelText = item.skipLevel === 'group'
        ? '被第 3 级分组额度挡住'
        : item.skipLevel === 'account'
          ? '被第 4 级账号当天上限挡住'
          : reason.indexOf('当日') >= 0
            ? '被第 1 级店铺当天预算挡住'
            : '被第 2 级分时上限挡住';

      skipRows.push(makeSkipRow(item, {
        key: levelKey,
        detail: `${levelText}：${reason}，本次需 ${formatMoney(item.amount)} 元`
      }));
    });

    console.log('读取到的店铺子账号：', accounts);
    console.log('按规则命中的充值任务：', matched);
    console.log('预算控制后的充值任务：', targets);

    const recordOutcome = (submitted, mode, extraRows) => {
      recordScanOutcome({
        scanned: list.length,
        matched: matched.length,
        submitted,
        mode,
        skipRows: skipRows.concat(extraRows || [])
      });
    };

    if (!matched.length) {
      if (isDryRun()) {
        setSimulationResults([], '模拟规则检测', budgeted);
      }
      recordOutcome(0, isDryRun() ? '模拟运行' : '正常运行');
      showStatus('检查完成：没有命中规则的充值账号' + budgetText);
      return;
    }

    if (isPaused()) {
      recordOutcome(0, '已暂停');
      showStatus(`已暂停自动充值：本轮检测到 ${matched.length} 个命中账号，但不会投递任务` + budgetText);
      return;
    }

    if (isDryRun()) {
      setSimulationResults(targets, '模拟规则检测', budgeted);
      recordOutcome(targets.length, '模拟运行');
      showStatus(
        `模拟运行：规则命中 ${matched.length} 个，预算后可投递 ${targets.length} 个，不会打开充值页、不提交充值。\n` +
        targets.map(item => `${item.accountName}，预计 ${item.amount} 元，${item.ruleName}`).join('\n') +
        skippedText +
        budgetText
      );
      return;
    }

    if (!targets.length) {
      recordOutcome(0, '正常运行');
      showStatus('检查完成：有账号命中规则，但受当日推广预算限制，未投递充值任务' + skippedText + budgetText);
      return;
    }

    const addResult = addTasks(targets);
    const added = addResult.added;
    const current = getCurrent();
    const queue = getQueue();

    recordOutcome(added, '正常运行', addResult.skipRows);

    showStatus(
      `发现 ${matched.length} 个符合条件账号，预算后投递 ${targets.length} 个。\n` +
      `新增任务：${added} 个\n` +
      `当前：${current ? `${current.accountName}，金额 ${current.amount} 元` : '无'}\n` +
      `队列剩余：${queue.length} 个\n` +
      `命中规则：${targets.map(item => `${item.accountName}/${item.ruleName}`).join('、')}\n` +
      `将交给充值页处理` +
      skippedText +
      budgetText
    );

    openAssignTabIfNeeded();
  }

  function readExpandedRowsAndHandle() {
    if (!isJxjSite()) return;
    const accounts = collectExpandedAccounts();
    handleAccounts(accounts);
  }

  async function checkAdPage(options = {}) {
    if (isChecking) return;

    if (isPaused()) {
      showStatus('已暂停自动充值：本轮不执行京小洁查询');
      return;
    }

    if (!getShopName()) {
      showStatus('尚未填写店铺名称。请打开工作台「运行设置」，填写店铺名或点「从页面抓取」。');
      return;
    }

    resetDailyStateIfNewDay(); // 每轮开始先确认有没有跨天，避免昨天的已用金额挡住今天的充值。
    isChecking = true;

    try {
      showStatus(options.manual ? '手动执行完整自动流程：开始检查店子账号' : (isDryRun() ? '模拟运行：开始检查店子账号' : '开始检查店子账号'));

      const refreshReady = await forceRefreshOnceAfterMidnight();
      if (!refreshReady) return;

      const searched = await clickSearchButton({
        forceSearch: !!options.forceSearch
      });
      if (!searched) return;

      const hasShop = await waitForShopVisible();
      if (!hasShop) return;

      const expanded = await expandShop();
      if (!expanded) {
        showStatus('没有自动展开子账号');
        return;
      }

      const readDelayMs = getExpandedAccountReadDelayMs();
      if (readDelayMs > 0) {
        showStatus(`子账号已展开，等待 ${Math.round(readDelayMs / 1000)} 秒后读取余额数据`);
        await sleep(readDelayMs); // 展开后等待时间，优先使用规则面板里的“余额等待”设置。
      }
      readExpandedRowsAndHandle();
    } catch (err) {
      console.error(err);
      showStatus('广告明细页面脚本出错，请查看 Console');
    } finally {
      isChecking = false;
    }
  }

  function runManualFullFlow() {
    if (!isJxjAdPage()) {
      window.alert('请在京小洁广告投放明细页面点击“立即执行全流程”。充值页不能执行京小洁查询、展开和筛选流程。\n当前地址：' + location.href);
      return;
    }

    if (isChecking) {
      showStatus('当前已经有一轮检查正在执行，请稍后再点立即执行');
      return;
    }

    localStorage.removeItem(STORAGE_LAST_SEARCH);
    checkAdPage({
      manual: true,
      forceSearch: true
    });
  }

  async function waitAssignPageReady() {
    for (let i = 0; i < 50; i++) { // 最多等待充值页加载50秒，找到账户搜索框和表格才继续。
      const hasInput = queryPageElements('input').some(el =>
        el.placeholder &&
        (
          el.placeholder.includes('投放账户') ||
          el.placeholder.includes('账户') ||
          el.placeholder.includes('ID')
        )
      );

      const hasRows = getVisibleRows().length > 0;

      if (hasInput && hasRows) return true;

      showStatus(`等待分配金额页面加载... ${i + 1}/50`);
      await sleep(1000); // 每1秒检查一次充值页是否加载完成。
    }

    return false;
  }

  function findExactAccountRow(accountName) {
    return getVisibleRows().find(row => sameAccount(getAccountName(row), accountName));
  }

  async function clickAssignSearch(input) {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      keyCode: 13
    }));

    input.dispatchEvent(new KeyboardEvent('keyup', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      keyCode: 13
    }));

    await sleep(300); // 按回车后等0.3秒，再点输入框右侧搜索图标。

    const rect = input.getBoundingClientRect();
    clickPointOnce(rect.right - 18, rect.top + rect.height / 2);

    showStatus('已触发账号搜索，等待精确结果');
  }

  async function waitForExactTargetRow(accountName) {
    for (let i = 0; i < 40; i++) { // 最多等待精确账号搜索结果40秒。
      const exactRow = findExactAccountRow(accountName);

      if (exactRow) {
        const foundName = getAccountName(exactRow);
        if (sameAccount(foundName, accountName)) {
          showStatus(`已精确找到账号：${accountName}`);
          return exactRow;
        }
      }

      showStatus(`等待精确账号搜索结果：${accountName}... ${i + 1}/40`);
      await sleep(1000); // 每1秒检查一次搜索结果是否出现目标账号。
    }

    return null;
  }

  function hasTransferPanelText(panel, accountName) {
    if (!panel) return false;

    const text = normalizeText(panel.innerText);
    const account = normalizeText(accountName);
    const hasAccount = !account || text.includes(account);
    const hasTransferText =
      text.includes('转入方') ||
      text.includes('转入现金') ||
      text.includes('投放账户分配金额') ||
      text.includes('可分配金额');

    return hasAccount && hasTransferText;
  }

  function getTransferPanelByAmountInput(amountInput, accountName) {
    if (!amountInput) return null;

    const panelSelector = [
      '.ant-drawer',
      '.ant-drawer-content',
      '.ant-modal',
      '.ant-modal-content',
      '[class*="drawer"]',
      '[class*="Drawer"]',
      '[class*="modal"]',
      '[class*="Modal"]'
    ].join(',');

    const selectorPanels = [...document.querySelectorAll(panelSelector)]
      .filter(panel => panel.offsetParent !== null && panel.contains(amountInput));

    const exactSelectorPanel = selectorPanels.find(panel =>
      hasTransferPanelText(panel, accountName)
    );

    if (exactSelectorPanel) return exactSelectorPanel;

    let node = amountInput.parentElement;
    let fallbackPanel = selectorPanels[0] || null;

    for (let i = 0; node && node !== document.body && i < 25; i++) {
      if (hasTransferPanelText(node, accountName)) {
        return node;
      }

      if (!fallbackPanel && hasTransferPanelText(node, '')) {
        fallbackPanel = node;
      }

      node = node.parentElement;
    }

    return fallbackPanel;
  }

  function isTransferPanelForAccount(amountInput, accountName) {
    return hasTransferPanelText(
      getTransferPanelByAmountInput(amountInput, accountName),
      accountName
    );
  }

  async function waitForAmountInput(accountName) {
    for (let i = 0; i < 30; i++) { // 最多等待右侧金额输入框30秒。
      const inputs = queryPageElements('input').filter(el =>
        el.offsetParent !== null
      );

      const amountInputs = inputs.filter(el =>
        el.placeholder &&
        (
          el.placeholder.includes('可分配金额') ||
          el.placeholder.includes('输入金额') ||
          el.placeholder.includes('金额')
        )
      );

      for (const amountInput of amountInputs) {
        if (!accountName || isTransferPanelForAccount(amountInput, accountName)) {
          return amountInput;
        }
      }

      if (amountInputs.length === 1 && i >= 2) { // 2秒后如果只有一个金额框，先使用它，后续仍会校验账号。
        return amountInputs[0];
      }

      showStatus(`等待金额输入框... ${i + 1}/30`);
      await sleep(1000); // 每1秒检查一次金额输入框。
    }

    return null;
  }

  async function waitDrawerAccount(accountName, amountInput) {
    for (let i = 0; i < 20; i++) { // 最多等待右侧转入面板账号校验20秒。
      if (amountInput && isTransferPanelForAccount(amountInput, accountName)) {
        showStatus(`右侧转入面板账号校验通过：${accountName}`);
        return true;
      }

      showStatus(`等待右侧转入面板账号校验：${accountName}... ${i + 1}/20`);
      await sleep(1000); // 每1秒检查一次面板里是否包含目标账号。
    }

    return false;
  }

  function findDrawerTransferButton(amountInput) {
    const inputRect = amountInput.getBoundingClientRect();

    const candidates = queryPageElements(['button', 'a', 'span']).filter(el => {
      if (el.offsetParent === null) return false;

      const text = normalizeText(el.innerText);
      if (text !== '转入') return false;

      const rect = el.getBoundingClientRect();

      return rect.top >= inputRect.top - 30 &&
        rect.top <= inputRect.bottom + 40 &&
        rect.left > inputRect.right - 10;
    });

    return candidates[0] || null;
  }

  async function clickConfirmIfAny() {
    for (let i = 0; i < 10; i++) { // 点“转入”后最多找确认按钮10次。
      const btn = queryPageElements(['button', 'a', 'span'])
        .filter(el => el.offsetParent !== null)
        .find(el => {
          const text = normalizeText(el.innerText);
          return text === '确定' || text === '确认';
        });

      if (btn) {
        simpleClick(btn);
        showStatus('已自动点击确认');
        await sleep(2000); // 点击确认后等2秒，让平台提交完成。
        return true;
      }

      await sleep(500); // 每0.5秒找一次确认按钮。
    }

    return false;
  }

  async function submitTransfer(amountInput, accountName) {
    const drawerOk = await waitDrawerAccount(accountName, amountInput);

    if (!drawerOk) {
      showStatus(`安全停止：右侧转入面板没有匹配到目标账号 ${accountName}`);
      return false;
    }

    for (let i = 0; i < 20; i++) { // 最多等待右侧“转入”按钮20秒。
      const btn = findDrawerTransferButton(amountInput);

      if (btn) {
        simpleClick(btn);
        showStatus(`已自动点击右侧转入按钮：${accountName}`);
        await sleep(3000); // 点击右侧“转入”后等3秒，再尝试点确认按钮。
        await clickConfirmIfAny();
        return true;
      }

      showStatus(`等待右侧转入按钮... ${i + 1}/20`);
      await sleep(1000); // 每1秒找一次右侧“转入”按钮。
    }

    return false;
  }

  async function fillAssignPage() {
    markAssignPageReady();

    if (isPaused()) {
      setAssignState('已暂停自动充值，充值页不处理任务。到「运行设置」取消勾选「暂停自动充值」。');
      showStatus('已暂停自动充值：充值页不处理待充值任务');
      return;
    }

    if (isDryRun()) {
      setAssignState('模拟运行中，充值页只看不充。到「运行设置」取消勾选「模拟运行」。');
      showStatus('模拟运行中：充值页不处理待充值任务');
      return;
    }

    if (isAssigning) return;

    if (!acquireAssignLock()) {
      setAssignState('另一个充值页正在处理任务，本页等待。多开了充值页就关掉多余的。');
      showStatus('另一个充值页正在处理任务，本页等待');
      return;
    }

    isAssigning = true;
    const submittedTasks = [];

    try {
      markAssignPageReady();
      await sleep(2500); // 充值页开始处理任务前先等2.5秒，确保页面表格和按钮稳定。

      while (true) {
      markAssignPageReady();

      if (isPaused() || isDryRun()) {
        showStatus(isPaused() ? '已暂停自动充值：停止处理充值队列' : '模拟运行中：停止处理充值队列');
        return;
      }

      let current = popNextToCurrentIfNeeded();

      if (!current) {
        setAssignState('充值页空闲，没有待充值账号');
        showStatus('分配金额页面：没有待充值账号');
        return;
      }

      setAssignState(`正在处理 ${current.accountName}，金额 ${current.amount} 元`);
      const ready = await waitAssignPageReady();

      if (!ready) {
        setAssignState('充值页加载超时：没找到账户搜索框或表格。请确认已登录并停在「投放账户分配金额」页。');
        showStatus('分配金额页面加载超时');
        if (await retryOrContinueCurrentTask(current, '分配金额页面加载超时')) continue;
        return;
      }

      const budgetGate = gateTaskByDailyBudget(current);
      if (budgetGate.skip) {
        showStatus(`受当日推广预算限制，跳过 ${current.accountName}：${budgetGate.reason}`);
        skipCurrentTaskForBudget(current, budgetGate.reason);
        const remainQueue = getQueue();
        if (remainQueue.length > 0) {
          showStatus(`已跳过超预算账号，${CONFIG.nextAccountDelayMs / 1000}秒后继续下一个。剩余：${remainQueue.length}`);
          await sleep(CONFIG.nextAccountDelayMs);
          continue;
        }
        return;
      }

      if (budgetGate.amount && Number(budgetGate.amount) !== Number(current.amount || 0)) {
        current = Object.assign({}, current, budgetGate.task || {}, {
          amount: budgetGate.amount
        });
        setCurrent(current);
        refreshQueuePanel();
        showStatus(`${current.accountName} 受当日预算限制，提交金额调整为 ${current.amount} 元`);
      }

      const { accountName, amount } = current;

      showStatus(`正在自动充值：${accountName}，${amount}元\n规则：${current.ruleName || '默认'}\n原因：${current.triggerReason || '余额/ROI规则'}`);

      const input = queryPageElements('input')
        .find(el =>
          el.placeholder &&
          (
            el.placeholder.includes('投放账户') ||
            el.placeholder.includes('账户') ||
            el.placeholder.includes('ID')
          )
        );

      if (!input) {
        showStatus('没有找到账号搜索框');
        if (await retryOrContinueCurrentTask(current, '没有找到账号搜索框')) continue;
        return;
      }

      setInputValue(input, accountName);
      await sleep(800);
      await clickAssignSearch(input);

      const targetRow = await waitForExactTargetRow(accountName);

      if (!targetRow) {
        showStatus(`安全停止：没有精确找到账号 ${accountName}`);
        if (await retryOrContinueCurrentTask(current, `没有精确找到账号 ${accountName}`)) continue;
        return;
      }

      const rowAccountName = getAccountName(targetRow);

      if (!sameAccount(rowAccountName, accountName)) {
        showStatus(`安全停止：目标账号不一致。目标=${accountName}，页面=${rowAccountName}`);
        if (await retryOrContinueCurrentTask(current, `目标账号不一致，页面显示为 ${rowAccountName}`)) continue;
        return;
      }

      const transferIn = [...targetRow.querySelectorAll('a, button, span')]
        .find(el => el.innerText && normalizeText(el.innerText) === '转入');

      if (!transferIn) {
        showStatus(`找到了精确账号，但没有找到列表里的转入按钮：${accountName}`);
        if (await retryOrContinueCurrentTask(current, `没有找到列表里的转入按钮：${accountName}`)) continue;
        return;
      }

      simpleClick(transferIn);

      const amountInput = await waitForAmountInput(accountName);

      if (!amountInput) {
        showStatus(`没有找到金额输入框：${accountName}`);
        if (await retryOrContinueCurrentTask(current, `没有找到金额输入框：${accountName}`)) continue;
        return;
      }

      const drawerOk = await waitDrawerAccount(accountName, amountInput);

      if (!drawerOk) {
        showStatus(`安全停止：打开的转入面板不是目标账号 ${accountName}`);
        if (await retryOrContinueCurrentTask(current, `打开的转入面板不是目标账号 ${accountName}`)) continue;
        return;
      }

      if (!isCurrentTaskStillActive(current)) {
        showStatus(`当前任务已被清空或替换，停止提交：${accountName}`);
        return;
      }

      if (isPaused() || isDryRun()) {
        showStatus(isPaused() ? `已暂停自动充值，停止提交：${accountName}` : `模拟运行中，停止提交：${accountName}`);
        return;
      }

      const submitGuardAcquired = await acquireAccountSubmitGuard(accountName);

      if (!submitGuardAcquired) {
        showStatus(`防重复充值：${accountName} 近期已有同账号充值正在处理或已提交，本次跳过重复任务`);
        clearCurrent();
        refreshQueuePanel();

        const queue = getQueue();

        if (queue.length > 0) {
          showStatus(`已跳过重复账号，${CONFIG.nextAccountDelayMs / 1000}秒后继续下一个。剩余：${queue.length}`);
          await sleep(CONFIG.nextAccountDelayMs); // 跳过重复账号后，按顶部nextAccountDelayMs等待再处理下一个。
          continue;
        }

        showStatus('重复账号已跳过，当前没有其他待充值任务');
        return;
      }

      setInputValue(amountInput, amount);

      await sleep(1000); // 金额填入后等1秒，让页面识别输入值。

      if (!isCurrentTaskStillActive(current)) {
        releaseAccountSubmitGuard(accountName);
        showStatus(`当前任务已被清空或替换，停止提交：${accountName}`);
        return;
      }

      if (isPaused() || isDryRun()) {
        releaseAccountSubmitGuard(accountName);
        showStatus(isPaused() ? `已暂停自动充值，停止提交：${accountName}` : `模拟运行中，停止提交：${accountName}`);
        return;
      }

      const submitted = await submitTransfer(amountInput, accountName);

      if (!submitted) {
        releaseAccountSubmitGuard(accountName);
        showStatus(`没有成功点击右侧转入按钮：${accountName}`);
        if (await retryOrContinueCurrentTask(current, `没有成功点击右侧转入按钮：${accountName}`)) continue;
        return;
      }

      markAccountSubmitFinished(accountName);
      setAssignState(`已提交 ${accountName}，${amount} 元`);
      addRechargeLog(current);
      submittedTasks.push(Object.assign({}, current));
      markRuleDone(current);
      clearCurrent();
      refreshQueuePanel();

      const queue = getQueue();

      if (queue.length > 0) {
        showStatus(`当前账号已提交，${CONFIG.nextAccountDelayMs / 1000}秒后继续下一个。剩余：${queue.length}`);
        await sleep(CONFIG.nextAccountDelayMs); // 一个账号提交后，按顶部nextAccountDelayMs等待再处理下一个。
        continue;
      } else {
        showStatus('所有待充值账号已自动提交完成');
        return;
      }
      }
    } catch (err) {
      console.error(err);
      showStatus('分配金额页面脚本出错，请查看 Console');
    } finally {
      if (submittedTasks.length > 0) {
        await notifyDingTalkRechargeBatch(submittedTasks);
      }
      releaseAssignLock();
      isAssigning = false;
    }
  }

  function startAssignPolling() {
    markAssignPageReady();
    fillAssignPage();

    setInterval(() => { // 充值页轮询：每CONFIG.assignPollMs毫秒检查一次是否有待充值任务。
      markAssignPageReady();

      if (hasPendingTask()) {
        fillAssignPage();
        return;
      }

      if (Date.now() - lastAssignIdleStatus > 30000) {
        lastAssignIdleStatus = Date.now();
        setAssignState('充值页已打开，等待京小洁页面投递任务');
        showStatus('充值页已打开，等待京小洁页面投递任务');
      }
    }, CONFIG.assignPollMs);
  }

  function waitForBody() {
    return new Promise(resolve => {
      if (document.body) {
        resolve();
        return;
      }

      const finish = () => {
        if (document.body) resolve();
      };

      document.addEventListener('DOMContentLoaded', finish, { once: true });
      window.addEventListener('load', finish, { once: true });

      const timer = setInterval(() => {
        if (document.body) {
          clearInterval(timer);
          resolve();
        }
      }, 50);

      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 15000);
    });
  }

  function isJxjSite() {
    const host = String(location.hostname || '');
    const href = String(location.href || '');
    return host.indexOf('hnyjyx.cn') >= 0 || href.indexOf('hnyjyx.cn') >= 0;
  }

  function isJztSite() {
    const host = String(location.hostname || '');
    const href = String(location.href || '');
    return host.indexOf('jzt.jd.com') >= 0 || href.indexOf('jzt.jd.com') >= 0;
  }

  function isJxjAdPage() {
    return detectPageMode() === 'jxj-ad';
  }

  function isProbablyHiddenFrame() {
    try {
      if (window.top === window) return false;
    } catch (e) {}

    const width = window.innerWidth || 0;
    const height = window.innerHeight || 0;
    return (width > 0 && width < 360) || (height > 0 && height < 240);
  }

  function detectPageMode() {
    const href = String(location.href || '');
    const host = String(location.hostname || '');
    const hash = String(location.hash || '');
    const path = String(location.pathname || '');
    const title = String(document.title || '');
    const blob = (href + ' ' + hash + ' ' + path + ' ' + title).toLowerCase();

    const isJxj = isJxjSite();
    const isJzt = isJztSite();
    const isJxjAd = isJxj && (
      blob.indexOf('adplacement') >= 0 ||
      blob.indexOf('ad-placement') >= 0 ||
      blob.indexOf('ad_placement') >= 0 ||
      blob.indexOf('/jzt/') >= 0 ||
      blob.indexOf('投放明细') >= 0 ||
      blob.indexOf('广告投放') >= 0
    );
    const isAssign = isJzt && (
      blob.indexOf('/account') >= 0 ||
      blob.indexOf('assign') >= 0 ||
      blob.indexOf('分配金额') >= 0 ||
      blob.indexOf('投放账户') >= 0
    );

    if (isJxjAd) return 'jxj-ad';
    if (isAssign) return 'jzt-assign';
    if (isJxj) return 'jxj';
    if (isJzt) return 'jzt';
    return 'other';
  }

  function syncPageMode() {
    const mode = detectPageMode();
    if (mode === pageMode) return;
    pageMode = mode;

    if (mode === 'jxj-ad') {
      showStatus('全自动脚本已启动：广告投放明细页面\n版本 ' + SCRIPT_VERSION + '，右下角可打开「工作台」');
      checkAdPage();
      startAdCheckTimer();
      return;
    }

    if (mode === 'jzt-assign') {
      showStatus('全自动脚本已启动：分配金额页面，精确匹配账号名\n版本 ' + SCRIPT_VERSION + '，右下角可打开「工作台」');
      startAssignPolling();
      return;
    }

    showStatus(
      '自动充值脚本 v' + SCRIPT_VERSION + ' 已加载，但当前还不是工作页。\n' +
      '当前地址：' + location.href + '\n' +
      '请打开京小洁「广告投放明细」，或京准通「投放账户分配金额」页面。右下角应出现「工作台 ' + SCRIPT_VERSION + '」。'
    );
  }

  function watchUrlChanges() {
    if (urlWatchStarted) return;
    urlWatchStarted = true;

    const wrapHistory = method => {
      const original = history[method];
      if (typeof original !== 'function') return;
      history[method] = function () {
        const result = original.apply(this, arguments);
        setTimeout(syncPageMode, 80);
        return result;
      };
    };

    wrapHistory('pushState');
    wrapHistory('replaceState');
    window.addEventListener('popstate', () => setTimeout(syncPageMode, 80));
    window.addEventListener('hashchange', () => setTimeout(syncPageMode, 80));
    setInterval(syncPageMode, 2500);
  }

  function watchDomRemount() {
    if (!document.documentElement) return;

    const observer = new MutationObserver(() => {
      if (!document.body) return;
      if (document.getElementById('jxj-rule-panel-toggle') && document.getElementById('jxj-rule-panel')) return;
      renderRulePanel();
      renderRechargeLogPanel();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // 页面长时间不关时，也要在 0 点自动重置，不用等下一轮查询。
  function startDailyResetWatcher() {
    if (dailyResetTimerStarted) return;
    dailyResetTimerStarted = true;
    setInterval(resetDailyStateIfNewDay, 60 * 1000); // 每分钟检查一次日期是否变了。
  }

  function notifyNewVersionIfNeeded() {
    if (!hasUnreadVersion()) return;
    const latest = getLatestVersionEntry();
    setTimeout(() => {
      if (!hasUnreadVersion()) return;
      showStatus(
        '已更新到 v' + SCRIPT_VERSION + '：' + (latest.title || '版本更新') + '\n' +
        '打开工作台左侧「版本中心」可查看本次更新和历史功能记录。'
      );
    }, 1600);
  }

  async function main() {
    try {
      if (isProbablyHiddenFrame()) {
        console.log('[京小洁全自动脚本] 跳过隐藏/过小的 iframe', location.href);
        return;
      }

      await waitForBody();
      if (!document.body) {
        console.error('[京小洁全自动脚本] 页面没有 body，无法显示工作台');
        return;
      }

      migrateRuntimeStateIfNeeded();
      renderRulePanel();
      renderRechargeLogPanel();
      resetDailyStateIfNewDay();
      startDailyResetWatcher();
      startRuleScheduler();
      watchUrlChanges();
      watchDomRemount();
      pageMode = '';
      syncPageMode();
      notifyNewVersionIfNeeded();
    } catch (error) {
      console.error('[京小洁全自动脚本] 启动失败', error);
      try {
        showStatus('自动充值脚本启动失败：' + (error && error.message ? error.message : error));
      } catch (e) {}
    }
  }

  main();
})();
