// ==UserScript==
// @name         idlepoe 助手测试服版 2.17
// @namespace    https://idlepoe.com
// @version      2.17
// @description  测试服装备改造助手：批量通货、打孔链接、洗色、词缀筛选、通货邮件。
// @match        *://poe-test.faith.wang/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const SKILL_TREE_IMPORT_SESSION_KEY = 'poeAssistantV2.skillTreePendingImport';
  const SKILL_TREE_IMPORT_STATUS_SESSION_KEY = 'poeAssistantV2.skillTreeImportStatus';

  /**
   * installSkillTreeImportInterceptor 只替换一次天赋页 GET 响应，让网页原生组件加载导入方案。
   * 这里不提交 POST /api/skilltree，最终保存仍由用户点击网页自己的“保存”按钮完成。
   */
  const installSkillTreeImportInterceptor = () => {
    const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (!targetWindow?.fetch || targetWindow.__poeAssistantSkillTreeImportInstalled) return;
    targetWindow.__poeAssistantSkillTreeImportInstalled = true;
    const originalFetch = targetWindow.fetch;
    targetWindow.fetch = async function interceptedSkillTreeFetch(...args) {
      const response = await originalFetch.apply(this, args);
      let pendingText = '';
      try {
        pendingText = targetWindow.sessionStorage.getItem(SKILL_TREE_IMPORT_SESSION_KEY) || '';
        if (!pendingText || !response?.ok) return response;
        const input = args[0];
        const requestUrl = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
        const requestMethod = String(args[1]?.method || input?.method || 'GET').toUpperCase();
        const pathname = new URL(requestUrl, targetWindow.location.origin).pathname;
        if (requestMethod !== 'GET' || pathname !== '/api/skilltree') return response;

        const pending = JSON.parse(pendingText);
        const payload = await response.clone().json();
        const data = payload?.data;
        const currentSkills = Array.isArray(data?.skills) ? data.skills.map(String) : [];
        const currentStart = String(data?.start || '');
        if (currentStart && !currentSkills.includes(currentStart)) currentSkills.unshift(currentStart);
        const importedSkills = Array.isArray(pending?.passives) ? pending.passives.map(String) : [];
        const importedStart = String(pending?.start || '');
        const totalPoints = Number(data?.points || 0) + Math.max(0, currentSkills.length - 1);
        const requiredPoints = Math.max(0, importedSkills.length - 1);
        if (!data || !importedStart || importedStart !== currentStart) throw new Error('职业起点与当前角色不一致');

        data.skills = importedSkills;
        data.masteries = pending.masteries && typeof pending.masteries === 'object' ? pending.masteries : {};
        data.points = totalPoints - requiredPoints;
        targetWindow.sessionStorage.removeItem(SKILL_TREE_IMPORT_SESSION_KEY);
        targetWindow.sessionStorage.setItem(SKILL_TREE_IMPORT_STATUS_SESSION_KEY, JSON.stringify({
          success: true,
          message: `已把 ${requiredPoints} 点天赋载入当前页面，请检查后点击网页原生“保存”。`,
        }));
        const headers = new targetWindow.Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        return new targetWindow.Response(JSON.stringify(payload), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        targetWindow.sessionStorage.removeItem(SKILL_TREE_IMPORT_SESSION_KEY);
        targetWindow.sessionStorage.setItem(SKILL_TREE_IMPORT_STATUS_SESSION_KEY, JSON.stringify({
          success: false,
          message: `导入天赋失败：${error.message}`,
        }));
        return response;
      }
    };
  };

  installSkillTreeImportInterceptor();

  /**
   * AssistantV2 是脚本唯一的命名空间，用来避免污染游戏页面的全局变量。
   * 里面按 config、state、api、logic、ui 分层，后续维护时可以更稳定地定位问题。
   */
  const AssistantV2 = {};

  /**
   * API_BASE_URL 表示当前测试服页面对应的接口根地址。
   * 使用 location.origin 可以避免以后测试服域名协议变化时还要改硬编码。
   */
  const API_BASE_URL = `${location.origin}/api`;

  /**
   * STORAGE_KEYS 保存脚本自己的本地存储键名，统一前缀可以避免和页面原有键冲突。
   */
  /**
   * STORAGE_KEY_PREFIX 是助手所有自有 localStorage 字段的统一前缀。
   * 新增本地缓存时必须通过 createStorageKey 生成，避免出现散落的裸 key。
   */
  const STORAGE_KEY_PREFIX = 'poeAssistantV2';

  /**
   * createStorageKey 为助手自有存储字段生成统一前缀的 localStorage key。
   * @param {string} keyName 业务字段名。
   * @returns {string} 带 poeAssistantV2 前缀的完整存储 key。
   */
  const createStorageKey = (keyName) => `${STORAGE_KEY_PREFIX}.${keyName}`;

  const STORAGE_KEYS = {
    craftPlans: createStorageKey('craftPlans'),
    advancedBatchPlan: createStorageKey('advancedBatchPlan'),
    settings: createStorageKey('settings'),
  };

  const TRANSIENT_ASSISTANT_STORAGE_KEYS = [
    'panelLeft',
    'panelTop',
    'toggleLeft',
    'toggleTop',
    'panelVisible',
    'useStorage',
    'recentMailReceivers',
    'minimizePausesAutomation',
    'speedMode',
    'logMode',
    'themeMode',
    'stepActionSafetyLimit',
    'customCraftStepSafetyLimit',
    'customCraftCurrencyLimit',
  ].map(createStorageKey);

  /**
   * PAGE_STORAGE_KEYS 是游戏网页自身使用的 localStorage/sessionStorage 字段。
   * 这些字段不是助手写入的配置，不能强行改成 poeAssistantV2 前缀，否则会读不到登录态或网页主题。
   */
  const PAGE_STORAGE_KEYS = {
    token: 'token',
    theme: 'theme',
  };

  /**
   * THEME_MODES 表示助手 UI 的主题选择；auto 会读取游戏页面自己的 localStorage.theme。
   */
  const THEME_MODES = {
    auto: 'auto',
    light: 'light',
    dark: 'dark',
  };

  /**
   * MODIFY_TYPES 是装备改造接口使用的通货类型编号。
   * 编号来自原版脚本，集中放置可以减少魔法数字散落。
   */
  const MODIFY_TYPES = {
    jeweller: 1,
    chromatic: 2,
    fusing: 3,
    transmutation: 4,
    chance: 5,
    alchemy: 6,
    augment: 7,
    alteration: 8,
    exalted: 9,
    chaos: 10,
    regal: 11,
    scouring: 12,
    divine: 13,
    vaal: 14,
    whetstone: 16,
    armourScrap: 17,
    annulment: 18,
    glassblowerBauble: 20,
  };

  /**
   * SKILL_STONE_MODIFY_TYPES 是技能石改造接口使用的操作编号。
   * 赚钱脚本中确认 type=38 表示使用宝石匠的棱镜提升技能石品质。
   */
  const SKILL_STONE_MODIFY_TYPES = {
    vaal: MODIFY_TYPES.vaal,
    gemcutterPrism: 38,
  };

  /**
   * CURRENCY_USAGE_REPORT_INTERVAL 控制通货消耗进度汇报频率。
   * 用户要求每消耗 200 个通货汇报一次，因此所有成功消耗都会汇总到同一个计数器。
   */
  const CURRENCY_USAGE_REPORT_INTERVAL = 200;

  /**
   * MODIFY_TYPE_LABELS 把装备和技能石改造编号统一映射为日志中的通货名称。
   */
  const MODIFY_TYPE_LABELS = {
    [MODIFY_TYPES.jeweller]: '工匠石',
    [MODIFY_TYPES.chromatic]: '幻色石',
    [MODIFY_TYPES.fusing]: '链接石',
    [MODIFY_TYPES.transmutation]: '蜕变石',
    [MODIFY_TYPES.chance]: '机会石',
    [MODIFY_TYPES.alchemy]: '点金石',
    [MODIFY_TYPES.augment]: '增幅石',
    [MODIFY_TYPES.alteration]: '改造石',
    [MODIFY_TYPES.exalted]: '崇高石',
    [MODIFY_TYPES.chaos]: '混沌石',
    [MODIFY_TYPES.regal]: '富豪石',
    [MODIFY_TYPES.scouring]: '重铸石',
    [MODIFY_TYPES.divine]: '神圣石',
    [MODIFY_TYPES.vaal]: '瓦尔宝珠',
    [MODIFY_TYPES.whetstone]: '磨刀石',
    [MODIFY_TYPES.armourScrap]: '护甲片',
    [MODIFY_TYPES.annulment]: '剥离石',
    [MODIFY_TYPES.glassblowerBauble]: '玻璃弹珠',
    [SKILL_STONE_MODIFY_TYPES.gemcutterPrism]: '宝石匠的棱镜',
  };

  /**
   * SKILL_STONE_MAX_UPGRADE_ATTEMPTS 是单颗技能石单次任务最多尝试升级次数。
   * 正常技能石最高 20 级，少数特殊宝石更低；这里用安全上限防止接口异常时无限循环。
   */
  const SKILL_STONE_MAX_UPGRADE_ATTEMPTS = 24;

  /**
   * GEMCUTTER_PRISM_BATCH_SIZE 控制单颗技能石使用棱镜时的并发请求数。
   * 小批次比逐次等待更快，也比一次性大量请求更容易观察进度和定位失败。
   */
  const GEMCUTTER_PRISM_BATCH_SIZE = 5;

  /**
   * SKILL_STONE_UPGRADE_CONCURRENCY 控制选中技能石升级时同时处理几颗。
   * 单颗内部仍然逐级请求，避免同一颗石头的等级状态被并发请求打乱。
   */
  const SKILL_STONE_UPGRADE_CONCURRENCY = 5;

  /**
   * SKILL_STONE_VAAL_BATCH_SIZE 控制批量腐化技能石时的并发数量。
   */
  const SKILL_STONE_VAAL_BATCH_SIZE = 5;

  /**
   * SKILL_STONE_PRACTICE_CONCURRENCY 控制智能练技能调整位置时的并发请求数。
   */
  const SKILL_STONE_PRACTICE_CONCURRENCY = 5;

  /**
   * SKILL_STONE_DETAIL_CONCURRENCY 控制加载技能石时并发读取详情的请求数。
   */
  const SKILL_STONE_DETAIL_CONCURRENCY = 5;

  const EXCEPTIONAL_SKILL_STONE_NAMES = new Set(['赋予(辅)', '启蒙(辅)', '增幅(辅)']);
  const EXCEPTIONAL_SKILL_STONE_IDS = new Set(['Empower_Support', 'Enlighten_Support', 'Enhance_Support']);
  const EXCEPTIONAL_SKILL_STONE_EXP = [226854909, 1439190228];
  const NORMAL_SKILL_STONE_EXP_CURVES = [
    [70, 308, 1554, 6667, 26047, 49725, 95714, 169595, 283759, 453996, 703128, 1061223, 2065870, 2507110, 5798936, 15083919, 27792735, 43869739, 242081556],
    [841, 3099, 7433, 22895, 49725, 95714, 169595, 283759, 453996, 703128, 1061223, 2065870, 2507110, 2573731, 7611351, 13437908, 25052147, 43869436, 242081178],
    [3231, 9569, 28189, 59146, 111192, 193800, 320280, 507839, 554379, 755049, 1016533, 1898602, 1964019, 2573731, 7610839, 13436884, 25050611, 43867388, 242078618],
    [9569, 28189, 59146, 111192, 193800, 320280, 359090, 498508, 682057, 921777, 1727879, 1791769, 2353679, 3070912, 9095466, 16039890, 29817117, 62895056, 212051599],
    [15249, 41517, 81983, 147968, 250557, 405086, 447718, 615318, 834639, 1570760, 1633987, 2151030, 2812189, 5099360, 9400731, 15273366, 26286582, 62890590, 212046017],
    [49725, 95714, 169595, 199345, 285815, 401344, 554379, 755049, 1016533, 1898602, 1964019, 2573731, 4676439, 3017327, 7823001, 15264208, 26272845, 62872274, 212023122],
    [69833, 128549, 154553, 225374, 320672, 447718, 615318, 834639, 1570760, 1633987, 2151030, 2812189, 3655184, 3017327, 7818905, 15256013, 26260555, 62855887, 212002638],
    [118383, 175816, 254061, 359090, 498508, 682057, 921777, 1727879, 1138877, 1368233, 1638338, 1956648, 3655184, 3017327, 7793914, 15206031, 26185582, 62755923, 211877683],
    [199345, 285815, 401344, 554379, 477437, 583786, 710359, 1355511, 1138877, 1368233, 1638338, 1956648, 3655184, 3017327, 7759995, 15138193, 26083825, 62620247, 211708088],
    [285815, 252595, 314394, 388734, 477437, 583786, 710359, 1355511, 1138877, 1368233, 1638338, 1956648, 3655184, 3017327, 7720126, 15058455, 25964218, 62460771, 211508743],
    [252595, 314394, 388734, 477437, 583786, 710359, 1355511, 1138877, 1368233, 1638338, 1956648, 3655184, 3017327, 3576232, 9164731, 17861428, 46032386, 87248039, 157972052],
    [388734, 477437, 583786, 710359, 1355511, 1138877, 1368233, 1638338, 1956648, 3655184, 3017327, 3576232, 4231667, 2395078, 8421063, 16159983, 41170367, 86794448, 157405063],
    [413868278, 455255105, 500780616, 550858678],
  ];

  /**
   * BATCH_CURRENCY_CONCURRENCY 控制批量通货同时处理几件装备。
   */
  const BATCH_CURRENCY_CONCURRENCY = 5;

  /**
   * CRAFT_SOCKET_CONCURRENCY 控制孔洞操作同时处理几件装备。
   */
  const CRAFT_SOCKET_CONCURRENCY = 5;

  /**
   * AUTO_UNIQUE_CONCURRENCY 控制自动暗金同时处理几件装备。
   */
  const AUTO_UNIQUE_CONCURRENCY = 5;

  /**
   * GEMCUTTER_TARGET_QUALITY 表示宝石匠的棱镜自动使用的目标品质。
   */
  const GEMCUTTER_TARGET_QUALITY = 20;

  /**
   * EQUIPMENT_TARGET_QUALITY 表示装备品质通货的目标品质。
   */
  const EQUIPMENT_TARGET_QUALITY = 20;

  /**
   * FRACTURED_DESTROY_BATCH_SIZE 控制批量丢弃破裂装备时的并发数量。
   * 小批次可以明显快于逐件等待，同时比一次性全部请求更稳。
   */
  const FRACTURED_DESTROY_BATCH_SIZE = 5;

  /**
   * TAIL_PAGE_DESTROY_CONFIG 定义其他功能里的背包尾页清理范围。
   * 这是一个危险操作，执行入口会强制二次确认，并且只清理背包，不读取储藏。
   */
  const TAIL_PAGE_DESTROY_CONFIG = {
    pageCount: 100,
  };

  /**
   * BATTLE_ANALYSIS_CONFIG 定义轻量战斗分析的判定阈值。
   * 时间膨胀用“服务器战斗时间增量 / 本地真实时间增量”判断，明显低于 1 说明游戏时间推进变慢。
   */
  const BATTLE_ANALYSIS_CONFIG = {
    dilationRatioThreshold: 0.75,
    speedRatioThreshold: 1.25,
    minSampleSeconds: 1,
    initialSyncIgnoreMs: 5000,
    stableFrameTarget: 3,
    maxReliableLocalDeltaSeconds: 5,
  };

  /**
   * RANK_ANALYSIS_CONFIG 定义排行榜分析的分页和展示上限。
   * 排行榜可能会随赛季人数增长，因此必须限制最大分页，避免异常响应导致无限请求。
   */
  const RANK_ANALYSIS_CONFIG = {
    maxPages: 200,
    topLimit: 50,
    concurrency: 5,
  };

  /**
   * CHARACTER_EQUIPMENT_SLOT_LABELS 把角色详情中的装备槽位 key 映射为中文。
   * 同时兼容 bodyArmour/bodyArmor 两种可能拼写，提升接口字段变化时的容错能力。
   */
  const CHARACTER_EQUIPMENT_SLOT_LABELS = {
    mainHand: '主手',
    mainhand: '主手',
    main_hand: '主手',
    weapon1: '主手',
    offHand: '副手',
    offhand: '副手',
    off_hand: '副手',
    weapon2: '副手',
    helmet: '头盔',
    bodyArmour: '胸甲',
    bodyArmor: '胸甲',
    belt: '腰带',
    glove: '手套',
    gloves: '手套',
    boot: '鞋子',
    boots: '鞋子',
    necklace: '项链',
    amulet: '项链',
    ring: '戒指',
    ring1: '左戒',
    ring2: '右戒',
    flask1: '药剂1',
    flask2: '药剂2',
    flask3: '药剂3',
    flask4: '药剂4',
    flask5: '药剂5',
  };

  const getCharacterEquipmentSlotLabel = (slotKey, slotName = '', fallback = '') => {
    const rawKey = String(slotKey || '').trim();
    const rawName = String(slotName || '').trim();
    const compactKey = rawKey.replace(/[-_\s]/g, '').toLowerCase();
    return CHARACTER_EQUIPMENT_SLOT_LABELS[rawKey]
      || CHARACTER_EQUIPMENT_SLOT_LABELS[compactKey]
      || CHARACTER_EQUIPMENT_SLOT_LABELS[rawName]
      || rawName
      || fallback
      || rawKey
      || '装备';
  };

  /**
   * CHARACTER_CLASS_LABELS 把游戏接口里的职业编号转成中文职业名。
   * 编号来源和战斗分析插件的 classEmojis 保持一致，这里展示文字而不是 emoji，便于排行榜统计阅读。
   */
  const CHARACTER_CLASS_LABELS = {
    1: '野蛮人',
    2: '贵族',
    3: '女巫',
    4: '游侠',
    5: '决斗者',
    6: '圣堂武僧',
    7: '暗影刺客',
  };

  /**
   * SPECIAL_SOCKET_EQUIPMENT_NAMES 来自赚钱脚本的特殊暗金装备名单。
   * 这些装备上的技能石即使没有出现在当前启用技能/光环里，也可能由装备触发或产生效果，排行榜报告应补充展示。
   */
  const SPECIAL_SOCKET_EQUIPMENT_NAMES = new Set([
    '灰烬行者', '诗人之笔', '阿拉卡力之牙', '隐匿之刃', '积怨溃脓', '荒野之律', '月岚', '秘法君临',
    '救世者', '思想奔流', '卡斯普里怨恨', '沉默之雷', '卡美利亚之贪婪', '虚无之倾', '飞龙之翼',
    '扭魂者', '阿兹里的统治', '断罪', '努葛玛呼之耀', '唤星', '乌尔尼多的拥抱', '禅意苦行僧',
    '乔赫黑钢', '塔赫亚的砍伐', '离异梦寐', '合流梦寐', '苍白烈火', '冰点低语', '斯瓦林',
    '坚毅之食', '孔明的神算', '永恒苹果', '破裂碎片', '惊悸剧院', '影月', '耀日', '不屈烈焰',
    '峰回路转', '苍空之翎', '千里狙敌', '安赛娜丝的迅敏之冠', '吞噬者王冠', '伊芙班的诡计',
    '希伯的霸权', '奇塔弗之渴望', '光明偷猎者', '鸥喙', '冥使之体', '德瑞之肤', '女王的饥饿',
    '孢囊守卫', '将军的复生', '七大教义', '永恒幽影', '永恒幽影（仿品）', '泯光寿衣',
    '腐朽仆从', '大地之痕', '狮眼的斗志', '狮眼的斗志（仿品）', '灵柩行者', '鼠疫之源',
    '沃拉娜的征途', '欧斯卡姆', '刁妇的圈套', '领主之手', '多里亚尼的幻想', '多里亚尼之拳',
    '相生相克', '蠕动恐惧', '马洛尼的技巧', '马洛尼的技巧（仿品）', '乌尔尼多之誓', '侍从',
  ]);

  /**
   * RARITY_TYPES 是装备稀有度编号，和游戏接口保持一致。
   */
  const RARITY_TYPES = {
    any: '',
    normal: 1,
    magic: 2,
    rare: 3,
    unique: 4,
  };

  const SPECIAL_CONDITION_METRICS = {
    totalAffixCount: { label: '当前总词缀数', valueType: 'number' },
    prefixCount: { label: '当前前缀数', valueType: 'number' },
    suffixCount: { label: '当前后缀数', valueType: 'number' },
    rarity: { label: '装备稀有度', valueType: 'rarity' },
    corrupted: { label: '是否已腐化', valueType: 'boolean' },
    crafted: { label: '是否有工艺词缀', valueType: 'boolean' },
    craftedMultimod: { label: '是否有工艺多大师', valueType: 'boolean' },
    openPrefix: { label: '是否有空前缀', valueType: 'boolean' },
    openSuffix: { label: '是否有空后缀', valueType: 'boolean' },
    openAffix: { label: '是否有空词缀', valueType: 'boolean' },
  };

  const ROLL_CONDITION_METRICS = {
    physicalDamageMin: { label: '武器物理最小伤害', valueType: 'number' },
    physicalDamageMax: { label: '武器物理最大伤害', valueType: 'number' },
    fireDamageMin: { label: '武器火焰最小伤害', valueType: 'number' },
    fireDamageMax: { label: '武器火焰最大伤害', valueType: 'number' },
    coldDamageMin: { label: '武器冰霜最小伤害', valueType: 'number' },
    coldDamageMax: { label: '武器冰霜最大伤害', valueType: 'number' },
    lightningDamageMin: { label: '武器闪电最小伤害', valueType: 'number' },
    lightningDamageMax: { label: '武器闪电最大伤害', valueType: 'number' },
    chaosDamageMin: { label: '武器混沌最小伤害', valueType: 'number' },
    chaosDamageMax: { label: '武器混沌最大伤害', valueType: 'number' },
    prefixRollAverage: { label: '前缀平均Roll', valueType: 'percent' },
    prefixRollMinimum: { label: '前缀最低Roll', valueType: 'percent' },
    suffixRollAverage: { label: '后缀平均Roll', valueType: 'percent' },
    suffixRollMinimum: { label: '后缀最低Roll', valueType: 'percent' },
    affixRollAverage: { label: '前后缀平均Roll', valueType: 'percent' },
    affixRollMinimum: { label: '前后缀最低Roll', valueType: 'percent' },
    craftedRollAverage: { label: '工艺词缀平均Roll', valueType: 'percent' },
    craftedRollMinimum: { label: '工艺词缀最低Roll', valueType: 'percent' },
  };

  const SPECIAL_CONDITION_OPERATORS = {
    eq: '等于',
    ne: '不等于',
    contains: '包含',
    notContains: '不包含',
    gt: '大于',
    gte: '大于等于',
    lt: '小于',
    lte: '小于等于',
  };

  const SPECIAL_CONDITION_RARITY_LABELS = {
    [RARITY_TYPES.normal]: '普通',
    [RARITY_TYPES.magic]: '魔法',
    [RARITY_TYPES.rare]: '稀有',
    [RARITY_TYPES.unique]: '暗金',
  };

  /**
   * SPEED_OPTIONS 定义全局自动化速度档位，只控制等待间隔，不控制日志密度。
   */
  const SPEED_OPTIONS = {
    stepwise: { label: '逐步', delayMs: 1500 },
    normal: { label: '普通', delayMs: 500 },
    fast: { label: '快速', delayMs: 50 },
    immediate: { label: '立即', delayMs: 0 },
  };

  const normalizeSpeedMode = (speedMode) => (SPEED_OPTIONS[speedMode] ? speedMode : 'normal');

  const LOG_MODES = {
    trace: { label: '逐条', minPriority: 10 },
    detailed: { label: '详细', minPriority: 15 },
    main: { label: '主要', minPriority: 20 },
    compact: { label: '精简', minPriority: 30 },
  };

  const normalizeLogMode = (logMode) => (LOG_MODES[logMode] ? logMode : 'main');

  const LOG_LEVELS = {
    trace: { label: '逐条', priority: 10, className: 'detail' },
    detail: { label: '详细', priority: 15, className: 'detail' },
    info: { label: '信息', priority: 15, className: 'info' },
    main: { label: '主要', priority: 20, className: 'info' },
    success: { label: '成功', priority: 30, className: 'success' },
    lifecycle: { label: '任务', priority: 30, className: 'info' },
    compact: { label: '精简', priority: 30, className: 'info' },
    warn: { label: '警告', priority: 30, className: 'warn' },
    error: { label: '错误', priority: 40, className: 'error' },
    always: { label: '提示', priority: 50, className: 'info' },
  };

  /**
   * CONTINUOUS_CRAFT_ACTIONS 定义连续打造中每一步可执行的动作。
   * limits 用于在开跑前判断词缀组合是否可能出现，避免明显不可能的方案无限消耗通货。
   */
  const CONTINUOUS_CRAFT_ACTIONS = {
    conditionCheck: {
      label: '条件判断',
      currencyLabel: '条件判断',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: true,
    },
    none: {
      label: '无动作',
      currencyLabel: '无动作',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: false,
    },
    ensureMagic: {
      label: '变为魔法',
      currencyLabel: '变为魔法',
      limits: { prefix: 1, suffix: 1, total: 2 },
      requiresConditions: false,
    },
    ensureRare: {
      label: '变为稀有',
      currencyLabel: '变为稀有',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: false,
    },
    smartAugment: {
      label: '智能增幅',
      currencyLabel: '智能增幅',
      limits: { prefix: 1, suffix: 1, total: 2 },
      requiresConditions: false,
    },
    smartExalted: {
      label: '智能崇高',
      currencyLabel: '智能崇高',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: false,
    },
    smartCraftBench: {
      label: '智能工艺',
      currencyLabel: '智能工艺',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: false,
    },
    gardenCraft: {
      label: '花园工艺',
      currencyLabel: '花园工艺',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: false,
    },
    scouring: {
      label: '重铸石',
      currencyLabel: '重铸石',
      limits: { prefix: 0, suffix: 0, total: 0 },
      requiresConditions: false,
    },
    transmutation: {
      label: '蜕变石',
      currencyLabel: '蜕变石',
      limits: { prefix: 1, suffix: 1, total: 2 },
      requiresConditions: false,
    },
    alteration: {
      label: '改造石',
      currencyLabel: '改造石',
      limits: { prefix: 1, suffix: 1, total: 2 },
      requiresConditions: false,
    },
    augment: {
      label: '增幅石',
      currencyLabel: '增幅石',
      limits: { prefix: 1, suffix: 1, total: 2 },
      requiresConditions: false,
    },
    regal: {
      label: '富豪石',
      currencyLabel: '富豪石',
      limits: { prefix: 2, suffix: 2, total: 3 },
      requiresConditions: false,
    },
    alchemy: {
      label: '点金石',
      currencyLabel: '点金石',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: false,
    },
    chaos: {
      label: '混沌石',
      currencyLabel: '混沌石',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: false,
    },
    exalted: {
      label: '崇高石',
      currencyLabel: '崇高石',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: false,
    },
    divine: {
      label: '神圣石',
      currencyLabel: '神圣石',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: false,
    },
    annulment: {
      label: '剥离石',
      currencyLabel: '剥离石',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: false,
    },
    craftBench: {
      label: '工艺',
      currencyLabel: '工艺',
      limits: { prefix: 3, suffix: 3, total: 6 },
      requiresConditions: false,
    },
  };

  const CONTINUOUS_ACTION_KIND_OPTIONS = [
    { value: 'currency', label: '使用通货' },
    { value: 'craftBench', label: '工艺' },
    { value: 'gardenCraft', label: '花园工艺' },
    { value: 'aggregate', label: '智能操作' },
    { value: 'condition', label: '条件判断' },
    { value: 'none', label: '无动作' },
  ];

  const CONTINUOUS_ACTION_KIND_DETAIL_OPTIONS = {
    currency: [
      'scouring',
      'transmutation',
      'alteration',
      'augment',
      'regal',
      'alchemy',
      'chaos',
      'exalted',
      'divine',
      'annulment',
    ],
    aggregate: [
      'ensureMagic',
      'ensureRare',
      'smartAugment',
      'smartExalted',
      'smartCraftBench',
    ],
  };

  const EQUIPMENT_TYPE_MASKS = {
    oneHandWeapons: 507n,
    twoHandWeapons: 31744n,
    bows: 512n,
    quivers: 70368744177664n,
    helmets: 0xfc00000000n,
    bodyArmours: 17045651456n,
    gloves: 2064384n,
    boots: 132120576n,
    shields: 69269232549888n,
    belts: 0x800000000000n,
    amulets: 281474976710656n,
    rings: 562949953421312n,
  };

  const CRAFT_BENCH_CATEGORY_OPTIONS = [
    { value: 'oneHandWeapons', label: '单手武器', mask: EQUIPMENT_TYPE_MASKS.oneHandWeapons },
    { value: 'twoHandWeapons', label: '双手武器', mask: EQUIPMENT_TYPE_MASKS.twoHandWeapons },
    { value: 'bows', label: '弓', mask: EQUIPMENT_TYPE_MASKS.bows },
    { value: 'quivers', label: '箭袋', mask: EQUIPMENT_TYPE_MASKS.quivers },
    { value: 'helmets', label: '头盔', mask: EQUIPMENT_TYPE_MASKS.helmets },
    { value: 'bodyArmours', label: '胸甲', mask: EQUIPMENT_TYPE_MASKS.bodyArmours },
    { value: 'gloves', label: '手套', mask: EQUIPMENT_TYPE_MASKS.gloves },
    { value: 'boots', label: '靴子', mask: EQUIPMENT_TYPE_MASKS.boots },
    { value: 'shields', label: '盾牌', mask: EQUIPMENT_TYPE_MASKS.shields },
    { value: 'belts', label: '腰带', mask: EQUIPMENT_TYPE_MASKS.belts },
    { value: 'amulets', label: '项链', mask: EQUIPMENT_TYPE_MASKS.amulets },
    { value: 'rings', label: '戒指', mask: EQUIPMENT_TYPE_MASKS.rings },
  ];

  const GARDEN_CRAFT_CATEGORY_OPTIONS = [
    {
      value: 'weapons',
      label: '武器',
      mask: EQUIPMENT_TYPE_MASKS.oneHandWeapons | EQUIPMENT_TYPE_MASKS.twoHandWeapons | EQUIPMENT_TYPE_MASKS.bows,
      sampleTypes: [1n, 512n, 2048n],
    },
    {
      value: 'armours',
      label: '护甲',
      mask: EQUIPMENT_TYPE_MASKS.helmets
        | EQUIPMENT_TYPE_MASKS.bodyArmours
        | EQUIPMENT_TYPE_MASKS.gloves
        | EQUIPMENT_TYPE_MASKS.boots
        | EQUIPMENT_TYPE_MASKS.shields,
      sampleTypes: [17179869184n, 134217728n, 1048576n, 2097152n, 1099511627776n],
    },
    {
      value: 'jewelry',
      label: '项链/戒指/腰带',
      mask: EQUIPMENT_TYPE_MASKS.amulets | EQUIPMENT_TYPE_MASKS.rings | EQUIPMENT_TYPE_MASKS.belts,
      sampleTypes: [EQUIPMENT_TYPE_MASKS.amulets, EQUIPMENT_TYPE_MASKS.rings, EQUIPMENT_TYPE_MASKS.belts],
    },
  ];

  /**
   * CONTINUOUS_STEP_HANDLINGS 定义连续打造步骤条件成立/不成立后的处理方式。
   * jump 选择目标步骤；terminate* 按原因结束当前装备打造；scourRestart 会重铸后回到步骤 A。
   */
  const CONTINUOUS_STEP_HANDLINGS = {
    jump: { label: '跳转到步骤' },
    scourRestart: { label: '重铸后从步骤 A 开始' },
    terminateError: { label: '终止(异常错误)' },
    terminateSuccess: { label: '终止(打造成功)' },
    terminateManual: { label: '终止(手动操作)' },
  };

  const CONTINUOUS_STEP_TERMINATION = {
    error: -3,
    success: -2,
    manual: -1,
  };

  const CONTINUOUS_STEP_TERMINATION_HANDLINGS = {
    terminateError: { result: CONTINUOUS_STEP_TERMINATION.error, label: '异常错误', level: 'error' },
    terminateSuccess: { result: CONTINUOUS_STEP_TERMINATION.success, label: '打造成功', level: 'success' },
    terminateManual: { result: CONTINUOUS_STEP_TERMINATION.manual, label: '手动操作', level: 'warn' },
  };

  /**
   * BATCH_STONE_OPTIONS 定义批量操作下拉框中可选的通货。
   */
  const BATCH_STONE_OPTIONS = [
    { type: MODIFY_TYPES.transmutation, label: '蜕变石' },
    { type: MODIFY_TYPES.chance, label: '机会石' },
    { type: MODIFY_TYPES.alchemy, label: '点金石' },
    { type: MODIFY_TYPES.alteration, label: '改造石' },
    { type: MODIFY_TYPES.augment, label: '增幅石' },
    { type: MODIFY_TYPES.regal, label: '富豪石' },
    { type: MODIFY_TYPES.scouring, label: '重铸石' },
    { type: MODIFY_TYPES.exalted, label: '崇高石' },
    { type: MODIFY_TYPES.divine, label: '神圣石' },
    { type: MODIFY_TYPES.vaal, label: '瓦尔宝珠' },
    { type: MODIFY_TYPES.whetstone, label: '磨刀石' },
    { type: MODIFY_TYPES.armourScrap, label: '护甲片' },
    { type: MODIFY_TYPES.glassblowerBauble, label: '玻璃弹珠' },
  ];

  /**
   * CURRENCY_ID_MAP 保存通货字段到邮件接口通货 ID 的映射。
   * ID 必须和游戏邮件接口一致；如果这里错位，后端会按错误通货扣库存并提示通货不足。
   */
  const CURRENCY_ID_MAP = {
    jewellerOrb: '1',
    chromaticOrb: '2',
    orbOfFusing: '3',
    orbOfTransmutation: '4',
    orbOfChance: '5',
    orbOfAlchemy: '6',
    orbOfAugmentation: '7',
    orbOfAlteration: '8',
    exaltedOrb: '9',
    chaosOrb: '10',
    regalOrb: '11',
    orbOfScouring: '12',
    divineOrb: '13',
    vaalOrb: '14',
    mirrorOfKalandra: '15',
    whetstone: '16',
    armourersScrap: '17',
    orbOfAnnulment: '18',
    fracturingOrb: '19',
    glassblowersBauble: '34',
    instillingOrb: '35',
    enkindlingOrb: '36',
    blessedOrb: '37',
    gemcuttersPrism: '38',
    hinekoraLock: '39',
    wildAmethystEnergy: '20',
    activeTopazEnergy: '21',
    primalSapphireEnergy: '22',
    sacredWhiteEnergy: '23',
    fierceCatalyst: '24',
    imbuedCatalyst: '25',
    abrasiveCatalyst: '26',
    temperingCatalyst: '27',
    fertileCatalyst: '28',
    prismaticCatalyst: '29',
    intrinsicCatalyst: '30',
    noxiousCatalyst: '31',
    acceleratingCatalyst: '32',
    unstableCatalyst: '33',
  };

  /**
   * CURRENCY_NAME_MAP 保存通货字段的中文名称，用于邮件发送数量预览。
   */
  const CURRENCY_NAME_MAP = {
    jewellerOrb: '工匠石',
    chromaticOrb: '幻色石',
    orbOfFusing: '链接石',
    orbOfTransmutation: '蜕变石',
    orbOfChance: '机会石',
    orbOfAlchemy: '点金石',
    orbOfAugmentation: '增幅石',
    orbOfAlteration: '改造石',
    exaltedOrb: '崇高石',
    chaosOrb: '混沌石',
    regalOrb: '富豪石',
    orbOfScouring: '重铸石',
    divineOrb: '神圣石',
    vaalOrb: '瓦尔宝珠',
    mirrorOfKalandra: '卡兰德的魔镜',
    whetstone: '磨刀石',
    armourersScrap: '护甲片',
    orbOfAnnulment: '剥离石',
    fracturingOrb: '破溃宝珠',
    glassblowersBauble: '玻璃弹珠',
    instillingOrb: '灌顶石',
    enkindlingOrb: '启明石',
    blessedOrb: '祝福石',
    gemcuttersPrism: '宝石匠的棱镜',
    hinekoraLock: '辛格拉的发辫',
    wildAmethystEnergy: '狂野紫晶命能',
    activeTopazEnergy: '活性黄晶命能',
    primalSapphireEnergy: '原始蓝晶命能',
    sacredWhiteEnergy: '神圣白晶命能',
    fierceCatalyst: '猛烈催化剂',
    imbuedCatalyst: '灌注催化剂',
    abrasiveCatalyst: '研磨催化剂',
    temperingCatalyst: '回火催化剂',
    fertileCatalyst: '丰沃催化剂',
    prismaticCatalyst: '棱光催化剂',
    intrinsicCatalyst: '内在催化剂',
    noxiousCatalyst: '有害催化剂',
    acceleratingCatalyst: '加速催化剂',
    unstableCatalyst: '不稳定催化剂',
  };

  /**
   * state 保存脚本运行中的可变状态，所有字段都集中在这里，避免散落的 let 变量互相影响。
   */

  /**
   * AFFIX_EQUIPMENT_DATA comes from the original crafting plugin affix picker.
   * Shape: equipment type -> affix position -> affix name and maximum selectable tier.
   */
  const AFFIX_EQUIPMENT_DATA = {
          "爪": {
              "前缀": [
                  { "name": "最大魔力(单手)", "maxLevel": 12 },
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(单手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(单手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(单手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(单手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(单手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(单手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "中毒伤害和中毒几率", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(单手和项链)", "maxLevel": 5 }
              ]
          },
          "匕首": {
              "前缀": [
                  { "name": "最大魔力(单手)", "maxLevel": 12 },
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(单手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(单手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(单手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(单手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(单手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(单手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "元素&混沌技能石等级", "maxLevel": 2 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "中毒伤害和中毒几率", "maxLevel": 3 },
                  { "name": "持续伤害加成(单手)", "maxLevel": 5 }
              ]
          },
          "符文匕首": {
              "前缀": [
                  { "name": "最大魔力(单手)", "maxLevel": 12 },
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(单手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(单手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(单手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(单手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(单手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(单手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 1 },
                  { "name": "所有法术主动技能石等级(单手)", "maxLevel": 1 },
                  { "name": "法术主动技能石等级(单手)", "maxLevel": 1},
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 3 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "法术附加伤害(单手)", "maxLevel": 27}
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "施法速度加快", "maxLevel": 7 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "中毒伤害和中毒几率", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(单手和项链)", "maxLevel": 5 },
                  { "name": "持续伤害加成(单手)", "maxLevel": 5 }
              ]
          },
          "单手剑": {
              "前缀": [
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(单手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(单手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(单手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(单手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(单手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(单手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "中毒伤害和中毒几率", "maxLevel": 3 },
                  { "name": "流血伤害和流血几率", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(单手和项链)", "maxLevel": 5 }
              ]
          },
          "细剑": {
              "前缀": [
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(单手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(单手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(单手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(单手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(单手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(单手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "中毒伤害和中毒几率", "maxLevel": 3 },
                  { "name": "流血伤害和流血几率", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(单手和项链)", "maxLevel": 5 }
              ]
          },
          "单手斧": {
              "前缀": [
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(单手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(单手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(单手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(单手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(单手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(单手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "流血伤害和流血几率", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(单手和项链)", "maxLevel": 5 }
              ]
          },
          "单手锤": {
              "前缀": [
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(单手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(单手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(单手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(单手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(单手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(单手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "中毒伤害和中毒几率", "maxLevel": 3 },
                  { "name": "流血伤害和流血几率", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(单手和项链)", "maxLevel": 5 }
              ]
          },
          "弓": {
              "前缀": [
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(双手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(双手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(双手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(双手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(双手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(双手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "弓技能石等级", "maxLevel": 2 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "额外箭矢", "maxLevel": 2 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "中毒伤害和中毒几率", "maxLevel": 3 },
                  { "name": "流血伤害和流血几率", "maxLevel": 3 },
                  { "name": "投射物速度加快", "maxLevel": 6 },
                  { "name": "所有持续伤害加成(双手)", "maxLevel": 5 }
              ]
          },
          "双手剑": {
              "前缀": [
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(双手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(双手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(双手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(双手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(双手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(双手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 5 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "中毒伤害和中毒几率", "maxLevel": 3 },
                  { "name": "流血伤害和流血几率", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(双手)", "maxLevel": 5 }
              ]
          },
          "双手斧": {
              "前缀": [
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(双手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(双手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(双手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(双手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(双手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(双手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 5 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "流血伤害和流血几率", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(双手)", "maxLevel": 5 }
              ]
          },
          "双手锤": {
              "前缀": [
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(双手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(双手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(双手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(双手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(双手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(双手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 5 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "流血伤害和流血几率", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(双手)", "maxLevel": 5 }
              ]
          },
          "长杖": {
              "前缀": [
                  { "name": "最大魔力(双手)", "maxLevel": 12 },
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(双手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(双手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(双手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(双手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(双手)", "maxLevel": 1 },
                  { "name": "法术伤害提高(双手)", "maxLevel": 8},
                  { "name": "法术伤害与魔力(双手)", "maxLevel": 7 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 3 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(双手)", "maxLevel": 6 },
                  { "name": "所有法术主动技能石等级(双手)", "maxLevel": 1 },
                  { "name": "法术主动技能石等级(双手)", "maxLevel": 2},
                  { "name": "近战技能石等级", "maxLevel": 2},
                  { "name": "法术附加伤害(双手)", "maxLevel": 27}
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "施法速度加快(长杖)", "maxLevel": 7 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "魔力再生率提高", "maxLevel": 6 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "法术暴击率提高", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "火焰伤害", "maxLevel": 6 },
                  { "name": "冰霜伤害", "maxLevel": 6 },
                  { "name": "闪电伤害", "maxLevel": 6 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 5 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3 },
                  { "name": "点燃概率(双手)", "maxLevel": 3 },
                  { "name": "冻结概率(双手)", "maxLevel": 3 },
                  { "name": "感电概率(双手)", "maxLevel": 3 },
                  { "name": "燃烧伤害提高(双手)", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(双手)", "maxLevel": 5 },
                  { "name": "持续伤害加成(双手)", "maxLevel": 5}
              ]
          },
          "战杖": {
              "前缀": [
                  { "name": "最大魔力", "maxLevel": 12 },
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(双手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(双手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(双手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(双手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(双手)", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 3 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(双手)", "maxLevel": 6 },
                  { "name": "所有技能石等级", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "元素&混沌技能石等级", "maxLevel": 2}
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "魔力再生率提高", "maxLevel": 6 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "法术暴击率提高", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "火焰伤害", "maxLevel": 6 },
                  { "name": "冰霜伤害", "maxLevel": 6 },
                  { "name": "闪电伤害", "maxLevel": 6 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 5 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3 },
                  { "name": "点燃概率(双手)", "maxLevel": 3 },
                  { "name": "冻结概率(双手)", "maxLevel": 3 },
                  { "name": "感电概率(双手)", "maxLevel": 3 },
                  { "name": "燃烧伤害提高(双手)", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(双手)", "maxLevel": 5 },
                  { "name": "持续伤害加成(双手)", "maxLevel": 5}
              ]
          },
          "短杖": {
              "前缀": [
                  { "name": "最大魔力(单手)", "maxLevel": 12 },
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(单手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(单手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(单手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(单手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(单手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(单手)", "maxLevel": 6 },
                  { "name": "法术伤害提高(单手)", "maxLevel": 8},
                  { "name": "法术伤害与魔力(单手)", "maxLevel": 7 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 3 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高", "maxLevel": 6 },
                  { "name": "所有法术主动技能石等级(单手)", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "法术主动技能石等级(单手)", "maxLevel": 1},
                  { "name": "法术附加伤害(单手)", "maxLevel": 27}
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "施法速度加快", "maxLevel": 7 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "魔力再生率提高", "maxLevel": 6 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "法术暴击率提高", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "火焰伤害", "maxLevel": 6 },
                  { "name": "冰霜伤害", "maxLevel": 6 },
                  { "name": "闪电伤害", "maxLevel": 6 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3 },
                  { "name": "点燃概率(单手)", "maxLevel": 3 },
                  { "name": "冻结概率(单手)", "maxLevel": 3 },
                  { "name": "感电概率(单手)", "maxLevel": 3 },
                  { "name": "燃烧伤害提高(单手)", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(单手和项链)", "maxLevel": 5 },
                  { "name": "持续伤害加成(单手)", "maxLevel": 5}
              ]
          },
          "法杖": {
              "前缀": [
                  { "name": "最大魔力(单手)", "maxLevel": 12 },
                  { "name": "物理伤害提高和命中值", "maxLevel": 8 },
                  { "name": "物理伤害提高", "maxLevel": 8 },
                  { "name": "基础物理伤害(单手)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(单手)", "maxLevel": 10 },
                  { "name": "基础冰霜伤害(单手)", "maxLevel": 10 },
                  { "name": "基础闪电伤害(单手)", "maxLevel": 10 },
                  { "name": "基础混沌伤害(单手)", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(单手)", "maxLevel": 6 },
                  { "name": "法术伤害提高(单手)", "maxLevel": 8},
                  { "name": "法术伤害与魔力(单手)", "maxLevel": 7 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 3 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高", "maxLevel": 6 },
                  { "name": "所有法术主动技能石等级(单手)", "maxLevel": 1 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "法术主动技能石等级(单手)", "maxLevel": 1},
                  { "name": "法术附加伤害(单手)", "maxLevel": 27}
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "施法速度加快", "maxLevel": 7 },
                  { "name": "攻击速度加快", "maxLevel": 8 },
                  { "name": "魔力再生率提高", "maxLevel": 6 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "法术暴击率提高", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "火焰伤害", "maxLevel": 6 },
                  { "name": "冰霜伤害", "maxLevel": 6 },
                  { "name": "闪电伤害", "maxLevel": 6 },
                  { "name": "武器攻击暴击率", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "命中值(武器)", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3 },
                  { "name": "点燃概率(单手)", "maxLevel": 3 },
                  { "name": "冻结概率(单手)", "maxLevel": 3 },
                  { "name": "感电概率(单手)", "maxLevel": 3 },
                  { "name": "燃烧伤害提高(单手)", "maxLevel": 3 },
                  { "name": "所有持续伤害加成(单手和项链)", "maxLevel": 5 },
                  { "name": "持续伤害加成(单手)", "maxLevel": 5},
                  { "name": "投射物速度加快", "maxLevel": 5 }
              ]
          },

          "箭袋": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 10 },
                  { "name": "基础物理伤害(箭袋)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(箭袋)", "maxLevel": 9 },
                  { "name": "基础冰霜伤害(箭袋)", "maxLevel": 9 },
                  { "name": "基础闪电伤害(箭袋)", "maxLevel": 9 },
                  { "name": "基础混沌伤害(箭袋)", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "弓类技能伤害提高", "maxLevel": 6 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 10 },
                  { "name": "攻击速度加快", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "弓类攻击暴击率提高", "maxLevel": 8 },
                  { "name": "弓类攻击暴击伤害加成", "maxLevel": 6 },
                  { "name": "投射物速度加快", "maxLevel": 5 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "额外箭矢", "maxLevel": 1 },
                  { "name": "攻击技能的持续伤害加成", "maxLevel": 5 }
              ]
          },

          "项链": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "最大魔力(非武器)", "maxLevel": 13 },
                  { "name": "最大能量护盾", "maxLevel": 11 },
                  { "name": "基础物理伤害(项链)", "maxLevel": 9 },
                  { "name": "基础火焰伤害(项链)", "maxLevel": 9 },
                  { "name": "基础冰霜伤害(项链)", "maxLevel": 9 },
                  { "name": "基础闪电伤害(项链)", "maxLevel": 9 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 3 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 2 },
                  { "name": "护甲提高(饰品)", "maxLevel": 7 },
                  { "name": "闪避值提高(饰品)", "maxLevel": 7 },
                  { "name": "能量护盾上限提高(饰品)", "maxLevel": 7 },
                  { "name": "法术伤害提高(饰品)", "maxLevel": 5 },
                  { "name": "攻击技能的元素伤害提高(非武器)", "maxLevel": 6 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 4 },
                  { "name": "所有主动技能石等级", "maxLevel": 1 },
                  { "name": "主动技能石等级", "maxLevel": 1 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "全属性", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 5 },
                  { "name": "施法速度加快", "maxLevel": 4 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "魔力再生率提高", "maxLevel": 6 },
                  { "name": "全域暴击率提高", "maxLevel": 6 },
                  { "name": "全域暴击伤害加成", "maxLevel": 6 },
                  { "name": "所有元素抗性", "maxLevel": 6 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 4 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "火焰伤害", "maxLevel": 5 },
                  { "name": "冰霜伤害", "maxLevel": 5 },
                  { "name": "闪电伤害", "maxLevel": 5 },
                  { "name": "所有持续伤害加成(单手和项链)", "maxLevel": 5 }
              ]
          },
          "戒指": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 8 },
                  { "name": "最大魔力(非武器)", "maxLevel": 13 },
                  { "name": "最大能量护盾", "maxLevel": 11 },
                  { "name": "基础物理伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础火焰伤害(戒指和手套)", "maxLevel": 9 },
                  { "name": "基础冰霜伤害(戒指和手套)", "maxLevel": 9 },
                  { "name": "基础闪电伤害(戒指和手套)", "maxLevel": 9 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "攻击技能的元素伤害提高(非武器)", "maxLevel": 5 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 4 },
                  { "name": "闪避值", "maxLevel": 7 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "全属性", "maxLevel": 4 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 5 },
                  { "name": "施法速度加快", "maxLevel": 3 },
                  { "name": "攻击速度加快", "maxLevel": 1 },
                  { "name": "生命每秒再生", "maxLevel": 7 },
                  { "name": "魔力再生率提高", "maxLevel": 6 },
                  { "name": "所有元素抗性", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 1 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "火焰伤害", "maxLevel": 4 },
                  { "name": "冰霜伤害", "maxLevel": 4 },
                  { "name": "闪电伤害", "maxLevel": 4 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3},
                  { "name": "受伤吸纳为生命", "maxLevel": 4}
              ]
          },
          "腰带": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 10 },
                  { "name": "最大魔力(非武器)", "maxLevel": 11 },
                  { "name": "最大能量护盾", "maxLevel": 12 },
                  { "name": "护甲", "maxLevel": 8 },
                  { "name": "攻击技能的元素伤害提高(非武器)", "maxLevel": 6 },
                  { "name": "反射物理伤害", "maxLevel": 2 },
                  { "name": "药剂效果提高", "maxLevel": 3 },
                  { "name": "药剂生命/魔力回复", "maxLevel": 6 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 10 },
                  { "name": "生命每秒再生", "maxLevel": 9 },
                  { "name": "敌人晕眩门槛降低", "maxLevel": 5 },
                  { "name": "敌人被晕眩时间延长", "maxLevel": 5 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "药剂充能获取提高/使用降低", "maxLevel": 6 },
                  { "name": "药剂效果持续时间延长", "maxLevel": 5 }
              ]
          },

          "手套(str)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "基础物理伤害(戒指和手套)", "maxLevel": 4 },
                  { "name": "基础火焰伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础冰霜伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础闪电伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的护甲提高", "maxLevel": 7 },
                  { "name": "该装备的护甲提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲(防具)", "maxLevel": 7 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 10 },
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "攻击速度加快", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 1 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "生命再生率提高", "maxLevel": 5 }
              ]
          },
          "手套(dex)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "基础物理伤害(戒指和手套)", "maxLevel": 4 },
                  { "name": "基础火焰伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础冰霜伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础闪电伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的闪避值提高", "maxLevel": 7 },
                  { "name": "该装备的闪避值提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "闪避值(防具)", "maxLevel": 7 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 10 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "攻击速度加快", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 1 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "法术伤害压制率", "maxLevel": 5 }
              ]
          },
          "手套(int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "最大能量护盾(防具)", "maxLevel": 7 },
                  { "name": "基础物理伤害(戒指和手套)", "maxLevel": 4 },
                  { "name": "基础火焰伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础冰霜伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础闪电伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的能量护盾提高", "maxLevel": 7 },
                  { "name": "该装备的能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 2 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 10 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "攻击速度加快", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 1 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "能量护盾充能率提高", "maxLevel": 5 }
              ]
          },
          "手套(str_dex)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "基础物理伤害(戒指和手套)", "maxLevel": 4 },
                  { "name": "基础火焰伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础冰霜伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础闪电伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的护甲,闪避提高", "maxLevel": 7 },
                  { "name": "该装备的护甲,闪避提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲和闪避值(防具)", "maxLevel": 4 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 2 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 10 },
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "攻击速度加快", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 1 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "生命再生率提高", "maxLevel": 5 },
                  { "name": "法术伤害压制率", "maxLevel": 5 }
              ]
          },
          "手套(str_int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "基础物理伤害(戒指和手套)", "maxLevel": 4 },
                  { "name": "基础火焰伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础冰霜伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础闪电伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的护甲,能量护盾提高", "maxLevel": 7 },
                  { "name": "该装备的护甲,能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲和能量护盾(防具)", "maxLevel": 4 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 2 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 2 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 10 },
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "攻击速度加快", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 1 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "生命再生率提高", "maxLevel": 5 },
                  { "name": "能量护盾充能率提高", "maxLevel": 5 }
              ]
          },
          "手套(dex_int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "基础物理伤害(戒指和手套)", "maxLevel": 4 },
                  { "name": "基础火焰伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础冰霜伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "基础闪电伤害(戒指和手套)", "maxLevel": 6 },
                  { "name": "物理攻击伤害转化为生命偷取", "maxLevel": 1 },
                  { "name": "物理攻击伤害转化为魔力偷取", "maxLevel": 1 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的闪避,能量护盾提高", "maxLevel": 7 },
                  { "name": "该装备的闪避,能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "闪避值和能量护盾(防具)", "maxLevel": 4 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 2 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 2 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 10 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "攻击速度加快", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "击中回血", "maxLevel": 1 },
                  { "name": "击败回血", "maxLevel": 3 },
                  { "name": "击败回蓝", "maxLevel": 3 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "法术伤害压制率", "maxLevel": 5 },
                  { "name": "能量护盾充能率提高", "maxLevel": 5 }
              ]
          },

          "鞋子(str)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的护甲提高", "maxLevel": 7 },
                  { "name": "该装备的护甲提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲(防具)", "maxLevel": 7 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 2 },
                  { "name": "移动速度", "maxLevel": 7 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "生命再生率提高", "maxLevel": 5 }
              ]
          },
          "鞋子(dex)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的闪避值提高", "maxLevel": 7 },
                  { "name": "该装备的闪避值提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "闪避值(防具)", "maxLevel": 7 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 2 },
                  { "name": "移动速度", "maxLevel": 7 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "法术伤害压制率", "maxLevel": 5 }
              ]
          },
          "鞋子(int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的能量护盾提高", "maxLevel": 7 },
                  { "name": "该装备的能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "最大能量护盾(防具)", "maxLevel": 7 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 2 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 2 },
                  { "name": "移动速度", "maxLevel": 7 }
              ],
              "后缀": [
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "能量护盾充能率提高", "maxLevel": 5 }
              ]
          },
          "鞋子(str_dex)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的护甲,闪避提高", "maxLevel": 7 },
                  { "name": "该装备的护甲,闪避提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲和闪避值(防具)", "maxLevel": 4 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 2 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 2 },
                  { "name": "移动速度", "maxLevel": 7 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "生命再生率提高", "maxLevel": 5 },
                  { "name": "法术伤害压制率", "maxLevel": 5 }
              ]
          },
          "鞋子(str_int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的护甲,能量护盾提高", "maxLevel": 7 },
                  { "name": "该装备的护甲,能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲和能量护盾(防具)", "maxLevel": 4 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 2 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 2 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 2 },
                  { "name": "移动速度", "maxLevel": 7 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "生命再生率提高", "maxLevel": 5 },
                  { "name": "能量护盾充能率提高", "maxLevel": 5 }
              ]
          },
          "鞋子(dex_int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 9 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 2 },
                  { "name": "该装备的闪避,能量护盾提高", "maxLevel": 7 },
                  { "name": "该装备的闪避,能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "闪避值和能量护盾(防具)", "maxLevel": 4 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 2 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 2 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 2 },
                  { "name": "移动速度", "maxLevel": 7 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 8 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "法术伤害压制率", "maxLevel": 5 },
                  { "name": "能量护盾充能率提高", "maxLevel": 5 }
              ]
          },

          "头部(str)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 10 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 3 },
                  { "name": "该装备的护甲提高", "maxLevel": 7 },
                  { "name": "该装备的护甲提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲(防具)", "maxLevel": 8 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 3 },
                  { "name": "召唤主动技能石", "maxLevel": 2 },
                  { "name": "反射物理伤害", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 10 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 9 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3 },
                  { "name": "生命再生率提高", "maxLevel": 5 }
              ]
          },
          "头部(dex)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 10 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 3 },
                  { "name": "该装备的闪避值提高", "maxLevel": 7 },
                  { "name": "该装备的闪避值提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "闪避值(防具)", "maxLevel": 8 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 3 },
                  { "name": "召唤主动技能石", "maxLevel": 2 },
                  { "name": "反射物理伤害", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 10 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 9 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3 },
                  { "name": "法术伤害压制率", "maxLevel": 5 }
              ]
          },
          "头部(int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 10 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 3 },
                  { "name": "该装备的能量护盾提高", "maxLevel": 7 },
                  { "name": "该装备的能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "最大能量护盾(防具)", "maxLevel": 8 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 3 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 3 },
                  { "name": "召唤主动技能石", "maxLevel": 2 },
                  { "name": "反射物理伤害", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "智慧", "maxLevel": 10 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 9 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3 },
                  { "name": "能量护盾充能率提高", "maxLevel": 5 }
              ]
          },
          "头部(str_dex)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 10 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 3 },
                  { "name": "该装备的护甲,闪避提高", "maxLevel": 7 },
                  { "name": "该装备的护甲,闪避提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲和闪避值(防具)", "maxLevel": 5 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 3 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 3 },
                  { "name": "召唤主动技能石", "maxLevel": 2 },
                  { "name": "反射物理伤害", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 10 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 9 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3 },
                  { "name": "生命再生率提高", "maxLevel": 5 },
                  { "name": "法术伤害压制率", "maxLevel": 5 }
              ]
          },
          "头部(str_int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 10 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 3 },
                  { "name": "该装备的护甲,能量护盾提高", "maxLevel": 7 },
                  { "name": "该装备的护甲,能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲和能量护盾(防具)", "maxLevel": 5 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 3 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 3 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 3 },
                  { "name": "召唤主动技能石", "maxLevel": 2 },
                  { "name": "反射物理伤害", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 10 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 9 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3 },
                  { "name": "生命再生率提高", "maxLevel": 5 },
                  { "name": "能量护盾充能率提高", "maxLevel": 5 }
              ]
          },
          "头部(dex_int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 10 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "物品稀有度提高(前缀)", "maxLevel": 3 },
                  { "name": "该装备的闪避,能量护盾提高", "maxLevel": 7 },
                  { "name": "该装备的闪避,能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "闪避值和能量护盾(防具)", "maxLevel": 5 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 3 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 3 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 3 },
                  { "name": "召唤主动技能石", "maxLevel": 2 },
                  { "name": "反射物理伤害", "maxLevel": 2 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 10 },
                  { "name": "物品稀有度提高(后缀)", "maxLevel": 2 },
                  { "name": "生命每秒再生", "maxLevel": 9 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "命中值(非武器)", "maxLevel": 6 },
                  { "name": "命中值和照亮范围扩大", "maxLevel": 3 },
                  { "name": "法术伤害压制率", "maxLevel": 5 },
                  { "name": "能量护盾充能率提高", "maxLevel": 5 }
              ]
          },

          "盾牌(str)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 11 },
                  { "name": "该装备的护甲提高", "maxLevel": 8 },
                  { "name": "该装备的护甲提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲(防具)", "maxLevel": 10 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 3 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "生命每秒再生", "maxLevel": 10 },
                  { "name": "所有元素抗性", "maxLevel": 6 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "全部抗性上限", "maxLevel": 2 },
                  { "name": "火焰抗性上限", "maxLevel": 3 },
                  { "name": "冰霜抗性上限", "maxLevel": 3 },
                  { "name": "闪电抗性上限", "maxLevel": 3 },
                  { "name": "混沌抗性上限", "maxLevel": 3 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "攻击格挡率", "maxLevel": 7 },
                  { "name": "格挡回复", "maxLevel": 6 },
                  { "name": "避免元素异常", "maxLevel": 4 },
                  { "name": "受到暴击伤害减少", "maxLevel": 4 },
                  { "name": "额外物理伤害减免", "maxLevel": 5 }
              ]
          },
          "盾牌(dex)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 11 },
                  { "name": "该装备的闪避值提高", "maxLevel": 8 },
                  { "name": "该装备的闪避值提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "闪避值(防具)", "maxLevel": 10 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 3 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 5 },
                  { "name": "生命每秒再生", "maxLevel": 10 },
                  { "name": "所有元素抗性", "maxLevel": 6 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "全部抗性上限", "maxLevel": 2 },
                  { "name": "火焰抗性上限", "maxLevel": 3 },
                  { "name": "冰霜抗性上限", "maxLevel": 3 },
                  { "name": "闪电抗性上限", "maxLevel": 3 },
                  { "name": "混沌抗性上限", "maxLevel": 3 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "攻击格挡率", "maxLevel": 7 },
                  { "name": "法术伤害压制率", "maxLevel": 5 },
                  { "name": "避免元素异常", "maxLevel": 4 }
              ]
          },
          "盾牌(int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 11 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "该装备的能量护盾提高", "maxLevel": 8 },
                  { "name": "该装备的能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "最大能量护盾(防具)", "maxLevel": 10 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 3 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 3 },
                  { "name": "法术伤害提高(单手)", "maxLevel": 8},
                  { "name": "所有法术主动技能石等级(单手)", "maxLevel": 1 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "生命每秒再生", "maxLevel": 10 },
                  { "name": "魔力再生率提高", "maxLevel": 6 },
                  { "name": "所有元素抗性", "maxLevel": 6 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "全部抗性上限", "maxLevel": 2 },
                  { "name": "火焰抗性上限", "maxLevel": 3 },
                  { "name": "冰霜抗性上限", "maxLevel": 3 },
                  { "name": "闪电抗性上限", "maxLevel": 3 },
                  { "name": "混沌抗性上限", "maxLevel": 3 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "攻击格挡率", "maxLevel": 7 },
                  { "name": "法术格挡率", "maxLevel": 4 },
                  { "name": "避免元素异常", "maxLevel": 4 },
                  { "name": "法术暴击率提高", "maxLevel": 6 },
                  { "name": "能量护盾充能时间提前", "maxLevel": 5 }
              ]
          },
          "盾牌(str_dex)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 11 },
                  { "name": "该装备的护甲,闪避提高", "maxLevel": 8 },
                  { "name": "该装备的护甲,闪避提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲和闪避值(防具)", "maxLevel": 7 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 3 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 3 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "攻击速度加快", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 5 },
                  { "name": "生命每秒再生", "maxLevel": 10 },
                  { "name": "所有元素抗性", "maxLevel": 6 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "全部抗性上限", "maxLevel": 2 },
                  { "name": "火焰抗性上限", "maxLevel": 3 },
                  { "name": "冰霜抗性上限", "maxLevel": 3 },
                  { "name": "闪电抗性上限", "maxLevel": 3 },
                  { "name": "混沌抗性上限", "maxLevel": 3 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "攻击格挡率", "maxLevel": 7 },
                  { "name": "格挡回复", "maxLevel": 6 },
                  { "name": "避免元素异常", "maxLevel": 4 },
                  { "name": "受到暴击伤害减少", "maxLevel": 4 },
                  { "name": "法术伤害压制率", "maxLevel": 5 },
                  { "name": "额外物理伤害减免", "maxLevel": 5 }
              ]
          },
          "盾牌(str_int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 11 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "该装备的护甲,能量护盾提高", "maxLevel": 8 },
                  { "name": "该装备的护甲,能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲和能量护盾(防具)", "maxLevel": 7 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 3 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 3 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 3 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "生命每秒再生", "maxLevel": 10 },
                  { "name": "魔力再生率提高", "maxLevel": 6 },
                  { "name": "法术暴击率提高", "maxLevel": 6 },
                  { "name": "所有元素抗性", "maxLevel": 6 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "全部抗性上限", "maxLevel": 2 },
                  { "name": "火焰抗性上限", "maxLevel": 3 },
                  { "name": "冰霜抗性上限", "maxLevel": 3 },
                  { "name": "闪电抗性上限", "maxLevel": 3 },
                  { "name": "混沌抗性上限", "maxLevel": 3 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "攻击格挡率", "maxLevel": 7 },
                  { "name": "法术格挡率", "maxLevel": 4 },
                  { "name": "格挡回复", "maxLevel": 6 },
                  { "name": "能量护盾充能时间提前", "maxLevel": 5 },
                  { "name": "避免元素异常", "maxLevel": 4 },
                  { "name": "受到暴击伤害减少", "maxLevel": 4 },
                  { "name": "额外物理伤害减免", "maxLevel": 5 }
              ]
          },
          "盾牌(dex_int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 11 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "该装备的闪避,能量护盾提高", "maxLevel": 8 },
                  { "name": "该装备的闪避,能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "闪避值和能量护盾(防具)", "maxLevel": 7 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 3 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 3 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 3 },
                  { "name": "近战技能石等级", "maxLevel": 2 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "生命每秒再生", "maxLevel": 10 },
                  { "name": "攻击速度加快", "maxLevel": 4 },
                  { "name": "命中值(非武器)", "maxLevel": 5 },
                  { "name": "魔力再生率提高", "maxLevel": 6 },
                  { "name": "所有元素抗性", "maxLevel": 6 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "全部抗性上限", "maxLevel": 2 },
                  { "name": "火焰抗性上限", "maxLevel": 3 },
                  { "name": "冰霜抗性上限", "maxLevel": 3 },
                  { "name": "闪电抗性上限", "maxLevel": 3 },
                  { "name": "混沌抗性上限", "maxLevel": 3 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "攻击格挡率", "maxLevel": 7 },
                  { "name": "避免元素异常", "maxLevel": 4 },
                  { "name": "法术格挡率", "maxLevel": 4 },
                  { "name": "法术暴击率提高", "maxLevel": 6 },
                  { "name": "能量护盾充能时间提前", "maxLevel": 5 },
                  { "name": "法术伤害压制率", "maxLevel": 5 }
              ]
          },

          "胸甲(str)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 13 },
                  { "name": "该装备的护甲提高", "maxLevel": 8 },
                  { "name": "该装备的护甲提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲(防具)", "maxLevel": 11},
                  { "name": "护甲和最大生命(防具)", "maxLevel": 4 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "生命每秒再生", "maxLevel": 11 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "额外物理伤害减免", "maxLevel": 5 }
              ]
          },
          "胸甲(dex))": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 13 },
                  { "name": "该装备的闪避值提高", "maxLevel": 8 },
                  { "name": "该装备的闪避值提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "闪避值(防具)", "maxLevel": 11 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 4 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "生命每秒再生", "maxLevel": 11 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "法术伤害压制率", "maxLevel": 5 }
              ]
          },
          "胸甲(int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 13 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "该装备的能量护盾提高", "maxLevel": 8 },
                  { "name": "该装备的能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "最大能量护盾(防具)", "maxLevel": 11 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 4 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 4 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "生命每秒再生", "maxLevel": 11 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "能量护盾充能时间提前", "maxLevel": 5 }
              ]
          },
          "胸甲(str_dex)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 13 },
                  { "name": "该装备的护甲,闪避提高", "maxLevel": 8 },
                  { "name": "该装备的护甲,闪避提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲和闪避值(防具)", "maxLevel": 8 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 4 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 4 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "生命每秒再生", "maxLevel": 11 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "法术伤害压制率", "maxLevel": 5 },
                  { "name": "额外物理伤害减免", "maxLevel": 5 }
              ]
          },
          "胸甲(str_int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 13 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "该装备的护甲,能量护盾提高", "maxLevel": 8 },
                  { "name": "该装备的护甲,能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲和能量护盾(防具)", "maxLevel": 8 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 4 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 4 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 4 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "生命每秒再生", "maxLevel": 11 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "额外物理伤害减免", "maxLevel": 5 },
                  { "name": "能量护盾充能时间提前", "maxLevel": 5 }
              ]
          },
          "胸甲(dex_int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 13 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "该装备的闪避,能量护盾提高", "maxLevel": 8 },
                  { "name": "该装备的闪避,能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "闪避值和能量护盾(防具)", "maxLevel": 8 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 4 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 4 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 4 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "生命每秒再生", "maxLevel": 11 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "法术伤害压制率", "maxLevel": 5 },
                  { "name": "能量护盾充能时间提前", "maxLevel": 5 }
              ]
          },
          "胸甲(str_dex_int)": {
              "前缀": [
                  { "name": "最大生命", "maxLevel": 13 },
                  { "name": "最大魔力(非武器)", "maxLevel": 12 },
                  { "name": "该装备的护甲,闪避,能量护盾提高", "maxLevel": 7 },
                  { "name": "该装备的护甲,闪避,能量护盾提高 晕眩回复和格挡回复提高", "maxLevel": 6 },
                  { "name": "护甲和闪避值(防具)", "maxLevel": 8 },
                  { "name": "护甲和能量护盾(防具)", "maxLevel": 8 },
                  { "name": "闪避值和能量护盾(防具)", "maxLevel": 8 },
                  { "name": "护甲和最大生命(防具)", "maxLevel": 4 },
                  { "name": "闪避值和最大生命(防具)", "maxLevel": 4 },
                  { "name": "能量护盾和最大生命(防具)", "maxLevel": 4 },
                  { "name": "能量护盾和最大魔力(防具)", "maxLevel": 4 },
                  { "name": "反射物理伤害", "maxLevel": 4 }
              ],
              "后缀": [
                  { "name": "力量", "maxLevel": 9 },
                  { "name": "敏捷", "maxLevel": 9 },
                  { "name": "智慧", "maxLevel": 9 },
                  { "name": "生命每秒再生", "maxLevel": 11 },
                  { "name": "火焰抗性", "maxLevel": 8 },
                  { "name": "冰霜抗性", "maxLevel": 8 },
                  { "name": "闪电抗性", "maxLevel": 8 },
                  { "name": "混沌抗性", "maxLevel": 6 },
                  { "name": "晕眩和格挡回复提高", "maxLevel": 6 },
                  { "name": "属性需求降低", "maxLevel": 2 },
                  { "name": "额外物理伤害减免", "maxLevel": 5 },
                  { "name": "法术伤害压制率", "maxLevel": 5 },
                  { "name": "能量护盾充能时间提前", "maxLevel": 5 }
              ]
          }
      };

  /**
   * AFFIX_LEVEL_DATA comes from the original crafting plugin affix picker.
   * Shape: affix type -> concrete tier names, display values, and tier levels.
   */
  const AFFIX_LEVEL_DATA = {
          "物品稀有度提高(前缀)": [
              { "name": "喜鹊的", "value": "(8–12)% 物品稀有度提高", "level": 1, "id": 1 },
              { "name": "海盗的", "value": "(13–18)% 物品稀有度提高", "level": 2, "id": 2 },
              { "name": "龙的", "value": "(19–24)% 物品稀有度提高", "level": 3, "id": 3 },
              { "name": "普兰德斯的", "value": "(25–28)% 物品稀有度提高", "level": 4, "id": 4 }
          ],
          "物品稀有度提高(后缀)": [
              { "name": "掠夺之", "value": "(6–10)% 物品稀有度提高", "level": 1, "id": 5 },
              { "name": "扫荡之", "value": "(11–14)% 物品稀有度提高", "level": 2, "id": 6 },
              { "name": "考古之", "value": "(15–20)% 物品稀有度提高", "level": 3, "id": 7 },
              { "name": "挖掘之", "value": "(21–26)% 物品稀有度提高", "level": 4, "id": 8 }
          ],

          "移动速度": [
              { "name": "跑步的", "value": "移动速度加快 10%", "level": 1, "id": 9 },
              { "name": "短跑的", "value": "移动速度加快 15%", "level": 2, "id": 10 },
              { "name": "种马的", "value": "移动速度加快 20%", "level": 3, "id": 11 },
              { "name": "瞪羚的", "value": "移动速度加快 25%", "level": 4, "id": 12 },
              { "name": "猎豹的", "value": "移动速度加快 30%", "level": 5, "id": 13 },
              { "name": "地狱的", "value": "移动速度加快 35%", "level": 6, "id": 14 }
          ],
          "反射物理伤害": [
              { "name": "多刺的", "value": "反射 (1–4) 物理伤害给近战攻击者", "level": 1, "id": 15 },
              { "name": "带刺的", "value": "反射 (5–10) 物理伤害给近战攻击者", "level": 10, "id": 16 },
              { "name": "尖刺的", "value": "反射 (11–24) 物理伤害给近战攻击者", "level": 20, "id": 17 },
              { "name": "锯齿的", "value": "反射 (25–50) 物理伤害给近战攻击者", "level": 35, "id": 18 }
          ],

          "法术伤害压制率": [
              { "name": "辩驳之", "value": "法术伤害压制率 +(5–6)%", "level": 1, "id": 19 },
              { "name": "响鼻之", "value": "法术伤害压制率 +(7–8)%", "level": 2, "id": 20 },
              { "name": "撤销之", "value": "法术伤害压制率 +(9–10)%", "level": 3, "id": 21 },
              { "name": "放弃之", "value": "法术伤害压制率 +(11–12)%", "level": 4, "id": 22 },
              { "name": "保命之", "value": "法术伤害压制率 +(13–14)%", "level": 5, "id": 23 }
          ],
          "晕眩和格挡回复提高": [
              { "name": "厚皮之", "value": "(11–13)% 晕眩回复和格挡回复提高", "level": 1, "id": 24 },
              { "name": "石皮之", "value": "(14–16)% 晕眩回复和格挡回复提高", "level": 2, "id": 25 },
              { "name": "金属皮之", "value": "(17–19)% 晕眩回复和格挡回复提高", "level": 3, "id": 26 },
              { "name": "钢皮之", "value": "(20–22)% 晕眩回复和格挡回复提高", "level": 4, "id": 27 },
              { "name": "金刚皮之", "value": "(23–25)% 晕眩回复和格挡回复提高", "level": 5, "id": 28 },
              { "name": "玉皮之", "value": "(26–28)% 晕眩回复和格挡回复提高", "level": 6, "id": 29 }
          ],
          "额外物理伤害减免": [
              { "name": "巡夜人之", "value": "4% 额外物理伤害减免", "level": 1, "id": 30 },
              { "name": "哨兵之", "value": "5% 额外物理伤害减免", "level": 2, "id": 31 },
              { "name": "护卫之", "value": "6% 额外物理伤害减免", "level": 3, "id": 32 },
              { "name": "保卫者之", "value": "7% 额外物理伤害减免", "level": 4, "id": 33 },
              { "name": "保护者之", "value": "8% 额外物理伤害减免", "level": 5, "id": 34 }
          ],
          "受伤吸纳为生命": [
              { "name": "包扎之", "value": "将所受伤害的(4–6)%吸纳为生命", "level": 1, "id": 35 },
              { "name": "缝针之", "value": "将所受伤害的(7–9)%吸纳为生命", "level": 2, "id": 36 },
              { "name": "缝合之", "value": "将所受伤害的(10–12)%吸纳为生命", "level": 3, "id": 37 },
              { "name": "补肉之", "value": " 将所受伤害的(13–15)%吸纳为生命", "level": 4, "id": 38 }
          ],

          "攻击格挡率":[
              {"name": "拦截之", "value": "攻击格挡率提高 (1–3)%", "level": 1, "id": 39 },
              {"name": "墙面之", "value": "攻击格挡率提高 (4–5)%", "level": 2, "id": 40 },
              {"name": "阻断之", "value": "攻击格挡率提高 (6–7)%", "level": 3, "id": 41 },
              {"name": "坚定之", "value": "攻击格挡率提高 (8–9)%", "level": 4, "id": 42 },
              {"name": "扶壁之", "value": "攻击格挡率提高 (10–11)%", "level": 5, "id": 43 },
              {"name": "哨兵之", "value": "攻击格挡率提高 (12–13)%", "level": 6, "id": 44 },
              {"name": "要塞之", "value": "攻击格挡率提高 (14–15)%", "level": 7, "id": 45 }
          ],
          "法术格挡率":[
              {"name": "障碍之", "value": "(4–6)% 法术伤害格挡几率", "level": 30, "id": 46 },
              {"name": "堡垒之", "value": "(7–9)% 法术伤害格挡几率", "level": 52, "id": 47 },
              {"name": "木栅之", "value": "(10–12)% 法术伤害格挡几率", "level": 71, "id": 48 },
              {"name": "壁垒之", "value": "(13–15)% 法术伤害格挡几率", "level": 84, "id": 49 }
          ],
          "格挡回复":[
              {"name": "修复之", "value": "生命在你格挡时 (5–15)", "level": 1, "id": 50 },
              {"name": "回潮之", "value": "生命在你格挡时 (16–25)", "level": 2, "id": 51 },
              {"name": "重续之", "value": "生命在你格挡时 (26–40)", "level": 3, "id": 52 },
              {"name": "重生之", "value": "生命在你格挡时 (41–60)", "level": 4, "id": 53 },
              {"name": "反弹之", "value": "生命在你格挡时 (61–85)", "level": 5, "id": 54 },
              {"name": "新生之", "value": "生命在你格挡时 (86–100)", "level": 6, "id": 55 }
          ],
          "避免元素异常":[
              {"name": "坚忍之", "value": "(16–20)% 几率避免元素异常状态", "level": 1, "id": 56 },
              {"name": "解决之", "value": "(21–25)% 几率避免元素异常状态", "level": 2, "id": 57 },
              {"name": "刚毅之", "value": "(26–30)% 几率避免元素异常状态", "level": 3, "id": 58 },
              {"name": "意志之", "value": "(31–35)% 几率避免元素异常状态", "level": 4, "id": 59 }
          ],
          "受到暴击伤害减少":[
              {"name": "晦暗之", "value": "(21–30)% 受到的暴击伤害降低", "level": 1, "id": 60 },
              {"name": "隔音之", "value": "(31–40)% 受到的暴击伤害降低", "level": 2, "id": 61 },
              {"name": "干涉之", "value": "(41–50)% 受到的暴击伤害降低", "level": 3, "id": 62 },
              {"name": "阻挠之", "value": "(51–60)% 受到的暴击伤害降低", "level": 4, "id": 63 }
          ],
          "火焰抗性上限": [
              {"name": "树火之", "value": "+1% 火焰抗性上限", "level": 1, "id": 64 },
              {"name": "熔火核心之", "value": "+2% 火焰抗性上限", "level": 2, "id": 65 },
              {"name": "太阳风暴之", "value": "+3% 火焰抗性上限", "level": 3, "id": 66 }
          ],
          "冰霜抗性上限": [
              {"name": "皮草之", "value": "+1% 冰霜抗性上限", "level": 1, "id": 67 },
              {"name": "苔原之", "value": "+2% 冰霜抗性上限", "level": 2, "id": 68 },
              {"name": "猛犸之", "value": "+3% 冰霜抗性上限", "level": 3, "id": 69 }
          ],
          "闪电抗性上限":[
              {"name": "抗阻之", "value": "+1% 闪电抗性上限", "level": 1, "id": 70 },
              {"name": "电证之", "value": "+2% 闪电抗性上限", "level": 2, "id": 71 },
              {"name": "电棒之", "value": "+3% 闪电抗性上限", "level": 3, "id": 72 }
          ],
          "混沌抗性上限":[
              {"name": "极宝之", "value": "+1% 混沌抗性上限", "level": 1, "id": 73 },
              {"name": "规整之", "value": "+2% 混沌抗性上限", "level": 2, "id": 74 },
              {"name": "和谐之", "value": "+3% 混沌抗性上限", "level": 3, "id": 75 }
          ],
          "全部抗性上限":[
              {"name": "永久之", "value": "+1% 全部抗性上限", "level": 75, "id": 76 },
              {"name": "不死之", "value": "+2% 全部抗性上限", "level": 81, "id": 77 }
          ],

          "法术伤害提高(单手)": [
              { "level": 1, "name": "学徒的", "value": "法术伤害提高 (10–19)%", "id": 78 },
              { "level": 2, "name": "娴熟的", "value": "法术伤害提高 (20–29)%", "id": 79 },
              { "level": 3, "name": "学者的", "value": "法术伤害提高 (30–39)%", "id": 80 },
              { "level": 4, "name": "教授的", "value": "法术伤害提高 (40–54)%", "id": 81 },
              { "level": 5, "name": "神秘学者的", "value": "法术伤害提高 (55–69)%", "id": 82 },
              { "level": 6, "name": "魔咒师的", "value": "法术伤害提高 (70–84)%", "id": 83 },
              { "level": 7, "name": "雕纹的", "value": "法术伤害提高 (85–99)%", "id": 84 },
              { "level": 8, "name": "锋芒的", "value": "法术伤害提高 (100–109)%", "id": 85 },
              { "level": 1, "name": "灼烧的", "value": "火焰伤害提高 (10–19)%", "id": 86 },
              { "level": 2, "name": "酷热的", "value": "火焰伤害提高 (20–29)%", "id": 87 },
              { "level": 3, "name": "酷暑的", "value": "火焰伤害提高 (30–39)%", "id": 88 },
              { "level": 4, "name": "炙烤的", "value": "火焰伤害提高 (40–54)%", "id": 89 },
              { "level": 5, "name": "火山的", "value": "火焰伤害提高 (55–69)%", "id": 90 },
              { "level": 6, "name": "熔岩的", "value": "火焰伤害提高 (70–84)%", "id": 91 },
              { "level": 7, "name": "火屑的", "value": "火焰伤害提高 (85–99)%", "id": 92 },
              { "level": 8, "name": "索伏的", "value": "火焰伤害提高 (100–109)%", "id": 93 },
              { "level": 1, "name": "苦涩的", "value": "冰霜伤害提高 (10–19)%", "id": 94 },
              { "level": 2, "name": "刻薄的", "value": "冰霜伤害提高 (20–29)%", "id": 95 },
              { "level": 3, "name": "高山的", "value": "冰霜伤害提高 (30–39)%", "id": 96 },
              { "level": 4, "name": "如雪的", "value": "冰霜伤害提高 (40–54)%", "id": 97 },
              { "level": 5, "name": "颂扬的", "value": "冰霜伤害提高 (55–69)%", "id": 98 },
              { "level": 6, "name": "结晶的", "value": "冰霜伤害提高 ((70–84)%", "id": 99 },
              { "level": 7, "name": "冰霜法师的", "value": "冰霜伤害提高 (85–99)%", "id": 100 },
              { "level": 8, "name": "托沃的", "value": "冰霜伤害提高 (100–109)%", "id": 101 },
              { "level": 1, "name": "充能的", "value": "闪电伤害提高 (10–19)%", "id": 102 },
              { "level": 2, "name": "嘶鸣的", "value": "闪电伤害提高 (20–29)%", "id": 103 },
              { "level": 3, "name": "离弦的", "value": "闪电伤害提高 (30–39)%", "id": 104 },
              { "level": 4, "name": "追逐的", "value": "闪电伤害提高 (40–54)%", "id": 105 },
              { "level": 5, "name": "显著的", "value": "闪电伤害提高 (55–69)%", "id": 106 },
              { "level": 6, "name": "重击的", "value": "闪电伤害提高 (70–84)%", "id": 107 },
              { "level": 7, "name": "电离的", "value": "闪电伤害提高 (85–99)%", "id": 108 },
              { "level": 8, "name": "艾许的", "value": "闪电伤害提高 (100–109)%", "id": 109 }
          ],
          "法术伤害提高(双手)": [
              { "level": 1, "name": "学徒的", "value": "法术伤害提高 (15–29)%", "id": 110 },
              { "level": 2, "name": "娴熟的", "value": "法术伤害提高 (30–44)%", "id": 111 },
              { "level": 3, "name": "学者的", "value": "法术伤害提高 (45–59)%", "id": 112 },
              { "level": 4, "name": "教授的", "value": "法术伤害提高 (60–84)%", "id": 113 },
              { "level": 5, "name": "神秘学者的", "value": "法术伤害提高 (85–104)%", "id": 114 },
              { "level": 6, "name": "魔咒师的", "value": "法术伤害提高 (105–124)%", "id": 115 },
              { "level": 7, "name": "雕纹的", "value": "法术伤害提高 (125–149)%", "id": 116 },
              { "level": 8, "name": "锋芒的", "value": "法术伤害提高 (150–164)%", "id": 117 },
              { "level": 1, "name": "灼烧的", "value": "火焰伤害提高 (15–29)%", "id": 118 },
              { "level": 2, "name": "酷热的", "value": "火焰伤害提高 (30–44)%", "id": 119 },
              { "level": 3, "name": "酷暑的", "value": "火焰伤害提高 (45–59)%", "id": 120 },
              { "level": 4, "name": "炙烤的", "value": "火焰伤害提高 (60–84)%", "id": 121 },
              { "level": 5, "name": "火山的", "value": "火焰伤害提高 (85–104)%", "id": 122 },
              { "level": 6, "name": "熔岩的", "value": "火焰伤害提高 (105–124)%", "id": 123 },
              { "level": 7, "name": "火屑的", "value": "火焰伤害提高 (125–149)%", "id": 124 },
              { "level": 8, "name": "索伏的", "value": "火焰伤害提高 (150–164)%", "id": 125 },
              { "level": 1, "name": "苦涩的", "value": "冰霜伤害提高 (15–29)%", "id": 126 },
              { "level": 2, "name": "刻薄的", "value": "冰霜伤害提高 (30–44)%", "id": 127 },
              { "level": 3, "name": "高山的", "value": "冰霜伤害提高 (45–59)%", "id": 128 },
              { "level": 4, "name": "如雪的", "value": "冰霜伤害提高 (60–84)%", "id": 129 },
              { "level": 5, "name": "颂扬的", "value": "冰霜伤害提高 (85–104)%", "id": 130 },
              { "level": 6, "name": "结晶的", "value": "冰霜伤害提高 (105–124)%", "id": 131 },
              { "level": 7, "name": "冰霜法师的", "value": "冰霜伤害提高 (125–149)%", "id": 132 },
              { "level": 8, "name": "托沃的", "value": "冰霜伤害提高 (150–164)%", "id": 133 },
              { "level": 1, "name": "充能的", "value": "闪电伤害提高 (15–29)%", "id": 134 },
              { "level": 2, "name": "嘶鸣的", "value": "闪电伤害提高 (30–44)%", "id": 135 },
              { "level": 3, "name": "离弦的", "value": "闪电伤害提高 (45–59)%", "id": 136 },
              { "level": 4, "name": "追逐的", "value": "闪电伤害提高 (60–84)%", "id": 137 },
              { "level": 5, "name": "显著的", "value": "闪电伤害提高 (85–104)%", "id": 138 },
              { "level": 6, "name": "重击的", "value": "闪电伤害提高 (105–124)%", "id": 139 },
              { "level": 7, "name": "电离的", "value": "闪电伤害提高 (125–149)%", "id": 140 },
              { "level": 8, "name": "艾许的", "value": "闪电伤害提高 (150–164)%", "id": 141 }
          ],
          "法术伤害提高(饰品)": [
              { "name": "护法的", "value": "(3–7)% 法术伤害提高", "level": 1, "id": 142 },
              { "name": "法师的", "value": "(8–12)% 法术伤害提高", "level": 2, "id": 143 },
              { "name": "术者的", "value": "(13–17)% 法术伤害提高", "level": 3, "id": 144 },
              { "name": "奇术师的", "value": "(18–22)% 法术伤害提高", "level": 4, "id": 145 },
              { "name": "巫师的", "value": "(23–26)% 法术伤害提高", "level": 5, "id": 146 }
          ],

          "法术伤害与魔力(单手)": [
              { "level": 1, "name": "施放者的", "value": "法术伤害提高 (5–9)% +(17–20) 最大魔力", "id": 147 },
              { "level": 2, "name": "咒术师的", "value": "法术伤害提高 (10–14)% +(21–24) 最大魔力", "id": 148 },
              { "level": 3, "name": "巫师的", "value": "法术伤害提高 (15–19)% +(25–28) 最大魔力", "id": 149 },
              { "level": 4, "name": "术士的", "value": "法术伤害提高 (20–24)% +(29–33) 最大魔力", "id": 150 },
              { "level": 5, "name": "魔导师的", "value": "法术伤害提高 (25–29)% +(34–37) 最大魔力", "id": 151 },
              { "level": 6, "name": "大法师的", "value": "法术伤害提高 (30–34)% +(38–41) 最大魔力", "id": 152 },
              { "level": 7, "name": "巫妖的", "value": "法术伤害提高 (35–39)% +(42–45) 最大魔力", "id": 153 }
          ],
          "法术伤害与魔力(双手)": [
              { "level": 1, "name": "施放者的", "value": "法术伤害提高 (8–14)% +(26–30) 最大魔力", "id": 154 },
              { "level": 2, "name": "咒术师的", "value": "法术伤害提高 (15–22)% +(31–35) 最大魔力", "id": 155 },
              { "level": 3, "name": "巫师的", "value": "法术伤害提高 (23–29)% +(36–41) 最大魔力", "id": 156 },
              { "level": 4, "name": "术士的", "value": "法术伤害提高 (30–37)% +(42–47) 最大魔力", "id": 157 },
              { "level": 5, "name": "魔导师的", "value": "法术伤害提高 (38–44)% +(48–53) 最大魔力", "id": 158 },
              { "level": 6, "name": "大法师的", "value": "法术伤害提高 (45–50)% +(54–59) 最大魔力", "id": 159 },
              { "level": 7, "name": "巫妖的", "value": "法术伤害提高 (51–55)% +(60–64) 最大魔力", "id": 160 }
          ],

          "基础混沌伤害(单手)": [
              { "level": 1, "name": "恶意的", "value": "该装备附加 (56–87) - (105–160) 基础混沌伤害", "id": 161 }
          ],
          "基础混沌伤害(双手)": [
              { "level": 1, "name": "恶意的", "value": "该装备附加 (98–149) - (183–280) 基础混沌伤害", "id": 162 }
          ],
          "基础混沌伤害(箭袋)": [
              { "level": 1, "name": "恶意的", "value": "该装备附加 (27–41) - (55–69) 基础混沌伤害", "id": 163 }
          ],

          "基础物理伤害(单手)": [
              { "name": "反光的", "value": "该装备附加 1 - (2–3) 基础物理伤害", "level": 1, "id": 164 },
              { "name": "磨光的", "value": "该装备附加 (4–5) - (8–9) 基础物理伤害", "level": 2, "id": 165 },
              { "name": "抛光的", "value": "该装备附加 (6–9) - (13–15) 基础物理伤害", "level": 3, "id": 166 },
              { "name": "砥砺的", "value": "该装备附加 (8–12) - (17–20) 基础物理伤害", "level": 4, "id": 167 },
              { "name": "熠熠的", "value": "该装备附加 (11–14) - (21–25) 基础物理伤害", "level": 5, "id": 168 },
              { "name": "韧炼的", "value": "该装备附加 (13–18) - (27–31) 基础物理伤害", "level": 6, "id": 169 },
              { "name": "锋利的", "value": "该装备附加 (16–21) - (32–38) 基础物理伤害", "level": 7, "id": 170 },
              { "name": "锻炼的", "value": "该装备附加 (19–25) - (39–45) 基础物理伤害", "level": 8, "id": 171 },
              { "name": "迸出的", "value": "该装备附加 (22–29) - (45–52) 基础物理伤害", "level": 9, "id": 172 }
          ],
          "基础物理伤害(双手)": [
              { "name": "反光的", "value": "该装备附加 2 - (4–5) 基础物理伤害", "level": 1, "id": 173 },
              { "name": "磨光的", "value": "该装备附加 (6–8) - (12–15) 基础物理伤害", "level": 2, "id": 174 },
              { "name": "抛光的", "value": "该装备附加 (10–13) - (21–25) 基础物理伤害", "level": 3, "id": 175 },
              { "name": "砥砺的", "value": "该装备附加 (13–17) - (28–32) 基础物理伤害", "level": 4, "id": 176 },
              { "name": "熠熠的", "value": "该装备附加 (16–22) - (35–40) 基础物理伤害", "level": 5, "id": 177 },
              { "name": "韧炼的", "value": "该装备附加 (20–28) - (43–51) 基础物理伤害", "level": 6, "id": 178 },
              { "name": "锋利的", "value": "该装备附加 (25–33) - (52–61) 基础物理伤害", "level": 7, "id": 179 },
              { "name": "锻炼的", "value": "该装备附加 (30–40) - (63–73) 基础物理伤害", "level": 8, "id": 180 },
              { "name": "迸出的", "value": "该装备附加 (34–47) - (72–84) 基础物理伤害", "level": 9, "id": 181 }
          ],
          "基础物理伤害(箭袋)": [
              { "name": "微烁的", "value": "攻击附加 (1–2) - 3 基础物理伤害", "level": 1, "id": 182 },
              { "name": "光亮的", "value": "攻击附加 (3–4) - (6–8) 基础物理伤害", "level": 2, "id": 183 },
              { "name": "抛光的", "value": "攻击附加 (5–6) - (9–10) 基础物理伤害", "level": 3, "id": 184 },
              { "name": "硬索的", "value": "攻击附加 (6–9) - (13–16) 基础物理伤害", "level": 4, "id": 185 },
              { "name": "熠熠的", "value": "攻击附加 (8–11) - (16–18) 基础物理伤害", "level": 5, "id": 186 },
              { "name": "韧炼的", "value": "攻击附加 (10–13) - (19–23) 基础物理伤害", "level": 6, "id": 187 },
              { "name": "锋利的", "value": "攻击附加 (11–16) - (23–26) 基础物理伤害", "level": 7, "id": 188 },
              { "name": "锻炼的", "value": "攻击附加 (14–19) - (28–33) 基础物理伤害", "level": 8, "id": 189 },
              { "name": "迸出的", "value": "攻击附加 (17–23) - (34–39) 基础物理伤害", "level": 9, "id": 190 }
          ],
          "基础物理伤害(项链)": [
              { "name": "反光的", "value": "攻击附加 1 - 2 基础物理伤害", "level": 1, "id": 191 },
              { "name": "磨光的", "value": "攻击附加 (2–3) - (4–5) 基础物理伤害", "level": 2, "id": 192 },
              { "name": "抛光的", "value": "攻击附加 (3–4) - (6–7) 基础物理伤害", "level": 3, "id": 193 },
              { "name": "砥砺的", "value": "攻击附加 (4–6) - (9–10) 基础物理伤害", "level": 4, "id": 194 },
              { "name": "熠熠的", "value": "攻击附加 (5–7) - (11–12) 基础物理伤害", "level": 5, "id": 195 },
              { "name": "韧炼的", "value": "攻击附加 (6–9) - (13–15) 基础物理伤害", "level": 6, "id": 196 },
              { "name": "锋利的", "value": "攻击附加 (7–10) - (15–18) 基础物理伤害", "level": 7, "id": 197 },
              { "name": "锻炼的", "value": "攻击附加 (9–12) - (19–22) 基础物理伤害", "level": 8, "id": 198 },
              { "name": "迸出的", "value": "攻击附加 (11–15) - (22–26) 基础物理伤害", "level": 9, "id": 199 }
          ],
          "基础物理伤害(戒指和手套)": [
              { "name": "反光的", "value": "攻击附加 1 - 2 基础物理伤害", "level": 1, "id": 200 },
              { "name": "磨光的", "value": "攻击附加 (2–3) - (4–5) 基础物理伤害", "level": 2, "id": 201 },
              { "name": "抛光的", "value": "攻击附加 (3–4) - (6–7) 基础物理伤害", "level": 3, "id": 202 },
              { "name": "砥砺的", "value": "攻击附加 (4–6) - (9–10) 基础物理伤害", "level": 4, "id": 203 },
              { "name": "熠熠的", "value": "攻击附加 (5–7) - (11–12) 基础物理伤害", "level": 5, "id": 204 },
              { "name": "韧炼的", "value": "攻击附加 (6–9) - (13–15) 基础物理伤害", "level": 6, "id": 205 }
          ],

          "基础火焰伤害(单手)": [
              { "name": "加热的", "value": "该装备附加 (1–2) - (3–4) 基础火焰伤害", "level": 1, "id": 206 },
              { "name": "闷烧的", "value": "该装备附加 (8–10) - (15–18) 基础火焰伤害", "level": 2, "id": 207 },
              { "name": "冒烟的", "value": "该装备附加 (12–17) - (25–29) 基础火焰伤害", "level": 3, "id": 208 },
              { "name": "燃烧的", "value": "该装备附加 (17–24) - (35–41) 基础火焰伤害", "level": 4, "id": 209 },
              { "name": "火焰的", "value": "该装备附加 (24–33) - (49–57) 基础火焰伤害", "level": 5, "id": 210 },
              { "name": "酷热的", "value": "该装备附加 (34–46) - (68–80) 基础火焰伤害", "level": 6, "id": 211 },
              { "name": "焚烧的", "value": "该装备附加 (46–62) - (93–107) 基础火焰伤害", "level": 7, "id": 212 },
              { "name": "爆破的", "value": "该装备附加 (59–81) - (120–140) 基础火焰伤害", "level": 8, "id": 213 },
              { "name": "火化的", "value": "该装备附加 (74–101) - (150–175) 基础火焰伤害", "level": 9, "id": 214 },
              { "name": "焦化的", "value": "该装备附加 (89–121) - (180–210) 基础火焰伤害", "level": 10, "id": 215 }
          ],
          "基础火焰伤害(双手)": [
              { "level": 1, "name": "加热的", "value": "该装备附加 (3–5) - (6–7) 基础火焰伤害", "id": 216 },
              { "level": 2, "name": "闷烧的", "value": "该装备附加 (14–20) - (29–33) 基础火焰伤害", "id": 217 },
              { "level": 3, "name": "冒烟的", "value": "该装备附加 (23–31) - (47–54) 基础火焰伤害", "id": 218 },
              { "level": 4, "name": "燃烧的", "value": "该装备附加 (32–44) - (65–76) 基础火焰伤害", "id": 219 },
              { "level": 5, "name": "火焰的", "value": "该装备附加 (45–61) - (91–106) 基础火焰伤害", "id": 220 },
              { "level": 6, "name": "酷热的", "value": "该装备附加 (63–85) - (128–148) 基础火焰伤害", "id": 221 },
              { "level": 7, "name": "焚烧的", "value": "该装备附加 (85–115) - (172–200) 基础火焰伤害", "id": 222 },
              { "level": 8, "name": "爆破的", "value": "该装备附加 (110–150) - (223–260) 基础火焰伤害", "id": 223 },
              { "level": 9, "name": "火化的", "value": "该装备附加 (137–188) - (279–325) 基础火焰伤害", "id": 224 },
              { "level": 10, "name": "焦化的", "value": "该装备附加 (165–225) - (335–390) 基础火焰伤害", "id": 225 }
          ],
          "基础火焰伤害(箭袋)": [
              { "name": "加热的", "value": "攻击附加 (1–2) - 3 基础火焰伤害", "level": 1, "id": 226 },
              { "name": "闷烧的", "value": "攻击附加 (5–7) - (10–12) 基础火焰伤害", "level": 2, "id": 227 },
              { "name": "冒烟的", "value": "攻击附加 (8–10) - (15–18) 基础火焰伤害", "level": 3, "id": 228 },
              { "name": "燃烧的", "value": "攻击附加 (11–14) - (21–25) 基础火焰伤害", "level": 4, "id": 229 },
              { "name": "烈火的", "value": "攻击附加 (13–18) - (27–31) 基础火焰伤害", "level": 5, "id": 230 },
              { "name": "酷热的", "value": "攻击附加 (17–22) - (33–38) 基础火焰伤害", "level": 6, "id": 231 },
              { "name": "焚烧的", "value": "攻击附加 (20–27) - (40–47) 基础火焰伤害", "level": 7, "id": 232 },
              { "name": "爆破的", "value": "攻击附加 (27–35) - (53–62) 基础火焰伤害", "level": 8, "id": 233 },
              { "name": "火化的", "value": "攻击附加 (37–50) - (74–87) 基础火焰伤害", "level": 9, "id": 234 }
          ],
          "基础火焰伤害(项链)": [
              { "name": "加热的", "value": "攻击附加 (1–2) - 2 基础火焰伤害", "level": 1, "id": 235 },
              { "name": "闷烧的", "value": "攻击附加 (3–5) - (7–8) 基础火焰伤害", "level": 2, "id": 236 },
              { "name": "冒烟的", "value": "攻击附加 (5–7) - (11–13) 基础火焰伤害", "level": 3, "id": 237 },
              { "name": "燃烧的", "value": "攻击附加 (7–10) - (15–18) 基础火焰伤害", "level": 4, "id": 238 },
              { "name": "火焰的", "value": "攻击附加 (9–12) - (19–22) 基础火焰伤害", "level": 5, "id": 239 },
              { "name": "酷热的", "value": "攻击附加 (11–15) - (23–27) 基础火焰伤害", "level": 6, "id": 240 },
              { "name": "焚烧的", "value": "攻击附加 (13–18) - (27–31) 基础火焰伤害", "level": 7, "id": 241 },
              { "name": "爆破的", "value": "攻击附加 (16–22) - (32–38) 基础火焰伤害", "level": 8, "id": 242 },
              { "name": "火化的", "value": "攻击附加 (19–25) - (39–45) 基础火焰伤害", "level": 9, "id": 243 }
          ],
          "基础火焰伤害(戒指和手套)": [
              { "name": "加热的", "value": "攻击附加 1 - 2 基础火焰伤害", "level": 1, "id": 244 },
              { "name": "闷烧的", "value": "攻击附加 (3–5) - (7–8) 基础火焰伤害", "level": 2, "id": 245 },
              { "name": "冒烟的", "value": "攻击附加 (5–7) - (11–13) 基础火焰伤害", "level": 3, "id": 246 },
              { "name": "燃烧的", "value": "攻击附加 (7–10) - (15–18) 基础火焰伤害", "level": 4, "id": 247 },
              { "name": "火焰的", "value": "攻击附加 (9–12) - (19–22) 基础火焰伤害", "level": 5, "id": 248 },
              { "name": "酷热的", "value": "攻击附加 (11–15) - (23–27) 基础火焰伤害", "level": 6, "id": 249 },
              { "name": "焚烧的", "value": "攻击附加 (13–18) - (27–31) 基础火焰伤害", "level": 7, "id": 250 },
              { "name": "爆破的", "value": "攻击附加 (16–22) - (32–38) 基础火焰伤害", "level": 8, "id": 251 },
              { "name": "火化的", "value": "攻击附加 (19–25) - (39–45) 基础火焰伤害", "level": 9, "id": 252 }
          ],

          "基础冰霜伤害(单手)": [
              { "name": "结霜的", "value": "该装备附加 (1–2) - (3–4) 基础冰霜伤害", "level": 1, "id": 253 },
              { "name": "冷冻的", "value": "该装备附加 (7–9) - (14–16) 基础冰霜伤害", "level": 2, "id": 254 },
              { "name": "结冰的", "value": "该装备附加 (11–15) - (23–26) 基础冰霜伤害", "level": 3, "id": 255 },
              { "name": "寒风的", "value": "该装备附加 (16–21) - (31–37) 基础冰霜伤害", "level": 4, "id": 256 },
              { "name": "急冻的", "value": "该装备附加 (22–30) - (44–51) 基础冰霜伤害", "level": 5, "id": 257 },
              { "name": "冻结的", "value": "该装备附加 (31–42) - (62–71) 基础冰霜伤害", "level": 6, "id": 258 },
              { "name": "冰河的", "value": "该装备附加 (41–57) - (83–97) 基础冰霜伤害", "level": 7, "id": 259 },
              { "name": "极地的", "value": "该装备附加 (54–74) - (108–126) 基础冰霜伤害", "level": 8, "id": 260 },
              { "name": "埋葬的", "value": "该装备附加 (68–92) - (136–157) 基础冰霜伤害", "level": 9, "id": 261 },
              { "name": "晶化的", "value": "该装备附加 (81–111) - (163–189) 基础冰霜伤害", "level": 10, "id": 262 }
          ],
          "基础冰霜伤害(双手)": [
              { "level": 1, "name": "结霜的", "value": "该装备附加 (2–3) - (6–7) 基础冰霜伤害", "id": 263 },
              { "level": 2, "name": "冷冻的", "value": "该装备附加 (12–17) - (26–30) 基础冰霜伤害", "id": 264 },
              { "level": 3, "name": "结冰的", "value": "该装备附加 (21–28) - (42–48) 基础冰霜伤害", "id": 265 },
              { "level": 4, "name": "寒风的", "value": "该装备附加 (29–40) - (58–68) 基础冰霜伤害", "id": 266 },
              { "level": 5, "name": "急冻的", "value": "该装备附加 (41–55) - (81–95) 基础冰霜伤害", "id": 267 },
              { "level": 6, "name": "冻结的", "value": "该装备附加 (57–77) - (114–132) 基础冰霜伤害", "id": 268 },
              { "level": 7, "name": "冰河的", "value": "该装备附加 (77–104) - (154–178) 基础冰霜伤害", "id": 269 },
              { "level": 8, "name": "极地的", "value": "该装备附加 (99–136) - (200–232) 基础冰霜伤害", "id": 270 },
              { "level": 9, "name": "埋葬的", "value": "该装备附加 (124–170) - (250–290) 基础冰霜伤害", "id": 271 },
              { "level": 10, "name": "晶化的", "value": "该装备附加 (149–204) - (300–348) 基础冰霜伤害", "id": 272 }
          ],
          "基础冰霜伤害(箭袋)": [
              { "name": "结霜的", "value": "攻击附加 (1–2) - (2–3) 基础冰霜伤害", "level": 1, "id": 273 },
              { "name": "冰缓", "value": "攻击附加 (5–6) - (9–10) 基础冰霜伤害", "level": 2, "id": 274 },
              { "name": "结冰的", "value": "攻击附加 (7–9) - (14–16) 基础冰霜伤害", "level": 3, "id": 275 },
              { "name": "寒风之", "value": "攻击附加 (10–13) - (19–22) 基础冰霜伤害", "level": 4, "id": 276 },
              { "name": "急冻的", "value": "攻击附加 (12–16) - (24–28) 基础冰霜伤害", "level": 5, "id": 277 },
              { "name": "冰冻的", "value": "攻击附加 (15–20) - (30–35) 基础冰霜伤害", "level": 6, "id": 278 },
              { "name": "冰河的", "value": "攻击附加 (18–24) - (36–42) 基础冰霜伤害", "level": 7, "id": 279 },
              { "name": "极地的", "value": "攻击附加 (23–32) - (48–55) 基础冰霜伤害", "level": 8, "id": 280 },
              { "name": "埋葬的", "value": "攻击附加 (33–45) - (67–78) 基础冰霜伤害", "level": 9, "id": 281 }
          ],
          "基础冰霜伤害(项链)": [
              { "name": "结霜的", "value": "攻击附加 1 - 2 基础冰霜伤害", "level": 1, "id": 282 },
              { "name": "冷冻的", "value": "攻击附加 (3–4) - (7–8) 基础冰霜伤害", "level": 2, "id": 283 },
              { "name": "结冰的", "value": "攻击附加 (5–7) - (10–12) 基础冰霜伤害", "level": 3, "id": 284 },
              { "name": "寒风的", "value": "攻击附加 (6–9) - (13–16) 基础冰霜伤害", "level": 4, "id": 285 },
              { "name": "急冻的", "value": "攻击附加 (8–11) - (16–19) 基础冰霜伤害", "level": 5, "id": 286 },
              { "name": "冻结的", "value": "攻击附加 (10–13) - (20–24) 基础冰霜伤害", "level": 6, "id": 287 },
              { "name": "冰河的", "value": "攻击附加 (12–16) - (24–28) 基础冰霜伤害", "level": 7, "id": 288 },
              { "name": "极地的", "value": "攻击附加 (14–19) - (29–34) 基础冰霜伤害", "level": 8, "id": 289 },
              { "name": "埋葬的", "value": "攻击附加 (17–22) - (34–40) 基础冰霜伤害", "level": 9, "id": 290 }
          ],
          "基础冰霜伤害(戒指和手套)": [
              { "name": "结霜的", "value": "攻击附加 1 - 2 基础冰霜伤害", "level": 1, "id": 291 },
              { "name": "冷冻的", "value": "攻击附加 (3–4) - (7–8) 基础冰霜伤害", "level": 2, "id": 292 },
              { "name": "结冰的", "value": "攻击附加 (5–7) - (10–12) 基础冰霜伤害", "level": 3, "id": 293 },
              { "name": "寒风的", "value": "攻击附加 (6–9) - (13–16) 基础冰霜伤害", "level": 4, "id": 294 },
              { "name": "急冻的", "value": "攻击附加 (8–11) - (16–19) 基础冰霜伤害", "level": 5, "id": 295 },
              { "name": "冻结的", "value": "攻击附加 (10–13) - (20–24) 基础冰霜伤害", "level": 6, "id": 296 },
              { "name": "冰河的", "value": "攻击附加 (12–16) - (24–28) 基础冰霜伤害", "level": 7, "id": 297 },
              { "name": "极地的", "value": "攻击附加 (14–19) - (29–34) 基础冰霜伤害", "level": 8, "id": 298 },
              { "name": "埋葬的", "value": "攻击附加 (17–22) - (34–40) 基础冰霜伤害", "level": 9, "id": 299 }
          ],

          "基础闪电伤害(单手)": [
              { "name": "低鸣的", "value": "该装备附加 1 - (5–6) 基础闪电伤害", "level": 1, "id": 300 },
              { "name": "嗡嗡的", "value": "该装备附加 2 - (25–29) 基础闪电伤害", "level": 2, "id": 301 },
              { "name": "捕捉的", "value": "该装备附加 2 - (41–48) 基础闪电伤害", "level": 3, "id": 302 },
              { "name": "劈哩啪啦的", "value": "该装备附加 3 - (57–67) 基础闪电伤害", "level": 4, "id": 303 },
              { "name": "火花的", "value": "该装备附加 (4–5) - (80–94) 基础闪电伤害", "level": 5, "id": 304 },
              { "name": "电弧的", "value": "该装备附加 (5–8) - (112–131) 基础闪电伤害", "level": 6, "id": 305 },
              { "name": "电震的", "value": "该装备附加 (8–10) - (152–176) 基础闪电伤害", "level": 7, "id": 306 },
              { "name": "放电的", "value": "该装备附加 (10–14) - (197–229) 基础闪电伤害", "level": 8, "id": 307 },
              { "name": "电极的", "value": "该装备附加 (13–17) - (247–286) 基础闪电伤害", "level": 9, "id": 308 },
              { "name": "汽化的", "value": "该装备附加 (15–21) - (296–344) 基础闪电伤害", "level": 10, "id": 309 }
          ],
          "基础闪电伤害(双手)": [
              { "level": 1, "name": "低鸣的", "value": "该装备附加 2 - (10–11) 基础闪电伤害", "id": 310 },
              { "level": 2, "name": "嗡嗡的", "value": "该装备附加 3 - (46–53) 基础闪电伤害", "id": 311 },
              { "level": 3, "name": "捕捉的", "value": "该装备附加 (4–5) - (76–88) 基础闪电伤害", "id": 312 },
              { "level": 4, "name": "劈哩啪啦的", "value": "该装备附加 (5–8) - (106–123) 基础闪电伤害", "id": 313 },
              { "level": 5, "name": "火花的", "value": "该装备附加 (8–10) - (148–173) 基础闪电伤害", "id": 314 },
              { "level": 6, "name": "电弧的", "value": "该装备附加 (11–14) - (208–242) 基础闪电伤害", "id": 315 },
              { "level": 7, "name": "电震的", "value": "该装备附加 (14–20) - (281–327) 基础闪电伤害", "id": 316 },
              { "level": 8, "name": "放电的", "value": "该装备附加 (19–25) - (366–425) 基础闪电伤害", "id": 317 },
              { "level": 9, "name": "电极的", "value": "该装备附加 (23–32) - (458–531) 基础闪电伤害", "id": 318 },
              { "level": 10, "name": "汽化的", "value": "该装备附加 (28–38) - (549–638) 基础闪电伤害", "id": 319 }
          ],
          "基础闪电伤害(箭袋)": [
              { "name": "雷电的", "value": "攻击附加 1 - (3–4) 基础闪电伤害", "level": 1, "id": 320 },
              { "name": "嗡嗡的", "value": "攻击附加 2 - (16–18) 基础闪电伤害", "level": 2, "id": 321 },
              { "name": "捕捉的", "value": "攻击附加 (1–3) - (25–28) 基础闪电伤害", "level": 3, "id": 322 },
              { "name": "劈哩啪啦的", "value": "攻击附加 (2–3) - (35–40) 基础闪电伤害", "level": 4, "id": 323 },
              { "name": "火花的", "value": "攻击附加 (2–4) - (44–50) 基础闪电伤害", "level": 5, "id": 324 },
              { "name": "电弧的", "value": "攻击附加 (2–5) - (56–62) 基础闪电伤害", "level": 6, "id": 325 },
              { "name": "电震的", "value": "攻击附加 (2–6) - (66–75) 基础闪电伤害", "level": 7, "id": 326 },
              { "name": "放电的", "value": "攻击附加 (3–8) - (89–99) 基础闪电伤害", "level": 8, "id": 327 },
              { "name": "电极的", "value": "攻击附加 (5–11) - (124–140) 基础闪电伤害", "level": 9, "id": 328 }
          ],
          "基础闪电伤害(项链)": [
              { "name": "低鸣的", "value": "攻击附加 1 - 5 基础闪电伤害", "level": 1, "id": 329 },
              { "name": "嗡嗡的", "value": "攻击附加 1 - (14–15) 基础闪电伤害", "level": 2, "id": 330 },
              { "name": "捕捉的", "value": "攻击附加 (1–2) - (22–23) 基础闪电伤害", "level": 3, "id": 331 },
              { "name": "劈哩啪啦的", "value": "攻击附加 (1–2) - (27–28) 基础闪电伤害", "level": 4, "id": 332 },
              { "name": "火花的", "value": "攻击附加 (1–3) - (33–34) 基础闪电伤害", "level": 5, "id": 333 },
              { "name": "电弧的", "value": "攻击附加 (1–4) - (40–43) 基础闪电伤害", "level": 6, "id": 334 },
              { "name": "电震的", "value": "攻击附加 (2–5) - (47–50) 基础闪电伤害", "level": 7, "id": 335 },
              { "name": "放电的", "value": "攻击附加 (3–6) - (57–61) 基础闪电伤害", "level": 8, "id": 336 },
              { "name": "电极的", "value": "攻击附加 (3–7) - (68–72) 基础闪电伤害", "level": 9, "id": 337 }
          ],
          "基础闪电伤害(戒指和手套)": [
              { "name": "低鸣的", "value": "攻击附加 1 - 5 基础闪电伤害", "level": 1, "id": 338 },
              { "name": "嗡嗡的", "value": "攻击附加 1 - (14–15) 基础闪电伤害", "level": 2, "id": 339 },
              { "name": "捕捉的", "value": "攻击附加 (1–2) - (22–23) 基础闪电伤害", "level": 3, "id": 340 },
              { "name": "劈哩啪啦的", "value": "攻击附加 (1–2) - (27–28) 基础闪电伤害", "level": 4, "id": 341 },
              { "name": "火花的", "value": "攻击附加 (1–3) - (33–34) 基础闪电伤害", "level": 5, "id": 342 },
              { "name": "电弧的", "value": "攻击附加 (1–4) - (40–43) 基础闪电伤害", "level": 6, "id": 343 },
              { "name": "电震的", "value": "攻击附加 (2–5) - (47–50) 基础闪电伤害", "level": 7, "id": 344 },
              { "name": "放电的", "value": "攻击附加 (3–6) - (57–61) 基础闪电伤害", "level": 8, "id": 345 },
              { "name": "电极的", "value": "攻击附加 (3–7) - (68–72) 基础闪电伤害", "level": 9, "id": 346 }
          ],

          "法术附加伤害(单手)": [
              { "level": 1, "name": "加热的", "value": "给法术附加 (1–2) 到 (3–4) 点火焰伤害", "id": 347 },
              { "level": 2, "name": "闷烧的", "value": "给法术附加 (6–8) 到 (12–14) 点火焰伤害", "id": 348 },
              { "level": 3, "name": "冒烟的", "value": "给法术附加 (10–12) 到 (19–23) 点火焰伤害", "id": 349 },
              { "level": 4, "name": "燃烧的", "value": "给法术附加 (13–18) 到 (27–31) 点火焰伤害", "id": 350 },
              { "level": 5, "name": "烈火的", "value": "给法术附加 (19–25) 到 (37–44) 点火焰伤害", "id": 351 },
              { "level": 6, "name": "酷热的", "value": "给法术附加 (24–33) 到 (48–57) 点火焰伤害", "id": 352 },
              { "level": 7, "name": "焚烧的", "value": "给法术附加 (31–42) 到 (64–73) 点火焰伤害", "id": 353 },
              { "level": 8, "name": "爆破的", "value": "给法术附加 (40–52) 到 (79–91) 点火焰伤害", "id": 354 },
              { "level": 9, "name": "火化的", "value": "给法术附加 (49–66) 到 (98–115) 点火焰伤害", "id": 355 },
              { "level": 10, "name": "结霜的", "value": "法术附加 1 - (2–3) 基础冰霜伤害", "id": 356 },
              { "level": 11, "name": "冷冻的", "value": "法术附加 (5–7) - (10–12) 基础冰霜伤害", "id": 357 },
              { "level": 12, "name": "结冰的", "value": "法术附加 (8–10) - (16–18) 基础冰霜伤害", "id": 358 },
              { "level": 13, "name": "寒风的", "value": "法术附加 (11–15) - (22–25) 基础冰霜伤害", "id": 359 },
              { "level": 14, "name": "冷冻的", "value": "法术附加 (16–20) - (30–36) 基础冰霜伤害", "id": 360 },
              { "level": 15, "name": "冻结的", "value": "法术附加 (20–26) - (40–46) 基础冰霜伤害", "id": 361 },
              { "level": 16, "name": "冰河的", "value": "法术附加 (26–35) - (51–60) 基础冰霜伤害", "id": 362 },
              { "level": 17, "name": "极地的", "value": "法术附加 (33–43) - (64–75) 基础冰霜伤害", "id": 363 },
              { "level": 18, "name": "埋葬的", "value": "法术附加 (41–54) - (81–93) 基础冰霜伤害", "id": 364 },
              { "level": 19, "name": "雷电的", "value": "法术附加 1 - (4–5) 基础闪电伤害", "id": 365 },
              { "level": 20, "name": "嗡嗡的", "value": "法术附加 (1–2) - (21–22) 基础闪电伤害", "id": 366 },
              { "level": 21, "name": "捕捉的", "value": "法术附加 (1–2) - (33–35) 基础闪电伤害", "id": 367 },
              { "level": 22, "name": "劈哩啪啦的", "value": "法术附加 (1–4) - (46–48) 基础闪电伤害", "id": 368 },
              { "level": 23, "name": "火花的", "value": "法术附加 (2–5) - (64–68) 基础闪电伤害", "id": 369 },
              { "level": 24, "name": "电弧的", "value": "法术附加 (2–7) - (84–88) 基础闪电伤害", "id": 370 },
              { "level": 25, "name": "导电的", "value": "法术附加 (2–9) - (109–115) 基础闪电伤害", "id": 371 },
              { "level": 26, "name": "放电的", "value": "法术附加 (4–11) - (136–144) 基础闪电伤害", "id": 372 },
              { "level": 27, "name": "电极的", "value": "法术附加 (4–14) - (170–179) 基础闪电伤害", "id": 373 }
          ],
          "法术附加伤害(双手)": [
              { "level": 1, "name": "加热的", "value": "给法术附加 (1–2) 到 (4–5) 点火焰伤害", "id": 374 },
              { "level": 2, "name": "闷烧的", "value": "给法术附加 (8–11) 到 (17–19) 点火焰伤害", "id": 375 },
              { "level": 3, "name": "冒烟的", "value": "给法术附加 (13–17) 到 (26–29) 点火焰伤害", "id": 376 },
              { "level": 4, "name": "燃烧的", "value": "给法术附加 (18–23) 到 (36–42) 点火焰伤害", "id": 377 },
              { "level": 5, "name": "烈火的", "value": "给法术附加 (25–33) 到 (50–59) 点火焰伤害", "id": 378 },
              { "level": 6, "name": "酷热的", "value": "给法术附加 (32–44) 到 (65–76) 点火焰伤害", "id": 379 },
              { "level": 7, "name": "焚烧的", "value": "给法术附加 (42–56) 到 (85–99) 点火焰伤害", "id": 380 },
              { "level": 8, "name": "爆破的", "value": "给法术附加 (53–70) 到 (107–123) 点火焰伤害", "id": 381 },
              { "level": 9, "name": "火化的", "value": "给法术附加 (66–88) 到 (132–155) 点火焰伤害", "id": 382 },
              { "level": 1, "name": "结霜的", "value": "法术附加 (1–2) - (3–4) 基础冰霜伤害", "id": 383 },
              { "level": 2, "name": "冷冻的", "value": "法术附加 (8–10) - (15–18) 基础冰霜伤害", "id": 384 },
              { "level": 3, "name": "结冰的", "value": "法术附加 (12–15) - (23–28) 基础冰霜伤害", "id": 385 },
              { "level": 4, "name": "寒风的", "value": "法术附加 (16–22) - (33–38) 基础冰霜伤害", "id": 386 },
              { "level": 5, "name": "冷冻的", "value": "法术附加 (24–30) - (45–53) 基础冰霜伤害", "id": 387 },
              { "level": 6, "name": "冻结的", "value": "法术附加 (30–40) - (59–69) 基础冰霜伤害", "id": 388 },
              { "level": 7, "name": "冰河的", "value": "法术附加 (39–52) - (77–90) 基础冰霜伤害", "id": 389 },
              { "level": 8, "name": "极地的", "value": "法术附加 (49–64) - (96–113) 基础冰霜伤害", "id": 390 },
              { "level": 9, "name": "埋葬的", "value": "法术附加 (61–81) - (120–140) 基础冰霜伤害", "id": 391 },
              { "level": 1, "name": "雷电的", "value": "法术附加 1 - (6–7) 基础闪电伤害", "id": 392 },
              { "level": 2, "name": "嗡嗡的", "value": "法术附加 (1–3) - (32–34) 基础闪电伤害", "id": 393 },
              { "level": 3, "name": "捕捉的", "value": "法术附加 (1–4) - (49–52) 基础闪电伤害", "id": 394 },
              { "level": 4, "name": "劈哩啪啦的", "value": "法术附加 (2–5) - (69–73) 基础闪电伤害", "id": 395 },
              { "level": 5, "name": "火花的", "value": "法术附加 (2–8) - (97–102) 基础闪电伤害", "id": 396 },
              { "level": 6, "name": "电弧的", "value": "法术附加 (3–10) - (126–133) 基础闪电伤害", "id": 397 },
              { "level": 7, "name": "导电的", "value": "法术附加 (5–12) - (164–173) 基础闪电伤害", "id": 398 },
              { "level": 8, "name": "放电的", "value": "法术附加 (5–17) - (204–216) 基础闪电伤害", "id": 399 },
              { "level": 9, "name": "电极的", "value": "法术附加 (7–20) - (255–270) 基础闪电伤害", "id": 400 }
          ],

          "攻击技能的元素伤害提高(单手)": [
              { "level": 1, "name": "催化的", "value": "攻击技能的元素伤害提高 (11–20)%", "id": 401 },
              { "level": 2, "name": "注入的", "value": "攻击技能的元素伤害提高 (21–30)%", "id": 402 },
              { "level": 3, "name": "驾驭的", "value": "攻击技能的元素伤害提高 (31–36)%", "id": 403 },
              { "level": 4, "name": "释放的", "value": "攻击技能的元素伤害提高 (37–42)%", "id": 404 },
              { "level": 5, "name": "狂暴的", "value": "攻击技能的元素伤害提高 (43–50)%", "id": 405 },
              { "level": 6, "name": "毁灭的", "value": "攻击技能的元素伤害提高 (51–59)%", "id": 406 }
          ],
          "攻击技能的元素伤害提高(双手)": [
              { "level": 1, "name": "催化的", "value": "攻击技能的元素伤害提高 (19–34)%", "id": 407 },
              { "level": 2, "name": "注入的", "value": "攻击技能的元素伤害提高 (36–51)%", "id": 408 },
              { "level": 3, "name": "赋能的", "value": "攻击技能的元素伤害提高 (53–61)%", "id": 409 },
              { "level": 4, "name": "释放的", "value": "攻击技能的元素伤害提高 (63–71)%", "id": 410 },
              { "level": 5, "name": "狂暴的", "value": "攻击技能的元素伤害提高 (73–85)%", "id": 411 },
              { "level": 6, "name": "毁灭的", "value": "攻击技能的元素伤害提高 (87–100)%", "id": 412 }
          ],
          "攻击技能的元素伤害提高(非武器)": [
              { "name": "催化的", "value": "(5–10)% 攻击技能的元素伤害提高", "level": 1, "id": 413 },
              { "name": "注入的", "value": "(11–20)% 攻击技能的元素伤害提高", "level": 2, "id": 414 },
              { "name": "赋予的", "value": "(21–30)% 攻击技能的元素伤害提高", "level": 3, "id": 415 },
              { "name": "释放的", "value": "(31–36)% 攻击技能的元素伤害提高", "level": 4, "id": 416 },
              { "name": "强盛的", "value": "(37–42)% 攻击技能的元素伤害提高", "level": 5, "id": 417 },
              { "name": "毁灭的", "value": "(43-50)% 攻击技能的元素伤害提高", "level": 6, "id": 418 }
          ],

          "所有技能石等级":[
              { "level": 1, "name": "模范的", "value": "此物品上装备的技能石等级 +1", "id": 419 }
          ],
          "所有主动技能石等级":[
              { "level": 1, "name": "交变者的", "value": "所有主动技能石等级 +1", "id": 420 }
          ],
          "主动技能石等级": [
              { "name": "伏尔甘教徒的", "value": "所有火焰主动技能石等级 +1", "level": 1, "id": 421 },
              { "name": "霜民的", "value": "所有冰霜主动技能石等级 +1", "level": 1, "id": 422 },
              { "name": "风民的", "value": "所有闪电主动技能石等级 +1", "level": 1, "id": 423 },
              { "name": "比蒙的", "value": "所有物理主动技能石等级 +1", "level": 1, "id": 424 },
              { "name": "内奸的", "value": "所有混沌主动技能石等级 +1", "level": 1, "id": 425 }
          ],
          "所有法术主动技能石等级(双手)": [
              { "level": 1, "name": "导师的", "value": "所有法术主动技能石等级 +(1–2)", "id": 426 }
          ],
          "所有法术主动技能石等级(单手)": [
              { "level": 1, "name": "导师的", "value": "所有法术主动技能石等级 + 1", "id": 427 }
          ],
          "弓技能石等级": [
              { "level": 1, "name": "弓箭专家的", "value": "此物品上装备的【弓技能石】等级 +1", "id": 428 },
              { "level": 2, "name": "神枪手的", "value": "此物品上装备的【弓技能石】等级 +2", "id": 429 }
          ],
          "近战技能石等级": [
              { "level": 1, "name": "战斗的", "value": "此物品上装备的近战技能石等级 +1", "id": 430 },
              { "level": 2, "name": "武器大师的", "value": "此物品上装备的近战技能石等级 +2", "id": 431 }
          ],
          "召唤主动技能石": [
              { "level": 1, "name": "监工之", "value": "所有召唤生物主动技能石等级 +1", "id": 432 },
              { "level": 2, "name": "狱卒之", "value": "所有召唤生物主动技能石等级 +2", "id": 433 }
          ],
          "法术主动技能石等级(双手)": [
              { "level": 1, "name": "塑焰的", "value": "所有火焰法术主动技能石等级 +(1–2)", "id": 434 },
              { "level": 2, "name": "熔咒的", "value": "所有火焰法术主动技能石等级 +3", "id": 435 },
              { "level": 1, "name": "霜颂的", "value": "所有冰霜法术主动技能石等级 +(1–2)", "id": 436 },
              { "level": 2, "name": "迎冬的", "value": "所有冰霜法术主动技能石等级 +3", "id": 437 },
              { "level": 1, "name": "雷手的", "value": "所有闪电法术主动技能石等级 +(1–2)", "id": 438 },
              { "level": 2, "name": "风伯的", "value": "所有闪电法术主动技能石等级 +3", "id": 439 },
              { "level": 1, "name": "疯王的", "value": "所有混沌法术主动技能石等级 +(1–2)", "id": 440 },
              { "level": 2, "name": "碎志的", "value": "所有混沌法术主动技能石等级 +3", "id": 441 },
              { "level": 1, "name": "石卜师的", "value": "所有物理主动法术技能石等级 +(1–2)", "id": 442 },
              { "level": 2, "name": "破釜的", "value": "所有物理主动法术技能石等级 +3", "id": 443 }
          ],
          "法术主动技能石等级(单手)": [
              { "level": 1, "name": "塑焰的", "value": "所有火焰法术主动技能石等级 +1", "id": 444 },
              { "level": 2, "name": "熔咒的", "value": "所有火焰法术主动技能石等级 +2", "id": 445 },
              { "level": 1, "name": "霜颂的", "value": "所有冰霜法术主动技能石等级 +1", "id": 446 },
              { "level": 2, "name": "迎冬的", "value": "所有冰霜法术主动技能石等级 +2", "id": 447 },
              { "level": 1, "name": "雷手的", "value": "所有闪电法术主动技能石等级 +1", "id": 448 },
              { "level": 2, "name": "风伯的", "value": "所有闪电法术主动技能石等级 +2", "id": 449 },
              { "level": 1, "name": "疯王的", "value": "所有混沌法术主动技能石等级 +1", "id": 450 },
              { "level": 2, "name": "碎志的", "value": "所有混沌法术主动技能石等级 +2", "id": 451 },
              { "level": 1, "name": "石卜师的", "value": "所有物理主动法术技能石等级 +1", "id": 452 },
              { "level": 2, "name": "破釜的", "value": "所有物理主动法术技能石等级 +2", "id": 453 }
          ],
          "元素&混沌技能石等级": [
              { "level": 1, "name": "火焰飞旋的", "value": "此物品上装备的【火焰技能石】等级 +1", "id": 454 },
              { "level": 2, "name": "岩浆呼唤的", "value": "此物品上装备的【火焰技能石】等级 +2", "id": 455 },
              { "level": 1, "name": "冰霜织女的", "value": "此物品上装备的【冰霜技能石】等级 +1", "id": 456 },
              { "level": 2, "name": "寒冰使者的", "value": "此物品上装备的【冰霜技能石】等级 +2", "id": 457 },
              { "level": 1, "name": "雷神的", "value": "此物品上装备的【闪电技能石】等级 +1", "id": 458 },
              { "level": 2, "name": "风暴王者的", "value": "此物品上装备的【闪电技能石】等级 +2", "id": 459 },
              { "level": 1, "name": "虚无主义的", "value": "此物品上装备的【混沌技能石】等级 +1", "id": 460 },
              { "level": 2, "name": "无序的", "value": "此物品上装备的【混沌技能石】等级 +2", "id": 461 }
          ],

          "物理攻击伤害转化为生命偷取": [
              { "level": 1, "name": "鲫鱼的", "value": "物理攻击伤害的 (0.2–0.4)% 会转化为生命偷取", "id": 462 },
              { "level": 2, "name": "七鳃鳗的", "value": "物理攻击伤害的 (0.6–0.8)% 会转化为生命偷取", "id": 463 },
              { "level": 3, "name": "吸血鬼的", "value": "物理攻击伤害的 (1–1.2)% 会转化为生命偷取", "id": 464 }
          ],
          "物理攻击伤害转化为魔力偷取": [
              { "level": 1, "name": "口渴的", "value": "物理攻击伤害的 (0.2–0.4)% 转化为魔力偷取", "id": 465 },
              { "level": 2, "name": "燥热的", "value": "物理攻击伤害的 (0.6–0.8)% 转化为魔力偷取", "id": 466 }
          ],

          "物理伤害提高": [
              { "name": "重量的", "value": "物理伤害提高 (40–49)%", "level": 1, "id": 467 },
              { "name": "锯齿的", "value": "物理伤害提高 (50–64)%", "level": 2, "id": 468 },
              { "name": "邪恶的", "value": "物理伤害提高 (65–84)%", "level": 3, "id": 469 },
              { "name": "狠毒的", "value": "物理伤害提高 (85–109)%", "level": 4, "id": 470 },
              { "name": "嗜血的", "value": "物理伤害提高 (110–134)%", "level": 5, "id": 471 },
              { "name": "残酷的", "value": "物理伤害提高 (135–154)%", "level": 6, "id": 472 },
              { "name": "强横的", "value": "物理伤害提高 (155–169)%", "level": 7, "id": 473 },
              { "name": "无情的", "value": "物理伤害提高 (170–179)%", "level": 8, "id": 474 }
          ],
          "物理伤害提高和命中值": [
              { "name": "侍从的", "value": "物理伤害提高(15–19)% & +(16–20) 命中值", "level": 1, "id": 475 },
              { "name": "旅人的", "value": "物理伤害提高(20–24)% & +(21–46) 命中值", "level": 2, "id": 476 },
              { "name": "掠夺者的", "value": "物理伤害提高(25–34)% & +(47–72) 命中值", "level": 3, "id": 477 },
              { "name": "佣兵的", "value": "物理伤害提高(35–44)% & +(73–97) 命中值", "level": 4, "id": 478 },
              { "name": "冠军的", "value": "物理伤害提高(45–54)% & +(98–123) 命中值", "level": 5, "id": 479 },
              { "name": "征服者的", "value": "物理伤害提高(55–64)% & +(124–149) 命中值", "level": 6, "id": 480 },
              { "name": "帝王的", "value": "物理伤害提高(65–74)% & +(150–174) 命中值", "level": 7, "id": 481 },
              { "name": "独裁者的", "value": "物理伤害提高(75–79)% & +(175–200) 命中值", "level": 8, "id": 482 }
          ],

          "弓类技能伤害提高": [
              { "name": "急性的", "value": "弓类技能伤害提高 (5–10)%", "level": 1, "id": 483 },
              { "name": "尖刻的", "value": "弓类技能伤害提高 (11–20)%", "level": 2, "id": 484 },
              { "name": "凿击的", "value": "弓类技能伤害提高 (21–30)%", "level": 3, "id": 485 },
              { "name": "锋尖的", "value": "弓类技能伤害提高 (31–36)%", "level": 4, "id": 486 },
              { "name": "破空的", "value": "弓类技能伤害提高 (37–42)%", "level": 5, "id": 487 },
              { "name": "穿刺的", "value": "弓类技能伤害提高 (43–50)%", "level": 6, "id": 488 }
          ],
          "额外箭矢": [
              { "level": 1, "name": "碎片之", "value": "弓类攻击发射一支额外箭矢", "id": 489 },
              { "level": 2, "name": "繁多之", "value": "弓类攻击发射2支额外箭矢", "id": 490 }
          ],
          "投射物速度加快":[
              { "name": "疾速之", "value": "投射物速度加快 (10–17)%", "level": 1, "id": 491 },
              { "name": "飞行之", "value": "投射物速度加快 (18–25)%", "level": 2, "id": 492 },
              { "name": "推进之", "value": "投射物速度加快 (26–33)%", "level": 3, "id": 493 },
              { "name": "和风之", "value": "投射物速度加快 (34–41)%", "level": 4, "id": 494 },
              { "name": "劲风之", "value": "投射物速度加快 (42–46)%", "level": 5, "id": 495 }
          ],
          "弓类攻击暴击伤害加成": [
              { "name": "怒火之", "value": "弓类攻击 +(8–12)% 暴击伤害加成", "level": 1, "id": 496 },
              { "name": "愤怒之", "value": "弓类攻击 +(13–19)% 暴击伤害加成", "level": 2, "id": 497 },
              { "name": "狂怒之", "value": "弓类攻击 +(20–24)% 暴击伤害加成", "level": 3, "id": 498 },
              { "name": "狂暴之", "value": "弓类攻击 +(25–29)% 暴击伤害加成", "level": 4, "id": 499 },
              { "name": "凶暴之", "value": "弓类攻击 +(30–34)% 暴击伤害加成", "level": 5, "id": 500 },
              { "name": "毁灭之", "value": "弓类攻击 +(35–38)% 暴击伤害加成", "level": 6, "id": 501 }
          ],
          "弓类攻击暴击率提高": [
              { "name": "针刺之", "value": "弓类攻击的暴击率提高 (10–14)%", "level": 1, "id": 502 },
              { "name": "刺痛之", "value": "弓类攻击的暴击率提高 (15–19)%", "level": 2, "id": 503 },
              { "name": "刺穿之", "value": "弓类攻击的暴击率提高 (20–24)%", "level": 3, "id": 504 },
              { "name": "破裂之", "value": "弓类攻击的暴击率提高 (25–29)%", "level": 4, "id": 505 },
              { "name": "穿透之", "value": "弓类攻击的暴击率提高 (30–34)%", "level": 5, "id": 506 },
              { "name": "手术之", "value": "弓类攻击的暴击率提高 (35–38)%", "level": 6, "id": 507 },
              { "name": "撕碎之", "value": "弓类攻击的暴击率提高 (39–44)%", "level": 7, "id": 508 }
          ],

          "最大生命": [
              { "level": 1, "value": "+(3–9) 最大生命", "name": "健壮的" },
              { "level": 2, "value": "+(10–19) 最大生命", "name": "健康的" },
              { "level": 3, "value": "+(20–29) 最大生命", "name": "乐观的" },
              { "level": 4, "value": "+(30–39) 最大生命", "name": "坚定的" },
              { "level": 5, "value": "+(40–49) 最大生命", "name": "粗壮的" },
              { "level": 6, "value": "+(50–59) 最大生命", "name": "健壮的" },
              { "level": 7, "value": "+(60–69) 最大生命", "name": "丰腴的" },
              { "level": 8, "value": "+(70–79) 最大生命", "name": "阳刚的" },
              { "name": "运动员的", "value": "+(80–89) 最大生命", "level": 9, "id": 509 },
              { "name": "丰饶的", "value": "+(90–99) 最大生命", "level": 10, "id": 510 },
              { "name": "蓬勃的", "value": "+(100–109) 最大生命", "level": 11, "id": 511 },
              { "name": "狂喜的", "value": "+(110–119) 最大生命", "level": 12, "id": 512 },
              { "name": "全盛的", "value": "+(120–129) 最大生命", "level": 13, "id": 513 }
          ],

          "最大魔力(单手)":[
              { "level": 1, "name": "绿宝石的", "value": "+(30–39) 最大魔力", "id": 514 },
              { "level": 2, "name": "钴蓝的", "value": "+(40–49) 最大魔力", "id": 515 },
              { "level": 3, "name": "湛蓝的", "value": "+(50–59) 最大魔力", "id": 516 },
              { "level": 4, "name": "蓝宝石的", "value": "+(60–69) 最大魔力", "id": 517 },
              { "level": 5, "name": "天蓝的", "value": "+(70–79) 最大魔力", "id": 518 },
              { "level": 6, "name": "水星的", "value": "+(80–89) 最大魔力", "id": 519 },
              { "level": 7, "name": "乳白色的", "value": "+(90–99) 最大魔力", "id": 520 },
              { "level": 8, "name": "龙胆的", "value": "+(100–109) 最大魔力", "id": 521 },
              { "level": 9, "name": "靛蓝的", "value": "+(110–119) 最大魔力", "id": 522 },
              { "level": 10, "name": "深蓝的", "value": "+(120–129) 最大魔力", "id": 523 },
              { "level": 11, "name": "蓝色的", "value": "+(130–139) 最大魔力", "id": 524 },
              { "level": 12, "name": "蓝釉的", "value": "+(140–159) 最大魔力", "id": 525 }
          ],
          "最大魔力(双手)": [
              { "level": 1, "name": "绿宝石的", "value": "+(40–49) 最大魔力", "id": 526 },
              { "level": 2, "name": "钴蓝的", "value": "+(50–59) 最大魔力", "id": 527 },
              { "level": 3, "name": "湛蓝的", "value": "+(60–69) 最大魔力", "id": 528 },
              { "level": 4, "name": "蓝宝石的", "value": "+(70–79) 最大魔力", "id": 529 },
              { "level": 5, "name": "天蓝的", "value": "+(80–89) 最大魔力", "id": 530 },
              { "level": 6, "name": "水星的", "value": "+(90–99) 最大魔力", "id": 531 },
              { "level": 7, "name": "乳白色的", "value": "+(100–119) 最大魔力", "id": 532 },
              { "level": 8, "name": "龙胆的", "value": "+(120–139) 最大魔力", "id": 533 },
              { "level": 9, "name": "靛蓝的", "value": "+(140–159) 最大魔力", "id": 534 },
              { "level": 10, "name": "深蓝的", "value": "+(160–179) 最大魔力", "id": 535 },
              { "level": 11, "name": "蓝色的", "value": "+(180–199) 最大魔力", "id": 536 },
              { "level": 12, "name": "蓝釉的", "value": "+(200–229) 最大魔力", "id": 537 }
          ],
          "最大魔力(非武器)": [
              { "name": "绿宝石的", "value": "+(15–19) 最大魔力", "level": 1, "id": 538 },
              { "name": "钴蓝的", "value": "+(20–24) 最大魔力", "level": 2, "id": 539 },
              { "name": "湛蓝的", "value": "+(25–29) 最大魔力", "level": 3, "id": 540 },
              { "name": "蓝宝石的", "value": "+(30–34) 最大魔力", "level": 4, "id": 541 },
              { "name": "天蓝的", "value": "+(35–39) 最大魔力", "level": 5, "id": 542 },
              { "name": "水星的", "value": "+(40–44) 最大魔力", "level": 6, "id": 543 },
              { "name": "乳白色的", "value": "+(45–49) 最大魔力", "level": 7, "id": 544 },
              { "name": "龙胆的", "value": "+(50–54) 最大魔力", "level": 8, "id": 545 },
              { "name": "靛蓝的", "value": "+(55–59) 最大魔力", "level": 9, "id": 546 },
              { "name": "深蓝的", "value": "+(60–64) 最大魔力", "level": 10, "id": 547 },
              { "name": "纯蓝的", "value": "+(65–68) 最大魔力", "level": 11, "id": 548 },
              { "name": "钴蓝的", "value": "+(69–73) 最大魔力", "level": 12, "id": 549 },
              { "name": "群青的", "value": "+(74–78) 最大魔力", "level": 13, "id": 550 }
          ],

          "最大能量护盾": [
              { "name": "发光的", "value": "+(1–3) 最大能量护盾", "level": 1, "id": 551 },
              { "name": "微光的", "value": "+(4–8) 最大能量护盾", "level": 2, "id": 552 },
              { "name": "闪闪发亮的", "value": "+(9–12) 最大能量护盾", "level": 3, "id": 553 },
              { "name": "泛光的", "value": "+(13–15) 最大能量护盾", "level": 4, "id": 554 },
              { "name": "辐射的", "value": "+(16–19) 最大能量护盾", "level": 5, "id": 555 },
              { "name": "脉冲的", "value": "+(20–22) 最大能量护盾", "level": 6, "id": 556 },
              { "name": "沸腾的", "value": "+(23–26) 最大能量护盾", "level": 7, "id": 557 },
              { "name": "炽烈的", "value": "+(27–31) 最大能量护盾", "level": 8, "id": 558 },
              { "name": "夺目的", "value": "+(32–37) 最大能量护盾", "level": 9, "id": 559 },
              { "name": "炽焰的", "value": "+(38–43) 最大能量护盾", "level": 10, "id": 560 },
              { "name": "灿烂的", "value": "+(44–47) 最大能量护盾", "level": 11, "id": 561 },
              { "name": "眩目的", "value": "+(48–51) 最大能量护盾", "level": 12, "id": 562 }
          ],
          "能量护盾上限提高(饰品)": [
              { "name": "保护的", "value": "(2–4)% 能量护盾上限提高", "level": 1, "id": 563 },
              { "name": "意志坚强的", "value": "(5–7)% 能量护盾上限提高", "level": 2, "id": 564 },
              { "name": "坚决的", "value": "(8–10)% 能量护盾上限提高", "level": 3, "id": 565 },
              { "name": "无惧的", "value": "(11–13)% 能量护盾上限提高", "level": 4, "id": 566 },
              { "name": "无畏的", "value": "(14–16)% 能量护盾上限提高", "level": 5, "id": 567 },
              { "name": "无法征服的", "value": "(17–19)% 能量护盾上限提高", "level": 6, "id": 568 },
              { "name": "坚不可摧的", "value": "(20–22)% 能量护盾上限提高", "level": 7, "id": 569 }
          ],
          "能量护盾充能时间提前": [
              { "name": "精力之", "value": "能量护盾充能时间提前 (27–34)%", "level": 1, "id": 570 },
              { "name": "风味之", "value": "能量护盾充能时间提前 (35–42)%", "level": 2, "id": 571 },
              { "name": "通电之", "value": "能量护盾充能时间提前 (43–50)%", "level": 3, "id": 572 },
              { "name": "活力之", "value": "能量护盾充能时间提前 (51–58)%", "level": 4, "id": 573 },
              { "name": "助力之风之", "value": "能量护盾充能时间提前 (59–66)%", "level": 5, "id": 574 }
          ],
          "能量护盾充能率提高":[
              {"name": "消减之", "value": "能量护盾充能率提高 (24–26)%", "level": 1, "id": 575 },
              {"name": "扩散之", "value": "能量护盾充能率提高 (27–29)%", "level": 2, "id": 576 },
              {"name": "散播之", "value": "能量护盾充能率提高 (30–32)%", "level": 3, "id": 577 },
              {"name": "缓冲之", "value": "能量护盾充能率提高 (33–35)%", "level": 4, "id": 578 },
              {"name": "灼情之", "value": "能量护盾充能率提高 (36–38)%", "level": 5, "id": 579 }
          ],

          "护甲": [
              { "name": "上漆的", "value": "+(3–10) 护甲", "level": 1, "id": 580 },
              { "name": "镶嵌的", "value": "+(11–35) 护甲", "level": 2, "id": 581 },
              { "name": "螺纹的", "value": "+(36–60) 护甲", "level": 3, "id": 582 },
              { "name": "强化的", "value": "+(61–138) 护甲", "level": 4, "id": 583 },
              { "name": "电镀的", "value": "+(139–322) 护甲", "level": 5, "id": 584 },
              { "name": "装甲化的", "value": "+(323–400) 护甲", "level": 6, "id": 585 },
              { "name": "围绕的", "value": "+(401–460) 护甲", "level": 7, "id": 586 },
              { "name": "包围的", "value": "+(461–540) 护甲", "level": 8, "id": 587 }
          ],

          "护甲提高(饰品)": [
              { "name": "增强的", "value": "(4–8)% 护甲提高", "level": 1, "id": 588 },
              { "name": "分层的", "value": "(9–13)% 护甲提高", "level": 2, "id": 589 },
              { "name": "甲壳的", "value": "(14–18)% 护甲提高", "level": 3, "id": 590 },
              { "name": "支持的", "value": "(19–23)% 护甲提高", "level": 4, "id": 591 },
              { "name": "加厚的", "value": "(24–28)% 护甲提高", "level": 5, "id": 592 },
              { "name": "围城的", "value": "(29–32)% 护甲提高", "level": 6, "id": 593 },
              { "name": "坚不可摧的", "value": "(33–36)% 护甲提高", "level": 7, "id": 594 }
          ],
          "闪避值提高(饰品)": [
              { "name": "敏捷的", "value": "(4–8)% 闪避值提高", "level": 1, "id": 595 },
              { "name": "舞者的", "value": "(9–13)% 闪避值提高", "level": 2, "id": 596 },
              { "name": "杂技的", "value": "(14–18)% 闪避值提高", "level": 3, "id": 597 },
              { "name": "飘忽的", "value": "(19–23)% 闪避值提高", "level": 4, "id": 598 },
              { "name": "模糊的", "value": "(24–28)% 闪避值提高", "level": 5, "id": 599 },
              { "name": "相位的", "value": "(29–32)% 闪避值提高", "level": 6, "id": 600 },
              { "name": "气态的", "value": "(33–36)% 闪避值提高", "level": 7, "id": 601 }
          ],

          "闪避值": [
              { "name": "敏捷的", "value": "(3–10) 点", "level": 1, "id": 602 },
              { "name": "舞者的", "value": "(11–35) 点", "level": 2, "id": 603 },
              { "name": "杂技的", "value": "(36–60) 点", "level": 3, "id": 604 },
              { "name": "飘忽的", "value": "(61–80) 点", "level": 4, "id": 605 },
              { "name": "模糊的", "value": "(81–120) 点", "level": 5, "id": 606 },
              { "name": "相位的", "value": "(121–150) 点", "level": 6, "id": 607 },
              { "name": "气态的", "value": "(151–170) 点", "level": 7, "id": 608 }
          ],

          "最大能量护盾(防具)": [
              { "name": "发光的", "value": "3-5 最大能量护盾", "level": 1, "id": 609 },
              { "name": "微光的", "value": "6-11 最大能量护盾", "level": 2, "id": 610 },
              { "name": "闪闪发亮的", "value": "12-16 最大能量护盾", "level": 3, "id": 611 },
              { "name": "泛光的", "value": "17-23 最大能量护盾", "level": 4, "id": 612 },
              { "name": "辐射的", "value": "24-30 最大能量护盾", "level": 5, "id": 613 },
              { "name": "脉冲的", "value": "31-38 最大能量护盾", "level": 6, "id": 614 },
              { "name": "沸腾的", "value": "39-49 最大能量护盾", "level": 7, "id": 615 },
              { "name": "炽烈的", "value": "50-61 最大能量护盾", "level": 8, "id": 616 },
              { "name": "夺目的", "value": "62-76 最大能量护盾", "level": 9, "id": 617 },
              { "name": "炽焰的", "value": "77-90 最大能量护盾", "level": 10, "id": 618 },
              { "name": "灿烂的", "value": "91-100 最大能量护盾", "level": 11, "id": 619 }
          ],
          "闪避值(防具)": [
              { "name": "敏捷的", "value": "6-12 点闪避值", "level": 1, "id": 620 },
              { "name": "舞者的", "value": "13-35 点闪避值", "level": 2, "id": 621 },
              { "name": "杂技的", "value": "36-63 点闪避值", "level": 3, "id": 622 },
              { "name": "飘忽的", "value": "64-82 点闪避值", "level": 4, "id": 623 },
              { "name": "模糊的", "value": "83-101 点闪避值", "level": 5, "id": 624 },
              { "name": "相位的", "value": "102-120 点闪避值", "level": 6, "id": 625 },
              { "name": "气态的", "value": "121-150 点闪避值", "level": 7, "id": 626 },
              { "name": "不可捉摸的", "value": "151-200 点闪避值", "level": 8, "id": 627 },
              { "name": "灵敏的", "value": "201-300 点闪避值", "level": 9, "id": 628 },
              { "name": "柔软的", "value": "301-400 点闪避值", "level": 10, "id": 629 },
              { "name": "易变的", "value": "401-500 点闪避值", "level": 11, "id": 630 }
          ],
          "护甲(防具)": [
              { "name": "上漆的", "value": "6-12 护甲", "level": 1, "id": 631 },
              { "name": "镶嵌的", "value": "13-35 护甲", "level": 2, "id": 632 },
              { "name": "螺纹的", "value": "36-63 护甲", "level": 3, "id": 633 },
              { "name": "强化的", "value": "64-82 护甲", "level": 4, "id": 634 },
              { "name": "电镀的", "value": "83-101 护甲", "level": 5, "id": 635 },
              { "name": "装甲化的", "value": "102-120 护甲", "level": 6, "id": 636 },
              { "name": "围绕的", "value": "121-150 护甲", "level": 7, "id": 637 },
              { "name": "包围的", "value": "151-200 护甲", "level": 8, "id": 638 },
              { "name": "柔缓的", "value": "201-300 护甲", "level": 9, "id": 639 },
              { "name": "不动的", "value": "301-400 护甲", "level": 10, "id": 640 },
              { "name": "无懈的", "value": "401-500 护甲", "level": 11, "id": 641 }
          ],
          "护甲和闪避值(防具)": [
              { "name": "柔韧的", "value": "5-9 护甲, 5-9 点闪避值", "level": 1, "id": 642 },
              { "name": "软绵的", "value": "10-27 护甲, 10-27 点闪避值", "level": 2, "id": 643 },
              { "name": "弹性的", "value": "28-48 护甲, 13-22 点闪避值", "level": 3, "id": 644 },
              { "name": "耐久的", "value": "49-85 护甲, 23-28 点闪避值", "level": 4, "id": 645 },
              { "name": "结实的", "value": "86-145 护甲, 29-48 点闪避值", "level": 5, "id": 646 },
              { "name": "弹力的", "value": "146-220 护甲, 49-60 点闪避值", "level": 6, "id": 647 },
              { "name": "可调的", "value": "221-300 护甲, 61-72 点闪避值", "level": 7, "id": 648 },
              { "name": "多用的", "value": "301-375 护甲, 73-80 点闪避值", "level": 8, "id": 649 }
          ],
          "护甲和能量护盾(防具)": [
              { "name": "受福的", "value": "5-9 护甲, 3-4 最大能量护盾", "level": 1, "id": 650 },
              { "name": "受膏的", "value": "10-27 护甲, 5-12 最大能量护盾", "level": 2, "id": 651 },
              { "name": "圣化的", "value": "28-48 护甲, 13-22 最大能量护盾", "level": 3, "id": 652 },
              { "name": "崇圣的", "value": "49-85 护甲, 23-28 最大能量护盾", "level": 4, "id": 653 },
              { "name": "赐福的", "value": "86-145 护甲, 29-48 最大能量护盾", "level": 5, "id": 654 },
              { "name": "奉献的", "value": "146-220 护甲, 49-60 最大能量护盾", "level": 6, "id": 655 },
              { "name": "圣洁的", "value": "221-300 护甲, 61-72 最大能量护盾", "level": 7, "id": 656 },
              { "name": "神样的", "value": "301-375 护甲, 73-80 最大能量护盾", "level": 8, "id": 657 }
          ],
          "闪避值和能量护盾(防具)": [
              { "name": "幽焰的", "value": "5-9 点闪避值, 3-4 最大能量护盾", "level": 1, "id": 658 },
              { "name": "仙子的", "value": "10-27 点闪避值, 5-12 最大能量护盾", "level": 2, "id": 659 },
              { "name": "仙精的", "value": "28-48 点闪避值, 13-22 最大能量护盾", "level": 3, "id": 660 },
              { "name": "仙灵的", "value": "49-85 点闪避值, 23-28 最大能量护盾", "level": 4, "id": 661 },
              { "name": "精魂的", "value": "86-145 点闪避值, 29-48 最大能量护盾", "level": 5, "id": 662 },
              { "name": "幻灵的", "value": "146-220 点闪避值, 49-60 最大能量护盾", "level": 6, "id": 663 },
              { "name": "容貌的", "value": "221-300 点闪避值, 61-72 最大能量护盾", "level": 7, "id": 664 },
              { "name": "幻象的", "value": "301-375 点闪避值, 73-80 最大能量护盾", "level": 8, "id": 665 }
          ],
          "护甲和最大生命(防具)": [
              { "name": "牡蛎的", "value": " +(20–32) 护甲, +(18–23) 最大生命", "level": 1, "id": 666 },
              { "name": "顽童的", "value": " +(33–48) 护甲, +(24–28) 最大生命", "level": 2, "id": 667 },
              { "name": "菊石的", "value": " +(49–96) 护甲, +(29–33) 最大生命", "level": 3, "id": 668 },
              { "name": "鳄鱼的", "value": " +(97–144) 护甲, +(34–38) 最大生命", "level": 4, "id": 669 }
          ],
          "闪避值和最大生命(防具)": [
              { "name": "跳蚤的", "value": "30 +(14–20) 点闪避值, +(18–23) 最大生命", "level": 1, "id": 670 },
              { "name": "幼鹿的", "value": "46 +(21–42) 点闪避值, +(24–28) 最大生命", "level": 2, "id": 671 },
              { "name": "公羊的", "value": "62 +(43–95) 点闪避值, +(29–33) 最大生命", "level": 3, "id": 672 },
              { "name": "山羊的", "value": "78 +(96–120) 点闪避值, +(34–38) 最大生命", "level": 4, "id": 673 }
          ],
          "能量护盾和最大生命(防具)": [
              { "name": "僧侣的", "value": "30 +(8–10) 最大能量护盾, +(18–23) 最大生命", "level": 1, "id": 674 },
              { "name": "院长的", "value": "46 +(11–15) 最大能量护盾, +(24–28) 最大生命", "level": 2, "id": 675 },
              { "name": "尊长的", "value": "62 +(16–25) 最大能量护盾, +(29–33) 最大生命", "level": 3, "id": 676 },
              { "name": "总督的", "value": "78 +(26–30) 最大能量护盾, +(34–38) 最大生命", "level": 4, "id": 677 }
          ],
          "能量护盾和最大魔力(防具)": [
              { "name": "侍僧的", "value": "30 +(8–10) 最大能量护盾, +(11–15) 最大魔力", "level": 1, "id": 678 },
              { "name": "辅祭的", "value": "46 +(11–15) 最大能量护盾, +(16–19) 最大魔力", "level": 2, "id": 679 },
              { "name": "祭司的", "value": "62 +(16–25) 最大能量护盾, +(20–22) 最大魔力", "level": 3, "id": 680 },
              { "name": "主教的", "value": "78 +(26–30) 最大能量护盾, +(23–25) 最大魔力", "level": 4, "id": 681 }
          ],

          "该装备的护甲,闪避,能量护盾提高":[
              { "name": "阴影的", "value": "该装备的护甲、闪避和能量护盾提高 (27–42)%", "level": 1, "id": 682 },
              { "name": "空灵的", "value": "该装备的护甲、闪避和能量护盾提高 (43–55)%", "level": 2, "id": 683 },
              { "name": "脱俗的", "value": "该装备的护甲、闪避和能量护盾提高 (56–67)%", "level": 3, "id": 684 },
              { "name": "无常的", "value": "该装备的护甲、闪避和能量护盾提高 (68–79)%", "level": 4, "id": 685 },
              { "name": "逝去的", "value": "该装备的护甲、闪避和能量护盾提高 (80–91)%", "level": 5, "id": 686 },
              { "name": "虚幻的", "value": "该装备的护甲、闪避和能量护盾提高 (92–100)%", "level": 6, "id": 687 },
              { "name": "无形的", "value": "该装备的护甲、闪避和能量护盾提高 (101–110)%", "level": 7, "id": 688 }
          ],
          "该装备的护甲,闪避,能量护盾提高 晕眩回复和格挡回复提高":[
              { "name": "蚊子的", "value": "该装备的护甲、闪避和能量护盾提高 (6–13)% 晕眩回复和格挡回复提高 (6–7)%", "level": 1, "id": 689 },
              { "name": "飞蛾的", "value": "该装备的护甲、闪避和能量护盾提高 (14–20)% 晕眩回复和格挡回复提高 (8–9)%", "level": 2, "id": 690 },
              { "name": "蝴蝶的", "value": "该装备的护甲、闪避和能量护盾提高 (21–26)% 晕眩回复和格挡回复提高 (10–11)%", "level": 3, "id": 691 },
              { "name": "黄蜂的", "value": "该装备的护甲、闪避和能量护盾提高 (27–32)% 晕眩回复和格挡回复提高 (12–13)%", "level": 4, "id": 692 },
              { "name": "蜻蜓的", "value": "该装备的护甲、闪避和能量护盾提高 (33–38)% 晕眩回复和格挡回复提高 (14–15)%", "level": 5, "id": 693 },
              { "name": "蜂鸟的", "value": "该装备的护甲、闪避和能量护盾提高 (39–42)% 晕眩回复和格挡回复提高 (16–17)%", "level": 6, "id": 694 }
          ],

          "该装备的护甲提高":[
              { "name": "增强的", "value": "该装备的护甲提高 (15–26)%", "level": 1, "id": 695 },
              { "name": "分层的", "value": "该装备的护甲提高 (27–42)%", "level": 2, "id": 696 },
              { "name": "甲壳的", "value": "该装备的护甲提高 (43–55)%", "level": 3, "id": 697 },
              { "name": "支持的", "value": "该装备的护甲提高 (56–67)%", "level": 4, "id": 698 },
              { "name": "加厚的", "value": "该装备的护甲提高 (68–79)%", "level": 5, "id": 699 },
              { "name": "围城的", "value": "该装备的护甲提高 (80–91)%", "level": 6, "id": 700 },
              { "name": "坚不可摧的", "value": "该装备的护甲提高 (92–100)%", "level": 7, "id": 701 },
              { "name": "无法通过的", "value": "该装备的护甲提高 (101–110)%", "level": 8, "id": 702 }
          ],
          "该装备的护甲提高 晕眩回复和格挡回复提高":[
              { "name": "甲虫的", "value": "该装备的护甲提高 (6–13)%, 晕眩回复和格挡回复提高 (6–7)%", "level": 1, "id": 703 },
              { "name": "螃蟹的", "value": "该装备的护甲提高 (14–20)%, 晕眩回复和格挡回复提高 (8–9)%", "level": 2, "id": 704 },
              { "name": "犰狳的", "value": "该装备的护甲提高 (21–26)%, 晕眩回复和格挡回复提高 (10–11)%", "level": 3, "id": 705 },
              { "name": "犀牛的", "value": "该装备的护甲提高 (27–32)%, 晕眩回复和格挡回复提高 (12–13)%", "level": 4, "id": 706 },
              { "name": "大象的", "value": "该装备的护甲提高 (33–38)%, 晕眩回复和格挡回复提高 (14–15)%", "level": 5, "id": 707 },
              { "name": "长毛象的", "value": "该装备的护甲提高 (39–42)%, 晕眩回复和格挡回复提高 (16–17)%", "level": 6, "id": 708 }
          ],
          "该装备的闪避提高":[
              { "name": "阴影的", "value": "该装备的护甲、闪避和能量护盾提高 (27–42)%", "level": 1, "id": 709 },
              { "name": "空灵的", "value": "该装备的护甲、闪避和能量护盾提高 (43–55)%", "level": 2, "id": 710 },
              { "name": "脱俗的", "value": "该装备的护甲、闪避和能量护盾提高 (56–67)%", "level": 3, "id": 711 },
              { "name": "无常的", "value": "该装备的护甲、闪避和能量护盾提高 (68–79)%", "level": 4, "id": 712 },
              { "name": "逝去的", "value": "该装备的护甲、闪避和能量护盾提高 (80–91)%", "level": 5, "id": 713 },
              { "name": "虚幻的", "value": "该装备的护甲、闪避和能量护盾提高 (92–100)%", "level": 6, "id": 714 },
              { "name": "无形的", "value": "该装备的护甲、闪避和能量护盾提高 (101–110)%", "level": 7, "id": 715 }
          ],
          "该装备的闪避提高 晕眩回复和格挡回复提高":[
              { "name": "蚊子的", "value": "该装备的护甲、闪避和能量护盾提高 (6–13)% 晕眩回复和格挡回复提高 (6–7)%", "level": 1, "id": 716 },
              { "name": "飞蛾的", "value": "该装备的护甲、闪避和能量护盾提高 (14–20)% 晕眩回复和格挡回复提高 (8–9)%", "level": 2, "id": 717 },
              { "name": "蝴蝶的", "value": "该装备的护甲、闪避和能量护盾提高 (21–26)% 晕眩回复和格挡回复提高 (10–11)%", "level": 3, "id": 718 },
              { "name": "黄蜂的", "value": "该装备的护甲、闪避和能量护盾提高 (27–32)% 晕眩回复和格挡回复提高 (12–13)%", "level": 4, "id": 719 },
              { "name": "蜻蜓的", "value": "该装备的护甲、闪避和能量护盾提高 (33–38)% 晕眩回复和格挡回复提高 (14–15)%", "level": 5, "id": 720 },
              { "name": "蜂鸟的", "value": "该装备的护甲、闪避和能量护盾提高 (39–42)% 晕眩回复和格挡回复提高 (16–17)%", "level": 6, "id": 721 }
          ],
          "该装备的能量护盾提高":[
              { "name": "保护的", "value": "该装备的能量护盾提高 (11–28)%", "level": 1, "id": 722 },
              { "name": "意志坚强的", "value": "该装备的能量护盾提高 (27–42)%", "level": 2, "id": 723 },
              { "name": "坚决的", "value": "该装备的能量护盾提高 (43–55)%", "level": 3, "id": 724 },
              { "name": "无惧的", "value": "该装备的能量护盾提高 (56–67)%", "level": 4, "id": 725 },
              { "name": "无畏的", "value": "该装备的能量护盾提高 (68–79)%", "level": 5, "id": 726 },
              { "name": "无法征服的", "value": "该装备的能量护盾提高 (80–91)%", "level": 6, "id": 727 },
              { "name": "坚不可摧的", "value": "该装备的能量护盾提高 (92–100)%", "level": 7, "id": 728 },
              { "name": "稳步坚决的", "value": "该装备的能量护盾提高 (101–110)%", "level": 8, "id": 729 }
          ],
          "该装备的能量护盾提高 晕眩回复和格挡回复提高":[
              { "name": "妖精的", "value": "该装备的能量护盾提高 (6–13)% 晕眩回复和格挡回复提高 (6–7)%", "level": 1, "id": 730 },
              { "name": "小魔怪的", "value": "该装备的能量护盾提高 (14–20)% 晕眩回复和格挡回复提高 (8–9)%", "level": 2, "id": 731 },
              { "name": "幻形怪的", "value": "该装备的能量护盾提高 (21–26)% 晕眩回复和格挡回复提高 (10–11)%", "level": 3, "id": 732 },
              { "name": "纳迦的", "value": "该装备的能量护盾提高 (27–32)% 晕眩回复和格挡回复提高 (12–13)%", "level": 4, "id": 733 },
              { "name": "巨灵的", "value": "该装备的能量护盾提高 (33–38)% 晕眩回复和格挡回复提高 (14–15)%", "level": 5, "id": 734 },
              { "name": "六翼天使的", "value": "该装备的能量护盾提高 (39–42)% 晕眩回复和格挡回复提高 (16–17)%", "level": 6, "id": 735 }
          ],

          "该装备的护甲,闪避提高":[
              { "name": "拆解的", "value": "该装备的护甲与闪避提高 (15–26)%", "level": 1, "id": 736 },
              { "name": "打斗者的", "value": "该装备的护甲与闪避提高 (27–42)%", "level": 2, "id": 737 },
              { "name": "击剑士的", "value": "该装备的护甲与闪避提高 (43–55)%", "level": 3, "id": 738 },
              { "name": "角斗士的", "value": "该装备的护甲与闪避提高 (56–67)%", "level": 4, "id": 739 },
              { "name": "决斗的", "value": "该装备的护甲与闪避提高 (68–79)%", "level": 5, "id": 740 },
              { "name": "英雄的", "value": "该装备的护甲与闪避提高 (80–91)%", "level": 6, "id": 741 },
              { "name": "传说的", "value": "该装备的护甲与闪避提高 (92–100)%", "level": 7, "id": 742 },
              { "name": "胜利的", "value": "该装备的护甲与闪避提高 (101–110)%", "level": 8, "id": 743 }
          ],
          "该装备的护甲,闪避提高 晕眩回复和格挡回复提高":[
              { "name": "甲虫的", "value": "该装备的护甲与闪避提高 (6–13)% 晕眩回复和格挡回复提高 (6–7)%", "level": 1, "id": 744 },
              { "name": "螃蟹的", "value": "该装备的护甲与闪避提高 (14–20)% 晕眩回复和格挡回复提高 (8–9)%", "level": 2, "id": 745 },
              { "name": "犰狳的", "value": "该装备的护甲与闪避提高 (21–26)% 晕眩回复和格挡回复提高 (10–11)%", "level": 3, "id": 746 },
              { "name": "犀牛的", "value": "该装备的护甲与闪避提高 (27–32)% 晕眩回复和格挡回复提高 (12–13)%", "level": 4, "id": 747 },
              { "name": "大象的", "value": "该装备的护甲与闪避提高 (33–38)% 晕眩回复和格挡回复提高 (14–15)%", "level": 5, "id": 748 },
              { "name": "长毛象的", "value": "该装备的护甲与闪避提高 (39–42)% 晕眩回复和格挡回复提高 (16–17)%", "level": 6, "id": 749 }
          ],
          "该装备的护甲,能量护盾提高":[
              { "name": "嵌入的", "value": "该装备的护甲与能量护盾提高 (15–26)%", "level": 1, "id": 750 },
              { "name": "扎根的", "value": "该装备的护甲与能量护盾提高 (27–42)%", "level": 2, "id": 751 },
              { "name": "灌输的", "value": "该装备的护甲与能量护盾提高 (43–55)%", "level": 3, "id": 752 },
              { "name": "灌注的", "value": "该装备的护甲与能量护盾提高 (56–67)%", "level": 4, "id": 753 },
              { "name": "重灌的", "value": "该装备的护甲与能量护盾提高 (68–79)%", "level": 5, "id": 754 },
              { "name": "窜改的", "value": "该装备的护甲与能量护盾提高 (80–91)%", "level": 6, "id": 755 },
              { "name": "鼓舞的", "value": "该装备的护甲与能量护盾提高 (92–100)%", "level": 7, "id": 756 },
              { "name": "渗入的", "value": "该装备的护甲与能量护盾提高 (101–110)%", "level": 8, "id": 757 }
          ],
          "该装备的护甲,能量护盾提高 晕眩回复和格挡回复提高":[
              { "name": "妖精的", "value": "该装备的护甲与能量护盾提高 (6–13)% 晕眩回复和格挡回复提高 (6–7)%", "level": 1, "id": 758 },
              { "name": "小魔怪的", "value": "该装备的护甲与能量护盾提高 (14–20)% 晕眩回复和格挡回复提高 (8–9)%", "level": 2, "id": 759 },
              { "name": "幻形怪的", "value": "该装备的护甲与能量护盾提高 (21–26)% 晕眩回复和格挡回复提高 (10–11)%", "level": 3, "id": 760 },
              { "name": "纳迦的", "value": "该装备的护甲与能量护盾提高 (27–32)% 晕眩回复和格挡回复提高 (12–13)%", "level": 4, "id": 761 },
              { "name": "巨灵的", "value": "该装备的护甲与能量护盾提高 (33–38)% 晕眩回复和格挡回复提高 (14–15)%", "level": 5, "id": 762 },
              { "name": "六翼天使的", "value": "该装备的护甲与能量护盾提高 (39–42)% 晕眩回复和格挡回复提高 (16–17)%", "level": 6, "id": 763 }
          ],
          "该装备的闪避,能量护盾提高":[
              { "name": "阴影的", "value": "该装备的闪避与能量护盾提高 (15–26)%", "level": 1, "id": 764 },
              { "name": "空灵的", "value": "该装备的闪避与能量护盾提高 (27–42)%", "level": 2, "id": 765 },
              { "name": "脱俗的", "value": "该装备的闪避与能量护盾提高 (43–55)%", "level": 3, "id": 766 },
              { "name": "无常的", "value": "该装备的闪避与能量护盾提高 (56–67)%", "level": 4, "id": 767 },
              { "name": "逝去的", "value": "该装备的闪避与能量护盾提高 (68–79)%", "level": 5, "id": 768 },
              { "name": "虚幻的", "value": "该装备的闪避与能量护盾提高 (80–91)%", "level": 6, "id": 769 },
              { "name": "幻觉的", "value": "该装备的闪避与能量护盾提高 (92–100)%", "level": 7, "id": 770 },
              { "name": "无形的", "value": "该装备的闪避与能量护盾提高 (101–110)%", "level": 8, "id": 771 }
          ],
          "该装备的闪避,能量护盾提高 晕眩回复和格挡回复提高":[
              {"name": "蚊子的", "value": "该装备的闪避与能量护盾提高 (6–13)% 晕眩回复和格挡回复提高 (6–7)%", "level": 1, "id": 772 },
              {"name": "飞蛾的", "value": "该装备的闪避与能量护盾提高 (14–20)% 晕眩回复和格挡回复提高 (8–9)%", "level": 2, "id": 773 },
              {"name": "蝴蝶的", "value": "该装备的闪避与能量护盾提高 (21–26)% 晕眩回复和格挡回复提高 (10–11)%", "level": 3, "id": 774 },
              {"name": "黄蜂的", "value": "该装备的闪避与能量护盾提高 (27–32)% 晕眩回复和格挡回复提高 (12–13)%", "level": 4, "id": 775 },
              {"name": "蜻蜓的", "value": "该装备的闪避与能量护盾提高 (33–38)% 晕眩回复和格挡回复提高 (14–15)%", "level": 5, "id": 776 },
              {"name": "蜂鸟的", "value": "该装备的闪避与能量护盾提高 (39–42)% 晕眩回复和格挡回复提高 (16–17)%", "level": 6, "id": 777 }
          ],

          "力量": [
              { "level": 1, "name": "野蛮之", "value": "+(8–12) 力量", "id": 778 },
              { "level": 2, "name": "摔角手之", "value": "+(13–17) 力量", "id": 779 },
              { "level": 3, "name": "熊之", "value": "+(18–22) 力量", "id": 780 },
              { "level": 4, "name": "狮子之", "value": "+(23–27) 力量", "id": 781 },
              { "level": 5, "name": "大猩猩之", "value": "+(28–32) 力量", "id": 782 },
              { "level": 6, "name": "巨人之", "value": "+(33–37) 力量", "id": 783 },
              { "level": 7, "name": "海兽之", "value": "+(38–42) 力量", "id": 784 },
              { "level": 8, "name": "泰坦之", "value": "+(43–50) 力量", "id": 785 },
              { "level": 9, "name": "众神之", "value": "+(51–55) 力量", "id": 786 },
              { "level": 10, "name": "弑神之", "value": "+(56–60) 力量", "id": 787 }
          ],
          "敏捷": [
              { "level": 1, "name": "猫鼬之", "value": "+(8–12) 敏捷", "id": 788 },
              { "level": 2, "name": "山猫之", "value": "+(13–17) 敏捷", "id": 789 },
              { "level": 3, "name": "狐狸之", "value": "+(18–22) 敏捷", "id": 790 },
              { "level": 4, "name": "猎鹰之", "value": "+(23–27) 敏捷", "id": 791 },
              { "level": 5, "name": "豹之", "value": "+(28–32) 敏捷", "id": 792 },
              { "level": 6, "name": "花豹之", "value": "+(33–37) 敏捷", "id": 793 },
              { "level": 7, "name": "美洲豹之", "value": "+(38–42) 敏捷", "id": 794 },
              { "level": 8, "name": "幻影之", "value": "+(43–50) 敏捷", "id": 795 },
              { "level": 9, "name": "风之", "value": "+(51–55) 敏捷", "id": 796 },
              { "level": 10, "name": "迷幻之", "value": "+(56–60) 敏捷", "id": 797 }
          ],
          "智慧": [
              { "level": 1, "name": "瞳孔之", "value": "+(8–12) 智慧", "id": 798 },
              { "level": 2, "name": "学徒之", "value": "+(13–17) 智慧", "id": 799 },
              { "level": 3, "name": "奇才之", "value": "+(18–22) 智慧", "id": 800 },
              { "level": 4, "name": "预言之", "value": "+(23–27) 智慧", "id": 801 },
              { "level": 5, "name": "哲学家之", "value": "+(28–32) 智慧", "id": 802 },
              { "level": 6, "name": "圣人之", "value": "+(33–37) 智慧", "id": 803 },
              { "level": 7, "name": "大学者之", "value": "+(38–42) 智慧", "id": 804 },
              { "level": 8, "name": "神技之", "value": "+(43–50) 智慧", "id": 805 },
              { "level": 9, "name": "天才之", "value": "+(51–55) 智慧", "id": 806 },
              { "level": 10, "name": "博学之", "value": "+(56–60) 智慧", "id": 807 }
          ],
          "全属性": [
              { "name": "云端之", "value": "+(1–4) 全属性", "level": 1, "id": 808 },
              { "name": "天空之", "value": "+(5–8) 全属性", "level": 2, "id": 809 },
              { "name": "流星之", "value": "+(9–12) 全属性", "level": 3, "id": 810 },
              { "name": "彗星之", "value": "+(13–16) 全属性", "level": 4, "id": 811 },
              { "name": "天堂之", "value": "+(17–20) 全属性", "level": 5, "id": 812 },
              { "name": "银河之", "value": "+(21–24) 全属性", "level": 6, "id": 813 },
              { "name": "宇宙之", "value": "+(25–28) 全属性", "level": 7, "id": 814 },
              { "name": "无限之", "value": "+(29–32) 全属性", "level": 8, "id": 815 },
              { "name": "多维之", "value": "+(33–35) 全属性", "level": 9, "id": 816 }
          ],

          "攻击速度加快": [
              { "level": 1, "name": "技巧之", "value": "攻击速度加快 (5–7)%", "id": 817 },
              { "level": 2, "name": "轻松之", "value": "攻击速度加快 (8–10)%", "id": 818 },
              { "level": 3, "name": "成熟之", "value": "攻击速度加快 (11–13)%", "id": 819 },
              { "level": 4, "name": "声望之", "value": "攻击速度加快 (14–16)%", "id": 820 },
              { "level": 5, "name": "喝采之", "value": "攻击速度加快 (17–19)%", "id": 821 },
              { "level": 6, "name": "名声之", "value": "攻击速度加快 (20–22)%", "id": 822 },
              { "level": 7, "name": "恶名之", "value": "攻击速度加快 (23–25)%", "id": 823 },
              { "level": 8, "name": "庆祝之", "value": "攻击速度加快 (26–27)%", "id": 824 }
          ],
          "施法速度加快": [
              { "level": 1, "value": "施法速度加快 (5–8)%", "name": "人才之" },
              { "level": 2, "value": "施法速度加快 (9–12)%", "name": "灵活应变之" },
              { "level": 3, "value": "施法速度加快 (13–16)%", "name": "有经验之" },
              { "level": 4, "value": "施法速度加快 (17–20)%", "name": "障眼法之" },
              { "level": 5, "value": "施法速度加快 (21–24)%", "name": "伎俩之" },
              { "level": 6, "value": "施法速度加快 (25–28)%", "name": "巫术之" },
              { "level": 7, "value": "施法速度加快 (29–32)%", "name": "娴熟之" }
          ],
          "施法速度加快(长杖)": [
              { "level": 1, "value": "施法速度加快 (8-13)%", "name": "人才之" },
              { "level": 2, "value": "施法速度加快 (14-19)%", "name": "灵活应变之" },
              { "level": 3, "value": "施法速度加快 (20-25)%", "name": "有经验之" },
              { "level": 4, "value": "施法速度加快 (26-31)%", "name": "障眼法之" },
              { "level": 5, "value": "施法速度加快 (32-37)%", "name": "伎俩之" },
              { "level": 6, "value": "施法速度加快 (38-43)%", "name": "巫术之" },
              { "level": 7, "value": "施法速度加快 (44-49)%", "name": "娴熟之" }
          ],

          "火焰抗性": [
              { "level": 1, "name": "幼龙之", "value": "+(6–11)% 火焰抗性", "id": 825 },
              { "level": 2, "name": "火蜥蜴之", "value": "+(12–17)% 火焰抗性", "id": 826 },
              { "level": 3, "name": "火龙之", "value": "+(18–23)% 火焰抗性", "id": 827 },
              { "level": 4, "name": "窑炉之", "value": "+(24–29)% 火焰抗性", "id": 828 },
              { "level": 5, "name": "炉火之", "value": "+(30–35)% 火焰抗性", "id": 829 },
              { "level": 6, "name": "火山之", "value": "+(36–41)% 火焰抗性", "id": 830 },
              { "level": 7, "name": "岩浆之", "value": "+(42–45)% 火焰抗性", "id": 831 },
              { "level": 8, "name": "提耶须之", "value": "+(46–48)% 火焰抗性", "id": 832 }
          ],
          "冰霜抗性": [
              { "level": 1, "name": "北方民族之", "value": "+(6–11)% 冰霜抗性", "id": 833 },
              { "level": 2, "name": "海豹之", "value": "+(12–17)% 冰霜抗性", "id": 834 },
              { "level": 3, "name": "企鹅之", "value": "+(18–23)% 冰霜抗性", "id": 835 },
              { "level": 4, "name": "雪人之", "value": "+(24–29)% 冰霜抗性", "id": 836 },
              { "level": 5, "name": "海象之", "value": "+(30–35)% 冰霜抗性", "id": 837 },
              { "level": 6, "name": "北极熊之", "value": "+(36–41)% 冰霜抗性", "id": 838 },
              { "level": 7, "name": "冰之", "value": "+(42–45)% 冰霜抗性", "id": 839 },
              { "level": 8, "name": "哈斯特之", "value": "+(46–48)% 冰霜抗性", "id": 840 }
          ],
          "闪电抗性": [
              { "level": 1, "name": "云朵之", "value": "+(6–11)% 闪电抗性", "id": 841 },
              { "level": 2, "name": "冰雹之", "value": "+(12–17)% 闪电抗性", "id": 842 },
              { "level": 3, "name": "暴风之", "value": "+(18–23)% 闪电抗性", "id": 843 },
              { "level": 4, "name": "积雨云之", "value": "+(24–29)% 闪电抗性", "id": 844 },
              { "level": 5, "name": "暴风雨之", "value": "+(30–35)% 闪电抗性", "id": 845 },
              { "level": 6, "name": "台风之", "value": "+(36–41)% 闪电抗性", "id": 846 },
              { "level": 7, "name": "电之", "value": "+(42–45)% 闪电抗性", "id": 847 },
              { "level": 8, "name": "艾菲吉之", "value": "+(46–48)% 闪电抗性", "id": 848 }
          ],
          "混沌抗性": [
              { "level": 1, "name": "失落之", "value": "+(5–10)% 混沌抗性", "id": 849 },
              { "level": 2, "name": "放逐之", "value": "+(11–15)% 混沌抗性", "id": 850 },
              { "level": 3, "name": "驱逐之", "value": "+(16–20)% 混沌抗性", "id": 851 },
              { "level": 4, "name": "出境之", "value": "+(21–25)% 混沌抗性", "id": 852 },
              { "level": 5, "name": "流亡之", "value": "+(26–30)% 混沌抗性", "id": 853 },
              { "level": 6, "name": "巴曼斯之", "value": "+(31–35)% 混沌抗性", "id": 854 }
          ],
          "所有元素抗性": [
              { "name": "水晶之", "value": "所有元素抗性(3–5)%", "level": 1, "id": 855 },
              { "name": "棱镜之", "value": "所有元素抗性(6–8)%", "level": 2, "id": 856 },
              { "name": "万花筒之", "value": "所有元素抗性(9–11)%", "level": 3, "id": 857 },
              { "name": "多彩之", "value": "所有元素抗性(12–14)%", "level": 4, "id": 858 },
              { "name": "彩虹之", "value": "所有元素抗性(15–16)%", "level": 5, "id": 859 },
              { "name": "博色之", "value": "所有元素抗性(17–18)%", "level": 6, "id": 860 }
          ],

          "火焰伤害": [
              { "level": 1, "name": "余烬之", "value": "(3–7)% 火焰伤害提高", "id": 861 },
              { "level": 2, "name": "煤之", "value": "(8–12)% 火焰伤害提高", "id": 862 },
              { "level": 3, "name": "灰烬之", "value": "(13–17)% 火焰伤害提高", "id": 863 },
              { "level": 4, "name": "烈焰之", "value": "(18–22)% 火焰伤害提高", "id": 864 },
              { "level": 5, "name": "献祭之", "value": "(23–26)% 火焰伤害提高", "id": 865 },
              { "level": 6, "name": "骨灰之", "value": "(27–30)% 火焰伤害提高", "id": 866 }
          ],
          "冰霜伤害": [
              { "level": 1, "name": "雪之", "value": "(3–7)% 冰霜伤害提高", "id": 867 },
              { "level": 2, "name": "雨雪之", "value": "(8–12)% 冰霜伤害提高", "id": 868 },
              { "level": 3, "name": "冰之", "value": "(13–17)% 冰霜伤害提高", "id": 869 },
              { "level": 4, "name": "雾凇之", "value": "(18–22)% 冰霜伤害提高", "id": 870 },
              { "level": 5, "name": "浮冰之", "value": "(23–26)% 冰霜伤害提高", "id": 871 },
              { "level": 6, "name": "冰河时期之", "value": "(27–30)% 冰霜伤害提高", "id": 872 }
          ],
          "闪电伤害": [
              { "level": 1, "name": "火花之", "value": "(3–7)% 闪电伤害提高", "id": 873 },
              { "level": 2, "name": "静电之", "value": "(8–12)% 闪电伤害提高", "id": 874 },
              { "level": 3, "name": "电能之", "value": "(13–17)% 闪电伤害提高", "id": 875 },
              { "level": 4, "name": "伏特之", "value": "(18–22)% 闪电伤害提高", "id": 876 },
              { "level": 5, "name": "放电之", "value": "(23–26)% 闪电伤害提高", "id": 877 },
              { "level": 6, "name": "电弧之", "value": "(27–30)% 闪电伤害提高", "id": 878 }
          ],

          "敌人被晕眩时间延长": [
              { "level": 1, "name": "冲击之", "value": "敌人被晕眩时间延长 (11–15)%", "id": 879 },
              { "level": 2, "name": "晕眩之", "value": "敌人被晕眩时间延长 (16–20)%", "id": 880 },
              { "level": 3, "name": "击晕之", "value": "敌人被晕眩时间延长 (21–25)%", "id": 881 },
              { "level": 4, "name": "轰击之", "value": "敌人被晕眩时间延长 (26–30)%", "id": 882 },
              { "level": 5, "name": "蹒跚之", "value": "敌人被晕眩时间延长 (31–35)%", "id": 883 }
          ],
          "敌人晕眩门槛降低": [
              { "level": 1, "name": "拳击之", "value": "敌人晕眩门槛降低 (5–7)%", "id": 884 },
              { "level": 2, "name": "打斗之", "value": "敌人晕眩门槛降低 (8–9)%", "id": 885 },
              { "level": 3, "name": "格斗家之", "value": "敌人晕眩门槛降低 (10–11)%", "id": 886 },
              { "level": 4, "name": "战斗之", "value": "敌人晕眩门槛降低 (12–13)%", "id": 887 },
              { "level": 5, "name": "角斗士之", "value": "敌人晕眩门槛降低 (14–15)%", "id": 888 }
          ],

          "击中回血": [
              { "level": 1, "name": "回春之", "value": "每击中一名敌人获得 2 点生命", "id": 889 },
              { "level": 2, "name": "恢复之", "value": "每击中一名敌人获得 3 点生命", "id": 890 },
              { "level": 3, "name": "再生之", "value": "每击中一名敌人获得 4 点生命", "id": 891 },
              { "level": 4, "name": "营养之", "value": "每击中一名敌人获得 5 点生命", "id": 892 }
          ],
          "击败回血": [
              { "level": 1, "name": "成功之", "value": "每击败一名敌人获得 (3–6) 点生命", "id": 893 },
              { "level": 2, "name": "胜利之", "value": "每击败一名敌人获得 (7–10) 点生命", "id": 894 },
              { "level": 3, "name": "凯旋之", "value": "每击败一名敌人获得 (11–14) 点生命", "id": 895 }
          ],
          "击败回蓝": [
              { "level": 1, "name": "吸收之", "value": "每击败一名敌人获得 1 点魔力", "id": 896 },
              { "level": 2, "name": "逆渗透之", "value": "每击败一名敌人获得 (2–3) 点魔力", "id": 897 },
              { "level": 3, "name": "消耗之", "value": "每击败一名敌人获得 (4–6) 点魔力", "id": 898 }
          ],

          "生命每秒再生": [
              { "name": "蝾螈之", "value": "生命每秒再生 (1–2)", "level": 1, "id": 899 },
              { "name": "蜥蜴之", "value": "生命每秒再生 (2.1–8)", "level": 2, "id": 900 },
              { "name": "海星之", "value": "生命每秒再生 (8.1–16)", "level": 3, "id": 901 },
              { "name": "九头蛇之", "value": "生命每秒再生 (16.1–24)", "level": 4, "id": 902 },
              { "name": "食人妖之", "value": "生命每秒再生 (24.1–32)", "level": 5, "id": 903 },
              { "name": "食人之", "value": "生命每秒再生 (32.1–48)", "level": 6, "id": 904 },
              { "name": "瑞斯拉萨之", "value": "生命每秒再生 (48.1–64)", "level": 7, "id": 905 },
              { "name": "凤凰之", "value": "生命每秒再生 (64.1–96)", "level": 8, "id": 906 },
              { "name": "复原之", "value": "生命每秒再生 (96.1–128)", "level": 9, "id": 907 },
              { "name": "康复之", "value": "生命每秒再生 (128.1–192)", "level": 10 }
          ],
          "魔力再生率提高": [
              { "level": 1, "name": "兴奋之", "value": "魔力再生率提高 (10–19)%", "id": 908 },
              { "level": 2, "name": "喜悦之", "value": "魔力再生率提高 (20–29)%", "id": 909 },
              { "level": 3, "name": "兴高采烈之", "value": "魔力再生率提高 (30–39)%", "id": 910 },
              { "level": 4, "name": "极乐之", "value": "魔力再生率提高 (40–49)%", "id": 911 },
              { "level": 5, "name": "幸福之", "value": "魔力再生率提高 (50–59)%", "id": 912 },
              { "level": 6, "name": "涅盘之", "value": "魔力再生率提高 (60–69)%", "id": 913 }
          ],
          "生命再生率提高": [
              {"name": "精神之", "value": "生命再生率提高 (9–11)%", "level": 1, "id": 914 },
              {"name": "永恒之", "value": "生命再生率提高 (12–14)%", "level": 2, "id": 915 },
              {"name": "苏生之", "value": "生命再生率提高 (15–17)%", "level": 3, "id": 916 },
              {"name": "年轻之", "value": "生命再生率提高 (18–19)%", "level": 4, "id": 917 },
              {"name": "恒久之", "value": "生命再生率提高 (20–21)%", "level": 5, "id": 918 }
          ],

          "点燃概率(单手)": [
              { "level": 1, "name": "点燃之", "value": "有 10% 的几率点燃", "id": 919 },
              { "level": 2, "name": "灼烧之", "value": "有 15% 的几率点燃", "id": 920 },
              { "level": 3, "name": "燃爆之", "value": "有 20% 的几率点燃", "id": 921 }
          ],
          "冻结概率(单手)": [
              { "level": 1, "name": "冰冻之", "value": "有 10% 的几率造成冻结状态", "id": 922 },
              { "level": 2, "name": "黯淡之", "value": "有 15% 的几率造成冻结状态", "id": 923 },
              { "level": 3, "name": "北风呼啸之", "value": "有 20% 的几率造成冻结状态", "id": 924 }
          ],
          "感电概率(单手)": [
              { "level": 1, "name": "导电之", "value": "闪电伤害击中时有 10% 的几率使敌人受到感电效果影响", "id": 925 },
              { "level": 2, "name": "摧毁之", "value": "闪电伤害击中时有 15% 的几率使敌人受到感电效果影响", "id": 926 },
              { "level": 3, "name": "电殛之", "value": "闪电伤害击中时有 20% 的几率使敌人受到感电效果影响", "id": 927 }
          ],

          "点燃概率(双手)": [
              { "level": 1, "name": "点燃之", "value": "有 20% 的几率点燃", "id": 928 },
              { "level": 2, "name": "灼烧之", "value": "有 25% 的几率点燃", "id": 929 },
              { "level": 3, "name": "燃爆之", "value": "有 30% 的几率点燃", "id": 930 }
          ],
          "冻结概率(双手)": [
              { "level": 1, "name": "冰冻之", "value": "有 20% 的几率造成冻结状态", "id": 931 },
              { "level": 2, "name": "黯淡之", "value": "有 25% 的几率造成冻结状态", "id": 932 },
              { "level": 3, "name": "北风呼啸之", "value": "有 30% 的几率造成冻结状态", "id": 933 }
          ],
          "感电概率(双手)": [
              { "level": 1, "name": "导电之", "value": "闪电伤害击中时有 20% 的几率使敌人受到感电效果影响", "id": 934 },
              { "level": 2, "name": "摧毁之", "value": "闪电伤害击中时有 25% 的几率使敌人受到感电效果影响", "id": 935 },
              { "level": 3, "name": "电殛之", "value": "闪电伤害击中时有 30% 的几率使敌人受到感电效果影响", "id": 936 }
          ],

          "武器攻击暴击率": [
              { "level": 1, "name": "针刺之", "value": "该装备的攻击暴击率提高 (10–14)%", "id": 937 },
              { "level": 2, "name": "刺痛之", "value": "该装备的攻击暴击率提高 (15–19)%", "id": 938 },
              { "level": 3, "name": "刺穿之", "value": "该装备的攻击暴击率提高 (20–24)%", "id": 939 },
              { "level": 4, "name": "穿孔之", "value": "该装备的攻击暴击率提高 (25–29)%", "id": 940 },
              { "level": 5, "name": "穿透之", "value": "该装备的攻击暴击率提高 (30–34)%", "id": 941 },
              { "level": 6, "name": "手术之", "value": "该装备的攻击暴击率提高 (35–38)%", "id": 942 }
          ],
          "法术暴击率提高": [
              { "level": 1, "name": "威胁之", "value": "(10–19)% 法术暴击率提高", "id": 943 },
              { "level": 2, "name": "浩劫之", "value": "(20–39)% 法术暴击率提高", "id": 944 },
              { "level": 3, "name": "灾害之", "value": "(40–59)% 法术暴击率提高", "id": 945 },
              { "level": 4, "name": "灾难之", "value": "(60–79)% 法术暴击率提高", "id": 946 },
              { "level": 5, "name": "灭绝之", "value": "(80–99)% 法术暴击率提高", "id": 947 },
              { "level": 6, "name": "解构之", "value": "(100–109)% 法术暴击率提高", "id": 948 }
          ],
          "全域暴击伤害加成": [
              { "level": 1, "name": "怒火之", "value": "全域暴击伤害加成 +(10–14)%", "id": 949 },
              { "level": 2, "name": "愤怒之", "value": "全域暴击伤害加成 +(15–19)%", "id": 950 },
              { "level": 3, "name": "狂怒之", "value": "全域暴击伤害加成 +(20–24)%", "id": 951 },
              { "level": 4, "name": "狂暴之", "value": "全域暴击伤害加成 +(25–29)%", "id": 952 },
              { "level": 5, "name": "凶暴之", "value": "全域暴击伤害加成 +(30–34)%", "id": 953 },
              { "level": 6, "name": "毁灭之", "value": "全域暴击伤害加成 +(35–38)%", "id": 954 }
          ],
          "全域暴击率提高": [
              { "name": "针刺之", "value": "全域暴击率提高(10–14)%", "level": 1, "id": 955 },
              { "name": "刺痛之", "value": "全域暴击率提高(15–19)%", "level": 2, "id": 956 },
              { "name": "刺穿之", "value": "全域暴击率提高(20–24)%", "level": 3, "id": 957 },
              { "name": "破裂之", "value": "全域暴击率提高(25–29)%", "level": 4, "id": 958 },
              { "name": "穿透之", "value": "全域暴击率提高(30–34)%", "level": 5, "id": 959 },
              { "name": "手术之", "value": "全域暴击率提高(35–38)%", "level": 6, "id": 960 }
          ],

          "属性需求降低": [
              { "level": 1, "name": "价值之", "value": "属性需求降低 18%", "id": 961 },
              { "level": 2, "name": "容易之", "value": "属性需求降低 32%", "id": 962 }
          ],

          "命中值(武器)": [
              { "level": 1, "name": "稳健之", "value": "+(80–130) 命中值", "id": 963 },
              { "level": 2, "name": "精密之", "value": "+(131–215) 命中值", "id": 964 },
              { "level": 3, "name": "狙击手之", "value": "+(216–325) 命中值", "id": 965 },
              { "level": 4, "name": "神射手之", "value": "+(326–455) 命中值", "id": 966 },
              { "level": 5, "name": "游侠之", "value": "+(456–624) 命中值", "id": 967 },
              { "level": 6, "name": "狮眼之", "value": "+(625–780) 命中值", "id": 968 }
          ],
          "命中值(非武器)": [
              { "level": 1, "name": "稳健之", "value": "+(50–100) 命中值", "id": 969 },
              { "level": 2, "name": "精密之", "value": "+(100–165) 命中值", "id": 970 },
              { "level": 3, "name": "狙击手之", "value": "+(166–250) 命中值", "id": 971 },
              { "level": 4, "name": "神射手之", "value": "+(251–350) 命中值", "id": 972 },
              { "level": 5, "name": "游侠之", "value": "+(351–480) 命中值", "id": 973 },
              { "level": 6, "name": "狮眼之", "value": "+(481–600) 命中值", "id": 974 }
          ],
          "命中值和照亮范围扩大": [
              { "level": 3, "name": "光辉之", "value": "命中值提高 (16–20)%，照亮范围扩大 15%", "id": 975 },
              { "level": 1, "name": "闪亮之", "value": "命中值提高 (9–11)%，照亮范围扩大 5%", "id": 976 },
              { "level": 2, "name": "光明之", "value": "命中值提高 (12–15)%，照亮范围扩大 10%", "id": 977 }
          ],

          "中毒伤害和中毒几率": [
              { "level": 1, "name": "有毒之", "value": "中毒伤害提高 (21–30)%，击中时有 20% 的几率使目标中毒", "id": 978 },
              { "level": 2, "name": "猛毒之", "value": "中毒伤害提高 (31–40)%，击中时有 25% 的几率使目标中毒", "id": 979 },
              { "level": 3, "name": "烈毒之", "value": "中毒伤害提高 (41–50)%，击中时有 30% 的几率使目标中毒", "id": 980 }
          ],
          "流血伤害和流血几率": [
              { "level": 1, "name": "有血之", "value": "攻击有 20% 的几率导致流血，流血伤害提高 (21–30)%", "id": 981 },
              { "level": 2, "name": "出血之", "value": "攻击有 25% 的几率导致流血，流血伤害提高 (31–40)%", "id": 982 },
              { "level": 3, "name": "放血之", "value": "攻击有 30% 的几率导致流血，流血伤害提高 (41–50)%", "id": 983 }
          ],

          "攻击技能的持续伤害加成": [
              { "name": "尖刻之", "value": "攻击技能的持续伤害加成 +(7–11)%", "level": 1, "id": 984 },
              { "name": "分散之", "value": "攻击技能的持续伤害加成 +(12–15)%", "level": 2, "id": 985 },
              { "name": "液化之", "value": "攻击技能的持续伤害加成 +(16–19)%", "level": 3, "id": 986 },
              { "name": "融化之", "value": "攻击技能的持续伤害加成 +(20–23)%", "level": 4, "id": 987 },
              { "name": "溶解之", "value": "攻击技能的持续伤害加成 +(24–26)%", "level": 5, "id": 988 }
          ],
          "所有持续伤害加成(单手和项链)": [
              { "level": 1, "name": "尖刻之", "value": "+(7–11)% 持续伤害加成", "id": 989 },
              { "level": 2, "name": "分散之", "value": "+(12–15)% 持续伤害加成", "id": 990 },
              { "level": 3, "name": "液化之", "value": "+(16–19)% 持续伤害加成", "id": 991 },
              { "level": 4, "name": "融化之", "value": "+(20–23)% 持续伤害加成", "id": 992 },
              { "level": 5, "name": "溶解之", "value": "+(24–26)% 持续伤害加成", "id": 993 }
          ],
          "所有持续伤害加成(双手)": [
              { "level": 1, "name": "尖刻之", "value": "+(16–21)% 持续伤害加成", "id": 994 },
              { "level": 2, "name": "分散之", "value": "+(24–29)% 持续伤害加成", "id": 995 },
              { "level": 3, "name": "液化之", "value": "+(31–35)% 持续伤害加成", "id": 996 },
              { "level": 4, "name": "融化之", "value": "+(36–40)% 持续伤害加成", "id": 997 },
              { "level": 5, "name": "溶解之", "value": "+(41–45)% 持续伤害加成", "id": 998 }
          ],

          "燃烧伤害(单手)": [
              { "level": 1, "name": "燃烧之", "value": "燃烧伤害提高 (26–30)%", "id": 999 },
              { "level": 2, "name": "烫伤之", "value": "燃烧伤害提高 (31–35)%", "id": 1000 },
              { "level": 3, "name": "重灼之", "value": "燃烧伤害提高 (36–40)%", "id": 1001 }
          ],
          "燃烧伤害(双手)": [
              { "level": 1, "name": "燃烧之", "value": "燃烧伤害提高 (31–40)%", "id": 1002 },
              { "level": 2, "name": "烫伤之", "value": "燃烧伤害提高 (41–50)%", "id": 1003 },
              { "level": 3, "name": "重灼之", "value": "燃烧伤害提高 (51–60)%", "id": 1004 }
          ],

          "持续伤害加成(单手)": [
              { "level": 1, "name": "衰损之", "value": "+(14–18)% 混沌持续伤害加成", "id": 1005 },
              { "level": 2, "name": "荒废之", "value": "+(19–23)% 混沌持续伤害加成", "id": 1006 },
              { "level": 3, "name": "退化之", "value": "+(24–28)% 混沌持续伤害加成", "id": 1007 },
              { "level": 4, "name": "萎减之", "value": "+(29–33)% 混沌持续伤害加成", "id": 1008 },
              { "level": 5, "name": "崩离之", "value": "+(34–38)% 混沌持续伤害加成", "id": 1009 },
              { "level": 1, "name": "阴酷之", "value": "+(14–18)% 冰霜持续伤害加成", "id": 1010 },
              { "level": 2, "name": "阴黯之", "value": "+(19–23)% 冰霜持续伤害加成", "id": 1011 },
              { "level": 3, "name": "北风之", "value": "+(24–28)% 冰霜持续伤害加成", "id": 1012 },
              { "level": 4, "name": "极冷之", "value": "+(29–33)% 冰霜持续伤害加成", "id": 1013 },
              { "level": 5, "name": "凝心之", "value": "+(34–38)% 冰霜持续伤害加成", "id": 1014 },
              { "level": 1, "name": "热忱之", "value": "+(14–18)% 火焰持续伤害加成", "id": 1015 },
              { "level": 2, "name": "激昂之", "value": "+(19–23)% 火焰持续伤害加成", "id": 1016 },
              { "level": 3, "name": "热切之", "value": "+(24–28)% 火焰持续伤害加成", "id": 1017 },
              { "level": 4, "name": "狂热之", "value": "+(29–33)% 火焰持续伤害加成", "id": 1018 },
              { "level": 5, "name": "狂信之", "value": "+(34–38)% 火焰持续伤害加成", "id": 1019 },
              { "level": 1, "name": "渗出之", "value": "+(14–18)% 物理持续伤害加成", "id": 1020 },
              { "level": 2, "name": "渗漏之", "value": "+(19–23)% 物理持续伤害加成", "id": 1021 },
              { "level": 3, "name": "抽血之", "value": "+(24–28)% 物理持续伤害加成", "id": 1022 },
              { "level": 4, "name": "溢血之", "value": "+(29–33)% 物理持续伤害加成", "id": 1023 },
              { "level": 5, "name": "放血之", "value": "+(34–38)% 物理持续伤害加成", "id": 1024 }
          ],
          "持续伤害加成(双手)": [
              { "level": 1, "name": "衰损之", "value": "(26–35)% 混沌持续伤害加成", "id": 1025 },
              { "level": 2, "name": "荒废之", "value": "(36–45)% 混沌持续伤害加成", "id": 1026 },
              { "level": 3, "name": "退化之", "value": "(46–55)% 混沌持续伤害加成", "id": 1027 },
              { "level": 4, "name": "萎减之", "value": "(56–65)% 混沌持续伤害加成", "id": 1028 },
              { "level": 5, "name": "崩离之", "value": "(66–75)% 混沌持续伤害加成", "id": 1029 },
              { "level": 1, "name": "阴酷之", "value": "(26–35)% 冰霜持续伤害加成", "id": 1030 },
              { "level": 2, "name": "阴黯之", "value": "(36–45)% 冰霜持续伤害加成", "id": 1031 },
              { "level": 3, "name": "北风之", "value": "(46–55)% 冰霜持续伤害加成", "id": 1032 },
              { "level": 4, "name": "极冷之", "value": "(56–65)% 冰霜持续伤害加成", "id": 1033 },
              { "level": 5, "name": "凝心之", "value": "(66–75)% 冰霜持续伤害加成", "id": 1034 },
              { "level": 1, "name": "热忱之", "value": "(26–35)% 火焰持续伤害加成", "id": 1035 },
              { "level": 2, "name": "激昂之", "value": "(36–45)% 火焰持续伤害加成", "id": 1036 },
              { "level": 3, "name": "热切之", "value": "(46–55)% 火焰持续伤害加成", "id": 1037 },
              { "level": 4, "name": "狂热之", "value": "(56–65)% 火焰持续伤害加成", "id": 1038 },
              { "level": 5, "name": "狂信之", "value": "(66–75)% 火焰持续伤害加成", "id": 1039 },
              { "level": 1, "name": "渗出之", "value": "(26–35)% 物理持续伤害加成", "id": 1040 },
              { "level": 2, "name": "渗漏之", "value": "(36–45)% 物理持续伤害加成", "id": 1041 },
              { "level": 3, "name": "抽血之", "value": "(46–55)% 物理持续伤害加成", "id": 1042 },
              { "level": 4, "name": "溢血之", "value": "(56–65)% 物理持续伤害加成", "id": 1043 },
              { "level": 5, "name": "放血之", "value": "(66–75)% 物理持续伤害加成", "id": 1044 }
          ]
      };
  /**
   * POEDB_FLASK_AFFIX_DATA 补充 PoEDB Modifiers Calc 中的生命、魔力、功能药剂普通词缀。
   * 数据源：https://poedb.tw/cn/Utility_Flasks#ModifiersCalc 及同站 Life_Flasks、Mana_Flasks。
   */
  const POEDB_FLASK_AFFIX_DATA = {
    "equipment":  {
                      "功能药剂":  {
                                   "前缀":  [
                                              {
                                                  "name":  "功能药剂：使用充能降低",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "功能药剂：最大充能",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "功能药剂：充能回复量提高",
                                                  "maxLevel":  84
                                              },
                                              {
                                                  "name":  "功能药剂：回复/持续速度",
                                                  "maxLevel":  84
                                              }
                                          ],
                                   "后缀":  [
                                              {
                                                  "name":  "功能药剂：免疫流血和腐化之血",
                                                  "maxLevel":  76
                                              },
                                              {
                                                  "name":  "功能药剂：生效期间效果",
                                                  "maxLevel":  85
                                              },
                                              {
                                                  "name":  "功能药剂：免疫冻结和冰缓",
                                                  "maxLevel":  72
                                              },
                                              {
                                                  "name":  "功能药剂：免疫点燃",
                                                  "maxLevel":  74
                                              },
                                              {
                                                  "name":  "功能药剂：免疫中毒",
                                                  "maxLevel":  76
                                              },
                                              {
                                                  "name":  "功能药剂：免疫感电",
                                                  "maxLevel":  74
                                              }
                                          ]
                               },
                      "生命药剂":  {
                                   "前缀":  [
                                              {
                                                  "name":  "生命药剂：生效期间效果",
                                                  "maxLevel":  7
                                              },
                                              {
                                                  "name":  "生命药剂：使用充能降低",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "生命药剂：回复量提高但消耗提高",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "生命药剂：最大充能",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "生命药剂：充能回复量提高",
                                                  "maxLevel":  83
                                              },
                                              {
                                                  "name":  "生命药剂：回复量提高",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "生命药剂：回复/持续速度",
                                                  "maxLevel":  81
                                              }
                                          ],
                                   "后缀":  [
                                              {
                                                  "name":  "生命药剂：移除诅咒",
                                                  "maxLevel":  18
                                              },
                                              {
                                                  "name":  "生命药剂：解除点燃",
                                                  "maxLevel":  78
                                              },
                                              {
                                                  "name":  "生命药剂：解除冰缓和冻结",
                                                  "maxLevel":  76
                                              },
                                              {
                                                  "name":  "生命药剂：解除中毒",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "生命药剂：召唤生物回复",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "生命药剂：解除流血和腐化之血",
                                                  "maxLevel":  80
                                              },
                                              {
                                                  "name":  "生命药剂：解除感电",
                                                  "maxLevel":  78
                                              },
                                              {
                                                  "name":  "生命药剂：解除缓速和瘫痪",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "生命药剂：生命不满额外回复",
                                                  "maxLevel":  81
                                              },
                                              {
                                                  "name":  "生命药剂：不满时缓速周围敌人",
                                                  "maxLevel":  84
                                              }
                                          ]
                               },
                      "魔力药剂":  {
                                   "前缀":  [
                                              {
                                                  "name":  "魔力药剂：生效期间效果",
                                                  "maxLevel":  7
                                              },
                                              {
                                                  "name":  "魔力药剂：使用充能降低",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "魔力药剂：魔力满后不移除",
                                                  "maxLevel":  16
                                              },
                                              {
                                                  "name":  "魔力药剂：回复量提高但消耗提高",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "魔力药剂：效果结束时回复魔力",
                                                  "maxLevel":  16
                                              },
                                              {
                                                  "name":  "魔力药剂：最大充能",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "魔力药剂：充能回复量提高",
                                                  "maxLevel":  83
                                              },
                                              {
                                                  "name":  "魔力药剂：回复量提高",
                                                  "maxLevel":  81
                                              },
                                              {
                                                  "name":  "魔力药剂：回复/持续速度",
                                                  "maxLevel":  81
                                              }
                                          ],
                                   "后缀":  [
                                              {
                                                  "name":  "魔力药剂：移除诅咒",
                                                  "maxLevel":  18
                                              },
                                              {
                                                  "name":  "魔力药剂：解除点燃",
                                                  "maxLevel":  78
                                              },
                                              {
                                                  "name":  "魔力药剂：解除冰缓和冻结",
                                                  "maxLevel":  76
                                              },
                                              {
                                                  "name":  "魔力药剂：解除中毒",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "魔力药剂：解除流血和腐化之血",
                                                  "maxLevel":  80
                                              },
                                              {
                                                  "name":  "魔力药剂：解除感电",
                                                  "maxLevel":  78
                                              },
                                              {
                                                  "name":  "魔力药剂：解除缓速和瘫痪",
                                                  "maxLevel":  82
                                              },
                                              {
                                                  "name":  "魔力药剂：不满时缓速周围敌人",
                                                  "maxLevel":  84
                                              }
                                          ]
                               }
                  },
    "levels":  {
                   "功能药剂：免疫流血和腐化之血":  [
                                          {
                                              "level":  8,
                                              "name":  "蜥蜴之",
                                              "value":  "持续时间总降 (45—49)%；生效期间免疫流血和腐化之血",
                                              "id": 1045
                                          },
                                          {
                                              "level":  42,
                                              "name":  "石龙子之",
                                              "value":  "持续时间总降 (40—44)%；生效期间免疫流血和腐化之血",
                                              "id": 1046
                                          },
                                          {
                                              "level":  76,
                                              "name":  "鬣蜥蜴之",
                                              "value":  "持续时间总降 (35—39)%；生效期间免疫流血和腐化之血",
                                              "id": 1047
                                          }
                                      ],
                   "功能药剂：生效期间效果":  [
                                       {
                                           "level":  82,
                                           "name":  "牛虻之",
                                           "value":  "生效期间，施法速度加快 (14—17)%",
                                           "id": 1347
                                       },
                                       {
                                           "level":  82,
                                           "name":  "飞鸽之",
                                           "value":  "生效期间，攻击速度加快 (14—17)%",
                                           "id": 1348
                                       },
                                       {
                                           "level":  85,
                                           "name":  "猎豹之",
                                           "value":  "生效期间，移动速度加快 (12—14)%",
                                           "id": 1120
                                       },
                                       {
                                           "level":  82,
                                           "name":  "手术之",
                                           "value":  "生效期间，暴击率提高 (50—55)%",
                                           "id": 1116
                                       },
                                       {
                                           "level":  65,
                                           "name":  "乌鸦之",
                                           "value":  "生效期间，命中值提高 (35—45)%",
                                           "id": 1355
                                       },
                                       {
                                           "level":  65,
                                           "name":  "符耀之",
                                           "value":  "生效期间，结界提高 (28—30)%",
                                           "id": 1358
                                       },
                                       {
                                           "level":  81,
                                           "name":  "彩虹之",
                                           "value":  "生效期间，元素抗性额外提高 (18—20)%",
                                           "id": 1112
                                       },
                                       {
                                           "level":  84,
                                           "name":  "犰狳之",
                                           "value":  "生效期间，护甲提高 (56—60)%",
                                           "id": 1118
                                       },
                                       {
                                           "level":  84,
                                           "name":  "斑羚之",
                                           "value":  "生效期间，闪避值提高 (56—60)%",
                                           "id": 1117
                                       },
                                       {
                                           "level":  1,
                                           "name":  "抵御之",
                                           "value":  "生效期间，近战攻击会造成击退",
                                           "id": 1352
                                       },
                                       {
                                           "level":  73,
                                           "name":  "稳固之",
                                           "value":  "生效期间，格挡及晕眩回复提高 (75—80)%",
                                           "id": 1106
                                       },
                                       {
                                           "level":  80,
                                           "name":  "海豹之",
                                           "value":  "生效期间，有 (51—55)% 几率避免被冰缓；生效期间，有 (51—55)% 几率避免被冰冻",
                                           "id": 1108
                                       },
                                       {
                                           "level":  80,
                                           "name":  "熊之",
                                           "value":  "生效期间，你受到的冰缓效果降低 (60—65)%；生效期间，你受到的冻结持续时间降低 (60—65)%",
                                           "id": 1110
                                       },
                                       {
                                           "level":  82,
                                           "name":  "翻车鱼之",
                                           "value":  "生效期间，有 (51—55)% 几率避免被点燃",
                                           "id": 1114
                                       },
                                       {
                                           "level":  82,
                                           "name":  "泥藓之",
                                           "value":  "生效期间，有 (51—55)% 几率避免被感电",
                                           "id": 1115
                                       },
                                       {
                                           "level":  82,
                                           "name":  "苍鹭之",
                                           "value":  "生效期间，你受到的感电效果降低 (60—65)%",
                                           "id": 1113
                                       },
                                       {
                                           "level":  84,
                                           "name":  "鸮之",
                                           "value":  "生效期间，你受到的诅咒效果降低 (60—65)%",
                                           "id": 1119
                                       },
                                       {
                                           "level":  80,
                                           "name":  "有血之",
                                           "value":  "生效期间，0.8% 的攻击伤害转化为生命偷取",
                                           "id": 1111
                                       },
                                       {
                                           "level":  80,
                                           "name":  "流失之",
                                           "value":  "生效期间，0.8% 的法术伤害转化为能量护盾偷取",
                                           "id": 1109
                                       },
                                       {
                                           "level":  80,
                                           "name":  "固执之",
                                           "value":  "生效期间，有 (51—55)% 几率避免被晕眩",
                                           "id": 1107
                                       },
                                       {
                                           "level":  72,
                                           "name":  "施罚之",
                                           "value":  "生效期间，有 (31—34)% 几率造成冻结、感电和点燃",
                                           "id": 1105
                                       },
                                       {
                                           "level":  62,
                                           "name":  "蜂鸟之",
                                           "value":  "生效期间，施法速度加快 (12—14)%",
                                           "id": 1349
                                       },
                                       {
                                           "level":  62,
                                           "name":  "飞鹰之",
                                           "value":  "生效期间，攻击速度加快 (12—14)%",
                                           "id": 1351
                                       },
                                       {
                                           "level":  65,
                                           "name":  "山猫之",
                                           "value":  "生效期间，移动速度加快 (9—11)%",
                                           "id": 1102
                                       },
                                       {
                                           "level":  66,
                                           "name":  "穿透之",
                                           "value":  "生效期间，暴击率提高 (44—49)%",
                                           "id": 1104
                                       },
                                       {
                                           "level":  49,
                                           "name":  "浣熊之",
                                           "value":  "生效期间，命中值提高 (28—32)%",
                                           "id": 1354
                                       },
                                       {
                                           "level":  49,
                                           "name":  "符光之",
                                           "value":  "生效期间，结界提高 (25—27)%",
                                           "id": 1357
                                       },
                                       {
                                           "level":  41,
                                           "name":  "万花筒之",
                                           "value":  "生效期间，元素抗性额外提高 (15—17)%",
                                           "id": 1081
                                       },
                                       {
                                           "level":  58,
                                           "name":  "穿山甲之",
                                           "value":  "生效期间，护甲提高 (51—55)%",
                                           "id": 1092
                                       },
                                       {
                                           "level":  58,
                                           "name":  "山羊之",
                                           "value":  "生效期间，闪避值提高 (51—55)%",
                                           "id": 1093
                                       },
                                       {
                                           "level":  55,
                                           "name":  "称锤之",
                                           "value":  "生效期间，格挡及晕眩回复提高 (69—74)%",
                                           "id": 1091
                                       },
                                       {
                                           "level":  61,
                                           "name":  "白鲸之",
                                           "value":  "生效期间，有 (46—50)% 几率避免被冰缓；生效期间，有 (46—50)% 几率避免被冰冻",
                                           "id": 1096
                                       },
                                       {
                                           "level":  61,
                                           "name":  "黑貂之",
                                           "value":  "生效期间，你受到的冰缓效果降低 (52—59)%；生效期间，你受到的冻结持续时间降低 (52—59)%",
                                           "id": 1097
                                       },
                                       {
                                           "level":  63,
                                           "name":  "鲇鱼之",
                                           "value":  "生效期间，有 (46—50)% 几率避免被点燃",
                                           "id": 1099
                                       },
                                       {
                                           "level":  63,
                                           "name":  "灰藓之",
                                           "value":  "生效期间，有 (46—50)% 几率避免被感电",
                                           "id": 1098
                                       },
                                       {
                                           "level":  63,
                                           "name":  "三趾鹬之",
                                           "value":  "生效期间，你受到的感电效果降低 (52—59)%",
                                           "id": 1100
                                       },
                                       {
                                           "level":  65,
                                           "name":  "鸮鹦鹉之",
                                           "value":  "生效期间，你受到的诅咒效果降低 (52—59)%",
                                           "id": 1103
                                       },
                                       {
                                           "level":  60,
                                           "name":  "战斗不息之",
                                           "value":  "生效期间，0.7% 的攻击伤害转化为生命偷取",
                                           "id": 1095
                                       },
                                       {
                                           "level":  60,
                                           "name":  "虹吸之",
                                           "value":  "生效期间，0.7% 的法术伤害转化为能量护盾偷取",
                                           "id": 1094
                                       },
                                       {
                                           "level":  63,
                                           "name":  "无情之",
                                           "value":  "生效期间，有 (46—50)% 几率避免被晕眩",
                                           "id": 1101
                                       },
                                       {
                                           "level":  52,
                                           "name":  "泻怒之",
                                           "value":  "生效期间，有 (27—30)% 几率造成冻结、感电和点燃",
                                           "id": 1090
                                       },
                                       {
                                           "level":  27,
                                           "name":  "信天翁之",
                                           "value":  "生效期间，施法速度加快 (9—11)%",
                                           "id": 1350
                                       },
                                       {
                                           "level":  27,
                                           "name":  "猎鹰之",
                                           "value":  "生效期间，攻击速度加快 (9—11)%",
                                           "id": 1359
                                       },
                                       {
                                           "level":  5,
                                           "name":  "野兔之",
                                           "value":  "生效期间，移动速度加快 (6—8)%",
                                           "id": 1052
                                       },
                                       {
                                           "level":  50,
                                           "name":  "破裂之",
                                           "value":  "生效期间，暴击率提高 (38—43)%",
                                           "id": 1089
                                       },
                                       {
                                           "level":  27,
                                           "name":  "猿猴之",
                                           "value":  "生效期间，命中值提高 (15—25)%",
                                           "id": 1353
                                       },
                                       {
                                           "level":  27,
                                           "name":  "符烁之",
                                           "value":  "生效期间，结界提高 (19—24)%",
                                           "id": 1356
                                       },
                                       {
                                           "level":  1,
                                           "name":  "水晶之",
                                           "value":  "生效期间，元素抗性额外提高 (12—14)%",
                                           "id": 1049
                                       },
                                       {
                                           "level":  32,
                                           "name":  "乌龟之",
                                           "value":  "生效期间，护甲提高 (46—50)%",
                                           "id": 1075
                                       },
                                       {
                                           "level":  32,
                                           "name":  "羚羊之",
                                           "value":  "生效期间，闪避值提高 (46—50)%",
                                           "id": 1074
                                       },
                                       {
                                           "level":  37,
                                           "name":  "底石之",
                                           "value":  "生效期间，格挡及晕眩回复提高 (63—68)%",
                                           "id": 1078
                                       },
                                       {
                                           "level":  42,
                                           "name":  "独角鲸之",
                                           "value":  "生效期间，有 (41—45)% 几率避免被冰缓；生效期间，有 (41—45)% 几率避免被冰冻",
                                           "id": 1082
                                       },
                                       {
                                           "level":  42,
                                           "name":  "狐狸之",
                                           "value":  "生效期间，你受到的冰缓效果降低 (48—52)%；生效期间，你受到的冻结持续时间降低 (48—52)%",
                                           "id": 1083
                                       },
                                       {
                                           "level":  44,
                                           "name":  "鲤鱼之",
                                           "value":  "生效期间，有 (41—45)% 几率避免被点燃",
                                           "id": 1084
                                       },
                                       {
                                           "level":  44,
                                           "name":  "藓齿之",
                                           "value":  "生效期间，有 (41—45)% 几率避免被感电",
                                           "id": 1086
                                       },
                                       {
                                           "level":  44,
                                           "name":  "鸬鹚之",
                                           "value":  "生效期间，你受到的感电效果降低 (48—52)%",
                                           "id": 1085
                                       },
                                       {
                                           "level":  46,
                                           "name":  "麻鹬之",
                                           "value":  "生效期间，你受到的诅咒效果降低 (48—52)%",
                                           "id": 1088
                                       },
                                       {
                                           "level":  40,
                                           "name":  "灭祸之",
                                           "value":  "生效期间，0.6% 的攻击伤害转化为生命偷取",
                                           "id": 1080
                                       },
                                       {
                                           "level":  40,
                                           "name":  "摧毁之",
                                           "value":  "生效期间，0.6% 的法术伤害转化为能量护盾偷取",
                                           "id": 1079
                                       },
                                       {
                                           "level":  46,
                                           "name":  "持续之",
                                           "value":  "生效期间，有 (41—45)% 几率避免被晕眩",
                                           "id": 1087
                                       },
                                       {
                                           "level":  32,
                                           "name":  "壮观之",
                                           "value":  "生效期间，有 (23—26)% 几率造成冻结、感电和点燃",
                                           "id": 1076
                                       },
                                       {
                                           "level":  34,
                                           "name":  "刺穿之",
                                           "value":  "生效期间，暴击率提高 (32—37)%",
                                           "id": 1077
                                       },
                                       {
                                           "level":  6,
                                           "name":  "鲍鱼之",
                                           "value":  "生效期间，护甲提高 (41—45)%",
                                           "id": 1053
                                       },
                                       {
                                           "level":  6,
                                           "name":  "瞪羚之",
                                           "value":  "生效期间，闪避值提高 (41—45)%",
                                           "id": 1054
                                       },
                                       {
                                           "level":  19,
                                           "name":  "爽快之",
                                           "value":  "生效期间，格挡及晕眩回复提高 (57—62)%",
                                           "id": 1064
                                       },
                                       {
                                           "level":  23,
                                           "name":  "海狮之",
                                           "value":  "生效期间，有 (36—40)% 几率避免被冰缓；生效期间，有 (36—40)% 几率避免被冰冻",
                                           "id": 1067
                                       },
                                       {
                                           "level":  23,
                                           "name":  "猫儿之",
                                           "value":  "生效期间，你受到的冰缓效果降低 (42—47)%；生效期间，你受到的冻结持续时间降低 (42—47)%",
                                           "id": 1068
                                       },
                                       {
                                           "level":  25,
                                           "name":  "金鱼之",
                                           "value":  "生效期间，有 (36—40)% 几率避免被点燃",
                                           "id": 1070
                                       },
                                       {
                                           "level":  25,
                                           "name":  "地衣之",
                                           "value":  "生效期间，有 (36—40)% 几率避免被感电",
                                           "id": 1069
                                       },
                                       {
                                           "level":  25,
                                           "name":  "鹬之",
                                           "value":  "生效期间，你受到的感电效果降低 (42—47)%",
                                           "id": 1071
                                       },
                                       {
                                           "level":  27,
                                           "name":  "仿声鸟之",
                                           "value":  "生效期间，你受到的诅咒效果降低 (42—47)%",
                                           "id": 1072
                                       },
                                       {
                                           "level":  20,
                                           "name":  "淤痕之",
                                           "value":  "生效期间，0.5% 的攻击伤害转化为生命偷取",
                                           "id": 1066
                                       },
                                       {
                                           "level":  20,
                                           "name":  "耗损之",
                                           "value":  "生效期间，0.5% 的法术伤害转化为能量护盾偷取",
                                           "id": 1065
                                       },
                                       {
                                           "level":  29,
                                           "name":  "稳当之",
                                           "value":  "生效期间，有 (36—40)% 几率避免被晕眩",
                                           "id": 1073
                                       },
                                       {
                                           "level":  12,
                                           "name":  "蒙骗之",
                                           "value":  "生效期间，有 (19—22)% 几率造成冻结、感电和点燃",
                                           "id": 1062
                                       },
                                       {
                                           "level":  18,
                                           "name":  "刺痛之",
                                           "value":  "生效期间，暴击率提高 (26—31)%",
                                           "id": 1063
                                       },
                                       {
                                           "level":  1,
                                           "name":  "僵固之",
                                           "value":  "生效期间，格挡及晕眩回复提高 (51—56)%",
                                           "id": 1048
                                       },
                                       {
                                           "level":  4,
                                           "name":  "虎鲸之",
                                           "value":  "生效期间，有 (31—35)% 几率避免被冰缓；生效期间，有 (31—35)% 几率避免被冰冻",
                                           "id": 1050
                                       },
                                       {
                                           "level":  4,
                                           "name":  "兔子之",
                                           "value":  "生效期间，你受到的冰缓效果降低 (36—41)%；生效期间，你受到的冻结持续时间降低 (36—41)%",
                                           "id": 1051
                                       },
                                       {
                                           "level":  6,
                                           "name":  "孔雀鱼之",
                                           "value":  "生效期间，有 (31—35)% 几率避免被点燃",
                                           "id": 1055
                                       },
                                       {
                                           "level":  6,
                                           "name":  "树苔之",
                                           "value":  "生效期间，有 (31—35)% 几率避免被感电",
                                           "id": 1057
                                       },
                                       {
                                           "level":  6,
                                           "name":  "千鸟之",
                                           "value":  "生效期间，你受到的感电效果降低 (36—41)%",
                                           "id": 1056
                                       },
                                       {
                                           "level":  8,
                                           "name":  "海燕之",
                                           "value":  "生效期间，你受到的诅咒效果降低 (36—41)%",
                                           "id": 1058
                                       },
                                       {
                                           "level":  10,
                                           "name":  "赤痕之",
                                           "value":  "生效期间，0.4% 的攻击伤害转化为生命偷取",
                                           "id": 1059
                                       },
                                       {
                                           "level":  10,
                                           "name":  "趣味之",
                                           "value":  "生效期间，0.4% 的法术伤害转化为能量护盾偷取",
                                           "id": 1060
                                       },
                                       {
                                           "level":  12,
                                           "name":  "沉着之",
                                           "value":  "生效期间，有 (31—35)% 几率避免被晕眩",
                                           "id": 1061
                                       }
                                   ],
                   "功能药剂：使用充能降低":  [
                                       {
                                           "level":  14,
                                           "name":  "学徒的",
                                           "value":  "每次使用消耗的充能次数降低 (14—16)%",
                                           "id": 1121
                                       },
                                       {
                                           "level":  31,
                                           "name":  "学者的",
                                           "value":  "每次使用消耗的充能次数降低 (17—19)%",
                                           "id": 1122
                                       },
                                       {
                                           "level":  48,
                                           "name":  "执业者的",
                                           "value":  "每次使用消耗的充能次数降低 (20—22)%",
                                           "id": 1123
                                       },
                                       {
                                           "level":  65,
                                           "name":  "酒师的",
                                           "value":  "每次使用消耗的充能次数降低 (23—25)%",
                                           "id": 1124
                                       },
                                       {
                                           "level":  82,
                                           "name":  "化学家的",
                                           "value":  "每次使用消耗的充能次数降低 (26—28)%",
                                           "id": 1125
                                       }
                                   ],
                   "功能药剂：免疫冻结和冰缓":  [
                                        {
                                            "level":  4,
                                            "name":  "鹿之",
                                            "value":  "持续时间总降 (45—49)%；生效期间免疫冻结和冰缓",
                                            "id": 1126
                                        },
                                        {
                                            "level":  38,
                                            "name":  "海象之",
                                            "value":  "持续时间总降 (40—44)%；生效期间免疫冻结和冰缓",
                                            "id": 1127
                                        },
                                        {
                                            "level":  72,
                                            "name":  "企鹅之",
                                            "value":  "持续时间总降 (35—39)%；生效期间免疫冻结和冰缓",
                                            "id": 1128
                                        }
                                    ],
                   "功能药剂：免疫点燃":  [
                                     {
                                         "level":  6,
                                         "name":  "山猬之",
                                         "value":  "持续时间总降 (45—49)%；药剂持续期间免疫点燃；使用时移除燃烧效果",
                                         "id": 1129
                                     },
                                     {
                                         "level":  40,
                                         "name":  "贻贝之",
                                         "value":  "持续时间总降 (40—44)%；药剂持续期间免疫点燃；使用时移除燃烧效果",
                                         "id": 1130
                                     },
                                     {
                                         "level":  74,
                                         "name":  "九头蛇之",
                                         "value":  "持续时间总降 (35—39)%；药剂持续期间免疫点燃；使用时移除燃烧效果",
                                         "id": 1131
                                     }
                                 ],
                   "功能药剂：最大充能":  [
                                     {
                                         "level":  2,
                                         "name":  "宽大的",
                                         "value":  "最大充能 +(16—19)",
                                         "id": 1132
                                     },
                                     {
                                         "level":  22,
                                         "name":  "丰富的",
                                         "value":  "最大充能 +(20—23)",
                                         "id": 1133
                                     },
                                     {
                                         "level":  42,
                                         "name":  "丰厚的",
                                         "value":  "最大充能 +(24—27)",
                                         "id": 1134
                                     },
                                     {
                                         "level":  62,
                                         "name":  "充裕的",
                                         "value":  "最大充能 +(28—31)",
                                         "id": 1135
                                     },
                                     {
                                         "level":  82,
                                         "name":  "充足的",
                                         "value":  "最大充能 +(32—35)",
                                         "id": 1136
                                     }
                                 ],
                   "功能药剂：免疫中毒":  [
                                     {
                                         "level":  16,
                                         "name":  "臭鼬之",
                                         "value":  "持续时间总降 (45—49)%；生效期间免疫中毒",
                                         "id": 1137
                                     },
                                     {
                                         "level":  46,
                                         "name":  "刺猬之",
                                         "value":  "持续时间总降 (40—44)%；生效期间免疫中毒",
                                         "id": 1138
                                     },
                                     {
                                         "level":  76,
                                         "name":  "负鼠之",
                                         "value":  "持续时间总降 (35—39)%；生效期间免疫中毒",
                                         "id": 1139
                                     }
                                 ],
                   "功能药剂：充能回复量提高":  [
                                        {
                                            "level":  3,
                                            "name":  "恒常的",
                                            "value":  "充能回复量提高 (16—20)%",
                                            "id": 1140
                                        },
                                        {
                                            "level":  8,
                                            "name":  "药师的",
                                            "value":  "暴击时有 (11—15)% 的几率获得 1 充能",
                                            "id": 1141
                                        },
                                        {
                                            "level":  20,
                                            "name":  "施予的",
                                            "value":  "充能回复量提高 (37—42)%；效果降低 25%",
                                            "id": 1142
                                        },
                                        {
                                            "level":  23,
                                            "name":  "恒续的",
                                            "value":  "充能回复量提高 (21—25)%",
                                            "id": 1143
                                        },
                                        {
                                            "level":  26,
                                            "name":  "医师的",
                                            "value":  "暴击时有 (16—20)% 的几率获得 1 充能",
                                            "id": 1144
                                        },
                                        {
                                            "level":  29,
                                            "name":  "违规者的",
                                            "value":  "你被敌人击中时获得 1 次充能",
                                            "id": 1145
                                        },
                                        {
                                            "level":  36,
                                            "name":  "配给的",
                                            "value":  "充能回复量提高 (43—48)%；效果降低 25%",
                                            "id": 1146
                                        },
                                        {
                                            "level":  43,
                                            "name":  "无穷的",
                                            "value":  "充能回复量提高 (26—30)%",
                                            "id": 1147
                                        },
                                        {
                                            "level":  44,
                                            "name":  "医生的",
                                            "value":  "暴击时有 (21—25)% 的几率获得 1 充能",
                                            "id": 1148
                                        },
                                        {
                                            "level":  52,
                                            "name":  "慎重的",
                                            "value":  "充能回复量提高 (49—54)%；效果降低 25%",
                                            "id": 1149
                                        },
                                        {
                                            "level":  62,
                                            "name":  "专家的",
                                            "value":  "暴击时有 (26—30)% 的几率获得 1 充能",
                                            "id": 1150
                                        },
                                        {
                                            "level":  63,
                                            "name":  "受虐者的",
                                            "value":  "你被敌人击中时获得 2 次充能",
                                            "id": 1151
                                        },
                                        {
                                            "level":  63,
                                            "name":  "无底的",
                                            "value":  "充能回复量提高 (31—45)%",
                                            "id": 1152
                                        },
                                        {
                                            "level":  68,
                                            "name":  "分配的",
                                            "value":  "充能回复量提高 (55—60)%；效果降低 25%",
                                            "id": 1153
                                        },
                                        {
                                            "level":  80,
                                            "name":  "鞭笞的",
                                            "value":  "你被敌人击中时获得 3 次充能",
                                            "id": 1154
                                        },
                                        {
                                            "level":  80,
                                            "name":  "外科医生的",
                                            "value":  "暴击时有 (31—35)% 的几率获得 1 充能",
                                            "id": 1155
                                        },
                                        {
                                            "level":  83,
                                            "name":  "永久的",
                                            "value":  "充能回复量提高 (46—50)%",
                                            "id": 1156
                                        },
                                        {
                                            "level":  84,
                                            "name":  "配给的",
                                            "value":  "充能回复量提高 (61—66)%；效果降低 25%",
                                            "id": 1157
                                        }
                                    ],
                   "功能药剂：回复/持续速度":  [
                                        {
                                            "level":  20,
                                            "name":  "调查者的",
                                            "value":  "生效时间延长 (16—20)%",
                                            "id": 1158
                                        },
                                        {
                                            "level":  20,
                                            "name":  "启蒙师的",
                                            "value":  "生效时间缩短 (33—38)%；效果提高 25%",
                                            "id": 1159
                                        },
                                        {
                                            "level":  36,
                                            "name":  "分析家的",
                                            "value":  "生效时间延长 (21—25)%",
                                            "id": 1160
                                        },
                                        {
                                            "level":  50,
                                            "name":  "业余者的",
                                            "value":  "生效时间缩短 (28—32)%；效果提高 25%",
                                            "id": 1161
                                        },
                                        {
                                            "level":  52,
                                            "name":  "审查人的",
                                            "value":  "生效时间延长 (26—30)%",
                                            "id": 1162
                                        },
                                        {
                                            "level":  68,
                                            "name":  "临床师的",
                                            "value":  "生效时间延长 (31—35)%",
                                            "id": 1163
                                        },
                                        {
                                            "level":  80,
                                            "name":  "炼金的",
                                            "value":  "生效时间缩短 (23—27)%；效果提高 25%",
                                            "id": 1164
                                        },
                                        {
                                            "level":  84,
                                            "name":  "实验家的",
                                            "value":  "生效时间延长 (36—40)%",
                                            "id": 1165
                                        }
                                    ],
                   "功能药剂：免疫感电":  [
                                     {
                                         "level":  6,
                                         "name":  "鳗鱼之",
                                         "value":  "持续时间总降 (45—49)%；生效期间免疫感电",
                                         "id": 1166
                                     },
                                     {
                                         "level":  40,
                                         "name":  "海鳝之",
                                         "value":  "持续时间总降 (40—44)%；生效期间免疫感电",
                                         "id": 1167
                                     },
                                     {
                                         "level":  74,
                                         "name":  "鳝鱼之",
                                         "value":  "持续时间总降 (35—39)%；生效期间免疫感电",
                                         "id": 1168
                                     }
                                 ],
                   "生命药剂：生效期间效果":  [
                                       {
                                           "level":  7,
                                           "name":  "沸腾的",
                                           "value":  "回复量降低 66%；立即回复",
                                           "id": 1169
                                       }
                                   ],
                   "生命药剂：使用充能降低":  [
                                       {
                                           "level":  14,
                                           "name":  "学徒的",
                                           "value":  "每次使用消耗的充能次数降低 (14—16)%",
                                           "id": 1170
                                       },
                                       {
                                           "level":  31,
                                           "name":  "学者的",
                                           "value":  "每次使用消耗的充能次数降低 (17—19)%",
                                           "id": 1171
                                       },
                                       {
                                           "level":  48,
                                           "name":  "执业者的",
                                           "value":  "每次使用消耗的充能次数降低 (20—22)%",
                                           "id": 1172
                                       },
                                       {
                                           "level":  65,
                                           "name":  "酒师的",
                                           "value":  "每次使用消耗的充能次数降低 (23—25)%",
                                           "id": 1173
                                       },
                                       {
                                           "level":  82,
                                           "name":  "化学家的",
                                           "value":  "每次使用消耗的充能次数降低 (26—28)%",
                                           "id": 1174
                                       }
                                   ],
                   "生命药剂：移除诅咒":  [
                                     {
                                         "level":  18,
                                         "name":  "守护之",
                                         "value":  "使用时移除诅咒",
                                         "id": 1175
                                     }
                                 ],
                   "生命药剂：解除点燃":  [
                                     {
                                         "level":  6,
                                         "name":  "潮息之",
                                         "value":  "被点燃时使用可以在接下来 (6—8) 秒免疫点燃；使用时移除所有燃烧效果",
                                         "id": 1176
                                     },
                                     {
                                         "level":  30,
                                         "name":  "惩戒之",
                                         "value":  "被点燃时使用可以在接下来 (9—11) 秒免疫点燃；使用时移除所有燃烧效果",
                                         "id": 1177
                                     },
                                     {
                                         "level":  54,
                                         "name":  "镇定之",
                                         "value":  "被点燃时使用可以在接下来 (12—14) 秒免疫点燃；使用时移除所有燃烧效果",
                                         "id": 1178
                                     },
                                     {
                                         "level":  78,
                                         "name":  "淬息之",
                                         "value":  "被点燃时使用可以在接下来 (15—17) 秒免疫点燃；使用时移除所有燃烧效果",
                                         "id": 1179
                                     }
                                 ],
                   "生命药剂：解除冰缓和冻结":  [
                                        {
                                            "level":  4,
                                            "name":  "对流之",
                                            "value":  "被冰缓时使用可以在接下来 (6—8) 内免疫冰缓；被冻结时使用可以在接下来 (6—8) 秒免疫冻结",
                                            "id": 1180
                                        },
                                        {
                                            "level":  28,
                                            "name":  "热学之",
                                            "value":  "被冰缓时使用可以在接下来 (9—11) 内免疫冰缓；被冻结时使用可以在接下来 (9—11) 秒免疫冻结",
                                            "id": 1181
                                        },
                                        {
                                            "level":  52,
                                            "name":  "乱世之",
                                            "value":  "被冰缓时使用可以在接下来 (12—14) 内免疫冰缓；被冻结时使用可以在接下来 (12—14) 秒免疫冻结",
                                            "id": 1182
                                        },
                                        {
                                            "level":  76,
                                            "name":  "熔解之",
                                            "value":  "被冰缓时使用可以在接下来 (15—17) 内免疫冰缓；被冻结时使用可以在接下来 (15—17) 秒免疫冻结",
                                            "id": 1183
                                        }
                                    ],
                   "生命药剂：解除中毒":  [
                                     {
                                         "level":  16,
                                         "name":  "抗毒素之",
                                         "value":  "中毒时使用可以在接下来 (6—8) 秒免疫中毒",
                                         "id": 1184
                                     },
                                     {
                                         "level":  38,
                                         "name":  "补救之",
                                         "value":  "中毒时使用可以在接下来 (9—11) 秒免疫中毒",
                                         "id": 1185
                                     },
                                     {
                                         "level":  60,
                                         "name":  "解药之",
                                         "value":  "中毒时使用可以在接下来 (12—14) 秒免疫中毒",
                                         "id": 1186
                                     },
                                     {
                                         "level":  82,
                                         "name":  "解毒之",
                                         "value":  "中毒时使用可以在接下来 (15—17) 秒免疫中毒",
                                         "id": 1187
                                     }
                                 ],
                   "生命药剂：召唤生物回复":  [
                                       {
                                           "level":  10,
                                           "name":  "新手之",
                                           "value":  "给召唤生物提供 (100—119)% 生命恢复效果",
                                           "id": 1188
                                       },
                                       {
                                           "level":  28,
                                           "name":  "辅祭之",
                                           "value":  "给召唤生物提供 (120—139)% 生命恢复效果",
                                           "id": 1189
                                       },
                                       {
                                           "level":  46,
                                           "name":  "召唤师之",
                                           "value":  "给召唤生物提供 (140—159)% 生命恢复效果",
                                           "id": 1190
                                       },
                                       {
                                           "level":  64,
                                           "name":  "咒法师之",
                                           "value":  "给召唤生物提供 (160—179)% 生命恢复效果",
                                           "id": 1191
                                       },
                                       {
                                           "level":  82,
                                           "name":  "死灵师之",
                                           "value":  "给召唤生物提供 (180—200)% 生命恢复效果",
                                           "id": 1192
                                       }
                                   ],
                   "生命药剂：回复量提高但消耗提高":  [
                                           {
                                               "level":  10,
                                               "name":  "硝酸盐的",
                                               "value":  "每次使用消耗的充能次数提高 (20—25)%；回复量提高 (21—26)%",
                                               "id": 1193
                                           },
                                           {
                                               "level":  28,
                                               "name":  "白云石的",
                                               "value":  "每次使用消耗的充能次数提高 (20—25)%；回复量提高 (27—32)%",
                                               "id": 1194
                                           },
                                           {
                                               "level":  46,
                                               "name":  "硝酸镁的",
                                               "value":  "每次使用消耗的充能次数提高 (20—25)%；回复量提高 (33—38)%",
                                               "id": 1195
                                           },
                                           {
                                               "level":  64,
                                               "name":  "钾盐镁的",
                                               "value":  "每次使用消耗的充能次数提高 (20—25)%；回复量提高 (39—44)%",
                                               "id": 1196
                                           },
                                           {
                                               "level":  82,
                                               "name":  "石膏的",
                                               "value":  "每次使用消耗的充能次数提高 (20—25)%；回复量提高 (45—50)%",
                                               "id": 1197
                                           }
                                       ],
                   "生命药剂：最大充能":  [
                                     {
                                         "level":  2,
                                         "name":  "宽大的",
                                         "value":  "最大充能 +(16—19)",
                                         "id": 1198
                                     },
                                     {
                                         "level":  22,
                                         "name":  "丰富的",
                                         "value":  "最大充能 +(20—23)",
                                         "id": 1199
                                     },
                                     {
                                         "level":  42,
                                         "name":  "丰厚的",
                                         "value":  "最大充能 +(24—27)",
                                         "id": 1200
                                     },
                                     {
                                         "level":  62,
                                         "name":  "充裕的",
                                         "value":  "最大充能 +(28—31)",
                                         "id": 1201
                                     },
                                     {
                                         "level":  82,
                                         "name":  "充足的",
                                         "value":  "最大充能 +(32—35)",
                                         "id": 1202
                                     }
                                 ],
                   "生命药剂：充能回复量提高":  [
                                        {
                                            "level":  3,
                                            "name":  "恒常的",
                                            "value":  "充能回复量提高 (16—20)%",
                                            "id": 1203
                                        },
                                        {
                                            "level":  8,
                                            "name":  "药师的",
                                            "value":  "暴击时有 (11—15)% 的几率获得 1 充能",
                                            "id": 1204
                                        },
                                        {
                                            "level":  23,
                                            "name":  "恒续的",
                                            "value":  "充能回复量提高 (21—25)%",
                                            "id": 1205
                                        },
                                        {
                                            "level":  26,
                                            "name":  "医师的",
                                            "value":  "暴击时有 (16—20)% 的几率获得 1 充能",
                                            "id": 1206
                                        },
                                        {
                                            "level":  29,
                                            "name":  "违规者的",
                                            "value":  "你被敌人击中时获得 1 次充能",
                                            "id": 1207
                                        },
                                        {
                                            "level":  43,
                                            "name":  "无穷的",
                                            "value":  "充能回复量提高 (26—30)%",
                                            "id": 1208
                                        },
                                        {
                                            "level":  44,
                                            "name":  "医生的",
                                            "value":  "暴击时有 (21—25)% 的几率获得 1 充能",
                                            "id": 1209
                                        },
                                        {
                                            "level":  62,
                                            "name":  "专家的",
                                            "value":  "暴击时有 (26—30)% 的几率获得 1 充能",
                                            "id": 1210
                                        },
                                        {
                                            "level":  63,
                                            "name":  "受虐者的",
                                            "value":  "你被敌人击中时获得 2 次充能",
                                            "id": 1211
                                        },
                                        {
                                            "level":  63,
                                            "name":  "无底的",
                                            "value":  "充能回复量提高 (31—45)%",
                                            "id": 1212
                                        },
                                        {
                                            "level":  80,
                                            "name":  "鞭笞的",
                                            "value":  "你被敌人击中时获得 3 次充能",
                                            "id": 1213
                                        },
                                        {
                                            "level":  80,
                                            "name":  "外科医生的",
                                            "value":  "暴击时有 (31—35)% 的几率获得 1 充能",
                                            "id": 1214
                                        },
                                        {
                                            "level":  83,
                                            "name":  "永久的",
                                            "value":  "充能回复量提高 (46—50)%",
                                            "id": 1215
                                        }
                                    ],
                   "生命药剂：回复量提高":  [
                                      {
                                          "level":  1,
                                          "name":  "重多的",
                                          "value":  "回复量提高 (41—46)%；回复速度减慢 33%",
                                          "id": 1216
                                      },
                                      {
                                          "level":  6,
                                          "name":  "谨简的",
                                          "value":  "恢复效果在低血状态下使用时总增 (101—106)%",
                                          "id": 1217
                                      },
                                      {
                                          "level":  13,
                                          "name":  "削妨的",
                                          "value":  "生命回复提高 (35—39)%；使用时会移除魔力，等同于生命回复值的 10%",
                                          "id": 1218
                                      },
                                      {
                                          "level":  21,
                                          "name":  "蔽光的",
                                          "value":  "回复量提高 (47—52)%；回复速度减慢 33%",
                                          "id": 1219
                                      },
                                      {
                                          "level":  25,
                                          "name":  "全备的",
                                          "value":  "恢复效果在低血状态下使用时总增 (107—112)%",
                                          "id": 1220
                                      },
                                      {
                                          "level":  30,
                                          "name":  "眼昏的",
                                          "value":  "生命回复提高 (40—44)%；使用时会移除魔力，等同于生命回复值的 10%",
                                          "id": 1221
                                      },
                                      {
                                          "level":  41,
                                          "name":  "全型的",
                                          "value":  "回复量提高 (53—58)%；回复速度减慢 33%",
                                          "id": 1222
                                      },
                                      {
                                          "level":  44,
                                          "name":  "谨戒的",
                                          "value":  "恢复效果在低血状态下使用时总增 (113—118)%",
                                          "id": 1223
                                      },
                                      {
                                          "level":  47,
                                          "name":  "耗尽的",
                                          "value":  "生命回复提高 (46—50)%；使用时会移除魔力，等同于生命回复值的 10%",
                                          "id": 1224
                                      },
                                      {
                                          "level":  61,
                                          "name":  "专注的",
                                          "value":  "回复量提高 (59—64)%；回复速度减慢 33%",
                                          "id": 1225
                                      },
                                      {
                                          "level":  63,
                                          "name":  "谨细的",
                                          "value":  "恢复效果在低血状态下使用时总增 (119—124)%",
                                          "id": 1226
                                      },
                                      {
                                          "level":  64,
                                          "name":  "损坏的",
                                          "value":  "生命回复提高 (51—55)%；使用时会移除魔力，等同于生命回复值的 10%",
                                          "id": 1227
                                      },
                                      {
                                          "level":  81,
                                          "name":  "饱和的",
                                          "value":  "回复量提高 (65—70)%；回复速度减慢 33%",
                                          "id": 1228
                                      },
                                      {
                                          "level":  81,
                                          "name":  "削弱的",
                                          "value":  "生命回复提高 (56—60)%；使用时会移除魔力，等同于生命回复值的 10%",
                                          "id": 1229
                                      },
                                      {
                                          "level":  82,
                                          "name":  "谨慎之",
                                          "value":  "恢复效果在低血状态下使用时总增 (125—130)%",
                                          "id": 1230
                                      }
                                  ],
                   "生命药剂：回复/持续速度":  [
                                        {
                                            "level":  1,
                                            "name":  "原汁的",
                                            "value":  "回复速度加快 (41—46)%",
                                            "id": 1231
                                        },
                                        {
                                            "level":  3,
                                            "name":  "煨闷的",
                                            "value":  "回复量降低 (52—55)%；回复速度加快 135%；立即回复50% 回复量",
                                            "id": 1232
                                        },
                                        {
                                            "level":  9,
                                            "name":  "惊骇的",
                                            "value":  "回复量降低 (27—30)%；低血时立即回复",
                                            "id": 1233
                                        },
                                        {
                                            "level":  21,
                                            "name":  "加厚的",
                                            "value":  "回复速度加快 (47—52)%",
                                            "id": 1234
                                        },
                                        {
                                            "level":  22,
                                            "name":  "沸溢的",
                                            "value":  "回复量降低 (48—51)%；回复速度加快 135%；立即回复50% 回复量",
                                            "id": 1235
                                        },
                                        {
                                            "level":  27,
                                            "name":  "恐骇的",
                                            "value":  "回复量降低 (23—26)%；低血时立即回复",
                                            "id": 1236
                                        },
                                        {
                                            "level":  41,
                                            "name":  "黏性的",
                                            "value":  "回复速度加快 (53—58)%",
                                            "id": 1237
                                        },
                                        {
                                            "level":  41,
                                            "name":  "喷熔的",
                                            "value":  "回复量降低 (44—47)%；回复速度加快 135%；立即回复50% 回复量",
                                            "id": 1238
                                        },
                                        {
                                            "level":  45,
                                            "name":  "警骇的",
                                            "value":  "回复量降低 (19—22)%；低血时立即回复",
                                            "id": 1239
                                        },
                                        {
                                            "level":  60,
                                            "name":  "沸熔的",
                                            "value":  "回复量降低 (40—43)%；回复速度加快 135%；立即回复50% 回复量",
                                            "id": 1240
                                        },
                                        {
                                            "level":  61,
                                            "name":  "浓黏的",
                                            "value":  "回复速度加快 (59—64)%",
                                            "id": 1241
                                        },
                                        {
                                            "level":  63,
                                            "name":  "惧骇的",
                                            "value":  "回复量降低 (15—18)%；低血时立即回复",
                                            "id": 1242
                                        },
                                        {
                                            "level":  79,
                                            "name":  "起泡的",
                                            "value":  "回复量降低 (36—39)%；回复速度加快 135%；立即回复50% 回复量",
                                            "id": 1243
                                        },
                                        {
                                            "level":  81,
                                            "name":  "催化的",
                                            "value":  "回复速度加快 (65—70)%",
                                            "id": 1244
                                        },
                                        {
                                            "level":  81,
                                            "name":  "恐慌之",
                                            "value":  "回复量降低 (11—14)%；低血时立即回复",
                                            "id": 1245
                                        }
                                    ],
                   "生命药剂：解除流血和腐化之血":  [
                                          {
                                              "level":  8,
                                              "name":  "封闭之",
                                              "value":  "在流血时使用可以在接下来 (6—8) 秒免疫流血；被腐化之血影响时使用可以在接下来 (6—8) 秒免疫腐化之血",
                                              "id": 1246
                                          },
                                          {
                                              "level":  32,
                                              "name":  "缓减之",
                                              "value":  "在流血时使用可以在接下来 (9—11) 秒免疫流血；被腐化之血影响时使用可以在接下来 (9—11) 秒免疫腐化之血",
                                              "id": 1247
                                          },
                                          {
                                              "level":  56,
                                              "name":  "消减之",
                                              "value":  "在流血时使用可以在接下来 (12—14) 秒免疫流血；被腐化之血影响时使用可以在接下来 (12—14) 秒免疫腐化之血",
                                              "id": 1248
                                          },
                                          {
                                              "level":  80,
                                              "name":  "宽慰之",
                                              "value":  "在流血时使用可以在接下来 (15—17) 秒免疫流血；被腐化之血影响时使用可以在接下来 (15—17) 秒免疫腐化之血",
                                              "id": 1249
                                          }
                                      ],
                   "生命药剂：解除感电":  [
                                     {
                                         "level":  6,
                                         "name":  "下地之",
                                         "value":  "遭受感电时使用可以在接下来 (6—8) 秒免疫感电",
                                         "id": 1250
                                     },
                                     {
                                         "level":  30,
                                         "name":  "接地之",
                                         "value":  "遭受感电时使用可以在接下来 (9—11) 秒免疫感电",
                                         "id": 1251
                                     },
                                     {
                                         "level":  54,
                                         "name":  "隔绝之",
                                         "value":  "遭受感电时使用可以在接下来 (12—14) 秒免疫感电",
                                         "id": 1252
                                     },
                                     {
                                         "level":  78,
                                         "name":  "电介之",
                                         "value":  "遭受感电时使用可以在接下来 (15—17) 秒免疫感电",
                                         "id": 1253
                                     }
                                 ],
                   "生命药剂：解除缓速和瘫痪":  [
                                        {
                                            "level":  16,
                                            "name":  "行动之",
                                            "value":  "缓速时使用可以在接下来 (6—8) 秒免疫缓速；瘫痪时使用可以在接下来 (6—8) 秒免疫瘫痪",
                                            "id": 1254
                                        },
                                        {
                                            "level":  38,
                                            "name":  "动机之",
                                            "value":  "缓速时使用可以在接下来 (9—11) 秒免疫缓速；瘫痪时使用可以在接下来 (9—11) 秒免疫瘫痪",
                                            "id": 1255
                                        },
                                        {
                                            "level":  60,
                                            "name":  "自由之",
                                            "value":  "缓速时使用可以在接下来 (12—14) 秒免疫缓速；瘫痪时使用可以在接下来 (12—14) 秒免疫瘫痪",
                                            "id": 1256
                                        },
                                        {
                                            "level":  82,
                                            "name":  "解放之",
                                            "value":  "缓速时使用可以在接下来 (15—17) 秒免疫缓速；瘫痪时使用可以在接下来 (15—17) 秒免疫瘫痪",
                                            "id": 1257
                                        }
                                    ],
                   "生命药剂：生命不满额外回复":  [
                                         {
                                             "level":  25,
                                             "name":  "丰收之",
                                             "value":  "在生命不满时使用则在 10 秒内额外恢复生命，等于生命药剂恢复量的 (11—16)%",
                                             "id": 1258
                                         },
                                         {
                                             "level":  39,
                                             "name":  "充裕之",
                                             "value":  "在生命不满时使用则在 10 秒内额外恢复生命，等于生命药剂恢复量的 (17—22)%",
                                             "id": 1259
                                         },
                                         {
                                             "level":  53,
                                             "name":  "猎者之",
                                             "value":  "在生命不满时使用则在 10 秒内额外恢复生命，等于生命药剂恢复量的 (23—28)%",
                                             "id": 1260
                                         },
                                         {
                                             "level":  67,
                                             "name":  "本续之",
                                             "value":  "在生命不满时使用则在 10 秒内额外恢复生命，等于生命药剂恢复量的 (29—34)%",
                                             "id": 1261
                                         },
                                         {
                                             "level":  81,
                                             "name":  "四季之",
                                             "value":  "在生命不满时使用则在 10 秒内额外恢复生命，等于生命药剂恢复量的 (35—40)%",
                                             "id": 1262
                                         }
                                     ],
                   "生命药剂：不满时缓速周围敌人":  [
                                          {
                                              "level":  30,
                                              "name":  "干涉之",
                                              "value":  "在生命不满时使用可以缓速周围敌人，使它们的移动速度减慢 (17—22)%",
                                              "id": 1263
                                          },
                                          {
                                              "level":  48,
                                              "name":  "阻挠之",
                                              "value":  "在生命不满时使用可以缓速周围敌人，使它们的移动速度减慢 (23—28)%",
                                              "id": 1264
                                          },
                                          {
                                              "level":  66,
                                              "name":  "闭收之",
                                              "value":  "在生命不满时使用可以缓速周围敌人，使它们的移动速度减慢 (29—34)%",
                                              "id": 1265
                                          },
                                          {
                                              "level":  84,
                                              "name":  "抑束之",
                                              "value":  "在生命不满时使用可以缓速周围敌人，使它们的移动速度减慢 (35—40)%",
                                              "id": 1266
                                          }
                                      ],
                   "魔力药剂：生效期间效果":  [
                                       {
                                           "level":  7,
                                           "name":  "沸腾的",
                                           "value":  "回复量降低 66%；立即回复",
                                           "id": 1267
                                       }
                                   ],
                   "魔力药剂：使用充能降低":  [
                                       {
                                           "level":  14,
                                           "name":  "学徒的",
                                           "value":  "每次使用消耗的充能次数降低 (14—16)%",
                                           "id": 1268
                                       },
                                       {
                                           "level":  31,
                                           "name":  "学者的",
                                           "value":  "每次使用消耗的充能次数降低 (17—19)%",
                                           "id": 1269
                                       },
                                       {
                                           "level":  48,
                                           "name":  "执业者的",
                                           "value":  "每次使用消耗的充能次数降低 (20—22)%",
                                           "id": 1270
                                       },
                                       {
                                           "level":  65,
                                           "name":  "酒师的",
                                           "value":  "每次使用消耗的充能次数降低 (23—25)%",
                                           "id": 1271
                                       },
                                       {
                                           "level":  82,
                                           "name":  "化学家的",
                                           "value":  "每次使用消耗的充能次数降低 (26—28)%",
                                           "id": 1272
                                       }
                                   ],
                   "魔力药剂：移除诅咒":  [
                                     {
                                         "level":  18,
                                         "name":  "守护之",
                                         "value":  "使用时移除诅咒",
                                         "id": 1273
                                     }
                                 ],
                   "魔力药剂：解除点燃":  [
                                     {
                                         "level":  6,
                                         "name":  "潮息之",
                                         "value":  "被点燃时使用可以在接下来 (6—8) 秒免疫点燃；使用时移除所有燃烧效果",
                                         "id": 1274
                                     },
                                     {
                                         "level":  30,
                                         "name":  "惩戒之",
                                         "value":  "被点燃时使用可以在接下来 (9—11) 秒免疫点燃；使用时移除所有燃烧效果",
                                         "id": 1275
                                     },
                                     {
                                         "level":  54,
                                         "name":  "镇定之",
                                         "value":  "被点燃时使用可以在接下来 (12—14) 秒免疫点燃；使用时移除所有燃烧效果",
                                         "id": 1276
                                     },
                                     {
                                         "level":  78,
                                         "name":  "淬息之",
                                         "value":  "被点燃时使用可以在接下来 (15—17) 秒免疫点燃；使用时移除所有燃烧效果",
                                         "id": 1277
                                     }
                                 ],
                   "魔力药剂：解除冰缓和冻结":  [
                                        {
                                            "level":  4,
                                            "name":  "对流之",
                                            "value":  "被冰缓时使用可以在接下来 (6—8) 内免疫冰缓；被冻结时使用可以在接下来 (6—8) 秒免疫冻结",
                                            "id": 1278
                                        },
                                        {
                                            "level":  28,
                                            "name":  "热学之",
                                            "value":  "被冰缓时使用可以在接下来 (9—11) 内免疫冰缓；被冻结时使用可以在接下来 (9—11) 秒免疫冻结",
                                            "id": 1279
                                        },
                                        {
                                            "level":  52,
                                            "name":  "乱世之",
                                            "value":  "被冰缓时使用可以在接下来 (12—14) 内免疫冰缓；被冻结时使用可以在接下来 (12—14) 秒免疫冻结",
                                            "id": 1280
                                        },
                                        {
                                            "level":  76,
                                            "name":  "熔解之",
                                            "value":  "被冰缓时使用可以在接下来 (15—17) 内免疫冰缓；被冻结时使用可以在接下来 (15—17) 秒免疫冻结",
                                            "id": 1281
                                        }
                                    ],
                   "魔力药剂：解除中毒":  [
                                     {
                                         "level":  16,
                                         "name":  "抗毒素之",
                                         "value":  "中毒时使用可以在接下来 (6—8) 秒免疫中毒",
                                         "id": 1282
                                     },
                                     {
                                         "level":  38,
                                         "name":  "补救之",
                                         "value":  "中毒时使用可以在接下来 (9—11) 秒免疫中毒",
                                         "id": 1283
                                     },
                                     {
                                         "level":  60,
                                         "name":  "解药之",
                                         "value":  "中毒时使用可以在接下来 (12—14) 秒免疫中毒",
                                         "id": 1284
                                     },
                                     {
                                         "level":  82,
                                         "name":  "解毒之",
                                         "value":  "中毒时使用可以在接下来 (15—17) 秒免疫中毒",
                                         "id": 1285
                                     }
                                 ],
                   "魔力药剂：魔力满后不移除":  [
                                        {
                                            "level":  16,
                                            "name":  "持久的",
                                            "value":  "回复量降低 66%；未保留的魔力充满时，效果不会消失；效果不会堆叠",
                                            "id": 1286
                                        }
                                    ],
                   "魔力药剂：回复量提高但消耗提高":  [
                                           {
                                               "level":  10,
                                               "name":  "硝酸盐的",
                                               "value":  "每次使用消耗的充能次数提高 (20—25)%；回复量提高 (21—26)%",
                                               "id": 1287
                                           },
                                           {
                                               "level":  28,
                                               "name":  "白云石的",
                                               "value":  "每次使用消耗的充能次数提高 (20—25)%；回复量提高 (27—32)%",
                                               "id": 1288
                                           },
                                           {
                                               "level":  46,
                                               "name":  "硝酸镁的",
                                               "value":  "每次使用消耗的充能次数提高 (20—25)%；回复量提高 (33—38)%",
                                               "id": 1289
                                           },
                                           {
                                               "level":  64,
                                               "name":  "钾盐镁的",
                                               "value":  "每次使用消耗的充能次数提高 (20—25)%；回复量提高 (39—44)%",
                                               "id": 1290
                                           },
                                           {
                                               "level":  82,
                                               "name":  "石膏的",
                                               "value":  "每次使用消耗的充能次数提高 (20—25)%；回复量提高 (45—50)%",
                                               "id": 1291
                                           }
                                       ],
                   "魔力药剂：效果结束时回复魔力":  [
                                          {
                                              "level":  16,
                                              "name":  "预兆的",
                                              "value":  "回复量提高 66%；魔力回复会在效果结束时立即开始",
                                              "id": 1292
                                          }
                                      ],
                   "魔力药剂：最大充能":  [
                                     {
                                         "level":  2,
                                         "name":  "宽大的",
                                         "value":  "最大充能 +(16—19)",
                                         "id": 1293
                                     },
                                     {
                                         "level":  22,
                                         "name":  "丰富的",
                                         "value":  "最大充能 +(20—23)",
                                         "id": 1294
                                     },
                                     {
                                         "level":  42,
                                         "name":  "丰厚的",
                                         "value":  "最大充能 +(24—27)",
                                         "id": 1295
                                     },
                                     {
                                         "level":  62,
                                         "name":  "充裕的",
                                         "value":  "最大充能 +(28—31)",
                                         "id": 1296
                                     },
                                     {
                                         "level":  82,
                                         "name":  "充足的",
                                         "value":  "最大充能 +(32—35)",
                                         "id": 1297
                                     }
                                 ],
                   "魔力药剂：充能回复量提高":  [
                                        {
                                            "level":  3,
                                            "name":  "恒常的",
                                            "value":  "充能回复量提高 (16—20)%",
                                            "id": 1298
                                        },
                                        {
                                            "level":  8,
                                            "name":  "药师的",
                                            "value":  "暴击时有 (11—15)% 的几率获得 1 充能",
                                            "id": 1299
                                        },
                                        {
                                            "level":  23,
                                            "name":  "恒续的",
                                            "value":  "充能回复量提高 (21—25)%",
                                            "id": 1300
                                        },
                                        {
                                            "level":  26,
                                            "name":  "医师的",
                                            "value":  "暴击时有 (16—20)% 的几率获得 1 充能",
                                            "id": 1301
                                        },
                                        {
                                            "level":  29,
                                            "name":  "违规者的",
                                            "value":  "你被敌人击中时获得 1 次充能",
                                            "id": 1302
                                        },
                                        {
                                            "level":  43,
                                            "name":  "无穷的",
                                            "value":  "充能回复量提高 (26—30)%",
                                            "id": 1303
                                        },
                                        {
                                            "level":  44,
                                            "name":  "医生的",
                                            "value":  "暴击时有 (21—25)% 的几率获得 1 充能",
                                            "id": 1304
                                        },
                                        {
                                            "level":  62,
                                            "name":  "专家的",
                                            "value":  "暴击时有 (26—30)% 的几率获得 1 充能",
                                            "id": 1305
                                        },
                                        {
                                            "level":  63,
                                            "name":  "受虐者的",
                                            "value":  "你被敌人击中时获得 2 次充能",
                                            "id": 1306
                                        },
                                        {
                                            "level":  63,
                                            "name":  "无底的",
                                            "value":  "充能回复量提高 (31—45)%",
                                            "id": 1307
                                        },
                                        {
                                            "level":  80,
                                            "name":  "鞭笞的",
                                            "value":  "你被敌人击中时获得 3 次充能",
                                            "id": 1308
                                        },
                                        {
                                            "level":  80,
                                            "name":  "外科医生的",
                                            "value":  "暴击时有 (31—35)% 的几率获得 1 充能",
                                            "id": 1309
                                        },
                                        {
                                            "level":  83,
                                            "name":  "永久的",
                                            "value":  "充能回复量提高 (46—50)%",
                                            "id": 1310
                                        }
                                    ],
                   "魔力药剂：回复量提高":  [
                                      {
                                          "level":  1,
                                          "name":  "重多的",
                                          "value":  "回复量提高 (41—46)%；回复速度减慢 33%",
                                          "id": 1311
                                      },
                                      {
                                          "level":  13,
                                          "name":  "老朽的",
                                          "value":  "魔力回复提高 (41—46)%；使用时会扣除生命，等同于魔力回复值的 15%",
                                          "id": 1312
                                      },
                                      {
                                          "level":  21,
                                          "name":  "蔽光的",
                                          "value":  "回复量提高 (47—52)%；回复速度减慢 33%",
                                          "id": 1313
                                      },
                                      {
                                          "level":  30,
                                          "name":  "陈酿的",
                                          "value":  "魔力回复提高 (47—52)%；使用时会扣除生命，等同于魔力回复值的 15%",
                                          "id": 1314
                                      },
                                      {
                                          "level":  41,
                                          "name":  "全型的",
                                          "value":  "回复量提高 (53—58)%；回复速度减慢 33%",
                                          "id": 1315
                                      },
                                      {
                                          "level":  47,
                                          "name":  "凝历的",
                                          "value":  "魔力回复提高 (53—58)%；使用时会扣除生命，等同于魔力回复值的 15%",
                                          "id": 1316
                                      },
                                      {
                                          "level":  61,
                                          "name":  "专注的",
                                          "value":  "回复量提高 (59—64)%；回复速度减慢 33%",
                                          "id": 1317
                                      },
                                      {
                                          "level":  64,
                                          "name":  "浊重的",
                                          "value":  "魔力回复提高 (59—64)%；使用时会扣除生命，等同于魔力回复值的 15%",
                                          "id": 1318
                                      },
                                      {
                                          "level":  81,
                                          "name":  "饱和的",
                                          "value":  "回复量提高 (65—70)%；回复速度减慢 33%",
                                          "id": 1319
                                      },
                                      {
                                          "level":  81,
                                          "name":  "腐蚀性的",
                                          "value":  "魔力回复提高 (65—70)%；使用时会扣除生命，等同于魔力回复值的 15%",
                                          "id": 1320
                                      }
                                  ],
                   "魔力药剂：回复/持续速度":  [
                                        {
                                            "level":  1,
                                            "name":  "原汁的",
                                            "value":  "回复速度加快 (41—46)%",
                                            "id": 1321
                                        },
                                        {
                                            "level":  3,
                                            "name":  "煨闷的",
                                            "value":  "回复量降低 (52—55)%；回复速度加快 135%；立即回复50% 回复量",
                                            "id": 1322
                                        },
                                        {
                                            "level":  21,
                                            "name":  "加厚的",
                                            "value":  "回复速度加快 (47—52)%",
                                            "id": 1323
                                        },
                                        {
                                            "level":  22,
                                            "name":  "沸溢的",
                                            "value":  "回复量降低 (48—51)%；回复速度加快 135%；立即回复50% 回复量",
                                            "id": 1324
                                        },
                                        {
                                            "level":  41,
                                            "name":  "黏性的",
                                            "value":  "回复速度加快 (53—58)%",
                                            "id": 1325
                                        },
                                        {
                                            "level":  41,
                                            "name":  "喷熔的",
                                            "value":  "回复量降低 (44—47)%；回复速度加快 135%；立即回复50% 回复量",
                                            "id": 1326
                                        },
                                        {
                                            "level":  60,
                                            "name":  "沸熔的",
                                            "value":  "回复量降低 (40—43)%；回复速度加快 135%；立即回复50% 回复量",
                                            "id": 1327
                                        },
                                        {
                                            "level":  61,
                                            "name":  "浓黏的",
                                            "value":  "回复速度加快 (59—64)%",
                                            "id": 1328
                                        },
                                        {
                                            "level":  79,
                                            "name":  "起泡的",
                                            "value":  "回复量降低 (36—39)%；回复速度加快 135%；立即回复50% 回复量",
                                            "id": 1329
                                        },
                                        {
                                            "level":  81,
                                            "name":  "催化的",
                                            "value":  "回复速度加快 (65—70)%",
                                            "id": 1330
                                        }
                                    ],
                   "魔力药剂：解除流血和腐化之血":  [
                                          {
                                              "level":  8,
                                              "name":  "封闭之",
                                              "value":  "在流血时使用可以在接下来 (6—8) 秒免疫流血；被腐化之血影响时使用可以在接下来 (6—8) 秒免疫腐化之血",
                                              "id": 1331
                                          },
                                          {
                                              "level":  32,
                                              "name":  "缓减之",
                                              "value":  "在流血时使用可以在接下来 (9—11) 秒免疫流血；被腐化之血影响时使用可以在接下来 (9—11) 秒免疫腐化之血",
                                              "id": 1332
                                          },
                                          {
                                              "level":  56,
                                              "name":  "消减之",
                                              "value":  "在流血时使用可以在接下来 (12—14) 秒免疫流血；被腐化之血影响时使用可以在接下来 (12—14) 秒免疫腐化之血",
                                              "id": 1333
                                          },
                                          {
                                              "level":  80,
                                              "name":  "宽慰之",
                                              "value":  "在流血时使用可以在接下来 (15—17) 秒免疫流血；被腐化之血影响时使用可以在接下来 (15—17) 秒免疫腐化之血",
                                              "id": 1334
                                          }
                                      ],
                   "魔力药剂：解除感电":  [
                                     {
                                         "level":  6,
                                         "name":  "下地之",
                                         "value":  "遭受感电时使用可以在接下来 (6—8) 秒免疫感电",
                                         "id": 1335
                                     },
                                     {
                                         "level":  30,
                                         "name":  "接地之",
                                         "value":  "遭受感电时使用可以在接下来 (9—11) 秒免疫感电",
                                         "id": 1336
                                     },
                                     {
                                         "level":  54,
                                         "name":  "隔绝之",
                                         "value":  "遭受感电时使用可以在接下来 (12—14) 秒免疫感电",
                                         "id": 1337
                                     },
                                     {
                                         "level":  78,
                                         "name":  "电介之",
                                         "value":  "遭受感电时使用可以在接下来 (15—17) 秒免疫感电",
                                         "id": 1338
                                     }
                                 ],
                   "魔力药剂：解除缓速和瘫痪":  [
                                        {
                                            "level":  16,
                                            "name":  "行动之",
                                            "value":  "缓速时使用可以在接下来 (6—8) 秒免疫缓速；瘫痪时使用可以在接下来 (6—8) 秒免疫瘫痪",
                                            "id": 1339
                                        },
                                        {
                                            "level":  38,
                                            "name":  "动机之",
                                            "value":  "缓速时使用可以在接下来 (9—11) 秒免疫缓速；瘫痪时使用可以在接下来 (9—11) 秒免疫瘫痪",
                                            "id": 1340
                                        },
                                        {
                                            "level":  60,
                                            "name":  "自由之",
                                            "value":  "缓速时使用可以在接下来 (12—14) 秒免疫缓速；瘫痪时使用可以在接下来 (12—14) 秒免疫瘫痪",
                                            "id": 1341
                                        },
                                        {
                                            "level":  82,
                                            "name":  "解放之",
                                            "value":  "缓速时使用可以在接下来 (15—17) 秒免疫缓速；瘫痪时使用可以在接下来 (15—17) 秒免疫瘫痪",
                                            "id": 1342
                                        }
                                    ],
                   "魔力药剂：不满时缓速周围敌人":  [
                                          {
                                              "level":  30,
                                              "name":  "干涉之",
                                              "value":  "在魔力不满时使用可以缓速周围敌人，使它们的移动速度减慢 (17—22)%",
                                              "id": 1343
                                          },
                                          {
                                              "level":  48,
                                              "name":  "阻挠之",
                                              "value":  "在魔力不满时使用可以缓速周围敌人，使它们的移动速度减慢 (23—28)%",
                                              "id": 1344
                                          },
                                          {
                                              "level":  66,
                                              "name":  "闭收之",
                                              "value":  "在魔力不满时使用可以缓速周围敌人，使它们的移动速度减慢 (29—34)%",
                                              "id": 1345
                                          },
                                          {
                                              "level":  84,
                                              "name":  "抑束之",
                                              "value":  "在魔力不满时使用可以缓速周围敌人，使它们的移动速度减慢 (35—40)%",
                                              "id": 1346
                                          }
                                      ]
               }
};

  Object.assign(AFFIX_EQUIPMENT_DATA, POEDB_FLASK_AFFIX_DATA.equipment);
  Object.assign(AFFIX_LEVEL_DATA, POEDB_FLASK_AFFIX_DATA.levels);

  const AFFIX_CONDITION_ID_SEPARATOR = '\u0001';
  const AFFIX_CONDITION_ID_TO_VALUE = new Map();
  const AFFIX_CONDITION_VALUE_TO_ID = new Map();

  const getAffixConditionIdKey = (affixType, affixName) => (
    `${String(affixType || '').trim()}${AFFIX_CONDITION_ID_SEPARATOR}${String(affixName || '').trim()}`
  );

  Object.entries(AFFIX_LEVEL_DATA || {}).forEach(([affixType, tierList]) => {
    if (!Array.isArray(tierList)) return;
    tierList.forEach((tier) => {
      const id = Number(tier?.id);
      const name = String(tier?.name || '').trim();
      if (!Number.isInteger(id) || id <= 0 || !name) return;
      const value = { name, affixType };
      AFFIX_CONDITION_ID_TO_VALUE.set(id, value);
      AFFIX_CONDITION_VALUE_TO_ID.set(getAffixConditionIdKey(affixType, name), id);
    });
  });

  const getAffixConditionId = (condition) => {
    const affixType = String(condition?.affixType || '').trim();
    const name = String(condition?.name || '').trim();
    if (!affixType || !name) return null;
    return AFFIX_CONDITION_VALUE_TO_ID.get(getAffixConditionIdKey(affixType, name)) || null;
  };

  const getAffixConditionById = (id) => AFFIX_CONDITION_ID_TO_VALUE.get(Number(id)) || null;

  const createShareEnum = (values) => {
    const toId = {};
    const fromId = {};
    values.forEach((value, index) => {
      const id = index + 1;
      toId[value] = id;
      fromId[id] = value;
    });
    return { toId, fromId };
  };

  const SHARE_ACTION_ENUM = createShareEnum([
    'conditionCheck',
    'none',
    'altAug',
    'scouring',
    'transmutation',
    'alteration',
    'augment',
    'regal',
    'alchemy',
    'chaos',
    'exalted',
    'annulment',
    'craftBench',
    'ensureMagic',
    'ensureRare',
    'smartAugment',
    'smartExalted',
    'smartCraftBench',
    'gardenCraft',
    'divine',
  ]);

  const SHARE_STEP_HANDLING_ENUM = createShareEnum([
    'jump',
    'scourRestart',
    'terminateError',
    'terminateSuccess',
    'terminateManual',
  ]);

  const SHARE_SPECIAL_METRIC_ENUM = createShareEnum([
    'totalAffixCount',
    'prefixCount',
    'suffixCount',
    'rarity',
    'corrupted',
    'openPrefix',
    'openSuffix',
    'openAffix',
    'crafted',
    'craftedMultimod',
  ]);

  const SHARE_ROLL_METRIC_ENUM = createShareEnum([
    'physicalDamageMin',
    'physicalDamageMax',
    'fireDamageMin',
    'fireDamageMax',
    'coldDamageMin',
    'coldDamageMax',
    'lightningDamageMin',
    'lightningDamageMax',
    'chaosDamageMin',
    'chaosDamageMax',
    'prefixRollAverage',
    'prefixRollMinimum',
    'suffixRollAverage',
    'suffixRollMinimum',
    'affixRollAverage',
    'affixRollMinimum',
    'craftedRollAverage',
    'craftedRollMinimum',
  ]);

  const SHARE_SPECIAL_OPERATOR_ENUM = createShareEnum([
    'eq',
    'ne',
    'contains',
    'notContains',
    'gt',
    'gte',
    'lt',
    'lte',
  ]);

  const SHARE_CRAFT_CATEGORY_ENUM = createShareEnum(CRAFT_BENCH_CATEGORY_OPTIONS.map((option) => option.value));
  const SHARE_GARDEN_CRAFT_CATEGORY_ENUM = createShareEnum(GARDEN_CRAFT_CATEGORY_OPTIONS.map((option) => option.value));

  const encodeShareEnumValue = (value, enumConfig) => enumConfig.toId[value] || value;
  const decodeShareEnumValue = (value, enumConfig, fallback = value) => (
    typeof value === 'number' ? (enumConfig.fromId[value] || fallback) : (value || fallback)
  );

  const decodeShareStepAction = (value) => {
    const action = decodeShareEnumValue(value, SHARE_ACTION_ENUM, value);
    if (!CONTINUOUS_CRAFT_ACTIONS[action]) {
      throw new Error(`分享码包含未知步骤动作：${value}`);
    }
    return action;
  };

  const decodeShareStepHandling = (value) => {
    const handling = decodeShareEnumValue(value, SHARE_STEP_HANDLING_ENUM, value);
    if (handling === 'continue') {
      throw new Error('分享码包含已移除的“继续当前步骤”，请重新导出当前格式的方案。');
    }
    if (!CONTINUOUS_STEP_HANDLINGS[handling]) {
      throw new Error(`分享码包含未知跳转处理：${value}`);
    }
    return handling;
  };

  /**
   * assertAssistantStorageKey 校验助手自有存储 key 必须使用统一前缀。
   * @param {string} storageKey localStorage 键名。
   */
  const assertAssistantStorageKey = (storageKey) => {
    if (!String(storageKey || '').startsWith(`${STORAGE_KEY_PREFIX}.`)) {
      throw new Error(`助手存储 key 缺少统一前缀：${storageKey}`);
    }
  };

  /**
   * getAssistantStorageValue 统一读取助手自有 localStorage 字段。
   * @param {string} storageKey STORAGE_KEYS 中定义的完整键名。
   * @param {string|null} fallbackValue 没有值时返回的默认值。
   * @returns {string|null} 本地存储值。
   */
  const getAssistantStorageValue = (storageKey, fallbackValue = null) => {
    assertAssistantStorageKey(storageKey);
    const storageValue = localStorage.getItem(storageKey);
    return storageValue === null ? fallbackValue : storageValue;
  };

  /**
   * setAssistantStorageValue 统一写入助手自有 localStorage 字段。
   * @param {string} storageKey STORAGE_KEYS 中定义的完整键名。
   * @param {string} storageValue 需要保存的字符串值。
   */
  const setAssistantStorageValue = (storageKey, storageValue) => {
    assertAssistantStorageKey(storageKey);
    localStorage.setItem(storageKey, String(storageValue));
  };

  /**
   * readAssistantStorageJson 安全读取助手自有 JSON 缓存，避免历史坏数据导致脚本初始化失败。
   * @param {string} storageKey STORAGE_KEYS 中定义的完整键名。
   * @param {*} fallbackValue 读取失败时返回的默认值。
   * @returns {*} 解析后的本地数据。
   */
  const readAssistantStorageJson = (storageKey, fallbackValue) => {
    try {
      const rawValue = getAssistantStorageValue(storageKey, null);
      if (!rawValue) return fallbackValue;
      return JSON.parse(rawValue);
    } catch (error) {
      console.warn('[AssistantV2] localStorage JSON parse failed:', storageKey, error);
      return fallbackValue;
    }
  };

  /**
   * writeAssistantStorageJson 统一写入助手自有 JSON 缓存。
   * @param {string} storageKey STORAGE_KEYS 中定义的完整键名。
   * @param {*} storageValue 需要序列化保存的数据。
   */
  const writeAssistantStorageJson = (storageKey, storageValue) => {
    setAssistantStorageValue(storageKey, JSON.stringify(storageValue));
  };

  /**
   * clampPositiveInteger 清洗正整数配置，并限制在可控范围内。
   * @param {*} value 原始值。
   * @param {number} minValue 最小值。
   * @param {number} maxValue 最大值。
   * @returns {number} 清洗后的正整数。
   */
  const clampPositiveInteger = (value, fallbackValue, minValue, maxValue) => {
    const parsedValue = Number.parseInt(value, 10);
    const safeValue = Number.isFinite(parsedValue) ? parsedValue : fallbackValue;
    return Math.min(maxValue, Math.max(minValue, safeValue));
  };

  const sanitizeRecentMailReceiverList = (receivers) => {
    if (typeof receivers === 'string') {
      try {
        receivers = JSON.parse(receivers);
      } catch (error) {
        receivers = [];
      }
    }
    const seenReceivers = new Set();
    return (Array.isArray(receivers) ? receivers : [])
      .map((receiver) => String(receiver || '').trim())
      .filter((receiver) => {
        if (!receiver || seenReceivers.has(receiver)) return false;
        seenReceivers.add(receiver);
        return true;
      })
      .slice(0, 3);
  };

  const sanitizePositionSetting = (position) => {
    if (!position || typeof position !== 'object') return null;
    const left = Number.parseFloat(position.left);
    const top = Number.parseFloat(position.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left: Math.max(0, left), top: Math.max(0, top) };
  };

  const sanitizeAssistantSettings = (settings = {}) => ({
    themeMode: Object.values(THEME_MODES).includes(settings.themeMode) ? settings.themeMode : THEME_MODES.auto,
    speedMode: normalizeSpeedMode(settings.speedMode || 'normal'),
    logMode: normalizeLogMode(settings.logMode || 'main'),
    minimizePausesAutomation: settings.minimizePausesAutomation === true || settings.minimizePausesAutomation === 'true',
    stepActionSafetyLimit: clampPositiveInteger(settings.stepActionSafetyLimit, 500, 1, 100000),
    customCraftStepSafetyLimit: clampPositiveInteger(settings.customCraftStepSafetyLimit, 300, 1, 100000),
    customCraftCurrencyLimit: clampPositiveInteger(settings.customCraftCurrencyLimit, 10000, 1, 1000000),
    panelPosition: sanitizePositionSetting(settings.panelPosition),
    togglePosition: sanitizePositionSetting(settings.togglePosition),
    recentMailReceivers: sanitizeRecentMailReceiverList(settings.recentMailReceivers),
  });

  const readAssistantSettings = () => {
    return sanitizeAssistantSettings(readAssistantStorageJson(STORAGE_KEYS.settings, {}));
  };

  const getCurrentAssistantSettingsSnapshot = () => sanitizeAssistantSettings({
      themeMode: state.themeMode,
      speedMode: state.speedMode,
      logMode: state.logMode,
      minimizePausesAutomation: state.minimizePausesAutomation,
      stepActionSafetyLimit: state.stepActionSafetyLimit,
      customCraftStepSafetyLimit: state.customCraftStepSafetyLimit,
      customCraftCurrencyLimit: state.customCraftCurrencyLimit,
      panelPosition: state.panelPosition,
      togglePosition: state.togglePosition,
      recentMailReceivers: state.recentMailReceivers,
  });

  const persistAssistantSettings = () => {
    writeAssistantStorageJson(STORAGE_KEYS.settings, getCurrentAssistantSettingsSnapshot());
  };

  const updateAssistantSetting = (keyName, value) => {
    writeAssistantStorageJson(STORAGE_KEYS.settings, sanitizeAssistantSettings({
      ...readAssistantStorageJson(STORAGE_KEYS.settings, {}),
      [keyName]: value,
    }));
  };

  const clearTransientAssistantStorage = () => {
    TRANSIENT_ASSISTANT_STORAGE_KEYS.forEach((storageKey) => localStorage.removeItem(storageKey));
  };

  clearTransientAssistantStorage();

  const assistantSettings = readAssistantSettings();

  writeAssistantStorageJson(STORAGE_KEYS.settings, assistantSettings);

  const state = {
    /** isPanelVisible 表示主面板是否显示。 */
    isPanelVisible: false,
    /** isRunning 表示当前是否有自动化任务正在执行。 */
    isRunning: false,
    /** abortController 用来中断当前正在进行的 fetch 请求。 */
    abortController: null,
    /** currentTaskName 记录当前任务名称，方便按钮状态和日志展示。 */
    currentTaskName: '',
    /** currentTaskStartedAt 记录当前任务启动时间戳，用于结束时输出耗时。 */
    currentTaskStartedAt: 0,
    /** processedEquipmentIds 记录本轮已处理装备，避免分页重复处理同一件装备。 */
    processedEquipmentIds: new Set(),
    /** currentPage 记录背包分页扫描位置。 */
    currentPage: 1,
    /** completedCount 记录本轮已成功完成的装备数量。 */
    completedCount: 0,
    /** currentTaskTargetCount 记录当前任务目标数量，用于停止或结束时输出命中汇总。 */
    currentTaskTargetCount: 0,
    /** currencyUsage 记录当前任务中已成功消耗的通货数量，用于每 200 个自动汇报一次。 */
    currencyUsage: { total: 0, byName: {}, stepCounts: {} },
    /** stepActionSafetyLimit 是经典打造、孔洞和批量操作的单动作连续尝试上限。 */
    stepActionSafetyLimit: assistantSettings.stepActionSafetyLimit,
    /** customCraftStepSafetyLimit 是自定义打造单个判断条件步骤的安全上限。 */
    customCraftStepSafetyLimit: assistantSettings.customCraftStepSafetyLimit,
    /** customCraftCurrencyLimit 是自定义打造单个任务允许消耗的总通货上限。 */
    customCraftCurrencyLimit: assistantSettings.customCraftCurrencyLimit,
    /** speedMode 记录当前速度档位。 */
    speedMode: assistantSettings.speedMode,
    /** logMode 记录当前日志密度。 */
    logMode: assistantSettings.logMode,
    /** useStorage 表示是否从储藏位置而不是背包读取装备。 */
    useStorage: false,
    /** refreshEquipmentAfterCraft 表示每次装备通货操作成功后是否重新查询单件装备信息；该开关不保存。 */
    refreshEquipmentAfterCraft: false,
    /** minimizePausesAutomation 表示收起面板时是否自动停止当前自动化任务。 */
    minimizePausesAutomation: assistantSettings.minimizePausesAutomation,
    /** themeMode 表示助手 UI 主题模式，默认跟随网页 localStorage.theme。 */
    themeMode: assistantSettings.themeMode,
    /** panelPosition 保存主面板拖拽位置。 */
    panelPosition: assistantSettings.panelPosition,
    /** togglePosition 保存外部入口按钮拖拽位置。 */
    togglePosition: assistantSettings.togglePosition,
    /** resolvedTheme 记录当前实际生效的浅色/深色主题。 */
    resolvedTheme: THEME_MODES.dark,
    /** logs 保存最近的操作日志。 */
    logs: [],
    /** skillStones 保存最近一次刷新到的背包和装备镶嵌技能石列表。 */
    skillStones: [],
    /** hasLoadedSkillStones 表示技能石列表是否已成功加载，用于禁用误操作按钮。 */
    hasLoadedSkillStones: false,
    /** practiceSkillStoneCache 保存加载技能石时同步获得的练习孔位缓存，调整位置时不再重复查询。 */
    practiceSkillStoneCache: {
      loaded: false,
      socketRecords: [],
      playerEpm: 0,
      excludedSummary: { active: 0, special: 0 },
      excludedEmptySockets: { active: [], special: [] },
    },
    /** affixConditionGroups 保存词缀筛选条件组；每组都有自己的条件列表和本组命中数。 */
    affixConditionGroups: [{ conditions: [], minRequired: 1 }],
    /** affixConditionContext 记录词缀编辑器当前是否正在编辑连续打造步骤。 */
    affixConditionContext: { mode: 'normal', stepIndex: 0 },
    /** continuousCraftSteps 保存连续打造的大步骤；每一步都有独立动作和独立条件组。 */
    continuousCraftSteps: [],
    /** activeContinuousStepIndex 记录当前正在编辑的连续打造步骤。 */
    activeContinuousStepIndex: 0,
    /** craftPlans 保存用户本地打造方案列表。 */
    craftPlans: readAssistantStorageJson(STORAGE_KEYS.craftPlans, []),
    /** advancedBatchSteps 保存高级连续批量的多个步骤动作。 */
    advancedBatchSteps: [],
    /** activeAdvancedBatchStepIndex 记录当前正在编辑的高级连续批量步骤。 */
    activeAdvancedBatchStepIndex: 0,
    /** recentMailReceivers 保存最近成功发送邮件的 3 个收件人角色名。 */
    recentMailReceivers: assistantSettings.recentMailReceivers,
    /** mailReceiverSuggestions 保存收件人输入框当前的角色名候选。 */
    mailReceiverSuggestions: [],
    /** mailCurrencyData 缓存最近一次读取到的通货数据，滑块预览时避免重复请求。 */
    mailCurrencyData: null,
    /** mailCurrencyPreview 保存按当前通货百分比计算后的预计发送数量。 */
    mailCurrencyPreview: [],
    /** mailReceiverSearchTimer 是收件人自动提示的防抖计时器。 */
    mailReceiverSearchTimer: null,
    /** mailCurrencyPreviewTimer 是通货数量预览的防抖计时器。 */
    mailCurrencyPreviewTimer: null,
    /** fracturedEquipments 保存最近一次扫描到的背包破裂装备列表。 */
    fracturedEquipments: [],
    /** battleAnalysis 保存轻量战斗分析的连接状态和实时统计。 */
    battleAnalysis: {
      isConnected: false,
      isConnecting: false,
      controller: null,
      socket: null,
      summaryTimerId: 0,
      startedAt: 0,
      timingStartedAt: 0,
      playerId: '',
      playerName: '',
      battleMap: new Map(),
      totalMonsterCount: 0,
      totalBattleFrameCount: 0,
      totalBattleEventCount: 0,
      totalRewardCount: 0,
      totalRewardExp: 0,
      totalRewardCurrencyCount: 0,
      totalServerSeconds: 0,
      observedServerSeconds: 0,
      dilationDetected: false,
      dilationSampleCount: 0,
      dilationMultiplierTotal: 0,
      dilationMultiplierMax: 1,
      dilationMultiplierLatest: 1,
      ignoredInitialFrameCount: 0,
      ignoredLocalLagSampleCount: 0,
      stableInitialFrameCount: 0,
      lastEventType: '',
      lastMessageAt: 0,
      lastError: '',
    },
    /** rankAnalysis 保存排行榜分析模块的缓存和当前选中玩家。 */
    rankAnalysis: {
      players: [],
      selectedPlayerId: '',
      selectedPlayerDetail: null,
      selectedPlayerReport: '',
      batchReport: '',
      activeReportType: 'player',
    },
    /** craftBench 保存工艺台列表缓存，来自游戏前端同款 /craft/list 接口。 */
    craftBench: {
      list: [],
      loaded: false,
      loading: false,
      loadingPromise: null,
      magicFormatters: null,
      magicFormattersLoadingPromise: null,
    },
    /** gardenCraft 保存花园工艺列表缓存，选项来自游戏前端同款 /equipment/garden/list 接口。 */
    gardenCraft: {
      byCategory: {},
      loadingByCategory: {},
    },
    /** isTogglePositionMode 表示外部悬浮入口按钮是否处于拖动调位模式。 */
    isTogglePositionMode: false,
    /** ui 保存创建后的 DOM 引用，避免重复 querySelector。 */
    ui: {},
  };

  /**
   * config 保存脚本可调参数和接口路径。
   */
  const config = {
    /** pageSize 是每次读取背包装备数量。 */
    pageSize: 30,
    /** maxPagesPerRound 是单轮任务最多扫描页数，防止异常情况下无限翻页。 */
    maxPagesPerRound: 20,
    /** maxChromaticAttempts 是单件装备最多洗色次数。 */
    maxChromaticAttempts: 120,
    /** maxCraftAttempts 是单件装备最多打孔次数。 */
    maxCraftAttempts: 240,
    /** maxLoopAttempts 是词缀类循环的单件装备最大尝试次数。 */
    maxLoopAttempts: 500,
    /**
     * requestRetry 控制接口短暂断线时的自动重连。
     * 打造装备会大量连续请求，服务器偶发 502/503/504 时自动等待重试，避免整轮任务直接中断。
     */
    requestRetry: {
      maxAttempts: 5,
      baseDelayMs: 1200,
      timeoutDelayMs: 3000,
      maxDelayMs: 8000,
      statuses: [502, 503, 504, 524],
    },
    /** endpoints 保存脚本使用的后端接口。 */
    endpoints: {
      character: `${API_BASE_URL}/character`,
      characterSearch: `${API_BASE_URL}/character/search`,
      backpack: `${API_BASE_URL}/character/backpack`,
      skillStones: `${API_BASE_URL}/character/skillstones`,
      skillStoneDetail: `${API_BASE_URL}/skillstone`,
      skillStoneUpgrade: `${API_BASE_URL}/skillstone/upgrade`,
      skillStoneModify: `${API_BASE_URL}/skillstone/modify`,
      skillStoneDestroy: `${API_BASE_URL}/skillstone/destroy`,
      skillStoneEnable: `${API_BASE_URL}/skillstone/enable`,
      currency: `${API_BASE_URL}/character/currency`,
      shopBuy: `${API_BASE_URL}/shop/buy`,
      mailSend: `${API_BASE_URL}/mail/send`,
      equipmentDetail: `${API_BASE_URL}/equipment`,
      equipmentModify: `${API_BASE_URL}/equipment/modify`,
      equipmentInsertStone: `${API_BASE_URL}/equipment/insertStone`,
      equipmentRemoveStone: `${API_BASE_URL}/equipment/removeStone`,
      equipmentDestroy: `${API_BASE_URL}/equipment/destroy`,
      equipmentDestroyBatch: `${API_BASE_URL}/equipment/destroyBatch`,
      equipmentStorage: `${API_BASE_URL}/equipment/storage`,
      craftList: `${API_BASE_URL}/craft/list`,
      craftApply: `${API_BASE_URL}/craft`,
      gardenList: `${API_BASE_URL}/equipment/garden/list`,
      gardenApply: `${API_BASE_URL}/equipment/garden/apply`,
      battleWs: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/battle/ws`,
      rankLevel: `${API_BASE_URL}/rank/level`,
      characterView: `${API_BASE_URL}/character/view`,
      skillTree: `${API_BASE_URL}/skilltree`,
      skillTreeData: `${API_BASE_URL}/skilltree/data`,
    },
  };

  /**
   * wait 用 Promise 包装 setTimeout，让异步流程更易读。
   * @param {number} milliseconds 等待的毫秒数。
   * @returns {Promise<void>} 等待结束后 resolve 的 Promise。
   */
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  const runConcurrentTasks = async (items, concurrency, worker) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(Math.floor(Number(concurrency) || 1), items.length || 1));
    const runners = Array.from({ length: workerCount }, async () => {
      while (state.isRunning && nextIndex < items.length) {
        const itemIndex = nextIndex;
        nextIndex += 1;
        try {
          results[itemIndex] = await worker(items[itemIndex], itemIndex);
        } catch (error) {
          results[itemIndex] = { error };
        }
      }
    });
    await Promise.all(runners);
    return results;
  };

  /**
   * normalizeThemeMode 清理用户或历史缓存中的主题模式。
   * @param {string} themeMode 原始主题模式。
   * @returns {string} 合法主题模式。
   */
  const normalizeThemeMode = (themeMode) => (
    Object.values(THEME_MODES).includes(themeMode) ? themeMode : THEME_MODES.auto
  );

  /**
   * getPageTheme 读取游戏网页自己的 UI 风格字段。
   * 赚钱脚本使用 localStorage.theme；这里复用同一字段来实现“跟随网页”。
   * @returns {string} light 或 dark。
   */
  const getPageTheme = () => (
    localStorage.getItem(PAGE_STORAGE_KEYS.theme) === THEME_MODES.light ? THEME_MODES.light : THEME_MODES.dark
  );

  /**
   * resolveAssistantTheme 根据助手主题模式计算实际浅色/深色。
   * @returns {string} light 或 dark。
   */
  const resolveAssistantTheme = () => (
    normalizeThemeMode(state.themeMode) === THEME_MODES.auto ? getPageTheme() : normalizeThemeMode(state.themeMode)
  );

  /**
   * applyAssistantTheme 把主题类应用到所有助手根节点。
   */
  const applyAssistantTheme = () => {
    const resolvedTheme = resolveAssistantTheme();
    state.resolvedTheme = resolvedTheme;
    for (const element of [state.ui.toggleButton, state.ui.panel, state.ui.fracturedModal]) {
      if (!element) continue;
      element.classList.remove('poe2-theme-light', 'poe2-theme-dark');
      element.classList.add(`poe2-theme-${resolvedTheme}`);
    }
    if (state.ui.themeModeSelect) {
      state.ui.themeModeSelect.value = normalizeThemeMode(state.themeMode);
    }
    if (state.ui.logModeSelect) {
      state.ui.logModeSelect.value = normalizeLogMode(state.logMode);
    }
  };

  /**
   * setAssistantThemeMode 保存并应用助手主题模式。
   * @param {string} nextThemeMode 新主题模式。
   */
  const setAssistantThemeMode = (nextThemeMode) => {
    state.themeMode = normalizeThemeMode(nextThemeMode);
    updateAssistantSetting('themeMode', state.themeMode);
    applyAssistantTheme();
    addLog(`UI 风格已切换为：${state.themeMode === THEME_MODES.auto ? '跟随网页' : (state.themeMode === THEME_MODES.light ? '浅色模式' : '深色模式')}`, 'compact');
  };

  /**
   * getSpeedDelay 读取当前速度档对应的请求间隔。
   * @returns {number} 当前速度档的毫秒延迟。
   */
  const getSpeedDelay = () => SPEED_OPTIONS[normalizeSpeedMode(state.speedMode)].delayMs;

  const normalizeLogLevel = (level) => (LOG_LEVELS[level] ? level : 'info');

  const shouldRecordLog = (level) => {
    const logLevel = LOG_LEVELS[normalizeLogLevel(level)];
    const minPriority = LOG_MODES[normalizeLogMode(state.logMode)]?.minPriority ?? LOG_LEVELS.info.priority;
    return logLevel.priority >= minPriority;
  };

  const addTraceLog = (message) => addLog(message, 'trace');

  const addStepLog = (message) => addLog(message, 'detail');

  const addMainLog = (message) => addLog(message, 'main');

  const setSpeedMode = (nextSpeedMode) => {
    state.speedMode = normalizeSpeedMode(nextSpeedMode);
    updateAssistantSetting('speedMode', state.speedMode);
    if (state.ui.speedSelect) setInputValue(state.ui.speedSelect, state.speedMode);
    addLog(`自动化速度已切换为：${SPEED_OPTIONS[state.speedMode].label}。`, 'compact');
  };

  const setLogMode = (nextLogMode) => {
    state.logMode = normalizeLogMode(nextLogMode);
    updateAssistantSetting('logMode', state.logMode);
    if (state.ui.logModeSelect) setInputValue(state.ui.logModeSelect, state.logMode);
    addLog(`日志等级已切换为：${LOG_MODES[state.logMode].label}。`, 'compact');
  };

  /**
   * getAuthToken 从页面已有登录态中读取 JWT。
   * 注意：2.0 不会把测试 token 写进脚本，也不会自动写入 localStorage。
   * @returns {string} 已去掉 Bearer 前缀的 token；没有登录态时返回空字符串。
   */
  const getAuthToken = () => {
    const tokenValue = localStorage.getItem(PAGE_STORAGE_KEYS.token) || sessionStorage.getItem(PAGE_STORAGE_KEYS.token) || '';
    return tokenValue.replace(/^Bearer\s+/i, '').trim();
  };

  /**
   * getAuthorizationHeader 生成后端接口需要的 Authorization 请求头。
   * @returns {string} Bearer 格式的 Authorization 值。
   */
  const getAuthorizationHeader = () => `Bearer ${getAuthToken()}`;

  /**
   * assertLoggedIn 在任务开始前检查登录态，避免没有 token 时发起大量失败请求。
   * @throws {Error} 没有登录态时抛出错误。
   */
  const assertLoggedIn = () => {
    if (!getAuthToken()) {
      throw new Error('未找到登录 token，请先在测试服登录后再运行脚本。');
    }
  };

  /**
   * readJsonResponse 安全读取接口 JSON，避免空响应或非 JSON 响应导致脚本崩溃。
   * @param {Response} response fetch 返回的响应对象。
   * @returns {Promise<object>} 解析后的 JSON 对象。
   */
  const readJsonResponse = async (response) => {
    const responseText = await response.text();
    if (!responseText) return {};
    try {
      return JSON.parse(responseText);
    } catch (error) {
      throw new Error(`接口返回不是 JSON：${responseText.slice(0, 120)}`);
    }
  };

  /**
   * isRequestAbortError 兼容不同浏览器/运行时的手动中断错误。
   * Chrome 有时会抛出 TypeError: signal is aborted without reason，而不是标准 AbortError。
   * @param {Error} error 捕获到的异常。
   * @returns {boolean} 是手动中断请求时返回 true。
   */
  const isRequestAbortError = (error) => {
    const message = String(error?.message || error || '').toLowerCase();
    return error?.name === 'AbortError'
      || message.includes('signal is aborted')
      || message.includes('aborted without reason')
      || message.includes('the user aborted a request');
  };

  /**
   * isRetryableRequestFailure 判断一次接口失败是否适合自动重试。
   * 只重试短暂服务不可用或浏览器网络瞬断，不重试业务错误，避免重复提交确定失败的操作。
   * @param {Error} error 捕获到的异常。
   * @param {Response|null} response fetch 返回的响应对象。
   * @returns {boolean} 可以重试时返回 true。
   */
  const isRetryableRequestFailure = (error, response) => {
    if (isRequestAbortError(error)) return false;
    if (response && config.requestRetry.statuses.includes(response.status)) return true;
    if (!response && error instanceof TypeError) return true;
    return false;
  };

  /**
   * getRequestRetryDelay 计算本次重连等待时间。
   * @param {number} attemptIndex 当前失败次数，从 1 开始。
   * @returns {number} 等待毫秒数。
   */
  const getRequestRetryDelay = (attemptIndex, response = null) => {
    if (response?.status === 524) return config.requestRetry.timeoutDelayMs;
    return Math.min(
      config.requestRetry.maxDelayMs,
      config.requestRetry.baseDelayMs * attemptIndex,
    );
  };

  /**
   * requestJson 统一处理 fetch、鉴权、JSON body、错误提示和中断信号。
   * @param {string} url 请求地址。
   * @param {object} options fetch 参数。
   * @returns {Promise<object>} 接口返回的 JSON。
   */
  const requestJson = async (url, options = {}) => {
    assertLoggedIn();
    let lastError = null;
    for (let attemptIndex = 1; attemptIndex <= config.requestRetry.maxAttempts; attemptIndex += 1) {
      let response = null;
      try {
        const requestOptions = {
          method: options.method || 'GET',
          cache: 'no-cache',
          signal: state.abortController?.signal,
          headers: {
            Accept: 'application/json',
            Authorization: getAuthorizationHeader(),
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
        };
        addTraceLog(`调用接口：${requestOptions.method} ${url}`);
        response = await fetch(url, requestOptions);
        const payload = await readJsonResponse(response);
        if (!response.ok) {
          throw new Error(payload.message || `HTTP ${response.status}`);
        }
        if (attemptIndex > 1) {
          console.info(`[AssistantV2] 接口已自动重连成功：第 ${attemptIndex} 次请求 ${url}`);
        }
        return payload;
      } catch (error) {
        lastError = error;
        const canRetry = attemptIndex < config.requestRetry.maxAttempts && isRetryableRequestFailure(error, response);
        if (!canRetry) break;
        const delayMs = getRequestRetryDelay(attemptIndex, response);
        console.warn(`[AssistantV2] 接口短暂不可用，${delayMs}ms 后重试：第 ${attemptIndex}/${config.requestRetry.maxAttempts} 次失败，${response?.status || error.message}`);
        await wait(delayMs);
      }
    }
    throw lastError || new Error('接口请求失败');
  };

  /**
   * extractJsonObjects 从混合文本中提取一个或多个 JSON 对象。
   * 兼容调试环境下的文本帧或一次网络分片里放多条数据的情况。
   * @param {string} text 可能包含 JSON 的原始文本。
   * @returns {Array<object>} 解析成功的 JSON 对象列表。
   */
  const extractJsonObjects = (text) => {
    const objects = [];
    let depth = 0;
    let startIndex = -1;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        if (depth === 0) startIndex = index;
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0 && startIndex >= 0) {
          try {
            objects.push(JSON.parse(text.slice(startIndex, index + 1)));
          } catch (error) {
            addLog(`战斗数据解析失败：${error.message}`, 'warn');
          }
          startIndex = -1;
        }
      }
    }
    return objects;
  };

  /**
   * createEmptyBattleAnalysisState 创建战斗分析统计的初始状态。
   * @returns {object} 可直接写入 state.battleAnalysis 的状态对象。
   */
  const createEmptyBattleAnalysisState = () => ({
    isConnected: false,
    isConnecting: false,
    controller: null,
    socket: null,
    summaryTimerId: 0,
    startedAt: 0,
    timingStartedAt: 0,
    playerId: '',
    playerName: '',
    playerSource: '',
    streamUrl: '',
    isSpectator: false,
    battleMap: new Map(),
    totalMonsterCount: 0,
    totalBattleFrameCount: 0,
    totalBattleEventCount: 0,
    totalRewardCount: 0,
    totalRewardExp: 0,
    totalRewardCurrencyCount: 0,
    totalServerSeconds: 0,
    observedServerSeconds: 0,
    dilationDetected: false,
    dilationSampleCount: 0,
    dilationMultiplierTotal: 0,
    dilationMultiplierMax: 1,
    dilationMultiplierLatest: 1,
    ignoredInitialFrameCount: 0,
    ignoredLocalLagSampleCount: 0,
    stableInitialFrameCount: 0,
    lastEventType: '',
    lastMessageAt: 0,
    lastError: '',
  });

  /**
   * getBattleAnalysisPerMinute 计算当前每分钟遇怪数量。
   * @returns {number} 怪物/分钟；数据不足时返回 0。
   */
  const getBattleAnalysisPerMinute = () => (
    state.battleAnalysis.observedServerSeconds > 0
      ? (state.battleAnalysis.totalMonsterCount / state.battleAnalysis.observedServerSeconds) * 60
      : 0
  );

  /**
   * getBattleAnalysisExpPerMinute 计算战斗时间口径的每分钟经验。
   * @returns {number} 经验/分钟；数据不足时返回 0。
   */
  const getBattleAnalysisExpPerMinute = () => (
    state.battleAnalysis.observedServerSeconds > 0
      ? (state.battleAnalysis.totalRewardExp / state.battleAnalysis.observedServerSeconds) * 60
      : 0
  );

  /**
   * normalizeBattleAnalysisWebSocketUrl 把网页端 streamUrl 转成可连接的 WebSocket 地址。
   * @param {string} streamUrl 网页端传给 BattleView 的 stream-url。
   * @returns {string} WebSocket 地址。
   */
  const normalizeBattleAnalysisWebSocketUrl = (streamUrl) => {
    let urlText = String(streamUrl || config.endpoints.battleWs).trim();
    if (urlText.startsWith('http://')) urlText = `ws://${urlText.slice(7)}`;
    else if (urlText.startsWith('https://')) urlText = `wss://${urlText.slice(8)}`;
    else if (urlText.startsWith('/')) {
      urlText = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${urlText}`;
    }
    return urlText;
  };

  /**
   * getBattleAnalysisWebSocketUrl 按网页战斗页的规则拼出战斗 WebSocket 地址。
   * 当前网页的正常战斗帧来自 /api/battle/ws；/api/battle/sse 主要用于奖励等轻量推送。
   * @param {string} characterId 当前角色 ID。
   * @param {boolean} isSpectator 是否按网页观战模式连接。
   * @param {string} streamUrl 网页端观战流地址。
   * @returns {string} 带 token 和 cid 的 WebSocket 地址。
   */
  const getBattleAnalysisWebSocketUrl = (characterId, isSpectator = false, streamUrl = '') => {
    const url = new URL(normalizeBattleAnalysisWebSocketUrl(streamUrl));
    url.searchParams.set('replay', '0');
    if (!isSpectator) {
      const token = getAuthToken();
      if (token) url.searchParams.set('token', token);
      if (characterId) url.searchParams.set('cid', characterId);
    }
    return url.toString();
  };

  /**
   * getWatchBattleCharacterIdFromUrl 从观战地址中读取角色 ID。
   * @param {string} urlText 当前页面 URL。
   * @returns {string} 观战角色 ID；不是观战地址时返回空字符串。
   */
  const getWatchBattleCharacterIdFromUrl = (urlText = location.href) => {
    try {
      const url = new URL(urlText, location.origin);
      const match = url.pathname.match(/\/watch\/battle\/([^/?#]+)/);
      if (match?.[1]) return decodeURIComponent(match[1]).trim();
      return url.pathname.replace(/\/+$/, '') === '/watch/battle'
        ? String(url.searchParams.get('cid') || '').trim()
        : '';
    } catch (error) {
      return '';
    }
  };

  /**
   * decodeBattleSocketData 把 WebSocket 收到的文本或二进制消息统一转成字符串。
   * @param {string|ArrayBuffer|Blob} rawData WebSocket 原始消息。
   * @returns {Promise<string>} 解码后的消息文本。
   */
  const decodeBattleSocketData = async (rawData) => {
    if (typeof rawData === 'string') return rawData;
    if (rawData instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(rawData);
    if (rawData instanceof Blob) return rawData.text();
    return String(rawData || '');
  };

  /**
   * parseBattleSocketMessage 解析网页战斗 WebSocket 消息。
   * 网页端消息通常是 { type, data }，这里也兼容直接推送 JSON 帧的情况。
   * @param {string} messageText WebSocket 消息文本。
   * @returns {object|null} 解析后的消息对象。
   */
  const parseBattleSocketMessage = (messageText) => {
    const text = String(messageText || '').trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      return extractJsonObjects(text)[0] || null;
    }
  };

  /**
   * BattleBinaryReader 是网页战斗页同款二进制协议的最小 reader。
   * 这里只解战斗分析需要的字段，但必须按完整字段顺序跳读，避免后续字段错位。
   */
  class BattleBinaryReader {
    /**
     * @param {ArrayBuffer|Uint8Array} bytes WebSocket 二进制 payload。
     */
    constructor(bytes) {
      this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
      this.offset = 0;
      this.textDecoder = new TextDecoder('utf-8');
    }

    /** @param {number} byteCount 需要读取的字节数。 */
    ensure(byteCount) {
      if (this.offset + byteCount > this.bytes.byteLength) {
        throw new Error('battle binary payload out of range');
      }
    }

    /** @returns {number} 8 位无符号整数。 */
    u8() { this.ensure(1); const value = this.view.getUint8(this.offset); this.offset += 1; return value; }
    /** @returns {boolean} 布尔值。 */
    bool() { return this.u8() !== 0; }
    /** @returns {number} 16 位无符号整数。 */
    u16() { this.ensure(2); const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
    /** @returns {number} 32 位无符号整数。 */
    u32() { this.ensure(4); const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
    /** @returns {number} 32 位有符号整数。 */
    i32() { this.ensure(4); const value = this.view.getInt32(this.offset, true); this.offset += 4; return value; }
    /** @returns {number} 64 位有符号整数。 */
    i64() { this.ensure(8); const value = this.view.getBigInt64(this.offset, true); this.offset += 8; return Number(value); }
    /** @returns {number} 32 位浮点数。 */
    f32() { this.ensure(4); const value = this.view.getFloat32(this.offset, true); this.offset += 4; return value; }
    /** @returns {number} 64 位浮点数。 */
    f64() { this.ensure(8); const value = this.view.getFloat64(this.offset, true); this.offset += 8; return value; }

    /** @returns {Uint8Array} 读取 length-prefixed 原始字节。 */
    raw() {
      const length = this.u32();
      this.ensure(length);
      const start = this.offset;
      this.offset += length;
      return this.bytes.subarray(start, start + length);
    }

    /** @returns {string} 读取 length-prefixed UTF-8 字符串。 */
    str() {
      const raw = this.raw();
      return raw.length ? this.textDecoder.decode(raw) : '';
    }
  }

  const BATTLE_BINARY_MAGIC = 1;
  const BATTLE_BINARY_VERSION = 6;
  const BATTLE_BINARY_TYPES = {
    1: 'battle_init',
    2: 'battle_event',
    3: 'battle_result',
    4: 'monster_drop',
    5: 'battle_searching',
    6: 'ping',
    7: 'reward_applied',
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleDamageMap = (reader) => {
    const damages = {};
    for (let index = 0; index < 6; index += 1) {
      const value = reader.i32();
      if (value !== 0) damages[String(index)] = value;
    }
    return damages;
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleMagicMap = (reader) => {
    const length = reader.u32();
    const values = {};
    for (let index = 0; index < length; index += 1) {
      const key = String(reader.i32());
      const valueLength = reader.u32();
      values[key] = Array.from({ length: valueLength }, () => reader.f64());
    }
    return values;
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleBuff = (reader) => ({
    name: reader.str(),
    type: reader.i32(),
    damagePerSecond: reader.i32(),
    damageType: reader.i32(),
    healPerSecond: reader.i32(),
    manaPerSecond: reader.i32(),
    duration: reader.f64(),
    startAt: reader.f64(),
    stacks: reader.i32(),
    magics: readBattleMagicMap(reader),
  });

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleSimpleBuff = (reader) => ({
    damagePerSecond: reader.i32(),
    damageType: reader.i32(),
    healPerSecond: reader.i32(),
    manaPerSecond: reader.i32(),
    duration: reader.f64(),
    startAt: reader.f64(),
    stacks: reader.i32(),
    magics: readBattleMagicMap(reader),
  });

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleBuffList = (reader) => Array.from({ length: reader.u32() }, () => readBattleBuff(reader));

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleFlaskList = (reader) => {
    const length = reader.u32();
    const slotIndexes = new Array(length);
    const baseIds = new Array(length);
    const names = new Array(length);
    const types = new Array(length);
    const currentCharges = new Array(length);
    const maxCharges = new Array(length);
    const chargesPerUse = new Array(length);
    const activeValues = new Array(length);
    const chargePercents = new Array(length);
    for (let index = 0; index < length; index += 1) slotIndexes[index] = reader.i32();
    for (let index = 0; index < length; index += 1) baseIds[index] = reader.str();
    for (let index = 0; index < length; index += 1) names[index] = reader.str();
    for (let index = 0; index < length; index += 1) types[index] = reader.str();
    for (let index = 0; index < length; index += 1) currentCharges[index] = reader.i32();
    for (let index = 0; index < length; index += 1) maxCharges[index] = reader.i32();
    for (let index = 0; index < length; index += 1) chargesPerUse[index] = reader.i32();
    for (let index = 0; index < length; index += 1) activeValues[index] = reader.bool();
    for (let index = 0; index < length; index += 1) chargePercents[index] = reader.f64();
    return slotIndexes.map((slotIndex, index) => ({
      slotIndex,
      baseId: baseIds[index],
      name: names[index],
      type: types[index],
      currentCharges: currentCharges[index],
      maxCharges: maxCharges[index],
      chargesPerUse: chargesPerUse[index],
      isActive: activeValues[index],
      chargePercent: chargePercents[index],
    }));
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleSkill = (reader) => {
    if (!reader.bool()) return null;
    const skill = {
      id: reader.str(),
      name: reader.str(),
      level: reader.i32(),
      additionLevel: reader.i32(),
      category: reader.i32(),
      manaCost: reader.i32(),
      lifeCost: reader.i32(),
      energyShieldCost: reader.i32(),
      rangeType: reader.i32(),
      effectDurationSeconds: reader.f64(),
      rangeRadiusMeters: reader.f64(),
      rangeLineHalfWidthMeters: reader.f64(),
      rangeConeHalfAngleRadians: reader.f64(),
      rangeCenterOnCaster: reader.bool(),
      castRangeMeters: reader.f64(),
      isProjectile: reader.bool(),
      quality: reader.i32(),
      qualityBonus: reader.i32(),
      stoneId: reader.str(),
      triggerSource: reader.str(),
      isPeriodic: reader.bool(),
    };
    skill.skillTags = Array.from({ length: reader.u32() }, () => reader.str());
    return skill;
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleSkillList = (reader) => Array.from({ length: reader.u32() }, () => readBattleSkill(reader) || {});

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readOptionalBattleSkillList = (reader) => (reader.bool() ? readBattleSkillList(reader) : null);

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleTargets = (reader) => {
    const length = reader.u32();
    const indexes = new Array(length);
    const reasons = new Array(length);
    const names = new Array(length);
    const rarities = new Array(length);
    const isMisses = new Array(length);
    const isBlockeds = new Array(length);
    const isCriticals = new Array(length);
    const isTerminateds = new Array(length);
    const isSelfs = new Array(length);
    const isCloseRanges = new Array(length);
    const isDots = new Array(length);
    const isSpellSuppresseds = new Array(length);
    const totalDamages = new Array(length);
    const totalHeals = new Array(length);
    const absorbeds = new Array(length);
    const totalEnergyShieldRecoveries = new Array(length);
    const damages = new Array(length);
    const absorbedByDamages = new Array(length);
    for (let index = 0; index < length; index += 1) indexes[index] = reader.i32();
    for (let index = 0; index < length; index += 1) reasons[index] = reader.str();
    for (let index = 0; index < length; index += 1) names[index] = reader.str();
    for (let index = 0; index < length; index += 1) rarities[index] = reader.i32();
    for (let index = 0; index < length; index += 1) isMisses[index] = reader.bool();
    for (let index = 0; index < length; index += 1) isBlockeds[index] = reader.bool();
    for (let index = 0; index < length; index += 1) isCriticals[index] = reader.bool();
    for (let index = 0; index < length; index += 1) isTerminateds[index] = reader.bool();
    for (let index = 0; index < length; index += 1) isSelfs[index] = reader.bool();
    for (let index = 0; index < length; index += 1) isCloseRanges[index] = reader.bool();
    for (let index = 0; index < length; index += 1) isDots[index] = reader.bool();
    for (let index = 0; index < length; index += 1) isSpellSuppresseds[index] = reader.bool();
    for (let index = 0; index < length; index += 1) totalDamages[index] = reader.i32();
    for (let index = 0; index < length; index += 1) totalHeals[index] = reader.i32();
    for (let index = 0; index < length; index += 1) absorbeds[index] = reader.i32();
    for (let index = 0; index < length; index += 1) totalEnergyShieldRecoveries[index] = reader.i32();
    for (let index = 0; index < length; index += 1) damages[index] = readBattleDamageMap(reader);
    for (let index = 0; index < length; index += 1) absorbedByDamages[index] = readBattleDamageMap(reader);
    return indexes.map((targetIndex, index) => ({
      index: targetIndex,
      reason: reasons[index],
      name: names[index],
      rarity: rarities[index],
      isMiss: isMisses[index],
      isBlocked: isBlockeds[index],
      isCritical: isCriticals[index],
      isTerminated: isTerminateds[index],
      isSelf: isSelfs[index],
      isCloseRange: isCloseRanges[index],
      isDot: isDots[index],
      isSpellSuppressed: isSpellSuppresseds[index],
      totalDamage: totalDamages[index],
      totalHeal: totalHeals[index],
      absorbed: absorbeds[index],
      totalEnergyShieldRecovery: totalEnergyShieldRecoveries[index],
      damages: damages[index],
      absorbedByDamage: absorbedByDamages[index],
    }));
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleProjectiles = (reader) => {
    const length = reader.u32();
    const ids = new Array(length);
    const xs = new Array(length);
    const ys = new Array(length);
    const midXs = new Array(length);
    const midYs = new Array(length);
    const toXs = new Array(length);
    const toYs = new Array(length);
    const durations = new Array(length);
    const delays = new Array(length);
    const angleDegs = new Array(length);
    const terminateOnHits = new Array(length);
    for (let index = 0; index < length; index += 1) ids[index] = reader.i64();
    for (let index = 0; index < length; index += 1) xs[index] = reader.f64();
    for (let index = 0; index < length; index += 1) ys[index] = reader.f64();
    for (let index = 0; index < length; index += 1) midXs[index] = reader.f64();
    for (let index = 0; index < length; index += 1) midYs[index] = reader.f64();
    for (let index = 0; index < length; index += 1) toXs[index] = reader.f64();
    for (let index = 0; index < length; index += 1) toYs[index] = reader.f64();
    for (let index = 0; index < length; index += 1) durations[index] = reader.f64();
    for (let index = 0; index < length; index += 1) delays[index] = reader.f64();
    for (let index = 0; index < length; index += 1) angleDegs[index] = reader.f64();
    for (let index = 0; index < length; index += 1) terminateOnHits[index] = reader.bool();
    return ids.map((id, index) => ({
      id,
      x: xs[index],
      y: ys[index],
      midX: midXs[index],
      midY: midYs[index],
      toX: toXs[index],
      toY: toYs[index],
      duration: durations[index],
      delay: delays[index],
      angleDeg: angleDegs[index],
      terminateOnHit: terminateOnHits[index],
    }));
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleActiveProjectiles = (reader) => {
    const length = reader.u32();
    const ids = new Array(length);
    const xs = new Array(length);
    const ys = new Array(length);
    const angles = new Array(length);
    for (let index = 0; index < length; index += 1) ids[index] = reader.i64();
    for (let index = 0; index < length; index += 1) xs[index] = reader.f64();
    for (let index = 0; index < length; index += 1) ys[index] = reader.f64();
    for (let index = 0; index < length; index += 1) angles[index] = reader.f64();
    return ids.map((id, index) => ({ id, x: xs[index], y: ys[index], angle: angles[index] }));
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleTeamStates = (reader) => {
    const length = reader.u32();
    const indexes = new Array(length);
    const removedValues = new Array(length);
    const names = new Array(length);
    const rarities = new Array(length);
    const hpMaxValues = new Array(length);
    const hpValues = new Array(length);
    const mpMaxValues = new Array(length);
    const mpValues = new Array(length);
    const esMaxValues = new Array(length);
    const esValues = new Array(length);
    const levels = new Array(length);
    const minionValues = new Array(length);
    const totemValues = new Array(length);
    const xs = new Array(length);
    const ys = new Array(length);
    const righteousFireRanges = new Array(length);
    const buffs = new Array(length);
    const flasks = new Array(length);
    for (let index = 0; index < length; index += 1) indexes[index] = reader.i32();
    for (let index = 0; index < length; index += 1) removedValues[index] = reader.bool();
    for (let index = 0; index < length; index += 1) names[index] = reader.str();
    for (let index = 0; index < length; index += 1) rarities[index] = reader.i32();
    for (let index = 0; index < length; index += 1) hpMaxValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) hpValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) mpMaxValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) mpValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) esMaxValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) esValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) levels[index] = reader.i32();
    for (let index = 0; index < length; index += 1) minionValues[index] = reader.bool();
    for (let index = 0; index < length; index += 1) totemValues[index] = reader.bool();
    for (let index = 0; index < length; index += 1) xs[index] = reader.f32();
    for (let index = 0; index < length; index += 1) ys[index] = reader.f32();
    for (let index = 0; index < length; index += 1) righteousFireRanges[index] = reader.f32();
    for (let index = 0; index < length; index += 1) buffs[index] = readBattleBuffList(reader);
    for (let index = 0; index < length; index += 1) flasks[index] = readBattleFlaskList(reader);
    return indexes.map((unitIndex, index) => ({
      index: unitIndex,
      removed: removedValues[index],
      name: names[index],
      rarity: rarities[index],
      hpMax: hpMaxValues[index],
      hp: hpValues[index],
      mpMax: mpMaxValues[index],
      mp: mpValues[index],
      esMax: esMaxValues[index],
      es: esValues[index],
      level: levels[index],
      isMinion: minionValues[index],
      isTotem: totemValues[index],
      x: xs[index],
      y: ys[index],
      righteousFireRangeMeters: righteousFireRanges[index],
      buffs: buffs[index],
      flasks: flasks[index],
    }));
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleTeamPatches = (reader) => {
    const length = reader.u32();
    const indexes = new Array(length);
    const fields = new Array(length);
    const removedValues = new Array(length);
    const buffOffsets = new Array(length);
    const buffCounts = new Array(length);
    const buffs = new Array(length);
    const flasks = new Array(length);
    const hasBuffs = new Array(length);
    const hasFlasks = new Array(length);
    for (let index = 0; index < length; index += 1) indexes[index] = reader.i32();
    for (let index = 0; index < length; index += 1) fields[index] = reader.u16();
    for (let index = 0; index < length; index += 1) removedValues[index] = reader.bool();
    for (let index = 0; index < length; index += 1) buffOffsets[index] = reader.i32();
    for (let index = 0; index < length; index += 1) buffCounts[index] = reader.i32();
    for (let index = 0; index < length; index += 1) {
      hasBuffs[index] = reader.bool();
      buffs[index] = hasBuffs[index] ? readBattleBuffList(reader) : null;
    }
    for (let index = 0; index < length; index += 1) {
      hasFlasks[index] = reader.bool();
      flasks[index] = hasFlasks[index] ? readBattleFlaskList(reader) : null;
    }
    return indexes.map((unitIndex, index) => ({
      index: unitIndex,
      fields: fields[index],
      removed: removedValues[index],
      buffUpdatesOffset: buffOffsets[index],
      buffUpdatesCount: buffCounts[index],
      buffs: buffs[index],
      flasks: flasks[index],
    }));
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleScalarPatches = (reader) => {
    const length = reader.u32();
    const indexes = new Array(length);
    const hpValues = new Array(length);
    const xs = new Array(length);
    const ys = new Array(length);
    const righteousFireRanges = new Array(length);
    for (let index = 0; index < length; index += 1) indexes[index] = reader.i32();
    for (let index = 0; index < length; index += 1) hpValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) xs[index] = reader.f32();
    for (let index = 0; index < length; index += 1) ys[index] = reader.f32();
    for (let index = 0; index < length; index += 1) righteousFireRanges[index] = reader.f32();
    return indexes.map((unitIndex, index) => ({
      index: unitIndex,
      hp: hpValues[index],
      x: xs[index],
      y: ys[index],
      righteousFireRangeMeters: righteousFireRanges[index],
    }));
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleResourcePatches = (reader) => {
    const length = reader.u32();
    const indexes = new Array(length);
    const mpValues = new Array(length);
    const esValues = new Array(length);
    for (let index = 0; index < length; index += 1) indexes[index] = reader.i32();
    for (let index = 0; index < length; index += 1) mpValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) esValues[index] = reader.i32();
    return indexes.map((unitIndex, index) => ({ index: unitIndex, mp: mpValues[index], es: esValues[index] }));
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleBuffUpdates = (reader) => {
    const length = reader.u32();
    const unitIndexes = new Array(length);
    const indexes = new Array(length);
    const operations = new Array(length);
    const names = new Array(length);
    const types = new Array(length);
    const buffs = new Array(length);
    for (let index = 0; index < length; index += 1) unitIndexes[index] = reader.i32();
    for (let index = 0; index < length; index += 1) indexes[index] = reader.i32();
    for (let index = 0; index < length; index += 1) operations[index] = reader.u8();
    for (let index = 0; index < length; index += 1) names[index] = operations[index] === 1 ? reader.str() : '';
    for (let index = 0; index < length; index += 1) types[index] = operations[index] === 1 ? reader.i32() : 0;
    for (let index = 0; index < length; index += 1) buffs[index] = operations[index] === 2 ? undefined : readBattleSimpleBuff(reader);
    return unitIndexes.map((unitIndex, index) => ({
      unitIndex,
      index: indexes[index],
      op: operations[index],
      name: names[index],
      type: types[index],
      buff: buffs[index],
    }));
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleSimpleTeam = (reader) => {
    const length = reader.u32();
    const indexes = new Array(length);
    const names = new Array(length);
    const rarities = new Array(length);
    const hpMaxValues = new Array(length);
    const hpValues = new Array(length);
    const mpMaxValues = new Array(length);
    const mpValues = new Array(length);
    const esMaxValues = new Array(length);
    const esValues = new Array(length);
    const levels = new Array(length);
    for (let index = 0; index < length; index += 1) indexes[index] = reader.i32();
    for (let index = 0; index < length; index += 1) names[index] = reader.str();
    for (let index = 0; index < length; index += 1) rarities[index] = reader.i32();
    for (let index = 0; index < length; index += 1) hpMaxValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) hpValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) mpMaxValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) mpValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) esMaxValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) esValues[index] = reader.i32();
    for (let index = 0; index < length; index += 1) levels[index] = reader.i32();
    return indexes.map((unitIndex, index) => ({
      index: unitIndex,
      name: names[index],
      rarity: rarities[index],
      hpMax: hpMaxValues[index],
      hp: hpValues[index],
      mpMax: mpMaxValues[index],
      mp: mpValues[index],
      esMax: esMaxValues[index],
      es: esValues[index],
      level: levels[index],
    }));
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleResult = (reader) => ({
    battleId: reader.str(),
    isWin: reader.bool(),
    totalTime: reader.f64(),
  });

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleMonsterDrop = (reader) => {
    const battleId = reader.str();
    const exp = reader.i64();
    const skillStones = Array.from({ length: reader.u32() }, () => ({
      id: reader.str(),
      name: reader.str(),
    }));
    const currencies = Array.from({ length: reader.u32() }, () => ({
      currencyType: reader.i32(),
      name: reader.str(),
      amount: reader.i32(),
    }));
    const equipments = Array.from({ length: reader.u32() }, () => ({
      name: reader.str(),
      baseName: reader.str(),
      rarity: reader.i32(),
    }));
    const atlasMaps = Array.from({ length: reader.u32() }, () => ({
      baseId: reader.str(),
      name: reader.str(),
      tier: reader.i32(),
      level: reader.i32(),
      rarity: reader.i32(),
    }));
    return { battleId, drop: { exp, skillStones, currencies, equipments, atlasMaps } };
  };

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleRewardApplied = (reader) => ({
    battleId: reader.str(),
    backpackChanged: reader.bool(),
    currencyChanged: reader.bool(),
    atlasMapChanged: reader.bool(),
  });

  /** @param {BattleBinaryReader} reader 二进制 reader。 */
  const readBattleEvent = (reader) => {
    const frame = {
      battleId: reader.str(),
      time: reader.f64(),
      eventType: reader.str(),
      respawnRemainingSeconds: reader.f64(),
      actor: {
        index: reader.i32(),
        name: reader.str(),
        rarity: reader.i32(),
        isMinion: reader.bool(),
        isTotem: reader.bool(),
      },
    };
    if (reader.bool()) frame.impactX = reader.f64();
    if (reader.bool()) frame.impactY = reader.f64();
    frame.splashRadiusMeters = reader.f64();
    frame.splashStartIndex = reader.i32();
    frame.visualOnly = reader.bool();
    frame.targets = readBattleTargets(reader);
    frame.projectiles = readBattleProjectiles(reader);
    frame.skill = readBattleSkill(reader) || {};
    frame.buffs = readBattleBuffList(reader);
    frame.triggerSkills = readBattleSkillList(reader);
    frame.leftTeam = readBattleTeamStates(reader);
    frame.rightTeam = readBattleTeamStates(reader);
    frame.leftTeamPatches = readBattleTeamPatches(reader);
    frame.rightTeamPatches = readBattleTeamPatches(reader);
    frame.leftTeamScalarPatches = readBattleScalarPatches(reader);
    frame.rightTeamScalarPatches = readBattleScalarPatches(reader);
    frame.leftTeamResourcePatches = readBattleResourcePatches(reader);
    frame.rightTeamResourcePatches = readBattleResourcePatches(reader);
    frame.leftTeamBuffUpdates = readBattleBuffUpdates(reader);
    frame.rightTeamBuffUpdates = readBattleBuffUpdates(reader);
    frame.leftTeamAuras = readOptionalBattleSkillList(reader);
    frame.rightTeamAuras = readOptionalBattleSkillList(reader);
    frame.fullState = reader.bool();
    frame.events = Array.from({ length: reader.u32() }, () => readBattleEvent(reader));
    frame.activeProjectiles = readBattleActiveProjectiles(reader);
    return frame;
  };

  /** @param {ArrayBuffer|Uint8Array} rawData WebSocket 二进制消息。 */
  const parseBattleBinaryMessage = (rawData) => {
    try {
      const bytes = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
      if (bytes.length < 2 || bytes[0] !== BATTLE_BINARY_MAGIC) return null;
      const type = BATTLE_BINARY_TYPES[bytes[1]];
      if (!type) return null;
      const reader = new BattleBinaryReader(bytes.subarray(2));
      if (reader.u8() !== BATTLE_BINARY_VERSION) return null;
      let data = null;
      if (type === 'battle_init') {
        data = { battleId: reader.str(), leftTeam: readBattleSimpleTeam(reader), rightTeam: readBattleSimpleTeam(reader) };
      } else if (type === 'battle_event') data = readBattleEvent(reader);
      else if (type === 'battle_result') data = readBattleResult(reader);
      else if (type === 'monster_drop') data = readBattleMonsterDrop(reader);
      else if (type === 'battle_searching') data = { time: reader.f64() };
      else if (type === 'ping') data = {};
      else if (type === 'reward_applied') data = readBattleRewardApplied(reader);
      if (!data || reader.offset !== reader.bytes.byteLength) return null;
      return { type, data };
    } catch (error) {
      return null;
    }
  };

  /**
   * parseBattleSocketData 自动识别网页战斗 WebSocket 的二进制帧和兼容 JSON 文本帧。
   * @param {string|ArrayBuffer|Blob} rawData WebSocket 原始消息。
   * @returns {Promise<object|null>} 标准化后的 { type, data } 消息。
   */
  const parseBattleSocketData = async (rawData) => {
    if (rawData instanceof ArrayBuffer) return parseBattleBinaryMessage(rawData);
    if (rawData instanceof Blob) return parseBattleBinaryMessage(new Uint8Array(await rawData.arrayBuffer()));
    return parseBattleSocketMessage(await decodeBattleSocketData(rawData));
  };

  /**
   * inferBattleMessageType 在没有显式 type 字段时尽量识别战斗消息类型。
   * @param {object} payload WebSocket 消息或 data 内容。
   * @returns {string} 标准战斗消息类型。
   */
  const inferBattleMessageType = (payload) => {
    if (payload?.type) return String(payload.type);
    if (payload?.drop) return 'monster_drop';
    if (payload?.backpackChanged !== undefined || payload?.currencyChanged !== undefined || payload?.atlasMapChanged !== undefined) {
      return 'reward_applied';
    }
    if (payload?.trophy) return 'battle_reward';
    if (payload?.result || payload?.winner || payload?.isWin !== undefined) return 'battle_result';
    if (payload?.leftTeam || payload?.rightTeam || payload?.events || payload?.time !== undefined) return 'battle_event';
    return 'unknown';
  };

  /**
   * updateBattleAnalysisReward 只统计掉落消息，不把奖励帧当作正常战斗时间帧。
   * 同时兼容旧 JSON battle_reward 的 trophy 和 v6 二进制 monster_drop 的 drop。
   * @param {object} payload monster_drop 或旧版 battle_reward 的 data。
   */
  const updateBattleAnalysisReward = (payload) => {
    if (!state.battleAnalysis.timingStartedAt) {
      renderBattleAnalysisSummary();
      return;
    }
    const trophy = payload?.drop || payload?.trophy || {};
    state.battleAnalysis.totalRewardCount += 1;
    state.battleAnalysis.totalRewardExp += Number(trophy.exp || 0);
    const currencies = trophy.currencies || [];
    state.battleAnalysis.totalRewardCurrencyCount += Array.isArray(currencies)
      ? currencies.reduce((sum, item) => sum + (Number(item?.amount) || 0), 0)
      : Object.values(currencies).reduce((sum, count) => sum + (Number(count) || 0), 0);
    renderBattleAnalysisSummary();
  };

  /**
   * updateBattleAnalysisResult 使用结算帧补齐没有采到连续事件时的战斗时长。
   * v6 的 battle_result 已不再携带奖励，奖励会由 monster_drop 单独发送。
   * @param {object} payload battle_result 的 data。
   */
  const updateBattleAnalysisResult = (payload) => {
    if (Number.isFinite(Number(payload?.totalTime)) && state.battleAnalysis.observedServerSeconds <= 0) {
      state.battleAnalysis.totalServerSeconds = Math.max(
        state.battleAnalysis.totalServerSeconds,
        Number(payload.totalTime),
      );
      state.battleAnalysis.observedServerSeconds = Math.max(
        state.battleAnalysis.observedServerSeconds,
        Number(payload.totalTime),
      );
    }
    renderBattleAnalysisSummary();
  };

  /**
   * renderBattleAnalysisSummary 刷新其他功能里的轻量战斗分析摘要。
   */
  const renderBattleAnalysisSummary = () => {
    const summaryElement = state.ui.battleAnalysisSummary;
    if (!summaryElement) return;
    const analysis = state.battleAnalysis;
    const nowMs = Date.now();
    const isInitialSyncing = (
      (analysis.isConnected || analysis.isConnecting) &&
      analysis.startedAt &&
      !analysis.timingStartedAt &&
      nowMs - analysis.startedAt < BATTLE_ANALYSIS_CONFIG.initialSyncIgnoreMs
    );
    const statusText = analysis.isConnecting ? '连接中'
      : (isInitialSyncing ? '同步中' : (analysis.isConnected ? '运行中' : '未连接'));
    const timingStartedAt = analysis.timingStartedAt || analysis.startedAt;
    const runningSeconds = timingStartedAt ? Math.max(0, (nowMs - timingStartedAt) / 1000) : 0;
    const combatToRealMultiplier = runningSeconds > 0 ? analysis.observedServerSeconds / runningSeconds : 1;
    const realToCombatMultiplier = analysis.observedServerSeconds > 0 ? runningSeconds / analysis.observedServerSeconds : 1;
    const totalMultiplierDelta = combatToRealMultiplier - 1;
    const totalMultiplierDeltaText = `${totalMultiplierDelta >= 0 ? '+' : ''}${totalMultiplierDelta.toFixed(2)}x`;
    const overallTimeAnomaly = (
      combatToRealMultiplier >= BATTLE_ANALYSIS_CONFIG.speedRatioThreshold ||
      realToCombatMultiplier >= BATTLE_ANALYSIS_CONFIG.speedRatioThreshold
    );
    const playerLabel = analysis.playerSource || '玩家名称';
    const dilationText = (analysis.dilationDetected || overallTimeAnomaly)
      ? `是（总量倍率 ${combatToRealMultiplier.toFixed(2)}x，差值 ${totalMultiplierDeltaText}，真实/战斗 ${realToCombatMultiplier.toFixed(2)}x，采样最高 ${analysis.dilationMultiplierMax.toFixed(2)}x）`
      : `否（总量倍率 ${combatToRealMultiplier.toFixed(2)}x，差值 ${totalMultiplierDeltaText}）`;
    summaryElement.textContent = [
      `运行：${runningSeconds.toFixed(1)}s`,
      `战斗时间：${analysis.observedServerSeconds.toFixed(1)}s`,
      `记录怪物：${analysis.totalMonsterCount}`,
      analysis.totalBattleEventCount ? `战斗事件：${analysis.totalBattleEventCount}` : '',
      analysis.totalRewardExp ? `奖励经验：${formatChineseLargeNumber(Math.floor(analysis.totalRewardExp))}` : '',
      analysis.totalRewardCurrencyCount ? `奖励通货：${analysis.totalRewardCurrencyCount}` : '',
      `怪物/分钟(战斗)：${getBattleAnalysisPerMinute().toFixed(2)}`,
      `经验/分钟(战斗)：${formatChineseLargeNumber(getBattleAnalysisExpPerMinute())}`,
      `时间膨胀：${dilationText}`,
      `状态：${statusText}`,
      analysis.ignoredInitialFrameCount ? `已忽略初始同步帧：${analysis.ignoredInitialFrameCount}` : '',
      analysis.ignoredLocalLagSampleCount ? `已排除本地卡顿样本：${analysis.ignoredLocalLagSampleCount}` : '',
      analysis.playerName ? `${playerLabel}：${analysis.playerName}` : (analysis.playerId ? `${playerLabel}：${analysis.playerId}` : ''),
      analysis.lastError ? `最近错误：${analysis.lastError}` : '',
    ].filter(Boolean).join(' | ');
  };

  /**
   * isBattleAnalysisInitialSyncing 判断当前是否仍处于战斗流初始同步阶段。
   * 初始连接时后端会快速推送数秒历史帧，这些帧不能进入时间倍率统计。
   * @param {number} nowMs 当前本地时间戳。
   * @returns {boolean} 仍在初始同步窗口时返回 true。
   */
  const isBattleAnalysisInitialSyncing = (nowMs) => (
    state.battleAnalysis.startedAt > 0 &&
    !state.battleAnalysis.timingStartedAt &&
    state.battleAnalysis.stableInitialFrameCount < BATTLE_ANALYSIS_CONFIG.stableFrameTarget &&
    nowMs - state.battleAnalysis.startedAt < BATTLE_ANALYSIS_CONFIG.initialSyncIgnoreMs
  );

  /**
   * updateBattleAnalysisInitialWarmup 根据服务端时间是否连续递增，判断能否提前结束预热。
   * 预热期只更新基准，不统计怪物、经验、通货和时间倍率。
   * @param {object} battle 单场战斗缓存。
   * @param {number} serverTime 当前服务端战斗时间。
   * @param {number} nowMs 当前本地时间戳。
   * @returns {boolean} 仍处于预热期时返回 true。
   */
  const updateBattleAnalysisInitialWarmup = (battle, serverTime, nowMs) => {
    if (!isBattleAnalysisInitialSyncing(nowMs)) return false;
    const serverDelta = Math.max(0, serverTime - battle.lastServerTime);
    const localDelta = Math.max(0, (nowMs - battle.lastLocalMs) / 1000);
    if (
      serverDelta > 0 &&
      localDelta > 0 &&
      localDelta <= BATTLE_ANALYSIS_CONFIG.maxReliableLocalDeltaSeconds
    ) {
      state.battleAnalysis.stableInitialFrameCount += 1;
    } else {
      state.battleAnalysis.stableInitialFrameCount = 0;
    }
    state.battleAnalysis.ignoredInitialFrameCount += 1;
    battle.baseServerTime = serverTime;
    battle.lastServerTime = serverTime;
    battle.lastLocalMs = nowMs;
    renderBattleAnalysisSummary();
    return state.battleAnalysis.stableInitialFrameCount < BATTLE_ANALYSIS_CONFIG.stableFrameTarget;
  };

  /**
   * startBattleAnalysisTiming 在初始同步结束后开始正式计算本地时间和战斗时间倍率。
   * @param {number} nowMs 当前本地时间戳。
   * @param {Map<string, object>} battleMap 当前战斗状态 Map。
   */
  const startBattleAnalysisTiming = (nowMs, battleMap) => {
    state.battleAnalysis.timingStartedAt = nowMs;
    for (const battle of battleMap.values()) {
      battle.lastLocalMs = nowMs;
    }
    addLog(`战斗分析初始同步完成，已跳过 ${state.battleAnalysis.ignoredInitialFrameCount} 条补推帧的时间倍率计算。`, 'compact');
  };

  /**
   * recordBattleAnalysisMonsters 从队伍和事件目标里提取怪物 ID，避免重复计数。
   * @param {object} battle 单场战斗的统计缓存。
   * @param {object} frame battle_event 或 battle_init 数据。
   */
  const recordBattleAnalysisMonsters = (battle, frame) => {
    const rightTeam = Array.isArray(frame.rightTeam) ? frame.rightTeam : [];
    for (const enemy of rightTeam) {
      const enemyKey = enemy?.index ?? enemy?.id ?? enemy?.name;
      if (enemyKey === undefined || enemyKey === null || battle.monsterIds.has(enemyKey)) continue;
      battle.monsterIds.add(enemyKey);
      state.battleAnalysis.totalMonsterCount += 1;
    }
    const rightTeamPatchSources = [
      ...(Array.isArray(frame.rightTeamPatches) ? frame.rightTeamPatches : []),
      ...(Array.isArray(frame.rightTeamScalarPatches) ? frame.rightTeamScalarPatches : []),
      ...(Array.isArray(frame.rightTeamResourcePatches) ? frame.rightTeamResourcePatches : []),
    ];
    for (const enemyPatch of rightTeamPatchSources) {
      if (enemyPatch?.removed) continue;
      const enemyKey = enemyPatch?.index ?? enemyPatch?.id ?? enemyPatch?.name;
      if (enemyKey === undefined || enemyKey === null || battle.monsterIds.has(enemyKey)) continue;
      battle.monsterIds.add(enemyKey);
      state.battleAnalysis.totalMonsterCount += 1;
    }

    const eventTargets = Array.isArray(frame.events)
      ? frame.events.flatMap((event) => (Array.isArray(event?.targets) ? event.targets : []))
      : [];
    for (const target of eventTargets) {
      const targetKey = target?.index ?? target?.id ?? target?.name;
      if (targetKey === undefined || targetKey === null || battle.monsterIds.has(targetKey)) continue;
      battle.monsterIds.add(targetKey);
      state.battleAnalysis.totalMonsterCount += 1;
    }
  };

  /**
   * updateBattleAnalysisFromFrame 用网页战斗 WebSocket 的 battle_init/battle_event 更新轻量统计。
   * @param {object} frame WebSocket data 中的战斗帧。
   */
  const updateBattleAnalysisFromFrame = (frame) => {
    if (!frame || frame.battleId === undefined) return;
    const battleId = String(frame.battleId);
    const nowMs = Date.now();
    const serverTime = Number(frame.time);
    state.battleAnalysis.totalBattleFrameCount += 1;
    if (Array.isArray(frame.events)) {
      state.battleAnalysis.totalBattleEventCount += frame.events.length;
    }
    let battle = state.battleAnalysis.battleMap.get(battleId);
    if (!battle) {
      battle = {
        monsterIds: new Set(),
        baseServerTime: Number.isFinite(serverTime) ? serverTime : 0,
        lastServerTime: Number.isFinite(serverTime) ? serverTime : 0,
        lastLocalMs: nowMs,
      };
      state.battleAnalysis.battleMap.set(battleId, battle);
    }

    if (!Number.isFinite(serverTime)) {
      renderBattleAnalysisSummary();
      return;
    }

    if (updateBattleAnalysisInitialWarmup(battle, serverTime, nowMs)) {
      return;
    }
    if (!state.battleAnalysis.timingStartedAt) {
      startBattleAnalysisTiming(nowMs, state.battleAnalysis.battleMap);
      battle.baseServerTime = serverTime;
      battle.lastServerTime = serverTime;
      battle.lastLocalMs = nowMs;
      renderBattleAnalysisSummary();
      return;
    }

    recordBattleAnalysisMonsters(battle, frame);
    const serverDelta = Math.max(0, serverTime - battle.lastServerTime);
    const localDelta = Math.max(0, (nowMs - battle.lastLocalMs) / 1000);
    state.battleAnalysis.totalServerSeconds = Math.max(state.battleAnalysis.totalServerSeconds, serverTime);
    const isLocalLagSample = (
      document.hidden ||
      localDelta > BATTLE_ANALYSIS_CONFIG.maxReliableLocalDeltaSeconds
    );
    if (serverDelta > 0 && isLocalLagSample) {
      state.battleAnalysis.ignoredLocalLagSampleCount += 1;
      battle.lastServerTime = serverTime;
      battle.lastLocalMs = nowMs;
      renderBattleAnalysisSummary();
      return;
    }
    if (serverDelta > 0) {
      state.battleAnalysis.observedServerSeconds += serverDelta;
    }
    if (serverDelta > 0 && localDelta >= BATTLE_ANALYSIS_CONFIG.minSampleSeconds) {
      const timeRatio = serverDelta / localDelta;
      const dilationMultiplier = localDelta / serverDelta;
      state.battleAnalysis.dilationMultiplierLatest = dilationMultiplier;
      if (timeRatio < BATTLE_ANALYSIS_CONFIG.dilationRatioThreshold) {
        state.battleAnalysis.dilationDetected = true;
        state.battleAnalysis.dilationSampleCount += 1;
        state.battleAnalysis.dilationMultiplierTotal += dilationMultiplier;
        state.battleAnalysis.dilationMultiplierMax = Math.max(state.battleAnalysis.dilationMultiplierMax, dilationMultiplier);
      }
    }
    battle.lastServerTime = serverTime;
    battle.lastLocalMs = nowMs;
    renderBattleAnalysisSummary();
  };

  /**
   * handleBattleSocketMessage 按网页战斗页的消息类型分发 WebSocket 数据。
   * @param {object} message 解析后的 WebSocket 消息。
   */
  const handleBattleSocketMessage = (message) => {
    if (!message) return;
    const type = inferBattleMessageType(message);
    if (type === 'ping') return;
    const payload = message.data && typeof message.data === 'object' ? message.data : message;
    const normalizedType = type === 'unknown' ? inferBattleMessageType(payload) : type;
    state.battleAnalysis.lastEventType = normalizedType;
    state.battleAnalysis.lastMessageAt = Date.now();

    if (normalizedType === 'monster_drop' || normalizedType === 'battle_reward') {
      updateBattleAnalysisReward(payload);
      return;
    }
    if (normalizedType === 'battle_result') {
      updateBattleAnalysisResult(payload);
      return;
    }
    if (normalizedType === 'battle_init') {
      updateBattleAnalysisFromFrame(payload);
      return;
    }
    if (normalizedType === 'battle_event') {
      updateBattleAnalysisFromFrame(payload);
    }
  };

  /**
   * startBattleAnalysis 连接网页战斗 WebSocket，并启动轻量统计。
   */
  const startBattleAnalysis = async () => {
    assertLoggedIn();
    if (state.battleAnalysis.isConnected || state.battleAnalysis.isConnecting) {
      addLog('战斗分析已经在运行。', 'warn');
      return;
    }
    state.battleAnalysis = createEmptyBattleAnalysisState();
    state.battleAnalysis.isConnecting = true;
    state.battleAnalysis.startedAt = Date.now();
    state.battleAnalysis.summaryTimerId = window.setInterval(renderBattleAnalysisSummary, 50);
    renderBattleAnalysisSummary();
    addLog('轻量战斗分析已开始：正在连接网页战斗 WebSocket，战斗数据和奖励数据会分开统计。', 'compact');
    try {
      const target = await resolveBattleAnalysisTargetCharacter();
      state.battleAnalysis.playerId = target.id;
      state.battleAnalysis.playerName = target.name || target.id;
      state.battleAnalysis.playerSource = target.source;
      state.battleAnalysis.streamUrl = target.streamUrl || '';
      state.battleAnalysis.isSpectator = !!target.isSpectator;
      renderBattleAnalysisSummary();
      if (target.warning) addLog(`战斗分析读取${target.source}详情失败，已使用 URL 中的角色 ID：${target.warning}`, 'warn');
    } catch (error) {
      addLog(`战斗分析读取玩家信息失败，不影响统计：${error.message}`, 'warn');
    }

    try {
      const socket = new WebSocket(getBattleAnalysisWebSocketUrl(
        state.battleAnalysis.playerId,
        state.battleAnalysis.isSpectator,
        state.battleAnalysis.streamUrl,
      ));
      state.battleAnalysis.socket = socket;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        state.battleAnalysis.isConnecting = false;
        state.battleAnalysis.isConnected = true;
        state.battleAnalysis.lastError = '';
        renderBattleAnalysisSummary();
        addLog('战斗分析 WebSocket 已连接，开始读取 battle_init / battle_event / monster_drop。', 'compact');
      };
      socket.onmessage = async (event) => {
        try {
          handleBattleSocketMessage(await parseBattleSocketData(event.data));
        } catch (error) {
          state.battleAnalysis.lastError = error.message;
          renderBattleAnalysisSummary();
        }
      };
      socket.onerror = () => {
        state.battleAnalysis.lastError = 'WebSocket 连接错误';
        renderBattleAnalysisSummary();
      };
      socket.onclose = () => {
        if (state.battleAnalysis.summaryTimerId) {
          window.clearInterval(state.battleAnalysis.summaryTimerId);
        }
        state.battleAnalysis.isConnected = false;
        state.battleAnalysis.isConnecting = false;
        state.battleAnalysis.socket = null;
        state.battleAnalysis.summaryTimerId = 0;
        renderBattleAnalysisSummary();
        addLog('轻量战斗分析已停止。', 'compact');
      };
    } catch (error) {
      if (state.battleAnalysis.summaryTimerId) {
        window.clearInterval(state.battleAnalysis.summaryTimerId);
      }
      state.battleAnalysis.isConnected = false;
      state.battleAnalysis.isConnecting = false;
      state.battleAnalysis.summaryTimerId = 0;
      state.battleAnalysis.lastError = error.message;
      renderBattleAnalysisSummary();
      addLog(`轻量战斗分析连接失败：${error.message}`, 'error');
    }
  };

  /**
   * stopBattleAnalysis 停止轻量战斗分析 WebSocket 连接。
   */
  const stopBattleAnalysis = () => {
    if (!state.battleAnalysis.isConnected && !state.battleAnalysis.isConnecting) {
      addLog('轻量战斗分析当前没有运行。', 'warn');
      return;
    }
    state.battleAnalysis.socket?.close();
    if (!state.battleAnalysis.socket) {
      state.battleAnalysis.isConnected = false;
      state.battleAnalysis.isConnecting = false;
      if (state.battleAnalysis.summaryTimerId) window.clearInterval(state.battleAnalysis.summaryTimerId);
      state.battleAnalysis.summaryTimerId = 0;
      renderBattleAnalysisSummary();
    }
  };

  /**
   * resetBattleAnalysis 清空轻量战斗分析统计。
   */
  const resetBattleAnalysis = () => {
    const wasConnected = state.battleAnalysis.isConnected;
    const wasConnecting = state.battleAnalysis.isConnecting;
    const socket = state.battleAnalysis.socket;
    const summaryTimerId = state.battleAnalysis.summaryTimerId;
    const playerId = state.battleAnalysis.playerId;
    const playerName = state.battleAnalysis.playerName;
    const playerSource = state.battleAnalysis.playerSource;
    const streamUrl = state.battleAnalysis.streamUrl;
    const isSpectator = state.battleAnalysis.isSpectator;
    state.battleAnalysis = createEmptyBattleAnalysisState();
    state.battleAnalysis.isConnected = wasConnected;
    state.battleAnalysis.isConnecting = wasConnecting;
    state.battleAnalysis.socket = socket;
    state.battleAnalysis.summaryTimerId = summaryTimerId;
    state.battleAnalysis.playerId = playerId;
    state.battleAnalysis.playerName = playerName;
    state.battleAnalysis.playerSource = playerSource;
    state.battleAnalysis.streamUrl = streamUrl;
    state.battleAnalysis.isSpectator = isSpectator;
    state.battleAnalysis.startedAt = (wasConnected || wasConnecting) ? Date.now() : 0;
    renderBattleAnalysisSummary();
    addLog('轻量战斗分析统计已重置。', 'compact');
  };

  /**
   * getObjectId 从多种常见字段中读取对象 ID。
   * @param {object} item 原始对象。
   * @returns {string} 标准化 ID，无法读取时为空字符串。
   */
  const getObjectId = (item) => String(
    item?.id ?? item?._id ?? item?.characterId ?? item?.uid ?? item?.cid ?? item?.character?.id ?? item?.character?._id ?? '',
  ).trim();

  /**
   * getCharacterDisplayName 从角色接口的常见字段中读取角色名。
   * @param {object} item 角色接口原始对象。
   * @returns {string} 角色名；无法读取时返回空字符串。
   */
  const getCharacterDisplayName = (item) => String(
    item?.name ?? item?.characterName ?? item?.playerName ?? item?.nickname ?? item?.character?.name ?? '',
  ).trim();

  /**
   * normalizeRankPlayer 把排行榜接口的玩家对象整理成稳定结构。
   * @param {object} rawPlayer 排行榜原始玩家对象。
   * @param {number} indexInList 在当前已读取排行榜中的位置。
   * @returns {object} 标准化后的排行榜玩家。
   */
  const normalizeRankPlayer = (rawPlayer, indexInList) => {
    const character = rawPlayer?.character || {};
    const levelValue = rawPlayer?.level ?? rawPlayer?.lv ?? character.level ?? 0;
    return {
      id: getObjectId(rawPlayer),
      name: String(rawPlayer?.name ?? rawPlayer?.characterName ?? rawPlayer?.playerName ?? character.name ?? '未知角色'),
      level: Number.parseInt(levelValue, 10) || 0,
      rank: Number.parseInt(rawPlayer?.rank ?? rawPlayer?.ranking ?? rawPlayer?.index, 10) || indexInList + 1,
      className: getCharacterClassName(rawPlayer, '未知职业'),
      raw: rawPlayer,
    };
  };

  /**
   * getCharacterClassName 从排行榜或角色详情对象中读取职业名称。
   * @param {object} characterData 排行榜玩家或角色详情。
   * @param {string} fallbackName 无职业字段时的默认文本。
   * @returns {string} 职业名称。
   */
  const getCharacterClassName = (characterData, fallbackName = '未知职业') => {
    const nestedCharacter = characterData?.character || {};
    const rawClassName = (
      characterData?.className ??
      characterData?.class ??
      characterData?.job ??
      characterData?.profession ??
      characterData?.ascendancy ??
      characterData?.ascendancyName ??
      nestedCharacter.className ??
      nestedCharacter.class ??
      nestedCharacter.job ??
      nestedCharacter.profession ??
      nestedCharacter.ascendancy ??
      nestedCharacter.ascendancyName ??
      fallbackName
    );
    return formatCharacterClassName(rawClassName, fallbackName);
  };

  /**
   * formatCharacterClassName 把职业编号或编号组合转换为中文职业名。
   * 例如接口返回 2 会显示“贵族”，返回 2/3 会显示“贵族/女巫”。
   * @param {*} rawClassName 接口返回的职业字段。
   * @param {string} fallbackName 无法识别时的默认文本。
   * @returns {string} 可读职业名。
   */
  const formatCharacterClassName = (rawClassName, fallbackName = '未知职业') => {
    const classText = String(rawClassName ?? '').trim();
    if (!classText) return fallbackName;
    const translatedParts = classText
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => CHARACTER_CLASS_LABELS[part] || part);
    return translatedParts.length ? translatedParts.join('/') : fallbackName;
  };

  /**
   * fetchRankLevelPage 读取等级排行榜单页。
   * @param {number} page 页码。
   * @returns {Promise<object>} 包含 items 和 total 的分页数据。
   */
  const fetchRankLevelPage = async (page) => {
    const searchParams = new URLSearchParams({ page: String(page), _: String(Date.now()) });
    const payload = await requestJson(`${config.endpoints.rankLevel}?${searchParams.toString()}`);
    if (payload.success === false) throw new Error(payload.message || '排行榜接口返回失败。');
    const data = payload.data || {};
    return {
      items: Array.isArray(data.items) ? data.items : [],
      total: Number.parseInt(data.total, 10) || 0,
    };
  };

  /**
   * fetchAllRankLevelPlayers 读取等级排行榜所有分页。
   * @returns {Promise<Array<object>>} 已归一化并去重的排行榜玩家列表。
   */
  const fetchAllRankLevelPlayers = async () => {
    const firstPage = await fetchRankLevelPage(1);
    const players = [];
    const seenIds = new Set();
    const appendPlayers = (items) => {
      for (const rawPlayer of items) {
        const normalizedPlayer = normalizeRankPlayer(rawPlayer, players.length);
        if (!normalizedPlayer.id || seenIds.has(normalizedPlayer.id)) continue;
        seenIds.add(normalizedPlayer.id);
        players.push(normalizedPlayer);
      }
    };
    appendPlayers(firstPage.items);
    const pageSize = Math.max(1, firstPage.items.length || 20);
    const totalPages = firstPage.total > 0
      ? Math.ceil(firstPage.total / pageSize)
      : (firstPage.items.length ? RANK_ANALYSIS_CONFIG.maxPages : 1);
    const safeTotalPages = Math.min(totalPages, RANK_ANALYSIS_CONFIG.maxPages);
    const pages = Array.from({ length: Math.max(0, safeTotalPages - 1) }, (_, index) => index + 2);
    let loadedPageCount = 1;
    const pageResults = await runConcurrentTasks(pages, RANK_ANALYSIS_CONFIG.concurrency, async (page) => {
      const pageResult = await fetchRankLevelPage(page);
      loadedPageCount += 1;
      if (loadedPageCount % 10 === 0) addLog(`排行榜读取进度：已读取 ${loadedPageCount}/${safeTotalPages} 页。`, 'info');
      await wait(40);
      return { page, pageResult };
    });
    const failedPage = pageResults.find((result) => result?.error && !isRequestAbortError(result.error));
    if (failedPage) throw failedPage.error;
    pageResults
      .filter((result) => result?.pageResult?.items?.length)
      .sort((left, right) => left.page - right.page)
      .forEach((result) => appendPlayers(result.pageResult.items));
    return players.sort((left, right) => left.rank - right.rank);
  };

  /**
   * fetchRankCharacterDetail 读取角色详情页使用的玩家详情接口。
   * @param {string} characterId 角色 ID。
   * @returns {Promise<object>} 角色详情数据。
   */
  const fetchRankCharacterDetail = async (characterId) => {
    const payload = await requestJson(`${config.endpoints.characterView}/${encodeURIComponent(characterId)}`);
    if (payload.success === false) throw new Error(payload.message || '角色详情接口返回失败。');
    return payload.data || payload;
  };

  /**
   * resolveBattleAnalysisTargetCharacter 根据当前页面决定战斗分析目标角色。
   * 观战页优先使用 URL 中的角色 ID，否则使用当前登录角色。
   * @returns {Promise<{id: string, name: string, source: string, isSpectator?: boolean, streamUrl?: string, warning?: string}>} 目标角色信息。
   */
  const resolveBattleAnalysisTargetCharacter = async () => {
    const watchCharacterId = getWatchBattleCharacterIdFromUrl();
    if (watchCharacterId) {
      try {
        const detail = await fetchRankCharacterDetail(watchCharacterId);
        return {
          id: watchCharacterId,
          name: getCharacterDisplayName(detail) || watchCharacterId,
          source: '观战用户',
          isSpectator: true,
          streamUrl: `/api/battle/ws/watch/${encodeURIComponent(watchCharacterId)}`,
        };
      } catch (error) {
        return {
          id: watchCharacterId,
          name: watchCharacterId,
          source: '观战用户',
          isSpectator: true,
          streamUrl: `/api/battle/ws/watch/${encodeURIComponent(watchCharacterId)}`,
          warning: error.message,
        };
      }
    }

    const characterPayload = await requestJson(config.endpoints.character);
    const characterData = characterPayload.data || characterPayload;
    const id = getObjectId(characterData);
    return {
      id,
      name: getCharacterDisplayName(characterData) || id,
      source: '玩家名称',
      isSpectator: false,
      streamUrl: '',
    };
  };

  /**
   * getCharacterSkills 读取角色当前实际使用的技能和光环。
   * @param {object} characterDetail 角色详情。
   * @returns {Array<object>} 技能列表。
   */
  const getCharacterSkills = (characterDetail) => [
    ...(Array.isArray(characterDetail?.skills) ? characterDetail.skills : []),
    ...(Array.isArray(characterDetail?.auras) ? characterDetail.auras : []),
  ].filter((skill) => skill?.enabled !== false && (skill.name || skill.skillId || skill.stoneId));

  /**
   * getCharacterEquipmentEntries 读取角色装备槽位，兼容对象和数组两种结构。
   * @param {object} characterDetail 角色详情。
   * @returns {Array<object>} 标准化装备槽位列表。
   */
  const getCharacterEquipmentEntries = (characterDetail) => {
    const slots = characterDetail?.equipmentSlots || characterDetail?.equipments || characterDetail?.equipment || {};
    if (Array.isArray(slots)) {
      return slots
        .map((equipment, index) => ({
          slotKey: equipment?.slot || equipment?.position || String(index),
          slotLabel: getCharacterEquipmentSlotLabel(equipment?.slot || equipment?.position, equipment?.slotName, `槽位${index + 1}`),
          equipment,
        }))
        .filter((entry) => entry.equipment);
    }
    return Object.entries(slots)
      .filter(([, equipment]) => equipment)
      .map(([slotKey, equipment]) => ({
        slotKey,
        slotLabel: getCharacterEquipmentSlotLabel(slotKey, equipment?.slotName, slotKey),
        equipment,
      }));
  };

  /**
   * getSocketGroups 读取装备插槽连接组，兼容已分组数组和扁平 sockets。
   * @param {object} equipment 装备对象。
   * @returns {Array<Array<object>>} 插槽连接组。
   */
  const getSocketGroups = (equipment) => {
    const sockets = equipment?.sockets || equipment?.socketGroups || equipment?.links || [];
    if (!Array.isArray(sockets)) return [];
    if (sockets.every((group) => Array.isArray(group))) return sockets;
    const groupEntries = sockets
      .filter((socket) => socket && typeof socket === 'object')
      .map((socket, socketIndex) => ({
        socket,
        groupKey: socket.groupId
          ?? socket.group
          ?? socket.linkGroupId
          ?? socket.linkGroup
          ?? socket.socketGroupId
          ?? socket.socketGroup
          ?? socket.linkId
          ?? socket.link
          ?? socket.links
          ?? socket.connectedGroup
          ?? socket.connectedGroupId
          ?? null,
        socketIndex,
      }));
    if (groupEntries.some((entry) => entry.groupKey !== null && entry.groupKey !== undefined && String(entry.groupKey) !== '')) {
      const groupsByKey = new Map();
      for (const entry of groupEntries) {
        const hasGroupKey = entry.groupKey !== null && entry.groupKey !== undefined && String(entry.groupKey) !== '';
        const groupKey = hasGroupKey ? String(entry.groupKey) : `ungrouped:${entry.socketIndex}`;
        if (!groupsByKey.has(groupKey)) groupsByKey.set(groupKey, []);
        groupsByKey.get(groupKey).push(entry.socket);
      }
      return Array.from(groupsByKey.values());
    }
    return [sockets];
  };

  /**
   * getSocketStone 从插槽对象中提取技能石对象或插槽自身。
   * @param {object} socket 插槽对象。
   * @returns {object|null} 技能石候选对象。
   */
  const getSocketStone = (socket) => socket?.stone || socket?.skillStone || socket?.gem || socket?.item || socket || null;

  /**
   * getStoneDisplayName 获取技能石在报告中的显示名称。
   * @param {object} stone 技能石对象。
   * @returns {string} 技能石名称。
   */
  const getStoneDisplayName = (stone) => String(
    stone?.name ?? stone?.skillName ?? stone?.stoneName ?? stone?.displayName ?? stone?.skillId ?? stone?.stoneId ?? '未知技能石',
  );

  /**
   * findSkillConnection 在装备插槽中查找某个实际使用技能的连接情况。
   * 排行榜接口同一技能可能存在多颗同名或同 skillId 宝石，连接判断只信任启用技能的 stoneId。
   * @param {object} skill 当前实际使用技能。
   * @param {Array<object>} equipmentEntries 装备槽位列表。
   * @returns {object|null} 技能连接信息。
   */
  const findSkillConnection = (skill, equipmentEntries) => {
    const skillStoneId = String(skill?.stoneId || '').trim();
    if (!skillStoneId) return null;
    for (const entry of equipmentEntries) {
      for (const socketGroup of getSocketGroups(entry.equipment)) {
        const sockets = Array.isArray(socketGroup) ? socketGroup : [socketGroup];
        if (!sockets.some((socket) => getSocketStoneId(socket) === skillStoneId)) continue;
        const linkedSupportNames = sockets
          .filter((socket) => getSocketStoneId(socket) !== skillStoneId)
          .map(getSocketStone)
          .filter(Boolean)
          .map(getStoneDisplayName)
          .filter((stoneName) => stoneName && stoneName !== '未知技能石');
        return {
          slotLabel: entry.slotLabel,
          equipmentName: getEquipmentDisplayName(entry.equipment),
          supportNames: [...new Set(linkedSupportNames)],
        };
      }
    }
    return null;
  };

  /**
   * isSpecialSocketEquipment 判断装备是否在赚钱脚本维护的特殊暗金名单内。
   * @param {object} equipment 装备对象。
   * @returns {boolean} 命中特殊装备名单时返回 true。
   */
  const isSpecialSocketEquipment = (equipment) => SPECIAL_SOCKET_EQUIPMENT_NAMES.has(getEquipmentDisplayName(equipment).trim());

  /**
   * getSpecialSocketEquipmentConnectionLines 补充展示特殊暗金装备上的非激活技能石连接组。
   * @param {Array<object>} equipmentEntries 装备槽位列表。
   * @param {Array<object>} activeSkills 当前启用技能和光环。
   * @returns {Array<string>} 报告行。
   */
  const getSpecialSocketEquipmentConnectionLines = (equipmentEntries, activeSkills) => {
    const lines = [];
    const seenGroupKeys = new Set();
    const activeStoneIds = new Set(
      activeSkills
        .map((skill) => String(skill?.stoneId || '').trim())
        .filter(Boolean),
    );
    for (const entry of equipmentEntries) {
      if (!isSpecialSocketEquipment(entry.equipment)) continue;
      for (const socketGroup of getSocketGroups(entry.equipment)) {
        const sockets = Array.isArray(socketGroup) ? socketGroup : [socketGroup];
        const stones = sockets.map(getSocketStone).filter(Boolean);
        const socketedStoneNames = stones
          .filter((stone) => stone?.stoneId || stone?.skillStoneId || stone?.skillId || stone?.id || stone?.name)
          .map(getStoneDisplayName)
          .filter((stoneName) => stoneName && stoneName !== '未知技能石');
        if (!socketedStoneNames.length) continue;
        if (sockets.some((socket) => activeStoneIds.has(getSocketStoneId(socket)))) continue;
        const uniqueStoneNames = [...new Set(socketedStoneNames)];
        const groupKey = `${entry.slotKey}|${getEquipmentDisplayName(entry.equipment)}|${uniqueStoneNames.join('|')}`;
        if (seenGroupKeys.has(groupKey)) continue;
        seenGroupKeys.add(groupKey);
        lines.push(`- [特殊装备] ${entry.slotLabel} · ${getEquipmentDisplayName(entry.equipment)}：连接：${uniqueStoneNames.join(' / ')}`);
      }
    }
    return lines;
  };

  /**
   * getEquipmentDisplayName 获取装备显示名称。
   * @param {object} equipment 装备对象。
   * @returns {string} 装备名称。
   */
  const getEquipmentDisplayName = (equipment) => String(
    equipment?.name ?? equipment?.equipmentName ?? equipment?.displayName ?? equipment?.baseName ?? equipment?.typeLine ?? '未知装备',
  );

  /**
   * getEquipmentBaseName 获取非暗金装备用于统计的基底名。
   * @param {object} equipment 装备对象。
   * @returns {string} 基底名称。
   */
  const getEquipmentBaseName = (equipment) => String(
    equipment?.baseName ?? equipment?.typeLine ?? equipment?.baseType ?? equipment?.equipmentBaseName ?? equipment?.templateName ?? getEquipmentDisplayName(equipment),
  );

  /**
   * formatPercent 把计数格式化为百分比文本。
   * @param {number} count 命中数量。
   * @param {number} total 总数。
   * @returns {string} 百分比。
   */
  const formatPercent = (count, total) => (total > 0 ? `${((count / total) * 100).toFixed(1)}%` : '0.0%');

  /**
   * formatChineseLargeNumber 用万/亿/兆/京压缩大数字，并保留 4 位有效数字。
   * @param {number} value 原始数值。
   * @returns {string} 适合 UI 展示的短数字。
   */
  const formatChineseLargeNumber = (value) => {
    const numberValue = Number(value) || 0;
    const absValue = Math.abs(numberValue);
    const units = [
      { value: 1e16, label: '京' },
      { value: 1e12, label: '兆' },
      { value: 1e8, label: '亿' },
      { value: 1e4, label: '万' },
    ];
    const unit = units.find((item) => absValue >= item.value);
    if (!unit) return Number(numberValue.toPrecision(4)).toString();
    return `${Number((numberValue / unit.value).toPrecision(4))}${unit.label}`;
  };

  /**
   * createRankPlayerReport 生成单个玩家的技能连接和观战摘要。
   * @param {object} player 排行榜玩家。
   * @param {object} detail 玩家详情。
   * @returns {string} 可展示和复制的报告。
   */
  const createRankPlayerReport = (player, detail) => {
    const skills = getCharacterSkills(detail);
    const equipmentEntries = getCharacterEquipmentEntries(detail);
    const skillLines = skills.map((skill) => {
      const connection = findSkillConnection(skill, equipmentEntries);
      const levelText = skill.level ? ` Lv${skill.level}${skill.additionLevel ? `(+${skill.additionLevel})` : ''}` : '';
      const supportText = connection?.supportNames?.length ? connection.supportNames.join(' / ') : '无已识别连接';
      const sourceText = connection ? `${connection.slotLabel} · ${connection.equipmentName}` : '未识别装备位置';
      return `- ${getStoneDisplayName(skill)}${levelText}：${sourceText}；连接：${supportText}`;
    });
    const specialSocketLines = getSpecialSocketEquipmentConnectionLines(equipmentEntries, skills);
    const connectionLines = [
      ...(skillLines.length ? skillLines : ['- 未读取到已使用技能。']),
      ...specialSocketLines,
    ];
    const characterUrl = `${location.origin}/character/${player.id}`;
    const battleUrl = `${location.origin}/watch/battle/${player.id}`;
    return [
      `玩家：${player.name}（Lv ${player.level || detail?.level || '未知'}，排名 ${player.rank || '未知'}）`,
      `角色详情：${characterUrl}`,
      `战斗观战：${battleUrl}`,
      '',
      '技能连接：',
      ...connectionLines,
    ].join('\n');
  };

  /**
   * createReportLink 创建排行榜分析报告里的可点击链接。
   * @param {string} url 链接地址。
   * @returns {HTMLAnchorElement} 可点击链接节点。
   */
  const createReportLink = (url) => {
    const linkElement = document.createElement('a');
    linkElement.href = url;
    linkElement.target = '_blank';
    linkElement.rel = 'noopener noreferrer';
    linkElement.textContent = url;
    return linkElement;
  };

  /**
   * renderClickableRankPlayerReport 渲染单个玩家报告，并把角色详情/战斗观战链接变成可点击。
   * @param {HTMLElement} container 报告容器。
   * @param {string} reportText 纯文本报告。
   */
  const renderClickableRankPlayerReport = (container, reportText) => {
    if (!container) return;
    const text = reportText || '加载排行榜后，选择玩家并点击“分析选中玩家”。';
    container.textContent = '';
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const separatorIndex = line.indexOf('：');
      const label = separatorIndex >= 0 ? line.slice(0, separatorIndex) : '';
      const url = separatorIndex >= 0 ? line.slice(separatorIndex + 1).trim() : '';
      if ((label === '角色详情' || label === '战斗观战') && /^https?:\/\/\S+$/.test(url)) {
        container.append(document.createTextNode(`${label}：`), createReportLink(url));
      } else {
        container.append(document.createTextNode(line));
      }
      if (index < lines.length - 1) container.append(document.createTextNode('\n'));
    });
  };

  /**
   * renderRankAnalysisSummary 刷新排行榜分析的主摘要。
   * @param {string} message 摘要文本。
   */
  const renderRankAnalysisSummary = (message = '') => {
    if (!state.ui.rankAnalysisSummary) return;
    const playerCount = state.rankAnalysis.players.length;
    state.ui.rankAnalysisSummary.textContent = message || `已加载排行榜玩家：${playerCount} 人。`;
  };

  /**
   * renderRankPlayerSelect 刷新排行榜玩家下拉框。
   */
  const renderRankPlayerSelect = () => {
    const selectElement = state.ui.rankPlayerSelect;
    if (!selectElement) return;
    const options = state.rankAnalysis.players.map((player) => ({
      value: player.id,
      label: `#${player.rank} ${player.name} Lv${player.level || '?'}`,
    }));
    setSelectOptions(selectElement, options, '先加载排行榜');
    if (state.rankAnalysis.selectedPlayerId) selectElement.value = state.rankAnalysis.selectedPlayerId;
  };

  const updateRankAnalysisActionButtonState = () => {
    const shouldDisable = state.isRunning || !state.rankAnalysis.players.length;
    for (const button of state.ui.rankAnalysisActionButtons || []) {
      button.disabled = shouldDisable;
    }
  };

  /**
   * renderRankAnalysisReports 刷新单人报告和批量报告区域。
   */
  const renderRankAnalysisReports = () => {
    const reportElement = state.ui.rankAnalysisReport || state.ui.rankPlayerReport;
    if (!reportElement) return;
    if (state.rankAnalysis.activeReportType === 'batch') {
      reportElement.textContent = state.rankAnalysis.batchReport || '填写等级后，可统计该等级以上玩家的技能和装备使用占比。';
      return;
    }
    renderClickableRankPlayerReport(reportElement, state.rankAnalysis.selectedPlayerReport);
  };

  /**
   * loadRankPlayers 读取完整等级排行榜。
   */
  const loadRankPlayers = async () => {
    const players = await fetchAllRankLevelPlayers();
    state.rankAnalysis.players = players;
    state.rankAnalysis.selectedPlayerId = players[0]?.id || '';
    renderRankPlayerSelect();
    updateRankAnalysisActionButtonState();
    renderRankAnalysisSummary(`排行榜加载完成：共 ${players.length} 名玩家。`);
    addLog(`排行榜加载完成：共 ${players.length} 名玩家。`, 'compact');
  };

  /**
   * getSelectedRankPlayer 获取当前下拉框选中的排行榜玩家。
   * @returns {object} 排行榜玩家。
   */
  const getSelectedRankPlayer = () => {
    const selectedId = state.ui.rankPlayerSelect?.value || state.rankAnalysis.selectedPlayerId;
    const player = state.rankAnalysis.players.find((item) => item.id === selectedId);
    if (!player) throw new Error('请先加载排行榜并选择一个玩家。');
    return player;
  };

  /**
   * analyzeSelectedRankPlayer 分析当前选中的玩家技能连接。
   */
  const analyzeSelectedRankPlayer = async () => {
    const player = getSelectedRankPlayer();
    const detail = await fetchRankCharacterDetail(player.id);
    state.rankAnalysis.selectedPlayerId = player.id;
    state.rankAnalysis.selectedPlayerDetail = detail;
    state.rankAnalysis.selectedPlayerReport = createRankPlayerReport(player, detail);
    state.rankAnalysis.batchReport = '';
    state.rankAnalysis.activeReportType = 'player';
    renderRankAnalysisReports();
    renderRankAnalysisSummary(`已分析玩家：${player.name}。`);
  };

  /**
   * copyTextToClipboard 复制文本到剪贴板，并在权限受限时降级为 textarea 复制。
   * @param {string} text 需要复制的文本。
   * @returns {Promise<void>} 复制完成。
   */
  const copyTextToClipboard = async (text) => {
    if (!text) throw new Error('没有可复制的内容。');
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        addLog(`剪贴板权限受限，尝试使用兼容复制：${error.message}`, 'warn');
      }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.append(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    textarea.remove();
    if (!success) throw new Error('浏览器拒绝写入剪贴板。');
  };

  const SKILL_TREE_EXPORT_PREFIX = 'T';
  const SKILL_TREE_BINARY_EXPORT_PREFIX = 'P2T3:';
  const LEGACY_SKILL_TREE_EXPORT_PREFIX = 'P2T2';

  const calculateSkillTreeExportChecksum = (text) => {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };

  const normalizeSkillTreeNodeIds = (values) => [...new Set((Array.isArray(values) ? values : [])
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isSafeInteger(value) && value >= 0))]
    .sort((left, right) => left - right);

  const encodeSkillTreeNodeIds = (values) => {
    let previous = 0;
    return normalizeSkillTreeNodeIds(values).map((value) => {
      const delta = value - previous;
      previous = value;
      return delta.toString(36);
    }).join(',');
  };

  const decodeSkillTreeNodeIds = (text) => {
    if (!text) return [];
    let previous = 0;
    return String(text).split(',').map((token) => {
      if (!/^[0-9a-z]+$/i.test(token)) throw new Error('天赋节点编码无效');
      const delta = Number.parseInt(token, 36);
      if (!Number.isSafeInteger(delta) || delta < 0) throw new Error('天赋节点编码超出范围');
      previous += delta;
      if (!Number.isSafeInteger(previous)) throw new Error('天赋节点编号超出范围');
      return String(previous);
    });
  };

  const encodeSkillTreeMasteries = (masteries) => {
    let previous = 0;
    return Object.entries(masteries || {})
      .map(([nodeId, effectIndex]) => [Number.parseInt(nodeId, 10), Number.parseInt(effectIndex, 10)])
      .filter(([nodeId, effectIndex]) => Number.isSafeInteger(nodeId) && nodeId >= 0 && Number.isInteger(effectIndex) && effectIndex >= 0)
      .sort((left, right) => left[0] - right[0])
      .map(([nodeId, effectIndex]) => {
        const delta = nodeId - previous;
        previous = nodeId;
        return `${delta.toString(36)}:${effectIndex.toString(36)}`;
      }).join(',');
  };

  const decodeSkillTreeMasteries = (text) => {
    if (!text) return {};
    let previous = 0;
    const masteries = {};
    String(text).split(',').forEach((entry) => {
      const [deltaText, effectText, extra] = entry.split(':');
      if (extra !== undefined || !/^[0-9a-z]+$/i.test(deltaText) || !/^[0-9a-z]+$/i.test(effectText)) {
        throw new Error('专精编码无效');
      }
      previous += Number.parseInt(deltaText, 36);
      const effectIndex = Number.parseInt(effectText, 36);
      if (!Number.isSafeInteger(previous) || !Number.isInteger(effectIndex)) throw new Error('专精编码超出范围');
      masteries[String(previous)] = effectIndex;
    });
    return masteries;
  };

  const appendSkillTreeVarUint = (bytes, value) => {
    let remaining = Number(value);
    if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error('天赋数据超出可编码范围');
    while (remaining >= 128) {
      bytes.push((remaining % 128) | 128);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(remaining);
  };

  const readSkillTreeVarUint = (bytes, cursor) => {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      if (cursor.index >= bytes.length) throw new Error('天赋字符串数据不完整');
      const byte = bytes[cursor.index];
      cursor.index += 1;
      value += (byte & 0x7f) * multiplier;
      if (!Number.isSafeInteger(value)) throw new Error('天赋数据超出可解析范围');
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new Error('天赋变长整数编码无效');
  };

  const calculateSkillTreeBinaryChecksum = (bytes) => {
    let hash = 2166136261;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };

  const skillTreeBytesToBase64Url = (bytes) => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };

  const skillTreeBase64UrlToBytes = (text) => {
    const encoded = String(text || '');
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
      throw new Error('天赋字符串的 Base64URL 编码无效');
    }
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4);
    let binary;
    try {
      binary = atob(padded);
    } catch {
      throw new Error('天赋字符串的 Base64URL 编码无效');
    }
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  };

  const normalizeSkillTreeMasteries = (masteries) => Object.entries(masteries || {})
    .map(([nodeId, effectIndex]) => [Number.parseInt(nodeId, 10), Number.parseInt(effectIndex, 10)])
    .filter(([nodeId, effectIndex]) => Number.isSafeInteger(nodeId) && nodeId >= 0 && Number.isInteger(effectIndex) && effectIndex >= 0)
    .sort((left, right) => left[0] - right[0]);

  const encodeBinarySkillTreeExport = ({ classId, start, passives, masteries }) => {
    const classNumber = Number.parseInt(classId, 10);
    const startNumber = Number.parseInt(start, 10);
    if (!Number.isInteger(classNumber) || !CHARACTER_CLASS_LABELS[classNumber]) throw new Error('当前角色缺少有效职业信息。');
    if (!Number.isSafeInteger(startNumber) || startNumber < 0) throw new Error('当前天赋缺少有效职业起点。');
    const nodeIds = normalizeSkillTreeNodeIds(passives);
    const masteryEntries = normalizeSkillTreeMasteries(masteries);
    const bytes = [];
    appendSkillTreeVarUint(bytes, classNumber);
    appendSkillTreeVarUint(bytes, startNumber);
    appendSkillTreeVarUint(bytes, nodeIds.length);
    let previous = 0;
    nodeIds.forEach((nodeId) => {
      appendSkillTreeVarUint(bytes, nodeId - previous);
      previous = nodeId;
    });
    appendSkillTreeVarUint(bytes, masteryEntries.length);
    previous = 0;
    masteryEntries.forEach(([nodeId, effectIndex]) => {
      appendSkillTreeVarUint(bytes, nodeId - previous);
      appendSkillTreeVarUint(bytes, effectIndex);
      previous = nodeId;
    });
    const checksum = calculateSkillTreeBinaryChecksum(bytes);
    bytes.push(checksum & 0xff, (checksum >>> 8) & 0xff, (checksum >>> 16) & 0xff, (checksum >>> 24) & 0xff);
    return `${SKILL_TREE_BINARY_EXPORT_PREFIX}${skillTreeBytesToBase64Url(bytes)}`;
  };

  const decodeLegacySkillTreeExport = (text) => {
    const parts = text.split('.');
    if (parts.length !== 6 || parts[0] !== LEGACY_SKILL_TREE_EXPORT_PREFIX) throw new Error('不是本插件支持的天赋字符串。');
    const body = parts.slice(1, 5).join('.');
    if (calculateSkillTreeExportChecksum(body) !== parts[5]) throw new Error('天赋字符串校验失败，内容可能不完整。');
    if (!/^[0-9a-z]+$/i.test(parts[1]) || !/^[0-9a-z]+$/i.test(parts[2])) throw new Error('职业或起点编码无效。');
    const classId = Number.parseInt(parts[1], 36);
    const start = String(Number.parseInt(parts[2], 36));
    const passives = decodeSkillTreeNodeIds(parts[3]);
    const masteries = decodeSkillTreeMasteries(parts[4]);
    if (!Number.isInteger(classId) || !CHARACTER_CLASS_LABELS[classId]) throw new Error('导入字符串包含未知职业。');
    if (!passives.includes(start)) throw new Error('天赋字符串没有包含职业起点。');
    return { classId, start, passives, masteries };
  };

  const decodeBinarySkillTreeExport = (text) => {
    const bytes = skillTreeBase64UrlToBytes(text.slice(SKILL_TREE_BINARY_EXPORT_PREFIX.length));
    if (bytes.length < 8) throw new Error('天赋字符串数据不完整。');
    const payload = bytes.subarray(0, bytes.length - 4);
    const checksumOffset = bytes.length - 4;
    const expectedChecksum = (bytes[checksumOffset]
      | (bytes[checksumOffset + 1] << 8)
      | (bytes[checksumOffset + 2] << 16)
      | (bytes[checksumOffset + 3] << 24)) >>> 0;
    if (calculateSkillTreeBinaryChecksum(payload) !== expectedChecksum) throw new Error('天赋字符串校验失败，内容可能不完整。');
    const cursor = { index: 0 };
    const classId = readSkillTreeVarUint(payload, cursor);
    const start = String(readSkillTreeVarUint(payload, cursor));
    const passiveCount = readSkillTreeVarUint(payload, cursor);
    if (passiveCount > 10000) throw new Error('天赋节点数量异常。');
    const passives = [];
    let previous = 0;
    for (let index = 0; index < passiveCount; index += 1) {
      previous += readSkillTreeVarUint(payload, cursor);
      if (!Number.isSafeInteger(previous)) throw new Error('天赋节点编号超出范围。');
      passives.push(String(previous));
    }
    const masteryCount = readSkillTreeVarUint(payload, cursor);
    if (masteryCount > 10000) throw new Error('专精数量异常。');
    const masteries = {};
    previous = 0;
    for (let index = 0; index < masteryCount; index += 1) {
      previous += readSkillTreeVarUint(payload, cursor);
      const effectIndex = readSkillTreeVarUint(payload, cursor);
      if (!Number.isSafeInteger(previous)) throw new Error('专精节点编号超出范围。');
      masteries[String(previous)] = effectIndex;
    }
    if (cursor.index !== payload.length) throw new Error('天赋字符串包含无法识别的额外数据。');
    if (!Number.isInteger(classId) || !CHARACTER_CLASS_LABELS[classId]) throw new Error('导入字符串包含未知职业。');
    if (!passives.includes(start)) throw new Error('天赋字符串没有包含职业起点。');
    return { classId, start, passives, masteries };
  };

  const getSkillTreeNodeDictionary = (treeData) => {
    const nodes = treeData?.nodes;
    if (!nodes || typeof nodes !== 'object') throw new Error('网页天赋节点数据尚未加载。');
    const dictionary = normalizeSkillTreeNodeIds(Object.keys(nodes)).map(String);
    if (!dictionary.length) throw new Error('当前版本的天赋节点字典为空。');
    return dictionary;
  };

  const calculateSkillTreeDictionaryFingerprint = (dictionary) => {
    const bytes = [];
    appendSkillTreeVarUint(bytes, dictionary.length);
    let previous = 0;
    dictionary.forEach((nodeId) => {
      const numericId = Number(nodeId);
      appendSkillTreeVarUint(bytes, numericId - previous);
      previous = numericId;
    });
    return calculateSkillTreeBinaryChecksum(bytes) & 0xffff;
  };

  const encodeSkillTreeExport = ({ classId, start, passives, masteries, treeData }) => {
    const classNumber = Number.parseInt(classId, 10);
    const startNumber = Number.parseInt(start, 10);
    if (!Number.isInteger(classNumber) || !CHARACTER_CLASS_LABELS[classNumber]) throw new Error('当前角色缺少有效职业信息。');
    if (!Number.isSafeInteger(startNumber) || startNumber < 0) throw new Error('当前天赋缺少有效职业起点。');
    const dictionary = getSkillTreeNodeDictionary(treeData);
    const dictionaryIndexByNodeId = new Map(dictionary.map((nodeId, index) => [nodeId, index]));
    const selectedNodeIds = normalizeSkillTreeNodeIds(passives).map(String);
    if (!selectedNodeIds.includes(String(startNumber))) throw new Error('当前天赋没有包含职业起点。');
    const selectedEntries = selectedNodeIds
      .filter((nodeId) => nodeId !== String(startNumber))
      .map((nodeId) => {
        const dictionaryIndex = dictionaryIndexByNodeId.get(nodeId);
        if (dictionaryIndex === undefined) throw new Error(`当前版本不存在天赋节点：${nodeId}`);
        return [dictionaryIndex, nodeId];
      })
      .sort((left, right) => left[0] - right[0]);
    const selectedPositionByNodeId = new Map(selectedEntries.map((entry, index) => [entry[1], index]));
    const masteryEntries = normalizeSkillTreeMasteries(masteries)
      .map(([nodeId, effectIndex]) => [selectedPositionByNodeId.get(String(nodeId)), effectIndex])
      .filter(([selectedPosition]) => selectedPosition !== undefined)
      .sort((left, right) => left[0] - right[0]);

    const bytes = [];
    const fingerprint = calculateSkillTreeDictionaryFingerprint(dictionary);
    bytes.push(fingerprint & 0xff, (fingerprint >>> 8) & 0xff);
    appendSkillTreeVarUint(bytes, selectedEntries.length);
    let previous = 0;
    selectedEntries.forEach(([dictionaryIndex]) => {
      appendSkillTreeVarUint(bytes, dictionaryIndex - previous);
      previous = dictionaryIndex;
    });
    appendSkillTreeVarUint(bytes, masteryEntries.length);
    previous = 0;
    masteryEntries.forEach(([selectedPosition, effectIndex]) => {
      appendSkillTreeVarUint(bytes, selectedPosition - previous);
      appendSkillTreeVarUint(bytes, effectIndex);
      previous = selectedPosition;
    });
    const checksum = calculateSkillTreeBinaryChecksum([classNumber, ...bytes]) & 0xffff;
    bytes.push(checksum & 0xff, (checksum >>> 8) & 0xff);
    return `${SKILL_TREE_EXPORT_PREFIX}${classNumber}${skillTreeBytesToBase64Url(bytes)}`;
  };

  const decodeCompactSkillTreeExport = (text, { treeData, start } = {}) => {
    const match = /^T([1-7])([A-Za-z0-9_-]+)$/.exec(text);
    if (!match) throw new Error('紧凑天赋字符串格式无效。');
    const classId = Number(match[1]);
    const startId = String(start || '');
    if (!startId) throw new Error('当前天赋缺少有效职业起点。');
    const bytes = skillTreeBase64UrlToBytes(match[2]);
    if (bytes.length < 6) throw new Error('天赋字符串数据不完整。');
    const payload = bytes.subarray(0, bytes.length - 2);
    const checksumOffset = bytes.length - 2;
    const expectedChecksum = bytes[checksumOffset] | (bytes[checksumOffset + 1] << 8);
    if ((calculateSkillTreeBinaryChecksum([classId, ...payload]) & 0xffff) !== expectedChecksum) {
      throw new Error('天赋字符串校验失败，内容可能不完整。');
    }
    const dictionary = getSkillTreeNodeDictionary(treeData);
    const expectedFingerprint = payload[0] | (payload[1] << 8);
    if (calculateSkillTreeDictionaryFingerprint(dictionary) !== expectedFingerprint) {
      throw new Error('天赋字符串对应的天赋树版本与当前页面不一致。');
    }
    const cursor = { index: 2 };
    const passiveCount = readSkillTreeVarUint(payload, cursor);
    if (passiveCount > dictionary.length) throw new Error('天赋节点数量异常。');
    const selectedNodeIds = [];
    let previous = 0;
    for (let index = 0; index < passiveCount; index += 1) {
      const delta = readSkillTreeVarUint(payload, cursor);
      if (index > 0 && delta === 0) throw new Error('天赋节点索引重复。');
      previous += delta;
      if (previous >= dictionary.length) throw new Error('天赋节点索引超出当前版本范围。');
      const nodeId = dictionary[previous];
      if (nodeId === startId) throw new Error('天赋字符串重复包含职业起点。');
      selectedNodeIds.push(nodeId);
    }
    const masteryCount = readSkillTreeVarUint(payload, cursor);
    if (masteryCount > passiveCount) throw new Error('专精数量异常。');
    const masteries = {};
    previous = 0;
    for (let index = 0; index < masteryCount; index += 1) {
      const delta = readSkillTreeVarUint(payload, cursor);
      if (index > 0 && delta === 0) throw new Error('专精节点索引重复。');
      previous += delta;
      if (previous >= selectedNodeIds.length) throw new Error('专精节点索引超出已选节点范围。');
      masteries[selectedNodeIds[previous]] = readSkillTreeVarUint(payload, cursor);
    }
    if (cursor.index !== payload.length) throw new Error('天赋字符串包含无法识别的额外数据。');
    return { classId, start: startId, passives: [startId, ...selectedNodeIds], masteries };
  };

  const decodeSkillTreeExport = (text, context) => {
    const normalized = String(text || '').trim();
    if (/^T[1-7]/.test(normalized)) return decodeCompactSkillTreeExport(normalized, context);
    if (normalized.startsWith(SKILL_TREE_BINARY_EXPORT_PREFIX)) return decodeBinarySkillTreeExport(normalized);
    if (normalized.startsWith(`${LEGACY_SKILL_TREE_EXPORT_PREFIX}.`)) return decodeLegacySkillTreeExport(normalized);
    throw new Error('不是本插件支持的天赋字符串。');
  };

  const exportSkillTree = async () => {
    const [payload, treePayload, characterPayload] = await Promise.all([
      requestJson(config.endpoints.skillTree),
      requestJson(config.endpoints.skillTreeData),
      requestJson(config.endpoints.character),
    ]);
    if (payload?.success === false || !payload?.data) throw new Error(payload?.message || '读取天赋失败。');
    if (!treePayload?.data) throw new Error('读取当前版本天赋节点字典失败。');
    if (!characterPayload?.data) throw new Error('读取当前角色职业失败。');
    const data = payload.data;
    const passives = Array.isArray(data.skills) ? data.skills.map(String) : [];
    const start = String(data.start || '');
    if (start && !passives.includes(start)) passives.unshift(start);
    const classId = Number(characterPayload.data.class || 0);
    const className = CHARACTER_CLASS_LABELS[classId] || `未知职业(${classId})`;
    const exportText = encodeSkillTreeExport({
      classId,
      start,
      passives,
      masteries: data.masteries || {},
      treeData: treePayload.data,
    });
    state.ui.skillTreeTransferText.value = exportText;
    state.ui.skillTreeTransferSummary.textContent = `已导出${className}当前保存的天赋：${Math.max(0, passives.length - 1)} 点，${Object.keys(data.masteries || {}).length} 个专精；字符串 ${exportText.length} 字符。`;
    try {
      await copyTextToClipboard(exportText);
      addLog('天赋字符串已导出并复制到剪贴板。', 'compact');
    } catch (error) {
      addLog(`天赋已导出到文本框，但自动复制失败：${error.message}`, 'warn');
    }
  };

  const validateImportedSkillTree = (imported, currentData, treeData, currentCharacter) => {
    const currentClassId = Number(currentCharacter?.class || 0);
    if (imported.classId !== currentClassId) {
      const currentClassName = CHARACTER_CLASS_LABELS[currentClassId] || `未知职业(${currentClassId})`;
      const importedClassName = CHARACTER_CLASS_LABELS[imported.classId] || `未知职业(${imported.classId})`;
      throw new Error(`请先切换职业，当前职业为：${currentClassName}，导入职业为：${importedClassName}。`);
    }
    const currentStart = String(currentData?.start || '');
    if (!currentStart || imported.start !== currentStart) throw new Error('当前职业的天赋起点与导入数据不一致，可能是天赋版本已经更新。');
    const nodes = treeData?.nodes;
    if (!nodes || typeof nodes !== 'object') throw new Error('网页天赋节点数据尚未加载。');
    const selectedSet = new Set(imported.passives.map(String));
    for (const nodeId of selectedSet) {
      if (!nodes[nodeId]) throw new Error(`导入天赋包含当前版本不存在的节点：${nodeId}`);
    }
    const visited = new Set([currentStart]);
    const queue = [currentStart];
    while (queue.length) {
      const nodeId = queue.shift();
      const node = nodes[nodeId] || {};
      const linkedIds = [...(Array.isArray(node.in) ? node.in : []), ...(Array.isArray(node.out) ? node.out : [])].map(String);
      linkedIds.forEach((linkedId) => {
        if (selectedSet.has(linkedId) && !visited.has(linkedId)) {
          visited.add(linkedId);
          queue.push(linkedId);
        }
      });
    }
    if (visited.size !== selectedSet.size) throw new Error('导入天赋存在与职业起点不连通的节点。');

    for (const [nodeId, effectIndex] of Object.entries(imported.masteries)) {
      const node = nodes[nodeId];
      if (!selectedSet.has(nodeId) || !node?.isMastery) throw new Error(`专精节点 ${nodeId} 未被正确点亮。`);
      if (!Number.isInteger(effectIndex) || effectIndex < 0 || effectIndex >= (node.masteryEffects?.length || 0)) {
        throw new Error(`专精节点 ${nodeId} 的选项已不适用于当前版本。`);
      }
    }

  };

  const importSkillTreeToPage = async () => {
    if (!/^\/skilltree\/?$/.test(location.pathname)) throw new Error('导入天赋必须在网页“天赋”页面执行。');
    const importText = state.ui.skillTreeTransferText?.value;
    const [currentPayload, treePayload, characterPayload] = await Promise.all([
      requestJson(config.endpoints.skillTree),
      requestJson(config.endpoints.skillTreeData),
      requestJson(config.endpoints.character),
    ]);
    if (!currentPayload?.data || !treePayload?.data || !characterPayload?.data) throw new Error('读取当前天赋页面数据失败。');
    const imported = decodeSkillTreeExport(importText, {
      treeData: treePayload.data,
      start: currentPayload.data.start,
    });
    validateImportedSkillTree(imported, currentPayload.data, treePayload.data, characterPayload.data);
    sessionStorage.setItem(SKILL_TREE_IMPORT_SESSION_KEY, JSON.stringify(imported));
    location.reload();
  };

  /**
   * copySelectedRankBattleInfo 生成当前玩家战斗信息并复制到剪贴板。
   */
  const copySelectedRankBattleInfo = async () => {
    let report = state.rankAnalysis.selectedPlayerReport;
    if (!report) {
      await analyzeSelectedRankPlayer();
      report = state.rankAnalysis.selectedPlayerReport;
    }
    await copyTextToClipboard(report);
    addLog('已复制玩家战斗信息到剪贴板。', 'compact');
  };

  /**
   * incrementPlayerUsage 对玩家维度的占比 Map 计数。
   * @param {Map<string, number>} usageMap 统计表。
   * @param {Set<string>} names 当前玩家使用项集合。
   */
  const incrementPlayerUsage = (usageMap, names) => {
    for (const name of names) {
      if (!name) continue;
      usageMap.set(name, (usageMap.get(name) || 0) + 1);
    }
  };

  /**
   * formatUsageTopList 把玩家使用占比统计格式化为文本。
   * @param {Map<string, number>} usageMap 使用统计。
   * @param {number} totalPlayers 分母玩家数。
   * @returns {Array<string>} 排序后的统计行。
   */
  const formatUsageTopList = (usageMap, totalPlayers) => [...usageMap.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, RANK_ANALYSIS_CONFIG.topLimit)
    .map(([name, count]) => `- ${name}：${count}/${totalPlayers} 人，${formatPercent(count, totalPlayers)}`);

  /**
   * formatUsageFullList 把少量固定分类的玩家占比完整格式化。
   * 职业数量有限，不应该像技能和装备那样只截取前 N 名。
   * @param {Map<string, number>} usageMap 使用统计。
   * @param {number} totalPlayers 分母玩家数。
   * @returns {Array<string>} 完整统计行。
   */
  const formatUsageFullList = (usageMap, totalPlayers) => [...usageMap.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => `- ${name}：${count}/${totalPlayers} 人，${formatPercent(count, totalPlayers)}`);

  /**
   * analyzeRankPlayersAboveLevel 统计指定等级以上玩家的技能和装备使用占比。
   */
  const analyzeRankPlayersAboveLevel = async () => {
    if (!state.rankAnalysis.players.length) await loadRankPlayers();
    const threshold = Number.parseInt(state.ui.rankLevelThresholdInput?.value, 10) || 1;
    const targetPlayers = state.rankAnalysis.players.filter((player) => player.level >= threshold);
    if (!targetPlayers.length) throw new Error(`排行榜中没有 ${threshold} 级以上玩家。`);
    const skillUsage = new Map();
    const classUsage = new Map();
    const uniqueEquipmentUsage = new Map();
    const nonUniqueBaseUsage = new Map();
    let analyzedCount = 0;
    const analyzeRankPlayerUsage = async (player, playerIndex) => {
      const detail = await fetchRankCharacterDetail(player.id);
      const className = getCharacterClassName(detail, player.className || '未知职业');
      const playerSkills = new Set(getCharacterSkills(detail).map(getStoneDisplayName).filter(Boolean));
      const playerUniques = new Set();
      const playerNonUniqueBases = new Set();
      for (const { equipment } of getCharacterEquipmentEntries(detail)) {
        if (Number(equipment?.rarity) === RARITY_TYPES.unique) {
          playerUniques.add(getEquipmentDisplayName(equipment));
        } else {
          playerNonUniqueBases.add(getEquipmentBaseName(equipment));
        }
      }
      analyzedCount += 1;
      if (analyzedCount % 10 === 0) {
        addLog(`排行榜批量分析进度：${analyzedCount}/${targetPlayers.length}。`, 'info');
      }
      await wait(45);
      return {
        playerIndex,
        className,
        playerSkills,
        playerUniques,
        playerNonUniqueBases,
      };
    };
    const analysisResults = await runConcurrentTasks(
      targetPlayers,
      RANK_ANALYSIS_CONFIG.concurrency,
      analyzeRankPlayerUsage,
    );
    const failedResults = analysisResults.filter((result) => result?.error && !isRequestAbortError(result.error));
    failedResults.forEach((result) => {
      addLog(`排行榜玩家分析失败：${result.error?.message || result.error || '未知错误'}`, 'warn');
    });
    analysisResults
      .filter((result) => result && !result.error)
      .sort((left, right) => left.playerIndex - right.playerIndex)
      .forEach((result) => {
        incrementPlayerUsage(classUsage, new Set([result.className]));
        incrementPlayerUsage(skillUsage, result.playerSkills);
        incrementPlayerUsage(uniqueEquipmentUsage, result.playerUniques);
        incrementPlayerUsage(nonUniqueBaseUsage, result.playerNonUniqueBases);
      });
    const reportLines = [
      `等级以上：${threshold}+`,
      `分析玩家：${analyzedCount}/${targetPlayers.length}`,
      '',
      '职业占比（全部职业）：',
      ...(formatUsageFullList(classUsage, analyzedCount).length ? formatUsageFullList(classUsage, analyzedCount) : ['- 无数据']),
      '',
      `技能使用占比（前 ${RANK_ANALYSIS_CONFIG.topLimit}）：`,
      ...(formatUsageTopList(skillUsage, analyzedCount).length ? formatUsageTopList(skillUsage, analyzedCount) : ['- 无数据']),
      '',
      `暗金装备使用占比（按名称，前 ${RANK_ANALYSIS_CONFIG.topLimit}）：`,
      ...(formatUsageTopList(uniqueEquipmentUsage, analyzedCount).length ? formatUsageTopList(uniqueEquipmentUsage, analyzedCount) : ['- 无数据']),
      '',
      `非暗金装备使用占比（按基底，前 ${RANK_ANALYSIS_CONFIG.topLimit}）：`,
      ...(formatUsageTopList(nonUniqueBaseUsage, analyzedCount).length ? formatUsageTopList(nonUniqueBaseUsage, analyzedCount) : ['- 无数据']),
    ];
    state.rankAnalysis.batchReport = reportLines.join('\n');
    state.rankAnalysis.selectedPlayerReport = '';
    state.rankAnalysis.activeReportType = 'batch';
    renderRankAnalysisReports();
    renderRankAnalysisSummary(`已完成 ${threshold} 级以上玩家统计：${analyzedCount} 人。`);
  };

  /**
   * getModifyTypeLabel 把改造编号转换为可读的通货名称。
   * @param {number} modifyType 改造编号。
   * @returns {string} 通货名称。
   */
  const getModifyTypeLabel = (modifyType) => MODIFY_TYPE_LABELS[modifyType] || `通货 ${modifyType}`;

  const getCurrencyNameById = (currencyId) => {
    const normalizedId = String(currencyId);
    const fieldName = Object.entries(CURRENCY_ID_MAP)
      .find(([, mappedId]) => String(mappedId) === normalizedId)?.[0];
    return fieldName ? CURRENCY_NAME_MAP[fieldName] : `通货 ${normalizedId}`;
  };

  /**
   * fetchEquipmentDetail 读取单件装备最新信息。
   * 测试服前端改造弹窗使用 GET /equipment/{id}，这里复用同一个接口，避免依赖通货接口返回的旧装备快照。
   * @param {string} equipmentId 装备 ID。
   * @returns {Promise<object|null>} 最新装备信息。
   */
  const fetchEquipmentDetail = async (equipmentId) => {
    if (!equipmentId) return null;
    const payload = await requestJson(`${config.endpoints.equipmentDetail}/${equipmentId}?_=${Date.now()}`);
    if (payload.success === false) {
      throw new Error(payload.message || '装备信息查询失败');
    }
    return payload.data?.equipment || payload.data || null;
  };

  const parseEquipmentTypeMask = (value) => {
    if (value === undefined || value === null || value === '') return 0n;
    try {
      return BigInt(String(value));
    } catch (error) {
      return 0n;
    }
  };

  const isCraftBenchForMask = (craft, mask) => {
    if (!mask) return true;
    if (!Array.isArray(craft?.equipmentTypes) || !craft.equipmentTypes.length) return true;
    return craft.equipmentTypes.some((equipmentType) => (
      (parseEquipmentTypeMask(equipmentType) & mask) !== 0n
    ));
  };

  const getCraftBenchCategoryLabel = (categoryValue) => (
    CRAFT_BENCH_CATEGORY_OPTIONS.find((option) => option.value === categoryValue)?.label || '未分类'
  );

  const stripHtmlText = (htmlText) => {
    const element = document.createElement('div');
    element.innerHTML = String(htmlText || '');
    return element.textContent.trim();
  };

  const formatCraftBenchMagicValue = (values) => {
    const normalizedValues = (Array.isArray(values) ? values : [])
      .map((value) => {
        const minValue = value?.min;
        const maxValue = value?.max;
        if (minValue === undefined && maxValue === undefined) return '';
        return String(minValue) === String(maxValue) ? String(minValue) : `${minValue} ~ ${maxValue}`;
      })
      .filter(Boolean);
    if (normalizedValues.length <= 1) return normalizedValues[0] || '';
    return normalizedValues;
  };

  const getPageMagicFormatters = () => {
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    return pageWindow.magics || pageWindow.bt || state.craftBench.magicFormatters || null;
  };

  const extractObjectLiteralByPrefix = (sourceText, prefix) => {
    const prefixIndex = sourceText.indexOf(prefix);
    if (prefixIndex < 0) return '';
    const startIndex = sourceText.indexOf('{', prefixIndex);
    if (startIndex < 0) return '';
    let depth = 0;
    let squareDepth = 0;
    let parenDepth = 0;
    let quote = '';
    let escaped = false;
    for (let index = startIndex; index < sourceText.length; index += 1) {
      const character = sourceText[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        continue;
      }
      if (character === '{') depth += 1;
      if (character === '[') squareDepth += 1;
      if (character === ']') squareDepth -= 1;
      if (character === '(') parenDepth += 1;
      if (character === ')') parenDepth -= 1;
      if (character === '}') {
        depth -= 1;
        if (depth === 0 && squareDepth === 0 && parenDepth === 0) return sourceText.slice(startIndex, index + 1);
      }
    }
    return '';
  };

  const createCraftMagicFormatterHelpers = () => {
    const numericValue = (value) => {
      if (Array.isArray(value)) return numericValue(value[0]);
      const parsedValue = Number(value);
      if (!Number.isFinite(parsedValue)) {
        const matchedNumber = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
        return matchedNumber ? Number(matchedNumber[0]) : 0;
      }
      return Number.isFinite(parsedValue) ? parsedValue : 0;
    };
    const absText = (value) => {
      if (Array.isArray(value)) return value.map(absText);
      const text = String(value ?? '');
      return text.startsWith('-') ? text.slice(1) : text;
    };
    return {
      nt: (value) => (numericValue(value) > 0 ? '+' : ''),
      t: absText,
      yi: (value) => (numericValue(value) >= 0 ? '加快' : '减慢'),
      dt: (value) => (numericValue(value) >= 0 ? '提高' : '降低'),
      Fe: { 1: '物理', 2: '火焰', 3: '冰霜', 4: '闪电', 5: '混沌' },
      yn: async () => ({}),
    };
  };

  const installCraftMagicFormattersFromBattleAsset = async () => {
    if (state.craftBench.magicFormatters) return state.craftBench.magicFormatters;
    if (state.craftBench.magicFormattersLoadingPromise) return state.craftBench.magicFormattersLoadingPromise;
    state.craftBench.magicFormattersLoadingPromise = (async () => {
      const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const battleScript = [...document.scripts]
        .map((script) => script.src || '')
        .find((src) => /\/assets\/battle-[^/]+\.js/.test(src));
      const battleScriptUrl = battleScript || `${location.origin}/assets/battle-CuuYzQen.js`;
      const sourceText = await fetch(battleScriptUrl).then((response) => response.ok ? response.text() : '');
      const objectLiteral = extractObjectLiteralByPrefix(sourceText, 'bt=');
      if (!objectLiteral) return null;
      const helpers = createCraftMagicFormatterHelpers();
      const formatters = Function(
        'nt',
        't',
        'yi',
        'dt',
        'Fe',
        'yn',
        `"use strict"; return (${objectLiteral});`,
      )(helpers.nt, helpers.t, helpers.yi, helpers.dt, helpers.Fe, helpers.yn);
      state.craftBench.magicFormatters = formatters;
      if (!pageWindow.magics) pageWindow.magics = formatters;
      return formatters;
    })();
    try {
      return await state.craftBench.magicFormattersLoadingPromise;
    } catch (error) {
      addLog(`工艺属性渲染表读取失败，部分工艺可能显示属性编号：${error.message}`, 'warn');
      return null;
    } finally {
      state.craftBench.magicFormattersLoadingPromise = null;
    }
  };

  const formatCraftBenchMagicText = (magicId, values) => {
    const formatter = getPageMagicFormatters()?.[magicId];
    const rawValues = (Array.isArray(values) ? values : [])
      .map((value) => {
        const minValue = value?.min;
        const maxValue = value?.max;
        if (minValue === undefined && maxValue === undefined) return '';
        return String(minValue) === String(maxValue) ? String(minValue) : `${minValue} ~ ${maxValue}`;
      })
      .filter(Boolean);
    const formattedValue = rawValues.length ? rawValues : formatCraftBenchMagicValue(values);
    if (typeof formatter === 'function') {
      try {
        const renderedText = stripHtmlText(formatter(formattedValue));
        return renderedText.replace(/\s+/g, ' ').trim();
      } catch (error) {
        try {
          const fallbackValue = Array.isArray(formattedValue) && formattedValue.length === 1 ? formattedValue[0] : formattedValue;
          const renderedText = stripHtmlText(formatter(fallbackValue));
          return renderedText.replace(/\s+/g, ' ').trim();
        } catch (fallbackError) {
          const renderedText = stripHtmlText(formatter(String(formattedValue || '')));
          return renderedText.replace(/\s+/g, ' ').trim();
        }
      }
    }
    const valueText = Array.isArray(formattedValue) ? formattedValue.join(' / ') : formattedValue;
    return `属性 ${magicId}${valueText ? ` ${valueText}` : ''}`;
  };

  const formatCraftBenchLabel = (craft) => {
    if (!craft) return '未选择工艺';
    if (craft.text) return String(craft.text);
    const affix = craft.affix || {};
    const positionText = Number(affix.type) === 1 ? '前缀' : (Number(affix.type) === 2 ? '后缀' : '词缀');
    const magicTexts = Object.entries(affix.magics || {})
      .map(([magicId, values]) => formatCraftBenchMagicText(magicId, values))
      .filter(Boolean);
    const effectText = magicTexts.length ? magicTexts.join('；') : (affix.name || `工艺 ${craft.craftId}`);
    return `${positionText}：${effectText}`;
  };

  const normalizeCraftBenchItem = (craft) => ({
    ...craft,
    craftId: Number(craft?.craftId),
    label: formatCraftBenchLabel(craft),
    searchText: [
      String(craft?.craftId ?? ''),
      String(craft?.text || ''),
      String(craft?.affix?.name || ''),
      ...Object.entries(craft?.affix?.magics || {}).map(([magicId, values]) => formatCraftBenchMagicText(magicId, values)),
    ].join(' '),
  });

  const fetchCraftBenchList = async () => {
    await installCraftMagicFormattersFromBattleAsset();
    const payload = await requestJson(`${config.endpoints.craftList}?_=${Date.now()}`);
    if (payload.success === false) throw new Error(payload.message || '工艺列表读取失败');
    const craftList = Array.isArray(payload.data) ? payload.data : [];
    state.craftBench.list = craftList
      .filter((craft) => craft?.affix || Number(craft?.craftId) === 0)
      .map(normalizeCraftBenchItem)
      .sort((left, right) => left.label.localeCompare(right.label) || left.craftId - right.craftId);
    state.craftBench.loaded = true;
    return state.craftBench.list;
  };

  const ensureCraftBenchList = async (forceRefresh = false) => {
    if (state.craftBench.loadingPromise && !forceRefresh) return state.craftBench.loadingPromise;
    if (state.craftBench.loaded && !forceRefresh) return state.craftBench.list;
    state.craftBench.loading = true;
    state.craftBench.loadingPromise = fetchCraftBenchList();
    try {
      return await state.craftBench.loadingPromise;
    } finally {
      state.craftBench.loading = false;
      state.craftBench.loadingPromise = null;
    }
  };

  const getCraftBenchOptionsByCategory = (categoryValue) => {
    const category = CRAFT_BENCH_CATEGORY_OPTIONS.find((option) => option.value === categoryValue);
    const mask = category?.mask || 0n;
    return state.craftBench.list
      .filter((craft) => isCraftBenchForMask(craft, mask))
      .map((craft) => ({
        value: craft.craftId,
        label: craft.label,
      }));
  };

  const getCraftBenchById = (craftId) => {
    const normalizedCraftId = Number.parseInt(craftId, 10);
    return state.craftBench.list.find((craft) => craft.craftId === normalizedCraftId) || null;
  };

  const getCraftBenchCost = (craft, equipment) => {
    const cost = { ...(craft?.cost || {}) };
    if (equipment?.corrupted && craft?.allowOnCorrupted) {
      const baseCostTotal = Object.values(craft.cost || {})
        .reduce((total, amount) => total + Number(amount || 0), 0);
      if (baseCostTotal > 0) cost[String(MODIFY_TYPES.vaal)] = (Number(cost[String(MODIFY_TYPES.vaal)] || 0) + baseCostTotal);
    }
    return cost;
  };

  const formatCraftBenchCost = (cost) => Object.entries(cost || {})
    .map(([currencyId, amount]) => `${getCurrencyNameById(currencyId)}x${amount}`)
    .join('，');

  const getGardenCraftCategory = (categoryValue) => (
    GARDEN_CRAFT_CATEGORY_OPTIONS.find((option) => option.value === categoryValue)
    || GARDEN_CRAFT_CATEGORY_OPTIONS[0]
  );

  const formatGardenCraftLabel = (craft) => {
    if (!craft) return '未选择花园工艺';
    const prefix = craft.type === 'catalyst' ? '催化剂' : '附魔';
    const nameText = craft.name || craft.description || craft.key;
    return `${prefix}：${stripHtmlText(nameText)}`;
  };

  const normalizeGardenCraftItem = (item) => {
    const type = item?.type === 'catalyst' ? 'catalyst' : 'enchantment';
    const idValue = type === 'catalyst' ? item?.currencyType : item?.enchantmentId;
    const key = `${type}:${idValue}`;
    const description = stripHtmlText(item?.description || '');
    const normalized = {
      ...item,
      type,
      key,
      label: formatGardenCraftLabel({ ...item, type, key }),
      searchText: [
        key,
        item?.name || '',
        description,
      ].join(' '),
    };
    if (type === 'catalyst') normalized.catalystType = Number(item?.currencyType);
    if (type === 'enchantment') normalized.enchantmentId = Number(item?.enchantmentId);
    return normalized;
  };

  const fetchGardenCraftRawList = async (equipmentTypeMask) => {
    const payload = await requestJson(`${config.endpoints.gardenList}/${equipmentTypeMask.toString()}?_=${Date.now()}`);
    if (payload.success === false) throw new Error(payload.message || '花园工艺列表读取失败');
    const data = payload.data || {};
    return [
      ...(Array.isArray(data.enchantments) ? data.enchantments.map((item) => ({ ...item, type: 'enchantment' })) : []),
      ...(Array.isArray(data.catalysts) ? data.catalysts.map((item) => ({ ...item, type: 'catalyst' })) : []),
    ];
  };

  const fetchGardenCraftListByCategory = async (categoryValue) => {
    const category = getGardenCraftCategory(categoryValue);
    let rawItems = await fetchGardenCraftRawList(category.mask);
    if (!rawItems.length && Array.isArray(category.sampleTypes)) {
      const byKey = new Map();
      for (const sampleType of category.sampleTypes) {
        const sampleItems = await fetchGardenCraftRawList(sampleType);
        sampleItems.forEach((item) => {
          const normalizedItem = normalizeGardenCraftItem(item);
          if (normalizedItem.key) byKey.set(normalizedItem.key, item);
        });
      }
      rawItems = [...byKey.values()];
    }
    const list = rawItems
      .map(normalizeGardenCraftItem)
      .filter((item) => item.key && (item.type === 'catalyst' ? Number.isFinite(item.catalystType) : Number.isFinite(item.enchantmentId)))
      .sort((left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
    state.gardenCraft.byCategory[category.value] = list;
    return list;
  };

  const ensureGardenCraftList = async (categoryValue, forceRefresh = false) => {
    const category = getGardenCraftCategory(categoryValue);
    if (state.gardenCraft.loadingByCategory[category.value] && !forceRefresh) {
      return state.gardenCraft.loadingByCategory[category.value];
    }
    if (state.gardenCraft.byCategory[category.value] && !forceRefresh) {
      return state.gardenCraft.byCategory[category.value];
    }
    state.gardenCraft.loadingByCategory[category.value] = fetchGardenCraftListByCategory(category.value);
    try {
      return await state.gardenCraft.loadingByCategory[category.value];
    } finally {
      delete state.gardenCraft.loadingByCategory[category.value];
    }
  };

  const getGardenCraftOptionsByCategory = (categoryValue) => (
    state.gardenCraft.byCategory[getGardenCraftCategory(categoryValue).value] || []
  ).map((craft) => ({
    value: craft.key,
    label: craft.label,
  }));

  const getGardenCraftByKey = (categoryValue, gardenCraftKey) => {
    const normalizedKey = String(gardenCraftKey || '');
    return (state.gardenCraft.byCategory[getGardenCraftCategory(categoryValue).value] || [])
      .find((craft) => craft.key === normalizedKey) || null;
  };

  const isGardenCraftForEquipment = (categoryValue, equipment) => {
    const category = getGardenCraftCategory(categoryValue);
    return (parseEquipmentTypeMask(equipment?.equipmentType) & category.mask) !== 0n;
  };

  const applyGardenCraft = async (equipment, categoryValue, gardenCraftKey) => {
    const category = getGardenCraftCategory(categoryValue);
    await ensureGardenCraftList(category.value);
    const craft = getGardenCraftByKey(category.value, gardenCraftKey);
    if (!craft) throw new Error('请先选择花园工艺方法。');
    if (!isGardenCraftForEquipment(category.value, equipment)) {
      throw new Error(`${equipment.name} 的装备类型不能使用该花园工艺分组：${category.label}。`);
    }
    recordStepExecution('花园工艺');
    addMainLog(`${equipment.name} 使用花园工艺：${craft.label}。`);
    const body = craft.type === 'catalyst'
      ? { type: 'catalyst', equipmentId: equipment.id, catalystType: craft.catalystType }
      : { type: 'enchantment', equipmentId: equipment.id, enchantmentId: craft.enchantmentId };
    const payload = await requestJson(config.endpoints.gardenApply, { method: 'POST', body });
    if (payload.success === false) throw new Error(payload.message || '花园工艺失败');
    const updatedEquipment = payload.data?.equipment || payload.data;
    if (updatedEquipment) mergeEquipmentUpdate(equipment, updatedEquipment);
    const cost = craft.cost || payload.data?.cost || {};
    recordCurrencyUsageBatch(cost);
    const costText = formatCraftBenchCost(cost);
    addLog(`${equipment.name} 已使用花园工艺：${craft.label}${costText ? `，消耗：${costText}` : ''}。`, 'info');
    await wait(getSpeedDelay());
    return true;
  };

  const getGardenCraftSelectionValue = (categoryValue, gardenCraftKey) => (
    `${getGardenCraftCategory(categoryValue).value}|${String(gardenCraftKey || '')}`
  );

  const parseGardenCraftSelectionValue = (selectionValue) => {
    const [categoryValue, ...keyParts] = String(selectionValue || '').split('|');
    return {
      categoryValue: getGardenCraftCategory(categoryValue).value,
      gardenCraftKey: keyParts.join('|'),
    };
  };

  const getAdvancedGardenCraftOptions = () => GARDEN_CRAFT_CATEGORY_OPTIONS.flatMap((category) => (
    (state.gardenCraft.byCategory[category.value] || []).map((craft) => ({
      value: getGardenCraftSelectionValue(category.value, craft.key),
      label: `${category.label} · ${craft.label}`,
    }))
  ));

  const applyCraftBench = async (equipment, craftId, { continueOnBackendRejection = false } = {}) => {
    await ensureCraftBenchList();
    const craft = getCraftBenchById(craftId);
    if (!craft) throw new Error('请先选择工艺词缀。');
    const equipmentMask = parseEquipmentTypeMask(equipment.equipmentType);
    if (!isCraftBenchForMask(craft, equipmentMask)) {
      throw new Error(`${equipment.name} 的装备类型不能使用该工艺：${craft.label}`);
    }
    if (equipment.corrupted && !craft.allowOnCorrupted) {
      throw new Error(`${equipment.name} 已腐化，不能使用该工艺：${craft.label}`);
    }
    recordStepExecution('工艺');
    addMainLog(`${equipment.name} 使用工艺：${craft.label}。`);
    let payload;
    try {
      payload = await requestJson(config.endpoints.craftApply, {
        method: 'POST',
        body: { equipmentId: equipment.id, craftId: craft.craftId },
      });
      if (payload.success === false) throw new Error(payload.message || '工艺改造失败');
    } catch (error) {
      if (!continueOnBackendRejection) throw error;
      addLog(`${equipment.name} 存在多大师工艺，已尝试工艺但被后端拒绝：${error.message}；继续执行后续步骤。`, 'warn');
      await wait(getSpeedDelay());
      return false;
    }
    const updatedEquipment = payload.data?.equipment || payload.data;
    if (updatedEquipment) mergeEquipmentUpdate(equipment, updatedEquipment);
    const cost = getCraftBenchCost(craft, equipment);
    recordCurrencyUsageBatch(cost);
    addLog(`${equipment.name} 已使用工艺：${craft.label}${formatCraftBenchCost(cost) ? `，消耗：${formatCraftBenchCost(cost)}` : ''}。`, 'info');
    await wait(getSpeedDelay());
    return true;
  };

  const hasCraftedAffix = (equipment) => (Array.isArray(equipment?.affixes) ? equipment.affixes : [])
    .some((affix) => affix?.isCrafted === true);

  const hasMultiMasterCraftAffix = (equipment) => (Array.isArray(equipment?.affixes) ? equipment.affixes : [])
    .some((affix) => (
      Object.prototype.hasOwnProperty.call(affix?.magics || {}, '552')
      || (
        affix?.isCrafted === true
        && normalizeAffixPositionType(affix) === 'suffix'
        && String(affix?.name || affix?.affixName || '').trim() === '大师之'
      )
    ));

  const getCraftBenchPositionType = (craft) => {
    const affixType = Number(craft?.affix?.type || 0);
    if (affixType === 1) return 'prefix';
    if (affixType === 2) return 'suffix';
    return '';
  };

  const shouldSkipSmartCraftBenchForFullAffix = (equipment, craft) => {
    const craftPositionType = getCraftBenchPositionType(craft);
    if (!craftPositionType) return false;
    const affixSummary = getMagicAffixSummary(equipment?.affixes);
    const affixSlotLimits = getAffixSlotLimits(equipment?.rarity, equipment);
    if (craftPositionType === 'prefix') return affixSummary.prefixCount >= affixSlotLimits.prefix;
    if (craftPositionType === 'suffix') return affixSummary.suffixCount >= affixSlotLimits.suffix;
    return false;
  };

  const applySmartCraftBench = async (equipment, craftId) => {
    await ensureCraftBenchList();
    const craft = getCraftBenchById(craftId);
    if (!craft) throw new Error('请先选择工艺词缀。');
    const hasMultiMasterCraft = hasMultiMasterCraftAffix(equipment);
    if (hasCraftedAffix(equipment) && !hasMultiMasterCraft) {
      addStepLog(`${equipment.name} 已有工艺词缀，智能工艺跳过。`);
      await wait(getSpeedDelay());
      return true;
    }
    if (shouldSkipSmartCraftBenchForFullAffix(equipment, craft) && !hasMultiMasterCraft) {
      const positionText = getCraftBenchPositionType(craft) === 'prefix' ? '前缀' : '后缀';
      addStepLog(`${equipment.name} ${positionText}已满，智能工艺跳过：${craft.label}。`);
      await wait(getSpeedDelay());
      return true;
    }
    if (hasMultiMasterCraft) addStepLog(`${equipment.name} 存在多大师工艺，智能工艺强制尝试：${craft.label}。`);
    const applied = await applyCraftBench(equipment, craftId, { continueOnBackendRejection: hasMultiMasterCraft });
    if (!applied && hasMultiMasterCraft) {
      addStepLog(`${equipment.name} 多大师智能工艺请求未成功，已忽略并继续。`);
      return true;
    }
    addStepLog(`${equipment.name} 智能工艺已执行。`);
    return true;
  };

  /**
   * formatCurrencyUsageSummary 把当前任务的通货消耗统计格式化为短文本。
   * @returns {string} 通货消耗摘要。
   */
  const formatCurrencyUsageSummary = () => Object.entries(state.currencyUsage.byName)
    .sort((left, right) => right[1] - left[1])
    .map(([currencyName, count]) => `${currencyName}x${count}`)
    .join('，');

  const formatStepExecutionSummary = () => Object.entries(state.currencyUsage.stepCounts || {})
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([stepName, count]) => `${stepName}${count}次`)
    .join('，');

  const formatCompactProgressSummary = () => {
    const currencyLine = [
      `本任务已消耗 ${state.currencyUsage.total} 个`,
      formatCurrencyUsageSummary(),
    ].filter(Boolean).join('。');
    const stepSummary = formatStepExecutionSummary();
    return [
      currencyLine,
      stepSummary ? `步骤执行：${stepSummary}` : '',
    ].filter(Boolean).join('\n');
  };

  /**
   * resetCurrencyUsage 清空当前任务通货消耗统计。
   */
  const resetCurrencyUsage = () => {
    state.currencyUsage = { total: 0, byName: {}, stepCounts: {} };
  };

  const recordStepExecution = (stepName, count = 1) => {
    const normalizedStepName = String(stepName || '未知步骤');
    if (isCustomCraftTask() && !/^步骤[A-Z]/.test(normalizedStepName)) return;
    state.currencyUsage.stepCounts[normalizedStepName] = (state.currencyUsage.stepCounts[normalizedStepName] || 0) + count;
  };

  const recordContinuousStepExecution = (stepIndex, actionLabel) => {
    recordStepExecution(`步骤${formatContinuousStepCode(stepIndex)} ${actionLabel}`);
  };

  /**
   * isCustomCraftTask 判断当前任务是否是自定义打造，用于应用专属通货上限。
   * @returns {boolean} 当前任务是自定义打造时返回 true。
   */
  const isCustomCraftTask = () => ['连续打造', '自定义打造'].includes(state.currentTaskName);

  const TIMED_CRAFT_TASK_NAMES = new Set(['连续批量', '自定义打造', '混沌筛选', '改造增幅', '自动暗金']);
  const COUNTED_CRAFT_TASK_NAMES = new Set(['自定义打造', '混沌筛选', '改造增幅', '自动暗金']);

  const shouldLogCraftTaskElapsed = (taskName = state.currentTaskName) => TIMED_CRAFT_TASK_NAMES.has(taskName);

  const formatElapsedDuration = (elapsedMs) => {
    const totalSeconds = Math.max(0, Math.floor(Number(elapsedMs || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}时${minutes}分${seconds}秒`;
    if (minutes) return `${minutes}分${seconds}秒`;
    return `${seconds}秒`;
  };

  const logCraftTaskElapsed = (prefix = '任务耗时', level = 'compact', taskName = state.currentTaskName) => {
    if (!shouldLogCraftTaskElapsed(taskName) || !state.currentTaskStartedAt) return;
    addLog(`${prefix}：${formatElapsedDuration(Date.now() - state.currentTaskStartedAt)}。`, level);
  };

  const logCountedCraftTaskSummary = (prefix = '最终汇总', level = 'success', taskName = state.currentTaskName) => {
    if (!COUNTED_CRAFT_TASK_NAMES.has(taskName)) return;
    if (!state.currentTaskStartedAt) return;
    const targetText = state.currentTaskTargetCount ? `/${state.currentTaskTargetCount}` : '';
    addLog(`${taskName}${prefix}：命中${state.completedCount}${targetText}件。`, level);
  };

  const formatCustomCraftCurrencyLimitMessage = () => `自定义打造已达到总通货消耗上限 ${state.customCraftCurrencyLimit} 个，已自动停止。${formatCurrencyUsageSummary()}`;

  const assertCustomCraftCurrencyLimitAfterUsage = () => {
    if (isCustomCraftTask() && state.currencyUsage.total >= state.customCraftCurrencyLimit) {
      if (state.isRunning) stopCurrentTask();
      throw new Error(formatCustomCraftCurrencyLimitMessage());
    }
  };

  /**
   * recordCurrencyUsage 记录一次成功通货消耗，并在每 200 个时自动写入进度日志。
   * @param {number} modifyType 改造编号。
   * @param {number} count 本次消耗数量。
   */
  const recordCurrencyUsage = (modifyType, count = 1, options = {}) => {
    const currencyName = options.currencyName || getModifyTypeLabel(modifyType);
    state.currencyUsage.total += count;
    state.currencyUsage.byName[currencyName] = (state.currencyUsage.byName[currencyName] || 0) + count;
    if (state.currencyUsage.total % CURRENCY_USAGE_REPORT_INTERVAL === 0) {
      addLog(`通货消耗进度：${formatCompactProgressSummary()}`, 'compact');
    }
    if (!options.deferLimitCheck) assertCustomCraftCurrencyLimitAfterUsage();
  };

  const recordCurrencyUsageBatch = (cost) => {
    for (const [currencyId, amount] of Object.entries(cost || {})) {
      recordCurrencyUsage(Number(currencyId), Number(amount || 0), {
        deferLimitCheck: true,
        currencyName: getCurrencyNameById(currencyId),
      });
    }
    assertCustomCraftCurrencyLimitAfterUsage();
  };

  /**
   * logCurrencyUsageSummary 在任务结束或失败时输出通货消耗汇总。
   * @param {string} prefix 日志前缀。
   * @param {string} level 日志级别。
   */
  const logCurrencyUsageSummary = (prefix = '任务通货统计', level = 'info') => {
    if (!state.currencyUsage.total) return;
    addLog(`${prefix}：${formatCompactProgressSummary()}`, 'compact');
  };

  /**
   * modifyEquipment 调用装备改造接口，并统一统计成功消耗的装备通货。
   * @param {string} equipmentId 装备 ID。
   * @param {number} modifyType 通货类型编号。
   * @returns {Promise<object>} 后端返回的装备改造结果。
   */
  const modifyEquipment = async (equipmentId, modifyType) => {
    const payload = await requestJson(config.endpoints.equipmentModify, {
      method: 'POST',
      body: { equipmentId, type: modifyType },
    });
    if (payload.success !== false) {
      recordCurrencyUsage(modifyType);
      if (state.refreshEquipmentAfterCraft) {
        try {
          const freshEquipment = await fetchEquipmentDetail(equipmentId);
          if (freshEquipment) {
            payload.data = {
              ...(payload.data || {}),
              equipment: freshEquipment,
            };
          }
        } catch (error) {
          addLog(`重新查询装备信息失败，暂用通货返回结果：${error.message}`, 'warn');
        }
      }
    }
    return payload;
  };

  /**
   * destroyEquipment 丢弃指定装备。
   * @param {string} equipmentId 装备 ID。
   * @returns {Promise<object>} 后端返回的丢弃结果。
   */
  const destroyEquipment = (equipmentId) => requestJson(config.endpoints.equipmentDestroy, {
    method: 'POST',
    body: { equipmentId },
  });

  /**
   * destroyEquipmentBatch 调用测试服前端“丢弃当前页所有装备”使用的批量丢弃接口。
   * @param {Array<string>} equipmentIds 当前页需要丢弃的装备 ID 列表。
   * @returns {Promise<object>} 后端返回的批量丢弃结果。
   */
  const destroyEquipmentBatch = (equipmentIds) => requestJson(config.endpoints.equipmentDestroyBatch, {
    method: 'POST',
    body: { equipmentIds },
  });

  /**
   * storageEquipment 把指定装备存入储藏。
   * 该接口来自测试服前端：POST /equipment/storage，body 为 { equipmentId }。
   * @param {string} equipmentId 装备 ID。
   * @returns {Promise<object>} 后端返回的存储结果。
   */
  const storageEquipment = (equipmentId) => requestJson(config.endpoints.equipmentStorage, {
    method: 'POST',
    body: { equipmentId },
  });

  /**
   * insertSkillStoneToEquipment 把技能石镶嵌到指定装备孔位。
   * @param {string} equipmentId 装备 ID。
   * @param {string|number} socketId 孔位 ID。
   * @param {string} stoneId 技能石 ID。
   * @returns {Promise<object>} 后端返回的镶嵌结果。
   */
  const insertSkillStoneToEquipment = (equipmentId, socketId, stoneId) => requestJson(config.endpoints.equipmentInsertStone, {
    method: 'POST',
    body: { equipmentId, socketId, stoneId },
  });

  /**
   * removeSkillStoneFromEquipment 从指定装备孔位取下技能石。
   * @param {string} equipmentId 装备 ID。
   * @param {string|number} socketId 孔位 ID。
   * @returns {Promise<object>} 后端返回的取下结果。
   */
  const removeSkillStoneFromEquipment = (equipmentId, socketId) => requestJson(config.endpoints.equipmentRemoveStone, {
    method: 'POST',
    body: { equipmentId, socketId },
  });

  /**
   * setSkillStoneEnabled 切换技能石启用状态；智能练技能会在镶嵌主动技能后关闭它。
   * @param {string} stoneId 技能石 ID。
   * @param {boolean} enabled 是否启用。
   * @returns {Promise<object>} 后端返回的启用状态切换结果。
   */
  const setSkillStoneEnabled = (stoneId, enabled) => requestJson(config.endpoints.skillStoneEnable, {
    method: 'POST',
    body: { stoneId, enable: Boolean(enabled) },
  });

  /**
   * modifySkillStone 调用技能石改造接口。
   * @param {string} stoneId 技能石 ID。
   * @param {number} modifyType 技能石改造类型编号。
   * @returns {Promise<object>} 后端返回的技能石改造结果。
   */
  const modifySkillStone = async (stoneId, modifyType) => {
    const payload = await requestJson(config.endpoints.skillStoneModify, {
      method: 'POST',
      body: { stoneId, type: modifyType },
    });
    if (payload.success !== false) recordCurrencyUsage(modifyType);
    return payload;
  };

  /**
   * upgradeSkillStone 调用技能石升级接口。
   * 该接口来自赚钱脚本验证过的 /skillstone/upgrade，用于消耗已满的技能石经验提升等级。
   * @param {string} stoneId 技能石 ID。
   * @returns {Promise<object>} 后端返回的技能石升级结果。
   */
  const upgradeSkillStone = (stoneId) => requestJson(config.endpoints.skillStoneUpgrade, {
    method: 'POST',
    body: { stoneId },
  });

  /**
   * destroySkillStones 调用技能石丢弃接口。
   * @param {Array<string>} stoneIds 需要丢弃的技能石 ID 列表。
   * @returns {Promise<object>} 后端返回的丢弃结果。
   */
  const destroySkillStones = (stoneIds) => requestJson(config.endpoints.skillStoneDestroy, {
    method: 'POST',
    body: { stoneIds },
  });

  /**
   * fetchSkillStoneDetail 读取单颗技能石详情，主要用于补全装备镶嵌技能石名称和品质。
   * @param {string} stoneId 技能石 ID。
   * @returns {Promise<object|null>} 技能石详情；读取失败时返回 null。
   */
  const fetchSkillStoneDetail = async (stoneId) => {
    if (!stoneId) return null;
    let lastError = null;
    for (let attemptIndex = 1; attemptIndex <= 2; attemptIndex += 1) {
      try {
        const payload = await requestJson(`${config.endpoints.skillStoneDetail}/${stoneId}`);
        if (payload.success === false) throw new Error(payload.message || '技能石详情读取失败');
        return payload.data?.stone || payload.data?.skillStone || payload.data || null;
      } catch (error) {
        lastError = error;
        if (attemptIndex < 2) {
          addLog(`技能石详情读取失败，准备重试 1 次：${stoneId}，${error.message}`, 'detail');
          continue;
        }
      }
    }
    addLog(`技能石详情读取失败：${stoneId}，已重试 1 次，${lastError?.message || lastError}`, 'warn');
    return null;
  };

  /**
   * fetchSkillStonePage 读取背包技能石分页。
   * @param {number} page 页码，从 1 开始。
   * @returns {Promise<object>} 标准化分页结果。
   */
  const fetchSkillStonePage = async (page) => {
    const payload = await requestJson(`${config.endpoints.skillStones}/${page}`);
    if (payload.success === false) {
      throw new Error(payload.message || `技能石第 ${page} 页读取失败`);
    }
    const data = payload.data || {};
    return {
      items: Array.isArray(data.items) ? data.items : [],
      total: Number(data.total || 0),
    };
  };

  /**
   * enrichSkillStoneWithDetail 单独读取技能石详情并和基础数据合并。
   * 背包分页接口有时不会返回 corrupted 等关键字段，因此列表中的每颗技能石都要再读一次详情。
   * @param {object} stone 基础技能石数据。
   * @param {object} sourceMeta 来源信息。
   * @returns {Promise<object>} 标准化后的技能石。
   */
  const enrichSkillStoneWithDetail = async (stone, sourceMeta) => {
    const baseStone = normalizeSkillStone({ ...stone, ...sourceMeta });
    if (!baseStone.id) return baseStone;
    const detail = await fetchSkillStoneDetail(baseStone.id);
    return normalizeSkillStone({ ...baseStone, ...(detail || {}), ...sourceMeta });
  };

  /**
   * fetchAllBackpackSkillStones 读取当前背包里的全部技能石。
   * 该接口默认一页 30 条，分页读取时单页失败会记录并继续，尽量不让局部失败破坏整次刷新。
   * 分页拿到列表后会再逐颗读取详情，确保腐化状态等字段准确。
   * @returns {Promise<Array<object>>} 标准化后的技能石列表。
   */
  const fetchAllBackpackSkillStones = async () => {
    const firstPage = await fetchSkillStonePage(1);
    const pageSize = Math.max(firstPage.items.length, 30);
    const totalPages = Math.max(1, Math.ceil(firstPage.total / pageSize));
    const stoneList = [...firstPage.items];
    for (let page = 2; page <= totalPages; page += 1) {
      if (!state.isRunning && state.currentTaskName === '加载技能石') break;
      try {
        const pageResult = await fetchSkillStonePage(page);
        stoneList.push(...pageResult.items);
      } catch (error) {
        addLog(`技能石第 ${page} 页读取失败：${error.message}`, 'warn');
      }
    }
    let loadedDetailCount = 0;
    const normalizedStones = await runConcurrentTasks(stoneList, SKILL_STONE_DETAIL_CONCURRENCY, async (stone) => {
      if (!state.isRunning && state.currentTaskName === '加载技能石') return null;
      const normalizedStone = await enrichSkillStoneWithDetail(stone, {
        source: 'backpack',
        sourceLabel: '背包',
      });
      loadedDetailCount += 1;
      if (loadedDetailCount % 10 === 0 || loadedDetailCount === stoneList.length) {
        addLog(`背包技能石详情读取进度：${loadedDetailCount}/${stoneList.length}，并发 ${SKILL_STONE_DETAIL_CONCURRENCY} 个。`, 'info');
      }
      return normalizedStone;
    });
    return normalizedStones.filter((stone) => stone?.id);
  };

  /**
   * fetchEquippedSkillStones 从角色装备槽里读取所有已镶嵌技能石。
   * 装备槽只稳定暴露 stoneId 和 socket 信息，因此会尽量再读取详情；详情失败时保留可操作的 ID。
   * @returns {Promise<Array<object>>} 标准化后的装备镶嵌技能石列表。
   */
  const fetchEquippedSkillStones = async () => {
    const payload = await requestJson(config.endpoints.character);
    if (payload.success === false) {
      throw new Error(payload.message || '角色装备读取失败');
    }
    const characterData = payload.data || payload;
    const equipmentEntries = getCharacterEquipmentEntries(characterData);
    const enabledStoneIds = getEnabledSkillStoneIdsFromCharacter(characterData);
    const playerEpm = Number(characterData.epm || 0);
    const socketRecords = [];
    const excludedSummary = { active: 0, special: 0 };
    const excludedEmptySockets = { active: [], special: [] };
    const socketStones = [];
    let invalidPracticeSocketCount = 0;
    for (const entry of equipmentEntries) {
      const equipment = entry.equipment;
      const equipmentId = getObjectId(equipment);
      const equipmentName = getEquipmentDisplayName(equipment) || entry.slotLabel;
      if (!equipmentId) continue;
      const excludedBySpecialEquipment = isSpecialSocketEquipment(equipment);
      for (const socketGroup of getSocketGroups(equipment)) {
        const sockets = Array.isArray(socketGroup) ? socketGroup : [socketGroup];
        const excludedByActiveSkill = sockets.some((socket) => {
          const stoneId = getSocketStoneId(socket);
          return stoneId && enabledStoneIds.has(stoneId);
        });
        if (excludedBySpecialEquipment) {
          excludedSummary.special += sockets.length;
        } else if (excludedByActiveSkill) {
          excludedSummary.active += sockets.length;
        }
        for (const socket of sockets) {
          const socketId = getSocketId(socket);
          const stoneId = getSocketStoneId(socket);
          const socketStone = getSocketStone(socket);
          const socketStoneEnabled = stoneId && enabledStoneIds.has(stoneId);
          if (!stoneId && socketId !== '') {
            const emptySocketRecord = {
              equipmentId,
              equipmentName,
              slotLabel: entry.slotLabel,
              socketId,
              socketType: socket?.type ?? socket?.socketType ?? '',
            };
            if (excludedBySpecialEquipment) excludedEmptySockets.special.push(emptySocketRecord);
            else if (excludedByActiveSkill) excludedEmptySockets.active.push(emptySocketRecord);
          }
          if (
            !excludedBySpecialEquipment
            && !excludedByActiveSkill
          ) {
            if (socketId === '') {
              invalidPracticeSocketCount += 1;
              continue;
            }
            const socketType = socket?.type ?? socket?.socketType ?? '';
            if (socketType === '' || socketType === null || socketType === undefined) {
              invalidPracticeSocketCount += 1;
              continue;
            }
            socketRecords.push({
              equipmentId,
              equipmentName,
              slotLabel: entry.slotLabel,
              socketId,
              socketType,
              stoneId,
              canInsert: !excludedByActiveSkill,
            });
          }
          if (!stoneId) continue;
          socketStones.push({
            ...socketStone,
            stoneId,
            id: stoneId,
            enabled: Boolean(socketStoneEnabled),
            source: 'equipment',
            sourceLabel: `装备：${equipmentName}`,
            slotLabel: entry.slotLabel,
            equipmentId,
            equipmentName,
            socketId,
            socketType: socket?.type ?? socket?.socketType ?? '',
            category: socket?.type ?? socket?.socketType,
          });
        }
      }
    }
    state.practiceSkillStoneCache = {
      loaded: true,
      socketRecords,
      playerEpm,
      excludedSummary,
      excludedEmptySockets,
    };
    if (invalidPracticeSocketCount) {
      addLog(`智能练技能跳过 ${invalidPracticeSocketCount} 个孔位：接口没有返回孔位颜色，无法安全判断可镶嵌宝石。`, 'warn');
    }
    let loadedEquipmentDetailCount = 0;
    const normalizedStones = await runConcurrentTasks(socketStones, SKILL_STONE_DETAIL_CONCURRENCY, async (socketStone) => {
      const normalizedStone = await enrichSkillStoneWithDetail(socketStone, {
        source: 'equipment',
        sourceLabel: socketStone.sourceLabel,
        slotLabel: socketStone.slotLabel,
        equipmentId: socketStone.equipmentId,
        equipmentName: socketStone.equipmentName,
        socketId: socketStone.socketId,
        socketType: socketStone.socketType,
      });
      loadedEquipmentDetailCount += 1;
      if (loadedEquipmentDetailCount % 10 === 0 || loadedEquipmentDetailCount === socketStones.length) {
        addLog(`装备技能石详情读取进度：${loadedEquipmentDetailCount}/${socketStones.length}，并发 ${SKILL_STONE_DETAIL_CONCURRENCY} 个。`, 'info');
      }
      return normalizedStone;
    });
    return normalizedStones.filter((stone) => stone?.id);
  };

  /**
   * fetchAllSkillStones 合并背包和装备镶嵌技能石，并按 ID 去重。
   * @returns {Promise<Array<object>>} 当前角色可见的全部技能石。
   */
  const fetchAllSkillStones = async () => {
    state.practiceSkillStoneCache = {
      loaded: false,
      socketRecords: [],
      playerEpm: 0,
      excludedSummary: { active: 0, special: 0 },
      excludedEmptySockets: { active: [], special: [] },
    };
    const [backpackResult, equippedResult] = await Promise.allSettled([
      fetchAllBackpackSkillStones(),
      fetchEquippedSkillStones(),
    ]);
    const backpackStones = backpackResult.status === 'fulfilled' ? backpackResult.value : [];
    const equippedStones = equippedResult.status === 'fulfilled' ? equippedResult.value : [];
    if (backpackResult.status === 'rejected') {
      addLog(`背包技能石读取失败：${backpackResult.reason?.message || backpackResult.reason}`, 'error');
    }
    if (equippedResult.status === 'rejected') {
      addLog(`装备技能石读取失败：${equippedResult.reason?.message || equippedResult.reason}`, 'error');
    }
    const stoneById = new Map();
    for (const stone of [...backpackStones, ...equippedStones]) {
      if (!stone.id || stoneById.has(stone.id)) continue;
      stoneById.set(stone.id, stone);
    }
    return Array.from(stoneById.values());
  };

  /**
   * normalizeSkillStone 把赚钱脚本里观察到的技能石字段整理成稳定结构。
   * @param {object} stone 接口返回的技能石对象。
   * @returns {object} 标准化技能石对象。
   */
  const normalizeSkillStone = (stone) => ({
    id: stone.stoneId || stone.id || '',
    name: stone.name || '未知技能石',
    level: Number(stone.level || 0),
    quality: Number(stone.quality || 0),
    exp: Number(stone.exp || 0),
    levelUpExp: Number(stone.levelUpExp || 0),
    category: stone.category ?? stone.socketType,
    corrupted: Boolean(stone.corrupted || stone.isCorrupted || stone.vaaled || stone.isVaaled),
    skillId: stone.skillId || '',
    tags: Array.isArray(stone.tags) ? stone.tags : [],
    isSupport: stone.isSupport,
    support: stone.support,
    isActive: stone.isActive,
    active: stone.active,
    enabled: stone.enabled,
    type: stone.type,
    skillType: stone.skillType,
    gemType: stone.gemType,
    kind: stone.kind,
    source: stone.source || 'backpack',
    sourceLabel: stone.sourceLabel || (stone.source === 'equipment' ? '装备' : '背包'),
    slotLabel: stone.slotLabel || '',
    equipmentId: stone.equipmentId || '',
    equipmentName: stone.equipmentName || '',
    socketId: stone.socketId || '',
    socketType: stone.socketType || '',
    hasPracticeProgressData: typeof stone.hasPracticeProgressData === 'boolean'
      ? stone.hasPracticeProgressData
      : stone.level !== undefined && stone.levelUpExp !== undefined,
    hasCategoryData: typeof stone.hasCategoryData === 'boolean'
      ? stone.hasCategoryData
      : stone.category !== undefined || stone.socketType !== undefined,
  });

  /**
   * formatSkillStoneLabel 生成技能石多选列表中的显示文本。
   * @param {object} stone 标准化技能石对象。
   * @returns {string} 可读的技能石标签。
   */
  const formatSkillStoneLabel = (stone) => {
    const corruptedText = stone.corrupted ? ' 已腐化' : '';
    const sourceText = stone.source === 'equipment'
      ? (stone.slotLabel || stone.sourceLabel || '装备')
      : (stone.sourceLabel || '背包');
    return `[${sourceText}] ${stone.name} | Lv.${stone.level || '?'} | 品质 ${stone.quality || 0}%${corruptedText}`;
  };

  /**
   * fetchBackpackPage 按关键词、稀有度和页码读取背包或储藏装备。
   * @param {object} query 查询条件。
   * @param {string} query.keyword 装备名称关键词。
   * @param {number|string} query.rarity 装备稀有度；空字符串表示不限稀有度。
   * @param {number} query.page 页码。
   * @param {boolean} query.useStorage 是否读取储藏；未传时沿用当前全局设置。
   * @param {boolean} query.excludeCorrupted 是否在本地过滤腐化装备。
   * @param {Array<number>} query.excludeRarities 需要在本地排除的装备稀有度。
   * @returns {Promise<object>} 标准化后的分页结果。
   */
  const fetchBackpackPage = async ({
    keyword,
    rarity,
    page,
    useStorage = state.useStorage,
    excludeCorrupted = false,
    excludeRarities = [],
  }) => {
    const searchParams = new URLSearchParams({
      keyword: keyword || '',
      pageSize: String(config.pageSize),
      _: String(Date.now()),
    });
    if (rarity !== RARITY_TYPES.any && rarity !== '' && rarity !== undefined && rarity !== null) {
      searchParams.set('rarity', String(rarity));
    }
    if (useStorage) searchParams.set('storage', 'true');
    const url = `${config.endpoints.backpack}/${page}?${searchParams.toString()}`;
    const payload = await requestJson(url);
    const data = payload.data || {};
    const items = Array.isArray(data.items) ? data.items : [];
    return {
      items: items.filter((item) => (
        item?.id &&
        !state.processedEquipmentIds.has(item.id) &&
        (!excludeCorrupted || !isEquipmentCorrupted(item)) &&
        !excludeRarities.includes(Number(item.rarity || RARITY_TYPES.normal))
      )),
      hasMore: page * config.pageSize < Number(data.total || 0),
    };
  };

  /**
   * fetchFracturedEquipmentPage 读取背包中破裂装备分页。
   * @param {number} page 页码，从 1 开始。
   * @returns {Promise<object>} 标准化分页结果。
   */
  const fetchFracturedEquipmentPage = async (page) => {
    const searchParams = new URLSearchParams({
      storage: 'false',
      isFractured: 'true',
      pageSize: String(config.pageSize),
      _: String(Date.now()),
    });
    const payload = await requestJson(`${config.endpoints.backpack}/${page}?${searchParams.toString()}`);
    if (payload.success === false) {
      throw new Error(payload.message || `破裂装备第 ${page} 页读取失败`);
    }
    const data = payload.data || {};
    return {
      items: Array.isArray(data.items) ? data.items : [],
      total: Number(data.total || 0),
    };
  };

  /**
   * fetchAllFracturedEquipments 读取当前背包中的全部破裂装备。
   * 单页失败会记录警告并继续扫描后续页，避免一个临时错误影响整个列表。
   * @returns {Promise<Array<object>>} 标准化后的破裂装备列表。
   */
  const fetchAllFracturedEquipments = async () => {
    const firstPage = await fetchFracturedEquipmentPage(1);
    const pageSize = Math.max(firstPage.items.length, config.pageSize);
    const totalPages = Math.max(1, Math.ceil(firstPage.total / pageSize));
    const equipmentList = [...firstPage.items];
    for (let page = 2; page <= totalPages; page += 1) {
      try {
        const pageResult = await fetchFracturedEquipmentPage(page);
        equipmentList.push(...pageResult.items);
      } catch (error) {
        addLog(`破裂装备第 ${page} 页读取失败：${error.message}`, 'warn');
      }
    }
    return equipmentList.map(normalizeEquipment).filter((equipment) => equipment.id);
  };

  /**
   * getNextEquipment 扫描分页并返回下一件未处理装备。
   * @param {object} query 查询条件。
   * @param {string} query.keyword 装备名称关键词。
   * @param {number|string} query.rarity 装备稀有度。
   * @returns {Promise<object|null>} 找到的装备；找不到时返回 null。
   */
  const getNextEquipment = async (query) => {
    let scannedPages = 0;
    while (state.isRunning && scannedPages < config.maxPagesPerRound) {
      const pageResult = await fetchBackpackPage({ ...query, page: state.currentPage });
      const nextItem = pageResult.items[0] || null;
      if (nextItem) {
        state.processedEquipmentIds.add(nextItem.id);
        return normalizeEquipment(nextItem);
      }
      if (!pageResult.hasMore) {
        state.currentPage = 1;
        return null;
      }
      state.currentPage += 1;
      scannedPages += 1;
    }
    return null;
  };

  /**
   * getNextEquipmentBatch 扫描分页并一次锁定多件未处理装备。
   * 一页接口默认能返回 30 件；批量锁定时尽量复用同一次分页结果，避免逐件重复请求同一页。
   * @param {object} query 查询条件。
   * @param {number} limit 本次最多锁定几件。
   * @param {Function} onProgress 每完成一页锁定后的进度回调。
   * @returns {Promise<Array<object>>} 找到的装备列表。
   */
  const getNextEquipmentBatch = async (query, limit, onProgress) => {
    const equipments = [];
    let scannedPages = 0;
    const targetLimit = Math.max(1, Number(limit) || 1);
    while (state.isRunning && equipments.length < targetLimit && scannedPages < config.maxPagesPerRound) {
      const pageResult = await fetchBackpackPage({ ...query, page: state.currentPage });
      const remainingCount = targetLimit - equipments.length;
      const pageItems = pageResult.items.slice(0, remainingCount);
      if (pageItems.length) {
        for (const item of pageItems) {
          state.processedEquipmentIds.add(item.id);
          equipments.push(normalizeEquipment(item));
        }
        if (typeof onProgress === 'function') {
          onProgress(equipments.length);
        }
        if (pageItems.length < pageResult.items.length) {
          break;
        }
      }
      if (!pageResult.hasMore) {
        state.currentPage = 1;
        break;
      }
      state.currentPage += 1;
      scannedPages += 1;
    }
    return equipments;
  };

  /**
   * isEquipmentCorrupted 兼容不同接口字段，判断装备是否已腐化。
   * 腐化装备不能继续被工匠、链接、幻色等通货稳定改造，因此打造流程会直接跳过。
   * @param {object} equipment 装备对象。
   * @returns {boolean} 装备已腐化时返回 true。
   */
  const isEquipmentCorrupted = (equipment) => Boolean(
    equipment?.corrupted ||
    equipment?.isCorrupted ||
    equipment?.vaaled ||
    equipment?.isVaaled,
  );

  const getEquipmentFixedMagics = (equipment) => {
    const fixedMagics = equipment?.fixedMagics || equipment?.raw?.fixedMagics;
    return fixedMagics && typeof fixedMagics === 'object' ? fixedMagics : null;
  };

  const sortObjectForSignature = (value) => {
    if (Array.isArray(value)) return value.map(sortObjectForSignature);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
      .reduce((result, key) => {
        result[key] = sortObjectForSignature(value[key]);
        return result;
      }, {});
  };

  const getFixedMagicsSignature = (equipment) => {
    const fixedMagics = getEquipmentFixedMagics(equipment);
    if (!fixedMagics || !Object.keys(fixedMagics).length) return '';
    return JSON.stringify(sortObjectForSignature(fixedMagics));
  };

  const getCorruptedAffixes = (equipment) => {
    const affixes = Array.isArray(equipment?.affixes)
      ? equipment.affixes
      : (Array.isArray(equipment?.raw?.affixes) ? equipment.raw.affixes : []);
    return affixes.filter((affix) => Number(affix?.type) === 8);
  };

  const getCorruptedBaseSignature = (equipment) => JSON.stringify(
    getCorruptedAffixes(equipment)
      .map((affix) => sortObjectForSignature(affix))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'zh-Hans-CN')),
  );

  const hasCorruptedBaseChange = (beforeSignature, equipment, options = {}) => Boolean(
    options.wasUniqueBeforeVaal &&
    isEquipmentCorrupted(equipment) &&
    Number(equipment?.rarity) === RARITY_TYPES.unique &&
    getCorruptedAffixes(equipment).length > 0 &&
    getCorruptedBaseSignature(equipment) !== beforeSignature,
  );

  /**
   * normalizeEquipment 把接口装备数据整理成脚本内部稳定使用的结构。
   * @param {object} equipment 接口返回的装备对象。
   * @returns {object} 标准化装备对象。
   */
  const normalizeDamageRange = (damageRange) => {
    if (!damageRange || typeof damageRange !== 'object') return undefined;
    const min = Number(damageRange.min);
    const max = Number(damageRange.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
    return { ...damageRange, min, max };
  };

  const normalizeDamageMap = (damageMap) => {
    if (!damageMap || typeof damageMap !== 'object') return undefined;
    const normalizedMap = {};
    for (const [damageType, damageRange] of Object.entries(damageMap)) {
      const normalizedRange = normalizeDamageRange(damageRange);
      if (normalizedRange) normalizedMap[damageType] = normalizedRange;
    }
    return Object.keys(normalizedMap).length ? normalizedMap : undefined;
  };

  const normalizeEquipment = (equipment) => ({
    id: equipment.id,
    name: equipment.name || equipment.originalName || '未知装备',
    baseName: equipment.baseName || '',
    itemLevel: Number(equipment.itemLevel || 0),
    equipmentType: equipment.equipmentType,
    rarity: Number(equipment.rarity || RARITY_TYPES.normal),
    physicalDamage: normalizeDamageRange(equipment.physicalDamage),
    damages: normalizeDamageMap(equipment.damages),
    affixes: Array.isArray(equipment.affixes) ? equipment.affixes : [],
    fixedMagics: equipment.fixedMagics && typeof equipment.fixedMagics === 'object' ? equipment.fixedMagics : undefined,
    corruptedMagics: equipment.corruptedMagics && typeof equipment.corruptedMagics === 'object' ? equipment.corruptedMagics : undefined,
    sockets: Array.isArray(equipment.sockets) ? equipment.sockets : [],
    quality: Number.isFinite(Number(equipment.quality)) ? Number(equipment.quality) : undefined,
    qualityBonus: Number.isFinite(Number(equipment.qualityBonus)) ? Number(equipment.qualityBonus) : undefined,
    catalystType: Number.isFinite(Number(equipment.catalystType)) ? Number(equipment.catalystType) : undefined,
    corrupted: isEquipmentCorrupted(equipment),
    isFractured: Boolean(equipment.isFractured || equipment.fractured),
    raw: equipment,
  });

  /**
   * mergeEquipmentUpdate 用接口返回的新装备更新当前装备引用。
   * @param {object} currentEquipment 当前装备对象。
   * @param {object} nextEquipment 接口返回的新装备对象。
   * @returns {object} 更新后的装备对象。
   */
  const mergeEquipmentUpdate = (currentEquipment, nextEquipment) => {
    const mergedEquipment = { ...currentEquipment, ...(nextEquipment || {}) };
    if (!mergedEquipment.id && currentEquipment?.id) mergedEquipment.id = currentEquipment.id;
    const normalizedEquipment = normalizeEquipment(mergedEquipment);
    Object.assign(currentEquipment, normalizedEquipment);
    state.processedEquipmentIds.add(currentEquipment.id);
    return currentEquipment;
  };

  /**
   * getAffixNames 提取装备词缀名称，过滤空值。
   * @param {Array<object>} affixes 装备词缀数组。
   * @returns {Array<string>} 词缀名称数组。
   */
  const getAffixNames = (affixes) => (Array.isArray(affixes) ? affixes : [])
    .map((affix) => String(affix?.name || '').trim())
    .filter(Boolean);

  /**
   * isFracturedAffix 尽量兼容不同接口字段，判断词缀是否为破裂锁定词缀。
   * 当前游戏前端把破裂词缀渲染为 locked，因此 isLocked 是主要判断条件。
   * @param {object} affix 装备词缀对象。
   * @returns {boolean} 是破裂词缀时返回 true。
   */
  const isFracturedAffix = (affix) => Boolean(
    affix?.isLocked ||
    affix?.fractured ||
    affix?.isFractured ||
    affix?.locked,
  );

  /**
   * getFracturedAffixes 提取装备上的破裂词缀。
   * 如果接口只返回破裂装备但没有标记具体词缀，则返回空数组，由 UI 给出“未返回明细”的提示。
   * @param {object} equipment 装备对象。
   * @returns {Array<object>} 破裂词缀数组。
   */
  const getFracturedAffixes = (equipment) => (Array.isArray(equipment.affixes) ? equipment.affixes : [])
    .filter(isFracturedAffix);

  /**
   * formatAffixPositionName 把词缀位置编号转换为可读文本。
   * @param {number|string} affixType 词缀类型编号。
   * @returns {string} 可读位置文本。
   */
  const formatAffixPositionName = (affixType) => {
    const normalizedType = Number(affixType);
    if (normalizedType === 1) return '前缀';
    if (normalizedType === 2) return '后缀';
    if (normalizedType === 8) return '腐化';
    if (normalizedType === 16) return '附魔';
    return '词缀';
  };

  /**
   * getAffixTierNumber 读取词缀阶级编号。
   * 测试服接口字段可能叫 tier、level 或 affixLevel，因此这里统一做兼容转换。
   * @param {object} affix 词缀对象。
   * @returns {number} 阶级编号；无法判断时返回 0。
   */
  const getAffixTierNumber = (affix) => {
    const rawTier = affix?.tier ?? affix?.level ?? affix?.affixLevel ?? affix?.modLevel ?? affix?.rank;
    const tierNumber = Number.parseInt(String(rawTier || '').replace(/^T/i, ''), 10);
    return Number.isFinite(tierNumber) ? tierNumber : 0;
  };

  /**
   * findKnownAffixEffectText 在本地词缀表中按词缀名反查效果文本。
   * 破裂装备接口有时只返回 name/tier，不返回 value；此时用做装词缀表补足展示信息。
   * @param {object} affix 词缀对象。
   * @returns {string} 本地词缀表中的效果文本，找不到时返回空字符串。
   */
  const findKnownAffixEffectText = (affix) => {
    const affixName = String(affix?.name || affix?.affixName || '').trim();
    if (!affixName) return '';
    const tierNumber = getAffixTierNumber(affix);
    const exactTierValues = [];
    const sameNameValues = [];
    for (const tierList of Object.values(AFFIX_LEVEL_DATA || {})) {
      if (!Array.isArray(tierList)) continue;
      for (const tier of tierList) {
        if (String(tier?.name || '').trim() !== affixName) continue;
        const effectValue = String(tier?.value || '').trim();
        if (!effectValue) continue;
        sameNameValues.push(effectValue);
        if (tierNumber && Number(tier?.level || 0) === tierNumber) {
          exactTierValues.push(effectValue);
        }
      }
    }
    const values = exactTierValues.length ? exactTierValues : sameNameValues;
    return [...new Set(values)].slice(0, 3).join('；');
  };

  /**
   * getAffixEffectText 读取词缀效果文本。
   * 不同接口版本可能把效果放在 value、effect、desc 或 description 中，统一兜底展示。
   * @param {object} affix 词缀对象。
   * @returns {string} 词缀效果文本。
   */
  const getAffixEffectText = (affix) => {
    const candidateValues = [
      affix?.value,
      affix?.effect,
      affix?.effectText,
      affix?.text,
      affix?.desc,
      affix?.description,
      affix?.displayText,
      affix?.statText,
      affix?.modText,
      affix?.modifierText,
      affix?.implicitText,
      affix?.explicitText,
      affix?.mod?.value,
      affix?.mod?.text,
      affix?.mod?.description,
    ];
    const arrayValues = [
      affix?.values,
      affix?.effects,
      affix?.stats,
      affix?.descriptions,
      affix?.lines,
      affix?.mods,
    ];
    for (const value of candidateValues) {
      const cleanValue = String(value || '').trim();
      if (cleanValue) return cleanValue;
    }
    for (const valueList of arrayValues) {
      if (!Array.isArray(valueList)) continue;
      const cleanValues = valueList
        .map((value) => {
          if (value && typeof value === 'object') {
            return String(value.value || value.text || value.description || value.name || '').trim();
          }
          return String(value || '').trim();
        })
        .filter(Boolean);
      if (cleanValues.length) return cleanValues.join('；');
    }
    const nestedEffectValues = [];
    const visitNestedValue = (value, depth = 0) => {
      if (!value || depth > 2 || nestedEffectValues.length >= 4) return;
      if (Array.isArray(value)) {
        value.forEach((item) => visitNestedValue(item, depth + 1));
        return;
      }
      if (typeof value !== 'object') return;
      for (const [key, nestedValue] of Object.entries(value)) {
        if (/^(id|name|type|tier|level|rank)$/i.test(key)) continue;
        if (/(value|effect|desc|description|text|stat|modifier|mod)/i.test(key)) {
          if (nestedValue && typeof nestedValue === 'object') {
            visitNestedValue(nestedValue, depth + 1);
          } else {
            const cleanValue = String(nestedValue || '').trim();
            if (cleanValue) nestedEffectValues.push(cleanValue);
          }
        } else if (nestedValue && typeof nestedValue === 'object') {
          visitNestedValue(nestedValue, depth + 1);
        }
      }
    };
    visitNestedValue(affix);
    if (nestedEffectValues.length) return [...new Set(nestedEffectValues)].join('；');
    return findKnownAffixEffectText(affix);
  };

  const formatAffixActualNumber = (value) => {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return String(value ?? '');
    if (Number.isInteger(numberValue)) return String(numberValue);
    return numberValue.toFixed(2).replace(/\.?0+$/, '');
  };

  const getOrderedActualValuesForRanges = (ranges, actualValues) => {
    const epsilon = 1e-7;
    const tryValues = (values) => {
      const orderedValues = [];
      for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
        const actualValue = values[rangeIndex];
        if (!Number.isFinite(actualValue)) return null;
        const rawPercent = calculateRollPercent(actualValue, ranges[rangeIndex]);
        if (!isRollPercentInRange(rawPercent, epsilon)) return null;
        orderedValues.push(actualValue);
      }
      return orderedValues;
    };
    if (actualValues.length === ranges.length) {
      const directValues = tryValues(actualValues);
      if (directValues) return directValues;
    }
    const usedIndexes = new Set();
    const pickedValues = [];
    const search = (rangeIndex) => {
      if (rangeIndex >= ranges.length) return tryValues(pickedValues);
      for (let actualIndex = 0; actualIndex < actualValues.length; actualIndex += 1) {
        if (usedIndexes.has(actualIndex)) continue;
        const actualValue = actualValues[actualIndex];
        const rawPercent = calculateRollPercent(actualValue, ranges[rangeIndex]);
        if (!isRollPercentInRange(rawPercent, epsilon)) continue;
        usedIndexes.add(actualIndex);
        pickedValues[rangeIndex] = actualValue;
        const result = search(rangeIndex + 1);
        if (result) return result;
        pickedValues.pop();
        usedIndexes.delete(actualIndex);
      }
      return null;
    };
    return search(0);
  };

  const replaceAffixRangesWithActualValues = (effectText, actualValues) => {
    const ranges = parseAffixRollRangeSpecs(effectText);
    if (!ranges.length || !actualValues.length) return '';
    const orderedValues = getOrderedActualValuesForRanges(ranges, actualValues);
    if (!orderedValues) return '';
    let rangeIndex = 0;
    return String(effectText || '').replace(/\(\s*[+-]?\d+(?:\.\d+)?\s*[–-]\s*[+-]?\d+(?:\.\d+)?\s*\)/g, () => (
      formatAffixActualNumber(orderedValues[rangeIndex++])
    ));
  };

  const getKnownAffixEffectCandidatesForEquipment = (equipment, affix) => {
    const affixName = String(affix?.name || affix?.affixName || '').trim();
    if (!affixName) return [];
    const affixTypeNames = getAffixTypeNamesForEquipmentAffix(equipment, affix);
    if (!affixTypeNames.length) return [];
    const tierNumber = getAffixTierNumber(affix);
    const exactTierCandidates = [];
    const sameNameCandidates = [];
    for (const affixTypeName of affixTypeNames) {
      const tierList = AFFIX_LEVEL_DATA[affixTypeName];
      if (!Array.isArray(tierList)) continue;
      for (const tier of tierList) {
        if (String(tier?.name || '').trim() !== affixName) continue;
        const effectValue = String(tier?.value || '').trim();
        if (!effectValue) continue;
        const candidate = { affixTypeName, effectValue, ranges: parseAffixRollRangeSpecs(effectValue) };
        sameNameCandidates.push(candidate);
        if (tierNumber && Number(tier?.level || 0) === tierNumber) exactTierCandidates.push(candidate);
      }
    }
    return exactTierCandidates.length ? exactTierCandidates : sameNameCandidates;
  };

  const getFracturedAffixEffectText = (equipment, affix) => {
    const actualValues = flattenAffixMagicValues(affix);
    const candidates = getKnownAffixEffectCandidatesForEquipment(equipment, affix);
    for (const candidate of candidates) {
      const actualText = replaceAffixRangesWithActualValues(candidate.effectValue, actualValues);
      if (actualText) return actualText;
    }
    const knownEffectText = candidates[0]?.effectValue || '';
    if (knownEffectText) return knownEffectText;
    return getAffixEffectText(affix);
  };

  /**
   * isTierOneFracturedAffix 判断破裂词缀是否为 T1。
   * @param {object} affix 破裂词缀对象。
   * @returns {boolean} 是 T1 时返回 true。
   */
  const isTierOneFracturedAffix = (affix) => getAffixTierNumber(affix) === 1;

  /**
   * shouldDestroyAsNonTierOneFractured 判断装备是否属于“一键丢弃非 T1”的目标。
   * 没有返回破裂词缀明细时不自动丢弃，避免误删无法判断的装备。
   * @param {object} equipment 装备对象。
   * @returns {boolean} 可安全归入非 T1 破裂装备时返回 true。
   */
  const shouldDestroyAsNonTierOneFractured = (equipment) => {
    const fracturedAffixes = getFracturedAffixes(equipment);
    return fracturedAffixes.length > 0 && fracturedAffixes.every((affix) => !isTierOneFracturedAffix(affix));
  };

  /**
   * formatFracturedAffixLabel 生成破裂词缀显示文本。
   * 文本包含词缀名称和效果，方便在模态框中直接判断破裂价值。
   * @param {object} affix 破裂词缀对象。
   * @returns {string} 可读的破裂词缀文本。
   */
  const formatFracturedAffixLabel = (equipment, affix) => {
    const tierNumber = getAffixTierNumber(affix);
    const tierText = tierNumber ? `T${tierNumber} ` : '';
    const nameText = affix?.name || affix?.affixName || '未知词缀';
    const effectText = getFracturedAffixEffectText(equipment, affix);
    return `${formatAffixPositionName(affix?.type)} ${tierText}${nameText}${effectText ? `：${effectText}` : ''}`;
  };

  /**
   * parseAffixExpression 兼容旧版手写表达式，把旧数据解析成条件组。
   * 新 UI 不再展示竖线语法，但保留解析能力，避免用户已有输入或外部调用直接失效。
   * @param {string} expression 用户输入的旧版词缀表达式。
   * @returns {Array<Array<string>>} 解析后的条件组。
   */
  const parseAffixExpression = (expression) => String(expression || '')
    .split('|')
    .map((orGroup) => orGroup.split(',').map((text) => text.trim()).filter(Boolean))
    .filter((orGroup) => orGroup.length > 0);

  const isSpecialCondition = (condition) => condition?.kind === 'special';
  const isRollCondition = (condition) => condition?.kind === 'roll';

  /**
   * normalizeAffixCondition 把旧版字符串条件和新版对象条件统一为普通词缀条件或特殊装备状态条件。
   * 词缀类型直接来自词缀选取 UI 的“词缀类型”下拉框，是互斥校验的唯一来源。
   * @param {string|object} condition 原始条件。
   * @returns {object} 规范化后的条件。
   */
  const normalizeAffixCondition = (condition) => {
    if (condition && typeof condition === 'object') {
      if (condition.kind === 'special') {
        const metric = SPECIAL_CONDITION_METRICS[condition.metric] ? condition.metric : 'totalAffixCount';
        const metricConfig = SPECIAL_CONDITION_METRICS[metric];
        const operator = SPECIAL_CONDITION_OPERATORS[condition.operator] ? condition.operator : 'eq';
        let value = condition.value;
        if (metricConfig.valueType === 'number') {
          value = Number.parseInt(value, 10);
          if (!Number.isFinite(value)) value = 0;
        } else if (metricConfig.valueType === 'boolean') {
          value = value === true || value === 'true';
        } else if (metricConfig.valueType === 'rarity') {
          value = Number.parseInt(value, 10);
          if (!SPECIAL_CONDITION_RARITY_LABELS[value]) value = RARITY_TYPES.magic;
        } else if (metricConfig.valueType === 'percent') {
          value = Number.parseFloat(value);
          if (!Number.isFinite(value)) value = 0;
        }
        return {
          kind: 'special',
          metric,
          operator,
          value,
          name: `${metric}:${operator}:${value}`,
          affixType: '',
        };
      }
      if (condition.kind === 'roll') {
        const metric = ROLL_CONDITION_METRICS[condition.metric] ? condition.metric : 'physicalDamageMin';
        const metricConfig = ROLL_CONDITION_METRICS[metric];
        const operator = SPECIAL_CONDITION_OPERATORS[condition.operator] ? condition.operator : 'gte';
        let value = Number.parseInt(condition.value, 10);
        if (!Number.isFinite(value)) value = 0;
        return {
          kind: 'roll',
          metric,
          operator,
          value,
          name: `${metric}:${operator}:${value}`,
          affixType: '',
        };
      }
      return {
        kind: 'affix',
        name: String(condition.name || '').trim(),
        affixType: String(condition.affixType || condition.typeName || '').trim(),
      };
    }
    return { kind: 'affix', name: String(condition || '').trim(), affixType: '' };
  };

  /**
   * getAffixConditionKey 生成条件去重键。
   * 同一具体词缀名在不同词缀类型中可能重复出现，因此必须同时保留类型和名称。
   * @param {{name: string, affixType: string}} condition 规范化词缀条件。
   * @returns {string} 条件唯一键。
   */
  const getAffixConditionKey = (condition) => {
    const normalizedCondition = normalizeAffixCondition(condition);
    if (isSpecialCondition(normalizedCondition)) {
      return `special\u0001${normalizedCondition.metric}\u0001${normalizedCondition.operator}\u0001${normalizedCondition.value}`;
    }
    if (isRollCondition(normalizedCondition)) {
      return `roll\u0001${normalizedCondition.metric}\u0001${normalizedCondition.operator}\u0001${normalizedCondition.value}`;
    }
    return `affix\u0001${normalizedCondition.affixType}\u0001${normalizedCondition.name}`;
  };

  /**
   * formatAffixConditionLabel 生成日志和条件标签显示文本。
   * @param {string|object} condition 原始词缀条件。
   * @returns {string} 带词缀类型的可读文本。
   */
  const formatAffixConditionLabel = (condition) => {
    const normalizedCondition = normalizeAffixCondition(condition);
    if (isSpecialCondition(normalizedCondition)) {
      const metricConfig = SPECIAL_CONDITION_METRICS[normalizedCondition.metric];
      const operatorLabel = SPECIAL_CONDITION_OPERATORS[normalizedCondition.operator] || normalizedCondition.operator;
      let valueLabel = normalizedCondition.value;
      if (metricConfig?.valueType === 'boolean') valueLabel = normalizedCondition.value ? '是' : '否';
      if (metricConfig?.valueType === 'rarity') valueLabel = SPECIAL_CONDITION_RARITY_LABELS[normalizedCondition.value] || normalizedCondition.value;
      if (metricConfig?.valueType === 'percent') valueLabel = `${normalizedCondition.value}%`;
      return `特殊：${metricConfig?.label || normalizedCondition.metric} ${operatorLabel} ${valueLabel}`;
    }
    if (isRollCondition(normalizedCondition)) {
      const metricConfig = ROLL_CONDITION_METRICS[normalizedCondition.metric];
      const operatorLabel = SPECIAL_CONDITION_OPERATORS[normalizedCondition.operator] || normalizedCondition.operator;
      const valueLabel = metricConfig?.valueType === 'percent' ? `${normalizedCondition.value}%` : normalizedCondition.value;
      return `词缀Roll：${metricConfig?.label || normalizedCondition.metric} ${operatorLabel} ${valueLabel}`;
    }
    if (!normalizedCondition.affixType) return normalizedCondition.name;
    return `${normalizedCondition.affixType}：${normalizedCondition.name}`;
  };

  const SPECIAL_CONDITION_SHORT_LABELS = {
    totalAffixCount: '词数',
    prefixCount: '前缀',
    suffixCount: '后缀',
    rarity: '稀有',
    corrupted: '腐化',
    crafted: '工艺',
    craftedMultimod: '多大师',
    openPrefix: '空前',
    openSuffix: '空后',
    openAffix: '空词',
  };

  const ROLL_CONDITION_SHORT_LABELS = {
    physicalDamageMin: '物理min',
    physicalDamageMax: '物理max',
    fireDamageMin: '火min',
    fireDamageMax: '火max',
    coldDamageMin: '冰min',
    coldDamageMax: '冰max',
    lightningDamageMin: '电min',
    lightningDamageMax: '电max',
    chaosDamageMin: '混沌min',
    chaosDamageMax: '混沌max',
    prefixRollAverage: '前均Roll',
    prefixRollMinimum: '前低Roll',
    suffixRollAverage: '后均Roll',
    suffixRollMinimum: '后低Roll',
    affixRollAverage: '全均Roll',
    affixRollMinimum: '全低Roll',
    craftedRollAverage: '工艺均Roll',
    craftedRollMinimum: '工艺低Roll',
  };

  const formatConditionStepShortLabel = (conditionGroups) => {
    const conditions = (Array.isArray(conditionGroups) ? conditionGroups : [])
      .flatMap((group) => normalizeAffixConditionGroup(group).conditions);
    if (conditions.some((condition) => {
      const normalizedCondition = normalizeAffixCondition(condition);
      return !isSpecialCondition(normalizedCondition) && !isRollCondition(normalizedCondition);
    })) return '词缀';
    const specialLabels = [...new Set(conditions
      .map(normalizeAffixCondition)
      .filter(isSpecialCondition)
      .map((condition) => SPECIAL_CONDITION_SHORT_LABELS[condition.metric] || '特殊'))];
    const rollLabels = [...new Set(conditions
      .map(normalizeAffixCondition)
      .filter(isRollCondition)
      .map((condition) => ROLL_CONDITION_SHORT_LABELS[condition.metric] || 'Roll'))];
    const labels = [...specialLabels, ...rollLabels];
    if (!labels.length) return '空';
    return labels.slice(0, 2).join('/');
  };

  /**
   * createEmptyAffixConditionGroup 创建空条件组；每组独立维护自己的命中数量。
   * @returns {{conditions: Array<object>, minRequired: number}} 可写入 state 的空条件组。
   */
  const createEmptyAffixConditionGroup = () => ({ conditions: [], minRequired: 1 });

  /**
   * normalizeAffixConditionGroup 兼容旧数组组和新版对象组，统一为带本组命中数的条件组。
   * @param {Array|object} group 原始条件组。
   * @returns {{conditions: Array<object>, minRequired: number}} 标准条件组。
   */
  const normalizeAffixConditionGroup = (group) => {
    const rawConditions = Array.isArray(group) ? group : group?.conditions;
    const seenConditionKeys = new Set();
    const conditions = (Array.isArray(rawConditions) ? rawConditions : [])
      .map(normalizeAffixCondition)
      .filter((condition) => condition.name || isSpecialCondition(condition) || isRollCondition(condition))
      .filter((condition) => {
        const conditionKey = getAffixConditionKey(condition);
        if (seenConditionKeys.has(conditionKey)) return false;
        seenConditionKeys.add(conditionKey);
        return true;
      });
    const parsedMinRequired = Number.parseInt(group?.minRequired, 10);
    const maxRequired = Math.max(1, conditions.length);
    return {
      conditions,
      minRequired: Math.min(maxRequired, Math.max(1, Number.isFinite(parsedMinRequired) ? parsedMinRequired : 1)),
    };
  };

  /**
   * fetchBackpackCleanupPage 读取背包清理用分页。
   * 该函数固定读取背包 storage=false，不受“读取位置”下拉框影响，避免误删储藏装备。
   * @param {number} page 页码，从 1 开始。
   * @returns {Promise<object>} 包含 items、total 和 totalPages 的分页数据。
   */
  const fetchBackpackCleanupPage = async (page) => {
    const searchParams = new URLSearchParams({
      storage: 'false',
      pageSize: String(config.pageSize),
      _: String(Date.now()),
    });
    const payload = await requestJson(`${config.endpoints.backpack}/${page}?${searchParams.toString()}`);
    if (payload.success === false) {
      throw new Error(payload.message || `背包第 ${page} 页读取失败`);
    }
    const data = payload.data || {};
    const items = Array.isArray(data.items) ? data.items.filter((item) => item?.id) : [];
    const total = Number(data.total || 0);
    return {
      items,
      total,
      totalPages: Math.max(1, Math.ceil(total / config.pageSize)),
    };
  };

  const normalizeContinuousStepNote = (note) => String(note || '').trim().slice(0, 200);

  /**
   * createContinuousCraftStep 创建连续打造步骤。
   * 每一步是比条件组更大的单位：先选择本步动作，再在本步内部自由组合多个条件组。
   * @param {string} action 动作标识。
   * @param {Array<object>} conditionGroups 本步骤独立使用的条件组。
   * @param {string} failureHandling 本步骤条件不成立后的处理方式。
   * @returns {{action: string, conditionGroups: Array<object>, failureHandling: string}} 可写入 state 的步骤对象。
   */
  const createContinuousCraftStep = (
    action = 'alteration',
    conditionGroups = [createEmptyAffixConditionGroup()],
    failureHandling = 'scourRestart',
    successHandling = 'jump',
    successTargetStepIndex = null,
    failureTargetStepIndex = 0,
    craftCategory = CRAFT_BENCH_CATEGORY_OPTIONS[0].value,
    craftId = '',
    note = '',
    gardenCraftCategory = GARDEN_CRAFT_CATEGORY_OPTIONS[0].value,
    gardenCraftKey = '',
  ) => {
    const normalizedFailureHandling = normalizeContinuousStepHandling(failureHandling, 'scourRestart');
    const normalizedSuccessHandling = normalizeContinuousStepHandling(successHandling, 'jump');
    const normalizedCraftCategory = CRAFT_BENCH_CATEGORY_OPTIONS.some((option) => option.value === craftCategory)
      ? craftCategory
      : CRAFT_BENCH_CATEGORY_OPTIONS[0].value;
    const normalizedCraftId = Number.parseInt(craftId, 10);
    const normalizedGardenCraftCategory = GARDEN_CRAFT_CATEGORY_OPTIONS.some((option) => option.value === gardenCraftCategory)
      ? gardenCraftCategory
      : GARDEN_CRAFT_CATEGORY_OPTIONS[0].value;
    return {
      action: CONTINUOUS_CRAFT_ACTIONS[action] ? action : 'alteration',
      craftCategory: normalizedCraftCategory,
      craftId: Number.isFinite(normalizedCraftId) ? String(normalizedCraftId) : '',
      gardenCraftCategory: normalizedGardenCraftCategory,
      gardenCraftKey: String(gardenCraftKey || ''),
      successHandling: normalizedSuccessHandling,
      successTargetStepIndex: Number.isInteger(successTargetStepIndex) && successTargetStepIndex >= 0 ? successTargetStepIndex : null,
      failureHandling: normalizedFailureHandling,
      failureTargetStepIndex: Number.isInteger(failureTargetStepIndex) && failureTargetStepIndex >= 0 ? failureTargetStepIndex : 0,
      note: normalizeContinuousStepNote(note),
      conditionGroups: (Array.isArray(conditionGroups) ? conditionGroups : [createEmptyAffixConditionGroup()])
        .map(normalizeAffixConditionGroup),
    };
  };

  /**
   * createDefaultContinuousCraftSteps 创建“改造石 -> 判断条件 -> 富豪石”的默认自定义打造预设。
   * 这是常用起点，但用户可以继续增删步骤、替换动作和重设每一步条件组。
   * @returns {Array<object>} 默认步骤列表。
   */
  const createDefaultContinuousCraftSteps = () => [
    createContinuousCraftStep('alteration', [createEmptyAffixConditionGroup()], 'jump', 'jump', 1, 0),
    createContinuousCraftStep('conditionCheck', [createEmptyAffixConditionGroup()], 'jump', 'jump', 2, 0),
    createContinuousCraftStep('regal'),
  ];

  /**
   * normalizeContinuousCraftStep 清洗单个连续打造步骤。
   * @param {object} rawStep 原始步骤。
   * @returns {object} 标准步骤。
   */
  const normalizeContinuousCraftStep = (rawStep = {}) => {
    const action = CONTINUOUS_CRAFT_ACTIONS[rawStep.action] ? rawStep.action : 'alteration';
    const successHandling = normalizeContinuousStepHandling(rawStep.successHandling, 'jump');
    const failureHandling = normalizeContinuousStepHandling(rawStep.failureHandling, 'jump');
    const successTargetStepIndex = Number.parseInt(rawStep.successTargetStepIndex, 10);
    const failureTargetStepIndex = Number.parseInt(rawStep.failureTargetStepIndex, 10);
    const conditionGroups = (Array.isArray(rawStep.conditionGroups) ? rawStep.conditionGroups : [])
      .map(normalizeAffixConditionGroup);
    return createContinuousCraftStep(
      action,
      conditionGroups.length ? conditionGroups : [createEmptyAffixConditionGroup()],
      failureHandling,
      successHandling,
      Number.isFinite(successTargetStepIndex) ? successTargetStepIndex : null,
      Number.isFinite(failureTargetStepIndex) ? failureTargetStepIndex : 0,
      rawStep.craftCategory,
      rawStep.craftId,
      rawStep.note,
      rawStep.gardenCraftCategory,
      rawStep.gardenCraftKey,
    );
  };

  /**
   * normalizeContinuousCraftSteps 清洗连续打造步骤列表；空列表会回退到默认预设。
   * @param {Array<object>} rawSteps 原始步骤列表。
   * @returns {Array<object>} 标准步骤列表。
   */
  const migrateLegacyContinuousCraftCompletionTargets = (steps) => {
    const stepCount = steps.length;
    const resolveTarget = (targetStepIndex, fallbackStepIndex) => {
      const rawIndex = Number.isInteger(targetStepIndex) ? targetStepIndex : fallbackStepIndex;
      return Math.max(0, Math.min(rawIndex, stepCount));
    };
    return steps.map((step, stepIndex) => {
      const nextStep = { ...normalizeContinuousCraftStep(step) };
      if (
        nextStep.successHandling === 'jump'
        && resolveTarget(nextStep.successTargetStepIndex, stepIndex + 1) >= stepCount
      ) {
        nextStep.successHandling = 'terminateSuccess';
        nextStep.successTargetStepIndex = null;
      }
      if (
        nextStep.failureHandling === 'jump'
        && resolveTarget(nextStep.failureTargetStepIndex, stepIndex) >= stepCount
      ) {
        nextStep.failureHandling = 'terminateSuccess';
        nextStep.failureTargetStepIndex = 0;
      }
      return nextStep;
    });
  };

  const normalizeContinuousCraftSteps = (rawSteps) => {
    const steps = (Array.isArray(rawSteps) ? rawSteps : [])
      .map(normalizeContinuousCraftStep)
      .filter((step) => CONTINUOUS_CRAFT_ACTIONS[step.action]);
    return steps.length ? steps : createDefaultContinuousCraftSteps();
  };

  /**
   * snapshotAffixConditionGroups 为正在运行的任务创建独立条件快照，避免运行中继续受 UI 修改影响。
   * @param {Array<object>} conditionGroups 原始条件组。
   * @returns {Array<object>} 独立的标准条件组快照。
   */
  const snapshotAffixConditionGroups = (conditionGroups) => (Array.isArray(conditionGroups) ? conditionGroups : [])
    .map(normalizeAffixConditionGroup)
    .filter((group) => group.conditions.length > 0);

  /**
   * snapshotContinuousCraftSteps 为自定义打造创建独立步骤快照，包含每步动作、条件成立/不成立处理和条件组。
   * @param {Array<object>} steps 原始步骤列表。
   * @returns {Array<object>} 独立的标准步骤快照。
   */
  const snapshotContinuousCraftSteps = (steps) => migrateLegacyContinuousCraftCompletionTargets(normalizeContinuousCraftSteps(steps))
    .map((step) => createContinuousCraftStep(
      step.action,
      snapshotAffixConditionGroups(step.conditionGroups),
      step.failureHandling,
      step.successHandling,
      step.successTargetStepIndex,
      step.failureTargetStepIndex,
      step.craftCategory,
      step.craftId,
      '',
      step.gardenCraftCategory,
      step.gardenCraftKey,
    ));

  /**
   * getContinuousCraftSteps 读取当前连续打造步骤，并确保 state 中始终有可编辑步骤。
   * @returns {Array<object>} 当前连续打造步骤。
   */
  const getContinuousCraftSteps = () => {
    state.continuousCraftSteps = normalizeContinuousCraftSteps(state.continuousCraftSteps);
    state.activeContinuousStepIndex = Math.min(
      Math.max(0, state.activeContinuousStepIndex),
      state.continuousCraftSteps.length - 1,
    );
    return state.continuousCraftSteps;
  };

  /**
   * setAffixGroupMinRequired 更新指定条件组的命中数。
   * @param {number} groupIndex 条件组下标。
   * @param {string|number} value 用户输入的命中数。
   */
  const setAffixGroupMinRequired = (groupIndex, value) => {
    const currentGroup = normalizeAffixConditionGroup(state.affixConditionGroups[groupIndex]);
    const parsedValue = Number.parseInt(value, 10);
    const maxRequired = Math.max(1, currentGroup.conditions.length);
    state.affixConditionGroups[groupIndex] = {
      ...currentGroup,
      minRequired: Math.min(maxRequired, Math.max(1, Number.isFinite(parsedValue) ? parsedValue : 1)),
    };
    renderAffixConditionBuilder();
  };

  /**
   * getAffixConditionGroups 读取当前可视化条件构建器里的有效词缀组。
   * 外层数组表示“任意条件组命中即可”，每组都有自己的本组命中数。
   * @returns {Array<object>} 清理空值和重复项后的条件组。
   */
  const getAffixConditionGroups = () => state.affixConditionGroups
    .map(normalizeAffixConditionGroup)
    .filter((group) => group.conditions.length > 0);

  /**
   * getAffixNamePositionMap 根据做装插件数据反查具体词缀名属于前缀还是后缀。
   * 同名词缀在不同装备/词缀类型中可能重复出现，因此每个词缀名对应一个位置集合。
   * @returns {Map<string, Set<string>>} 词缀名到 prefix/suffix 集合的映射。
   */
  const getAffixNamePositionMap = (() => {
    let cachedPositionMap = null;
    return () => {
      if (cachedPositionMap) return cachedPositionMap;
      cachedPositionMap = new Map();
      const addPosition = (affixName, positionName) => {
        const cleanAffixName = String(affixName || '').trim();
        if (!cleanAffixName) return;
        const positionType = String(positionName).includes('前') ? 'prefix' : 'suffix';
        if (!cachedPositionMap.has(cleanAffixName)) cachedPositionMap.set(cleanAffixName, new Set());
        cachedPositionMap.get(cleanAffixName).add(positionType);
      };
      for (const equipmentData of Object.values(AFFIX_EQUIPMENT_DATA)) {
        for (const [positionName, affixFamilies] of Object.entries(equipmentData || {})) {
          for (const affixType of Array.isArray(affixFamilies) ? affixFamilies : []) {
            addPosition(affixType?.name, positionName);
            for (const tier of AFFIX_LEVEL_DATA[affixType?.name] || []) {
              addPosition(tier?.name, positionName);
            }
          }
        }
      }
      return cachedPositionMap;
    };
  })();

  /**
   * getAffixNameTypeMap 根据做装插件数据反查具体词缀名属于哪个“词缀类型”。
   * 该映射只用于兼容旧条件；新条件会直接保存用户在 UI 中选择的词缀类型。
   * @returns {Map<string, Set<string>>} 词缀名到词缀类型集合的映射。
   */
  const getAffixNameTypeMap = (() => {
    let cachedTypeMap = null;
    return () => {
      if (cachedTypeMap) return cachedTypeMap;
      cachedTypeMap = new Map();
      const addType = (affixName, affixTypeName) => {
        const cleanAffixName = String(affixName || '').trim();
        const cleanAffixTypeName = String(affixTypeName || '').trim();
        if (!cleanAffixName || !cleanAffixTypeName) return;
        if (!cachedTypeMap.has(cleanAffixName)) cachedTypeMap.set(cleanAffixName, new Set());
        cachedTypeMap.get(cleanAffixName).add(cleanAffixTypeName);
      };
      for (const equipmentData of Object.values(AFFIX_EQUIPMENT_DATA)) {
        for (const affixTypes of Object.values(equipmentData || {})) {
          for (const affixType of Array.isArray(affixTypes) ? affixTypes : []) {
            const affixTypeName = affixType?.name;
            addType(affixTypeName, affixTypeName);
            for (const tier of AFFIX_LEVEL_DATA[affixTypeName] || []) {
              addType(tier?.name, affixTypeName);
            }
          }
        }
      }
      return cachedTypeMap;
    };
  })();

  /**
   * getAffixPossiblePositions 读取某个词缀可能占用的前后缀位置。
   * 如果本地数据无法反查位置，则保守认为前缀/后缀都有可能，避免误判合法条件。
   * @param {string} affixName 具体词缀名。
   * @returns {Array<string>} 可能位置，值为 prefix 或 suffix。
   */
  const getAffixPossiblePositions = (affixName) => {
    const positions = getAffixNamePositionMap().get(affixName);
    return positions?.size ? Array.from(positions) : ['prefix', 'suffix'];
  };

  /**
   * getAffixPossibleTypes 读取某个词缀可能所属的词缀类型。
   * 反查不到时使用词缀名自身作为独立类型，避免未知数据彼此误判冲突。
   * @param {string} affixName 具体词缀名。
   * @returns {Array<string>} 可能词缀类型名称。
   */
  const getAffixPossibleTypes = (affixName) => {
    const affixTypes = getAffixNameTypeMap().get(affixName);
    return affixTypes?.size ? Array.from(affixTypes) : [String(affixName || '').trim()];
  };

  /**
   * getAffixConditionPossibleTypes 读取条件可占用的词缀类型。
   * 新条件直接信任 UI 保存的词缀类型，旧字符串条件才走本地数据反查兜底。
   * @param {{name: string, affixType: string}} condition 规范化词缀条件。
   * @returns {Array<string>} 可用于互斥校验的词缀类型。
   */
  const getAffixConditionPossibleTypes = (condition) => (
    isSpecialCondition(condition) || isRollCondition(condition) ? [] :
    condition.affixType ? [condition.affixType] : getAffixPossibleTypes(condition.name)
  );

  /**
   * isAffixGroupPossible 判断某个条件组在指定前后缀上限下是否存在可实现的命中组合。
   * @param {object|Array<object>} affixGroup 单个条件组。
   * @param {object} limits 前后缀和总词缀上限。
   * @returns {boolean} 存在可实现组合时返回 true。
   */
  const isAffixGroupPossible = (affixGroup, limits) => {
    const normalizedGroup = normalizeAffixConditionGroup(affixGroup);
    const cleanGroup = normalizedGroup.conditions;
    if (!cleanGroup.length) return false;
    const requiredCount = Math.min(normalizedGroup.minRequired, cleanGroup.length);
    let states = new Map([['0,0,0|', new Set()]]);
    for (const condition of cleanGroup) {
      if (isSpecialCondition(condition) || isRollCondition(condition)) {
        const nextStates = new Map(states);
        for (const [stateKey, usedTypes] of states.entries()) {
          const [countKey, typeKey = ''] = stateKey.split('|');
          const [pickedCount, prefixCount, suffixCount] = countKey.split(',').map(Number);
          const nextPickedCount = pickedCount + 1;
          nextStates.set(`${nextPickedCount},${prefixCount},${suffixCount}|${typeKey}`, new Set(usedTypes));
        }
        states = nextStates;
        continue;
      }
      const nextStates = new Map(states);
      for (const [stateKey, usedTypes] of states.entries()) {
        const [countKey] = stateKey.split('|');
        const [pickedCount, prefixCount, suffixCount] = countKey.split(',').map(Number);
        for (const position of getAffixPossiblePositions(condition.name)) {
          for (const affixTypeName of getAffixConditionPossibleTypes(condition)) {
            if (usedTypes.has(affixTypeName)) continue;
            const nextPrefixCount = prefixCount + (position === 'prefix' ? 1 : 0);
            const nextSuffixCount = suffixCount + (position === 'suffix' ? 1 : 0);
            const nextPickedCount = pickedCount + 1;
            if (
              nextPrefixCount <= limits.prefix &&
              nextSuffixCount <= limits.suffix &&
              nextPickedCount <= limits.total
            ) {
              const nextUsedTypes = new Set([...usedTypes, affixTypeName]);
              const nextTypeKey = Array.from(nextUsedTypes).sort().join('\u0001');
              nextStates.set(`${nextPickedCount},${nextPrefixCount},${nextSuffixCount}|${nextTypeKey}`, nextUsedTypes);
            }
          }
        }
      }
      states = nextStates;
    }
    return Array.from(states.keys()).some((stateKey) => Number(stateKey.split(',')[0]) >= requiredCount);
  };

  /**
   * assertAffixConditionsPossible 在开始消耗通货前检查词缀目标是否可能实现。
   * 条件组之间是“或”，因此只要至少一个条件组可实现，就允许任务运行。
   * @param {Array<object>} conditionGroups 可视化条件组。
   * @param {object} limits 前后缀和总词缀上限。
   * @param {string} taskName 任务名称，用于错误提示。
   */
  const assertAffixConditionsPossible = (conditionGroups, limits, taskName) => {
    if (!conditionGroups.length) throw new Error('请先添加至少一个条件。');
    const groupResults = conditionGroups
      .map((group, groupIndex) => ({ group, groupIndex }))
      .map((item) => ({ ...item, isPossible: isAffixGroupPossible(item.group, limits) }));
    if (groupResults.some(({ isPossible }) => isPossible)) return;
    const groupLabels = groupResults
      .map(({ group, groupIndex }) => {
        const normalizedGroup = normalizeAffixConditionGroup(group);
        return `条件组 ${groupIndex + 1}（至少 ${Math.min(normalizedGroup.minRequired, normalizedGroup.conditions.length)} 条）：${normalizedGroup.conditions.map(formatAffixConditionLabel).join('，')}`;
      })
      .join('；');
    throw new Error(`${taskName} 的全部条件组都不可能实现，请调整前后缀条件。${groupLabels}`);
  };

  const compareConditionValue = (currentValue, operator, expectedValue) => {
    if (currentValue === undefined || currentValue === null) return false;
    if (operator === 'contains') return String(currentValue || '').includes(String(expectedValue || ''));
    if (operator === 'notContains') return !String(currentValue || '').includes(String(expectedValue || ''));
    if (typeof currentValue === 'number' && typeof expectedValue === 'number') {
      const epsilon = 1e-7;
      if (operator === 'eq') return Math.abs(currentValue - expectedValue) <= epsilon;
      if (operator === 'ne') return Math.abs(currentValue - expectedValue) > epsilon;
      if (operator === 'gt') return currentValue > expectedValue + epsilon;
      if (operator === 'gte') return currentValue + epsilon >= expectedValue;
      if (operator === 'lt') return currentValue < expectedValue - epsilon;
      if (operator === 'lte') return currentValue <= expectedValue + epsilon;
    }
    if (operator === 'eq') return currentValue === expectedValue;
    if (operator === 'ne') return currentValue !== expectedValue;
    if (operator === 'gt') return currentValue > expectedValue;
    if (operator === 'gte') return currentValue >= expectedValue;
    if (operator === 'lt') return currentValue < expectedValue;
    if (operator === 'lte') return currentValue <= expectedValue;
    return false;
  };

  const collectTextFromObject = (value, depth = 0, visited = new Set()) => {
    if (value === undefined || value === null || depth > 3) return [];
    if (typeof value === 'string' || typeof value === 'number') return [String(value)];
    if (typeof value !== 'object') return [];
    if (visited.has(value)) return [];
    visited.add(value);
    if (Array.isArray(value)) {
      return value.flatMap((item) => collectTextFromObject(item, depth + 1, visited));
    }
    const textKeys = new Set([
      'name',
      'baseName',
      'originalName',
      'typeLine',
      'baseType',
      'equipmentBaseName',
      'templateName',
      'implicitText',
      'explicitText',
      'displayText',
      'description',
      'desc',
      'text',
      'value',
    ]);
    return Object.entries(value).flatMap(([key, item]) => (
      textKeys.has(key) ? collectTextFromObject(item, depth + 1, visited) : []
    ));
  };

  const getEquipmentAffixLimitText = (equipment) => [
    equipment?.name,
    equipment?.baseName,
    equipment?.raw?.name,
    equipment?.raw?.baseName,
    equipment?.raw?.originalName,
    equipment?.raw?.typeLine,
    equipment?.raw?.baseType,
    equipment?.raw?.equipmentBaseName,
    ...collectTextFromObject(equipment?.raw),
  ].filter((text) => text !== undefined && text !== null).join(' ');

  const parseAffixSlotLimitDelta = (text, positionText) => {
    const englishPosition = positionText === '前缀' ? 'prefix' : 'suffix';
    const patterns = [
      new RegExp(`允许的${positionText}(?:词缀|修饰符)?\\s*([+-]?\\d+)`, 'gi'),
      new RegExp(`${positionText}(?:词缀|修饰符)?(?:数量|上限)?\\s*([+-]?\\d+)`, 'gi'),
      new RegExp(`${englishPosition}\\s*(?:modifiers?|mods?)?\\s*([+-]?\\d+)`, 'gi'),
    ];
    for (const pattern of patterns) {
      let totalDelta = 0;
      let matched = false;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const value = Number.parseInt(match[1], 10);
        if (!Number.isFinite(value)) continue;
        totalDelta += value;
        matched = true;
      }
      if (matched) return totalDelta;
    }
    return null;
  };

  const getSpecialBaseAffixSlotDeltas = (equipment) => {
    const text = getEquipmentAffixLimitText(equipment);
    const prefixDelta = parseAffixSlotLimitDelta(text, '前缀');
    const suffixDelta = parseAffixSlotLimitDelta(text, '后缀');
    if (prefixDelta !== null || suffixDelta !== null) {
      return { prefix: prefixDelta || 0, suffix: suffixDelta || 0 };
    }
    return { prefix: 0, suffix: 0 };
  };

  const getAffixSlotLimits = (rarity, equipment = null) => {
    let limits = { prefix: 0, suffix: 0 };
    if (Number(rarity) === RARITY_TYPES.rare) limits = { prefix: 3, suffix: 3 };
    if (Number(rarity) === RARITY_TYPES.magic) limits = { prefix: 1, suffix: 1 };
    const deltas = equipment ? getSpecialBaseAffixSlotDeltas(equipment) : { prefix: 0, suffix: 0 };
    return {
      prefix: Math.max(0, limits.prefix + deltas.prefix),
      suffix: Math.max(0, limits.suffix + deltas.suffix),
    };
  };

  const DAMAGE_ROLL_CONDITION_SOURCES = {
    physicalDamageMin: { path: 'physicalDamage', valueKey: 'min' },
    physicalDamageMax: { path: 'physicalDamage', valueKey: 'max' },
    fireDamageMin: { damageType: 2, valueKey: 'min' },
    fireDamageMax: { damageType: 2, valueKey: 'max' },
    coldDamageMin: { damageType: 3, valueKey: 'min' },
    coldDamageMax: { damageType: 3, valueKey: 'max' },
    lightningDamageMin: { damageType: 4, valueKey: 'min' },
    lightningDamageMax: { damageType: 4, valueKey: 'max' },
    chaosDamageMin: { damageType: 5, valueKey: 'min' },
    chaosDamageMax: { damageType: 5, valueKey: 'max' },
  };

  const getEquipmentDamageValue = (equipment, metric) => {
    const source = DAMAGE_ROLL_CONDITION_SOURCES[metric];
    if (!source) return undefined;
    const metricLabel = ROLL_CONDITION_METRICS[metric]?.label || metric;
    const equipmentName = equipment?.name || '当前装备';
    const physicalDamage = equipment?.physicalDamage || equipment?.raw?.physicalDamage;
    const damages = equipment?.damages || equipment?.raw?.damages;
    const damageData = source.path === 'physicalDamage'
      ? physicalDamage
      : damages?.[String(source.damageType)] || damages?.[source.damageType];
    if (!damageData || !Object.prototype.hasOwnProperty.call(damageData, source.valueKey)) {
      return 0;
    }
    const value = Number(damageData?.[source.valueKey]);
    if (!Number.isFinite(value)) {
      throw new Error(`${equipmentName} 的“${metricLabel}”不是有效数值，已停止自动化打造。`);
    }
    return value;
  };

  const AFFIX_ROLL_METRIC_SOURCES = {
    prefixRollAverage: { affixTypes: [1], aggregate: 'average' },
    prefixRollMinimum: { affixTypes: [1], aggregate: 'minimum' },
    suffixRollAverage: { affixTypes: [2], aggregate: 'average' },
    suffixRollMinimum: { affixTypes: [2], aggregate: 'minimum' },
    affixRollAverage: { affixTypes: [1, 2], aggregate: 'average' },
    affixRollMinimum: { affixTypes: [1, 2], aggregate: 'minimum' },
    craftedRollAverage: { affixTypes: [1, 2], aggregate: 'average', craftedOnly: true },
    craftedRollMinimum: { affixTypes: [1, 2], aggregate: 'minimum', craftedOnly: true },
  };

  const EQUIPMENT_TYPE_EXACT_AFFIX_KEYS = {
    单手剑: '单手剑',
    单手斧: '单手斧',
    法杖: '法杖',
    爪: '爪',
    匕首: '匕首',
    细剑: '细剑',
    单手锤: '单手锤',
    短杖: '短杖',
    符文匕首: '符文匕首',
    弓: '弓',
    长杖: '长杖',
    双手剑: '双手剑',
    双手斧: '双手斧',
    双手锤: '双手锤',
    战杖: '战杖',
    箭袋: '箭袋',
    项链: '项链',
    戒指: '戒指',
    腰带: '腰带',
  };

  const EQUIPMENT_TYPE_AFFIX_KEY_PREFIXES = {
    手套: '手套',
    靴子: '鞋子',
    头盔: '头部',
    胸甲: '胸甲',
    盾牌: '盾牌',
  };

  const isGameHelmetType = (equipmentType) => (
    [17179869184n, 34359738368n, 68719476736n, 137438953472n, 274877906944n, 549755813888n].includes(equipmentType)
    || (equipmentType & EQUIPMENT_TYPE_MASKS.helmets) !== 0n
  );

  const isGameBodyArmourType = (equipmentType) => (
    [134217728n, 268435456n, 536870912n, 1073741824n, 2147483648n, 4294967296n, 8589934592n].includes(equipmentType)
    || (equipmentType & EQUIPMENT_TYPE_MASKS.bodyArmours) !== 0n
  );

  const isGameShieldType = (equipmentType) => (
    [1099511627776n, 2199023255552n, 4398046511104n, 8796093022208n, 17592186044416n, 35184372088832n].includes(equipmentType)
    || (equipmentType & EQUIPMENT_TYPE_MASKS.shields) !== 0n
  );

  const isGameBootType = (equipmentType) => (
    [2097152n, 4194304n, 8388608n, 16777216n, 33554432n, 67108864n].includes(equipmentType)
    || (equipmentType & EQUIPMENT_TYPE_MASKS.boots) !== 0n
  );

  const isGameQuiverType = (equipmentType) => (
    equipmentType === EQUIPMENT_TYPE_MASKS.quivers || (equipmentType & EQUIPMENT_TYPE_MASKS.quivers) !== 0n
  );

  const getGameEquipmentTypeLabel = (equipmentTypeValue) => {
    const equipmentType = parseEquipmentTypeMask(equipmentTypeValue);
    if (!equipmentType) return '';
    if (equipmentType & 1n) return '单手剑';
    if (equipmentType & 2n) return '单手斧';
    if (equipmentType & 4n) return '法杖';
    if (equipmentType & 8n) return '爪';
    if (equipmentType & 16n) return '匕首';
    if (equipmentType & 32n) return '细剑';
    if (equipmentType & 64n) return '单手锤';
    if (equipmentType & 128n) return '短杖';
    if (equipmentType & 256n) return '符文匕首';
    if (equipmentType & 512n) return '弓';
    if (equipmentType & 1024n) return '长杖';
    if (equipmentType & 2048n) return '双手剑';
    if (equipmentType & 4096n) return '双手斧';
    if (equipmentType & 8192n) return '双手锤';
    if (equipmentType & 16384n) return '战杖';
    if (isGameShieldType(equipmentType)) return '盾牌';
    if (isGameQuiverType(equipmentType)) return '箭袋';
    if (isGameHelmetType(equipmentType)) return '头盔';
    if (isGameBodyArmourType(equipmentType)) return '胸甲';
    if (equipmentType & EQUIPMENT_TYPE_MASKS.gloves) return '手套';
    if (isGameBootType(equipmentType)) return '靴子';
    if ((equipmentType & EQUIPMENT_TYPE_MASKS.belts) !== 0n) return '腰带';
    if ((equipmentType & EQUIPMENT_TYPE_MASKS.amulets) !== 0n) return '项链';
    if ((equipmentType & EQUIPMENT_TYPE_MASKS.rings) !== 0n) return '戒指';
    return '';
  };

  const getAffixEquipmentKeysForEquipment = (equipment) => {
    const equipmentMask = parseEquipmentTypeMask(equipment?.equipmentType);
    if (!equipmentMask) return [];
    const gameTypeLabel = getGameEquipmentTypeLabel(equipmentMask);
    const exactKey = EQUIPMENT_TYPE_EXACT_AFFIX_KEYS[gameTypeLabel];
    if (exactKey && AFFIX_EQUIPMENT_DATA[exactKey]) return [exactKey];
    const prefix = EQUIPMENT_TYPE_AFFIX_KEY_PREFIXES[gameTypeLabel];
    if (!prefix) return [];
    return Object.keys(AFFIX_EQUIPMENT_DATA)
      .filter((equipmentKey) => equipmentKey === prefix || equipmentKey.startsWith(`${prefix}(`));
  };

  const getAffixTypeNamesForEquipmentAffix = (equipment, affix) => {
    const equipmentKeys = getAffixEquipmentKeysForEquipment(equipment);
    const positionName = Number(affix?.type) === 1 ? '前缀' : Number(affix?.type) === 2 ? '后缀' : '';
    if (!equipmentKeys.length || !positionName) return [];
    const typeNames = [];
    for (const equipmentKey of equipmentKeys) {
      const entries = AFFIX_EQUIPMENT_DATA[equipmentKey]?.[positionName] || [];
      entries.forEach((entry) => {
        if (entry?.name) typeNames.push(entry.name);
      });
    }
    return [...new Set(typeNames)];
  };

  const parseAffixRollRangeSpecs = (effectText) => {
    const specs = [];
    const tokenPattern = /\(\s*([+-]?\d+(?:\.\d+)?)\s*[–-]\s*([+-]?\d+(?:\.\d+)?)\s*\)|[+-]?\d+(?:\.\d+)?/g;
    let tokenIndex = 0;
    let match;
    while ((match = tokenPattern.exec(String(effectText || ''))) !== null) {
      if (match[1] !== undefined && match[2] !== undefined) {
        const min = Number.parseFloat(match[1]);
        const max = Number.parseFloat(match[2]);
        if (Number.isFinite(min) && Number.isFinite(max)) {
          specs.push({ min: Math.min(min, max), max: Math.max(min, max), valueIndex: tokenIndex });
        }
      }
      tokenIndex += 1;
    }
    return specs;
  };

  /**
   * readAffixMagicNumber 兼容接口的纯数字和 { parsedValue, source } 数值对象。
   * 放大后仍为整数的值通常会以对象返回，小数值则可能直接返回 number。
   */
  const readAffixMagicNumber = (value) => {
    if (value && typeof value === 'object') {
      const parsedValue = Number(value.parsedValue);
      if (Number.isFinite(parsedValue)) return parsedValue;
      const sourceValue = Number(value.source);
      if (Number.isFinite(sourceValue)) return sourceValue;
      const nestedValue = Number(value.value);
      return Number.isFinite(nestedValue) ? nestedValue : NaN;
    }
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : NaN;
  };

  const flattenMagicValueMap = (magicMap) => {
    if (magicMap == null) return [];
    const isSingleValueObject = !Array.isArray(magicMap)
      && typeof magicMap === 'object'
      && ['parsedValue', 'source', 'value'].some((key) => Object.prototype.hasOwnProperty.call(magicMap, key));
    const groupedValues = Array.isArray(magicMap) || isSingleValueObject
      ? [magicMap]
      : Object.values(magicMap);
    return groupedValues
      .flatMap((values) => (Array.isArray(values) ? values : [values]))
      .map(readAffixMagicNumber)
      .filter((value) => Number.isFinite(value));
  };

  const flattenAffixMagicValues = (affix) => flattenMagicValueMap(affix?.magics);

  // 当前网页 magic 定义：3914=全部显性词缀幅度，3915=前缀幅度，3916=后缀幅度。
  const EXPLICIT_AFFIX_MAGNITUDE_MAGIC_IDS = {
    3914: [1, 2],
    3915: [1],
    3916: [2],
  };

  const CATALYST_AFFIX_PATTERNS = {
    24: /(?:火焰|冰霜|冰冷|闪电|元素).{0,8}伤害|伤害.{0,8}(?:火焰|冰霜|冰冷|闪电|元素)/,
    25: /法术|施法/,
    26: /攻击|该装备附加/,
    27: /护甲|闪避|能量护盾|格挡|法术压制|防御/,
    28: /生命|魔力/,
    29: /抗性/,
    30: /力量|敏捷|智慧|属性/,
    31: /物理.{0,8}伤害|混沌.{0,8}伤害|伤害.{0,8}(?:物理|混沌)/,
    32: /速度/,
    33: /暴击/,
  };

  const getEquipmentBaseAffixMagnitudeMultiplier = (equipment, affix) => {
    const affixType = Number(affix?.type || 0);
    const fixedMagics = equipment?.fixedMagics || equipment?.raw?.fixedMagics || {};
    let increasedPercent = 0;
    for (const [magicId, supportedTypes] of Object.entries(EXPLICIT_AFFIX_MAGNITUDE_MAGIC_IDS)) {
      if (!supportedTypes.includes(affixType)) continue;
      const values = flattenMagicValueMap(fixedMagics?.[magicId]);
      if (values.length) increasedPercent += values.reduce((sum, value) => sum + value, 0);
    }
    return Math.max(0.000001, 1 + (increasedPercent / 100));
  };

  const isAffixCandidateAffectedByCatalyst = (equipment, candidate) => {
    const catalystType = Number(equipment?.catalystType ?? equipment?.raw?.catalystType ?? 0);
    const pattern = CATALYST_AFFIX_PATTERNS[catalystType];
    if (!pattern) return false;
    return pattern.test(`${candidate?.affixTypeName || ''} ${candidate?.effectValue || ''}`);
  };

  /**
   * getAffixMagnitudeMultiplierCandidates 返回实际词缀值相对字典原始值的倍率候选。
   * 已识别到催化剂类别时优先使用含品质倍率的结果；描述无法分类时保留它作为兜底。
   */
  const getAffixMagnitudeMultiplierCandidates = (equipment, affix, candidate) => {
    const baseMultiplier = getEquipmentBaseAffixMagnitudeMultiplier(equipment, affix);
    const quality = Math.max(0, Number(equipment?.quality ?? equipment?.raw?.quality ?? 0));
    const catalystType = Number(equipment?.catalystType ?? equipment?.raw?.catalystType ?? 0);
    const catalystMultiplier = catalystType && quality > 0 ? 1 + (quality / 100) : 1;
    if (catalystMultiplier === 1) return [baseMultiplier];
    const amplifiedMultiplier = baseMultiplier * catalystMultiplier;
    const candidates = isAffixCandidateAffectedByCatalyst(equipment, candidate)
      ? [amplifiedMultiplier, baseMultiplier]
      : [baseMultiplier, amplifiedMultiplier];
    return candidates.filter((value, index) => (
      Number.isFinite(value) && value > 0 && candidates.findIndex((item) => Math.abs(item - value) < 1e-9) === index
    ));
  };

  const getAffixMagicIds = (affix) => new Set(Object.keys(affix?.magics || {}).map(String));

  const parseCraftBenchRollRanges = (craftAffix) => Object.values(craftAffix?.magics || {})
    .flatMap((values) => (Array.isArray(values) ? values : [values]))
    .map((value) => {
      const min = Number(value?.min);
      const max = Number(value?.max);
      if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
      return { min: Math.min(min, max), max: Math.max(min, max) };
    })
    .filter(Boolean);

  const calculateRollPercent = (actualValue, range) => {
    const denominator = range.max - range.min;
    return denominator === 0 ? 100 : ((actualValue - range.min) / denominator) * 100;
  };

  /**
   * calculateAmplifiedRollPercent 直接用放大后的上下限计算，避免 actual / multiplier
   * 在区间端点产生 26.000000000000004 一类除法误差。
   */
  const calculateAmplifiedRollPercent = (actualValue, range, magnitudeMultiplier) => {
    const scaledMin = range.min * magnitudeMultiplier;
    const scaledMax = range.max * magnitudeMultiplier;
    const denominator = scaledMax - scaledMin;
    if (Math.abs(denominator) <= Number.EPSILON) return 100;
    return ((actualValue - scaledMin) / denominator) * 100;
  };

  const isRollPercentInRange = (rawPercent, epsilon = 1e-7) => (
    rawPercent >= -epsilon && rawPercent <= 100 + epsilon
  );

  const matchAffixRollRangesToActualValues = (ranges, actualValues, magnitudeMultiplier = 1) => {
    const epsilon = 1e-6;
    const safeMultiplier = Number.isFinite(magnitudeMultiplier) && magnitudeMultiplier > 0 ? magnitudeMultiplier : 1;
    const tryValues = (values) => {
      const percentages = [];
      for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
        const actualValue = values[rangeIndex];
        if (!Number.isFinite(actualValue)) return null;
        const rawPercent = calculateAmplifiedRollPercent(actualValue, ranges[rangeIndex], safeMultiplier);
        if (!isRollPercentInRange(rawPercent, epsilon)) return null;
        percentages.push(Math.max(0, Math.min(100, rawPercent)));
      }
      return percentages;
    };
    if (actualValues.length === ranges.length) {
      const directPercentages = tryValues(actualValues);
      if (directPercentages) return directPercentages;
    }
    const usedIndexes = new Set();
    const pickedValues = [];
    const search = (rangeIndex) => {
      if (rangeIndex >= ranges.length) return tryValues(pickedValues);
      for (let actualIndex = 0; actualIndex < actualValues.length; actualIndex += 1) {
        if (usedIndexes.has(actualIndex)) continue;
        const rawActualValue = actualValues[actualIndex];
        const rawPercent = calculateAmplifiedRollPercent(rawActualValue, ranges[rangeIndex], safeMultiplier);
        if (!isRollPercentInRange(rawPercent, epsilon)) continue;
        usedIndexes.add(actualIndex);
        pickedValues[rangeIndex] = rawActualValue;
        const result = search(rangeIndex + 1);
        if (result) return result;
        pickedValues.pop();
        usedIndexes.delete(actualIndex);
      }
      return null;
    };
    return search(0);
  };

  const getKnownAffixRollCandidates = (equipment, affix) => {
    const affixName = String(affix?.name || affix?.affixName || '').trim();
    if (!affixName) return [];
    const affixTypeNames = getAffixTypeNamesForEquipmentAffix(equipment, affix);
    if (!affixTypeNames.length) return [];
    const tierNumber = getAffixTierNumber(affix);
    const exactTierCandidates = [];
    const sameNameCandidates = [];
    for (const affixTypeName of affixTypeNames) {
      const tierList = AFFIX_LEVEL_DATA[affixTypeName];
      if (!Array.isArray(tierList)) continue;
      for (const tier of tierList) {
        if (String(tier?.name || '').trim() !== affixName) continue;
        const effectValue = String(tier?.value || '').trim();
        if (!effectValue) continue;
        const candidate = { affixTypeName, effectValue, ranges: parseAffixRollRangeSpecs(effectValue) };
        sameNameCandidates.push(candidate);
        if (tierNumber && Number(tier?.level || 0) === tierNumber) exactTierCandidates.push(candidate);
      }
    }
    return exactTierCandidates.length ? exactTierCandidates : sameNameCandidates;
  };

  const getCraftBenchRollCandidates = (equipment, affix) => {
    const craftList = Array.isArray(state.craftBench?.list) ? state.craftBench.list : [];
    if (!craftList.length) return [];
    const affixMagicIds = getAffixMagicIds(affix);
    if (!affixMagicIds.size) return [];
    const affixType = Number(affix?.type || 0);
    const equipmentMask = parseEquipmentTypeMask(equipment?.equipmentType);
    return craftList
      .filter((craft) => {
        const craftAffix = craft?.affix || {};
        if (affixType && Number(craftAffix.type || 0) !== affixType) return false;
        if (equipmentMask && !isCraftBenchForMask(craft, equipmentMask)) return false;
        const craftMagicIds = Object.keys(craftAffix.magics || {}).map(String);
        return craftMagicIds.length && craftMagicIds.every((magicId) => affixMagicIds.has(magicId));
      })
      .map((craft) => {
        const effectValue = String(craft.label || formatCraftBenchLabel(craft) || craft.affix?.name || '').trim();
        return {
          affixTypeName: '工艺词缀',
          effectValue,
          ranges: parseCraftBenchRollRanges(craft.affix),
        };
      })
      .filter((candidate) => candidate.ranges.length);
  };

  const calculateAffixRollPercentages = (equipment, affix) => {
    const affixName = String(affix?.name || affix?.affixName || '').trim() || '未知词缀';
    const actualValues = flattenAffixMagicValues(affix);
    const knownCandidates = getKnownAffixRollCandidates(equipment, affix);
    const shouldUseCraftCandidates = affix?.isCrafted === true || !knownCandidates.length;
    const craftCandidates = shouldUseCraftCandidates ? getCraftBenchRollCandidates(equipment, affix) : [];
    const candidates = affix?.isCrafted === true
      ? [...craftCandidates, ...knownCandidates]
      : [...knownCandidates, ...craftCandidates];
    if (!candidates.length) {
      const equipmentKeys = getAffixEquipmentKeysForEquipment(equipment);
      const equipmentText = equipmentKeys.length ? equipmentKeys.join('/') : `装备类型 ${equipment?.equipmentType ?? '未知'}`;
      const craftHint = state.craftBench?.loaded ? '工艺列表' : '工艺列表未加载';
      addLog(`${affixName} 未在 ${equipmentText} 的本地词缀表或${craftHint}中找到，已跳过该词缀的 Roll 计算。`, 'warn');
      return [];
    }
    const fixedRollCandidate = candidates.find((candidate) => !candidate.ranges.length);
    const rangedCandidates = candidates.filter((candidate) => candidate.ranges.length);
    if (!actualValues.length) {
      if (fixedRollCandidate) return [100];
      throw new Error(`${affixName} 缺少实际 Roll 值，已停止自动化打造。`);
    }
    if (!rangedCandidates.length) return [100];
    const matchedCandidate = rangedCandidates
      .flatMap((candidate) => getAffixMagnitudeMultiplierCandidates(equipment, affix, candidate)
        .map((magnitudeMultiplier) => {
          const percentages = matchAffixRollRangesToActualValues(candidate.ranges, actualValues, magnitudeMultiplier);
          return percentages?.length ? { candidate, percentages, magnitudeMultiplier } : null;
        }))
      .find(Boolean);
    if (!matchedCandidate && fixedRollCandidate) return [100];
    if (!matchedCandidate) {
      const candidateSummary = rangedCandidates.slice(0, 3).map((candidate) => {
        const rangeText = candidate.ranges.map((range) => `${range.min}–${range.max}`).join('/');
        const multiplierText = getAffixMagnitudeMultiplierCandidates(equipment, affix, candidate)
          .map((value) => formatAffixActualNumber(value))
          .join('/');
        return `${candidate.affixTypeName}:${rangeText}（倍率 ${multiplierText}）`;
      }).join('；');
      throw new Error(`${affixName} 的实际 Roll 值 ${actualValues.map(formatAffixActualNumber).join('/')} 无法匹配本地词缀表范围${candidateSummary ? `：${candidateSummary}` : ''}，已停止自动化打造。`);
    }
    return matchedCandidate.percentages;
  };

  const getAffixRollConditionValue = (equipment, metric) => {
    const source = AFFIX_ROLL_METRIC_SOURCES[metric];
    if (!source) return undefined;
    const affixes = (Array.isArray(equipment?.affixes) ? equipment.affixes : [])
      .filter((affix) => source.affixTypes.includes(Number(affix?.type)))
      .filter((affix) => !source.craftedOnly || affix?.isCrafted === true);
    if (!affixes.length) {
      const metricLabel = ROLL_CONDITION_METRICS[metric]?.label || metric;
      const targetText = source.craftedOnly ? '工艺词缀' : '前后缀';
      throw new Error(`${equipment?.name || '当前装备'} 没有可计算“${metricLabel}”的${targetText}，已停止自动化打造。`);
    }
    const percentages = affixes.flatMap((affix) => calculateAffixRollPercentages(equipment, affix));
    if (!percentages.length) {
      const metricLabel = ROLL_CONDITION_METRICS[metric]?.label || metric;
      throw new Error(`${equipment?.name || '当前装备'} 没有可计算“${metricLabel}”的 Roll 范围，已停止自动化打造。`);
    }
    if (source.aggregate === 'minimum') return Math.min(...percentages);
    return percentages.reduce((sum, value) => sum + value, 0) / percentages.length;
  };

  const getSpecialConditionValue = (equipment, metric) => {
    const affixSummary = getMagicAffixSummary(equipment?.affixes);
    const affixSlotLimits = getAffixSlotLimits(equipment?.rarity, equipment);
    if (metric === 'totalAffixCount') return affixSummary.totalCount;
    if (metric === 'prefixCount') return affixSummary.prefixCount;
    if (metric === 'suffixCount') return affixSummary.suffixCount;
    if (metric === 'rarity') return Number(equipment?.rarity || RARITY_TYPES.normal);
    if (metric === 'corrupted') return Boolean(equipment?.corrupted);
    if (metric === 'crafted') return hasCraftedAffix(equipment);
    if (metric === 'craftedMultimod') return hasMultiMasterCraftAffix(equipment);
    if (metric === 'openPrefix') return affixSummary.prefixCount < affixSlotLimits.prefix;
    if (metric === 'openSuffix') return affixSummary.suffixCount < affixSlotLimits.suffix;
    if (metric === 'openAffix') {
      return affixSummary.prefixCount < affixSlotLimits.prefix || affixSummary.suffixCount < affixSlotLimits.suffix;
    }
    return undefined;
  };

  const isConditionMatched = (equipment, condition, affixNames) => {
    const normalizedCondition = normalizeAffixCondition(condition);
    if (isSpecialCondition(normalizedCondition)) {
      return compareConditionValue(
        getSpecialConditionValue(equipment, normalizedCondition.metric),
        normalizedCondition.operator,
        normalizedCondition.value,
      );
    }
    if (isRollCondition(normalizedCondition)) {
      const currentValue = AFFIX_ROLL_METRIC_SOURCES[normalizedCondition.metric]
        ? getAffixRollConditionValue(equipment, normalizedCondition.metric)
        : getEquipmentDamageValue(equipment, normalizedCondition.metric);
      return compareConditionValue(
        currentValue,
        normalizedCondition.operator,
        normalizedCondition.value,
      );
    }
    return affixNames.includes(normalizedCondition.name);
  };

  /**
   * isAffixMatched 判断装备是否满足任意条件组。
   * @param {object|Array<object>} equipmentOrAffixes 装备对象，兼容旧调用传入 affixes 数组。
   * @param {Array<object>} conditionGroups 条件组。
   * @returns {boolean} 满足条件时返回 true。
   */
  const isAffixMatched = (equipmentOrAffixes, conditionGroups) => {
    const equipment = Array.isArray(equipmentOrAffixes) ? { affixes: equipmentOrAffixes } : (equipmentOrAffixes || {});
    const affixNames = getAffixNames(equipment.affixes);
    if (!conditionGroups.length) return false;
    return conditionGroups.some((group) => {
      const normalizedGroup = normalizeAffixConditionGroup(group);
      const cleanGroup = normalizedGroup.conditions;
      if (!cleanGroup.length) return false;
      const matchedCount = cleanGroup.filter((condition) => isConditionMatched(equipment, condition, affixNames)).length;
      const requiredCount = Math.min(normalizedGroup.minRequired, cleanGroup.length);
      return matchedCount >= requiredCount;
    });
  };

  /**
   * getMagicAffixSummary 统计魔法装备的前后缀数量。
   * @param {Array<object>} affixes 装备词缀数组。
   * @returns {object} 前后缀统计信息。
   */
  const normalizeAffixPositionType = (affix) => {
    const rawPosition = affix?.position ?? affix?.type ?? affix?.affixType ?? affix?.prefixSuffix ?? '';
    const positionText = String(rawPosition).trim().toLowerCase();
    const position = Number(rawPosition || 0);
    if (position === 1 || affix?.isPrefix || ['prefix', '前缀', '前'].includes(positionText)) return 'prefix';
    if (position === 2 || affix?.isSuffix || ['suffix', '后缀', '后'].includes(positionText)) return 'suffix';
    return '';
  };

  const getMagicAffixSummary = (affixes) => {
    const summary = { prefixCount: 0, suffixCount: 0, totalCount: 0 };
    for (const affix of Array.isArray(affixes) ? affixes : []) {
      const positionType = normalizeAffixPositionType(affix);
      if (positionType === 'prefix') summary.prefixCount += 1;
      if (positionType === 'suffix') summary.suffixCount += 1;
    }
    summary.totalCount = summary.prefixCount + summary.suffixCount;
    return summary;
  };

  const formatCraftSnapshotAffix = (affix) => {
    const tierNumber = getAffixTierNumber(affix);
    const tierText = tierNumber ? `T${tierNumber} ` : '';
    const craftedText = affix?.isCrafted === true ? '工艺 ' : '';
    const nameText = affix?.name || affix?.affixName || '未知词缀';
    const effectText = getAffixEffectText(affix);
    return `${craftedText}${tierText}${nameText}${effectText ? `：${effectText}` : ''}`;
  };

  const formatEquipmentAffixSnapshot = (equipment) => {
    const affixes = Array.isArray(equipment?.affixes) ? equipment.affixes : [];
    return affixes.length ? affixes.map((affix) => {
      const positionText = formatAffixPositionName(affix?.type);
      return `${positionText} ${formatCraftSnapshotAffix(affix)}`;
    }).join('；') : '无';
  };

  const logContinuousCraftAffixSnapshot = (equipment, stepIndex, actionLabel) => {
    addMainLog(`${equipment.name} 步骤 ${formatContinuousStepCode(stepIndex)} ${actionLabel}后，当前词缀：${formatEquipmentAffixSnapshot(equipment)}。`);
  };

  /**
   * shouldUseAugment 判断魔法装备是否还需要补增幅石。
   * @param {object} equipment 装备对象。
   * @returns {boolean} 需要增幅时返回 true。
   */
  const shouldUseAugment = (equipment) => {
    if (Number(equipment.rarity) !== RARITY_TYPES.magic) return false;
    return getMagicAffixSummary(equipment.affixes).totalCount < 2;
  };

  /**
   * getSocketSummary 统计插槽颜色、插槽总数和链接组数量。
   * @param {Array<Array<object>>} sockets 装备插槽数据。
   * @returns {object} 插槽统计信息。
   */
  const getSocketSummary = (sockets) => {
    const summary = { red: 0, green: 0, blue: 0, total: 0, groups: 0 };
    if (!Array.isArray(sockets)) return summary;
    summary.groups = sockets.length;
    for (const group of sockets) {
      if (!Array.isArray(group)) continue;
      for (const socket of group) {
        const socketType = Number(socket?.type);
        if (socketType === 1) summary.red += 1;
        if (socketType === 2) summary.green += 1;
        if (socketType === 3) summary.blue += 1;
        if ([1, 2, 3].includes(socketType)) summary.total += 1;
      }
    }
    return summary;
  };

  /**
   * isColorTargetMatched 判断插槽颜色是否已经覆盖用户目标。
   * 目标是“至少满足”而不是完全相等，例如红1绿1蓝1时，红2绿1蓝1也算命中。
   * @param {object} socketSummary 当前插槽统计。
   * @param {object} targetColor 用户目标颜色数量。
   * @returns {boolean} 每种目标颜色均达到指定数量时返回 true。
   */
  const isColorTargetMatched = (socketSummary, targetColor) => (
    socketSummary.red >= targetColor.red &&
    socketSummary.green >= targetColor.green &&
    socketSummary.blue >= targetColor.blue
  );

  /**
   * formatSocketSummary 把插槽统计格式化成日志文本。
   * @param {object} socketSummary 插槽统计信息。
   * @returns {string} 可读的颜色统计文本。
   */
  const formatSocketSummary = (socketSummary) => (
    `红${socketSummary.red} 绿${socketSummary.green} 蓝${socketSummary.blue} 总${socketSummary.total}`
  );

  /**
   * addLog 向日志面板追加一条消息。
   * @param {string} message 日志正文。
   * @param {string} level 日志级别：detail/info/success/warn/error。
   */
  const addLog = (message, level = 'info') => {
    const normalizedLevel = normalizeLogLevel(level);
    if (!shouldRecordLog(normalizedLevel)) return;
    const levelConfig = LOG_LEVELS[normalizedLevel];
    const logItem = {
      time: new Date().toLocaleTimeString(),
      level: normalizedLevel,
      levelLabel: levelConfig.label,
      className: levelConfig.className,
      message,
    };
    state.logs.unshift(logItem);
    state.logs = state.logs.slice(0, 160);
    renderLogs();
  };

  /**
   * renderLogs 根据 state.logs 重绘日志面板。
   */
  const renderLogs = () => {
    const logListElement = state.ui.logList;
    if (!logListElement) return;
    logListElement.replaceChildren(...state.logs.map((logItem) => {
      const rowElement = document.createElement('div');
      rowElement.className = `poe2-log-row poe2-log-${logItem.className || logItem.level}`;
      rowElement.textContent = `[${logItem.time}][${logItem.levelLabel || LOG_LEVELS[normalizeLogLevel(logItem.level)].label}] ${logItem.message}`;
      return rowElement;
    }));
  };

  /**
   * setRunningState 切换任务运行状态并同步按钮禁用状态。
   * @param {boolean} isRunning 是否正在运行。
   * @param {string} taskName 当前任务名称。
   */
  const setRunningState = (isRunning, taskName = '') => {
    state.isRunning = isRunning;
    state.currentTaskName = taskName;
    if (isRunning) {
      state.abortController = new AbortController();
      state.currentTaskStartedAt = Date.now();
      resetCurrencyUsage();
    } else {
      state.abortController = null;
      state.currentTaskStartedAt = 0;
      state.currentTaskTargetCount = 0;
      state.currentPage = 1;
      state.completedCount = 0;
      state.processedEquipmentIds.clear();
    }
    for (const button of state.ui.taskButtons || []) {
      button.disabled = isRunning;
    }
    for (const button of Object.values(state.ui.stopButtons || {})) {
      button.disabled = !isRunning;
    }
    updateSkillStoneActionButtonState();
    updateRankAnalysisActionButtonState();
  };

  /**
   * stopCurrentTask 请求中断当前任务。
   */
  const stopCurrentTask = () => {
    if (!state.isRunning) return;
    state.abortController?.abort();
    logCurrencyUsageSummary('任务停止时通货统计', 'warn');
    logCountedCraftTaskSummary('停止汇总', 'warn');
    logCraftTaskElapsed('任务停止时耗时', 'warn');
    setRunningState(false);
    addLog('已停止当前任务。', 'lifecycle');
  };

  const stopTaskForSafetyLimit = (message) => {
    if (state.isRunning) {
      addLog(message, 'warn');
      stopCurrentTask();
    }
    throw new Error(message);
  };

  /**
   * runTask 包装所有自动化任务，统一处理状态、异常和收尾。
   * @param {string} taskName 任务名称。
   * @param {Function} taskRunner 实际任务函数。
   */
  const runTask = async (taskName, taskRunner) => {
    if (state.isRunning) return;
    try {
      assertLoggedIn();
      setRunningState(true, taskName);
      addLog(`开始任务：${taskName}`, 'lifecycle');
      await taskRunner();
      if (state.isRunning) {
        logCurrencyUsageSummary('任务通货统计', 'success');
        logCountedCraftTaskSummary('最终汇总', 'success', taskName);
        logCraftTaskElapsed('任务耗时', 'success', taskName);
        addLog(`任务结束：${taskName}`, 'lifecycle');
      }
    } catch (error) {
      if (!isRequestAbortError(error)) {
        logCurrencyUsageSummary('任务中断时通货统计', 'warn');
        logCountedCraftTaskSummary('中断汇总', 'warn', taskName);
        logCraftTaskElapsed('任务中断时耗时', 'warn', taskName);
        addLog(`${taskName} 失败：${error.message}`, 'error');
      }
    } finally {
      setRunningState(false);
    }
  };

  /**
   * readTaskOptions 从 UI 控件读取本次任务参数。
   * @returns {object} 标准化任务参数。
   */
  const readTaskOptions = () => {
    const targetCount = Math.max(1, Number.parseInt(state.ui.targetCountInput.value, 10) || 1);
    state.currentTaskTargetCount = targetCount;
    const rarityValue = state.ui.raritySelect.value;
    const rarity = rarityValue === RARITY_TYPES.any ? RARITY_TYPES.any : Number.parseInt(rarityValue, 10);
    const keyword = state.ui.keywordInput.value.trim();
    const targetColor = {
      red: Number.parseInt(state.ui.redInput.value, 10) || 0,
      green: Number.parseInt(state.ui.greenInput.value, 10) || 0,
      blue: Number.parseInt(state.ui.blueInput.value, 10) || 0,
    };
    return {
      keyword,
      rarity,
      targetCount,
      targetColor,
      useStorage: state.useStorage,
      affixConditionGroups: getAffixConditionGroups(),
      continuousCraftSteps: getContinuousCraftSteps(),
      batchStoneType: Number.parseInt(state.ui.batchStoneSelect.value, 10),
    };
  };

  const conditionGroupsNeedCraftBenchRollRanges = (conditionGroups) => (
    (Array.isArray(conditionGroups) ? conditionGroups : []).some((group) => (
      (Array.isArray(group?.conditions) ? group.conditions : []).some((condition) => {
        const normalizedCondition = normalizeAffixCondition(condition);
        return isRollCondition(normalizedCondition) && Boolean(AFFIX_ROLL_METRIC_SOURCES[normalizedCondition.metric]);
      })
    ))
  );

  const continuousStepsNeedCraftBenchRollRanges = (steps) => (
    normalizeContinuousCraftSteps(steps).some((step) => (
      conditionGroupsNeedCraftBenchRollRanges(step.conditionGroups)
    ))
  );

  const ensureCraftBenchListForRollConditions = async (options) => {
    const needsCraftBenchList = conditionGroupsNeedCraftBenchRollRanges(options?.affixConditionGroups)
      || continuousStepsNeedCraftBenchRollRanges(options?.continuousCraftSteps);
    if (!needsCraftBenchList) return;
    await ensureCraftBenchList();
  };

  /**
   * createClassicCraftSnapshot 读取经典打造启动瞬间的选项和词缀条件快照。
   * @param {string} taskName 任务名称，用于日志提示。
   * @param {object} limits 该任务可实现的前后缀上限。
   * @returns {object} 本次任务固定使用的选项快照。
   */
  const createClassicCraftSnapshot = (taskName, limits) => {
    state.affixConditionContext = { mode: 'normal', stepIndex: 0 };
    renderAffixConditionBuilder();
    const options = readTaskOptions();
    const conditionGroups = snapshotAffixConditionGroups(options.affixConditionGroups);
    assertAffixConditionsPossible(conditionGroups, limits, taskName);
    addLog(`${taskName} 已锁定本次目标筛选和判断条件快照，运行期间继续修改 UI 不会影响当前任务。`, 'compact');
    return { ...options, affixConditionGroups: conditionGroups };
  };

  /**
   * createCustomCraftSnapshot 保存当前编辑步骤后，读取自定义打造启动瞬间的完整步骤快照。
   * @returns {object} 本次任务固定使用的选项和步骤快照。
   */
  const createCustomCraftSnapshot = () => {
    saveCurrentContinuousStepSilently();
    const options = readTaskOptions();
    const steps = snapshotContinuousCraftSteps(options.continuousCraftSteps);
    assertContinuousCraftStepsPossible(steps);
    addLog(`自定义打造已锁定本次目标筛选、步骤、条件成立/不成立处理和判断条件快照；自定义打造步骤上限 ${state.customCraftStepSafetyLimit} 次，总通货上限 ${state.customCraftCurrencyLimit} 个。运行期间继续修改 UI 不会影响当前任务。`, 'compact');
    return { ...options, continuousCraftSteps: steps };
  };

  /**
   * sanitizeCraftPlanOptions 把外部读取到的自定义方案参数清洗成 UI 可应用的安全形态。
   * @param {object} rawOptions 原始方案参数。
   * @returns {object} 标准化后的打造方案参数。
   */
  const sanitizeCraftPlanOptions = (rawOptions = {}) => {
    const rarity = rawOptions.rarity === RARITY_TYPES.any
      ? RARITY_TYPES.any
      : Number.parseInt(rawOptions.rarity, 10);
    return {
      keyword: String(rawOptions.keyword || '').trim(),
      rarity: rarity === RARITY_TYPES.any || Number.isFinite(rarity) ? rarity : RARITY_TYPES.normal,
      targetCount: Math.max(1, Number.parseInt(rawOptions.targetCount, 10) || 1),
      continuousCraftSteps: normalizeContinuousCraftSteps(rawOptions.continuousCraftSteps),
      useStorage: Boolean(rawOptions.useStorage),
      omitTargetFilters: Boolean(rawOptions.omitTargetFilters),
    };
  };

  /**
   * captureCraftPlanOptions 读取当前界面上的自定义打造配置，作为方案保存或导出。
   * @returns {object} 当前自定义方案参数。
   */
  const captureCraftPlanOptions = () => sanitizeCraftPlanOptions({
    keyword: state.ui.keywordInput?.value,
    rarity: state.ui.raritySelect?.value,
    targetCount: state.ui.targetCountInput?.value,
    continuousCraftSteps: getContinuousCraftSteps(),
    useStorage: state.useStorage,
  });

  /**
   * normalizeCraftPlan 把本地或分享码中的方案对象整理成统一格式。
   * @param {object} rawPlan 原始方案对象。
   * @returns {object|null} 可用方案；无效时返回 null。
   */
  const normalizeCraftPlan = (rawPlan) => {
    if (!rawPlan || typeof rawPlan !== 'object') return null;
    const options = sanitizeCraftPlanOptions(rawPlan.options || rawPlan);
    return {
      id: String(rawPlan.id || `plan-${Date.now()}`),
      name: String(rawPlan.name || '未命名方案').trim() || '未命名方案',
      updatedAt: Number(rawPlan.updatedAt || Date.now()),
      options,
    };
  };

  /**
   * normalizeCraftPlanList 清理本地方案列表，兼容旧数据和手动编辑后的异常数据。
   * @param {Array<object>} rawPlans 原始方案列表。
   * @returns {Array<object>} 可安全渲染和读取的方案列表。
   */
  const normalizeCraftPlanList = (rawPlans) => (Array.isArray(rawPlans) ? rawPlans : [])
    .map(normalizeCraftPlan)
    .filter(Boolean);

  /**
   * encodeBytesBase64Url 把压缩后的字节编码为 base64url。
   * @param {Uint8Array} bytes 原始字节。
   * @returns {string} base64url 文本。
   */
  const encodeBytesBase64Url = (bytes) => {
    let binaryText = '';
    for (const byte of bytes) binaryText += String.fromCharCode(byte);
    return btoa(binaryText).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };

  /**
   * decodeBytesBase64Url 把 base64url 文本还原为字节。
   * @param {string} code base64url 文本。
   * @returns {Uint8Array} 原始字节。
   */
  const decodeBytesBase64Url = (code) => {
    const normalizedCode = String(code || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const paddedCode = normalizedCode.padEnd(Math.ceil(normalizedCode.length / 4) * 4, '=');
    const binaryText = atob(paddedCode);
    return Uint8Array.from(binaryText, (character) => character.charCodeAt(0));
  };

  /**
   * compressTextWithDeflateRaw 使用浏览器原生 CompressionStream 压缩分享码 payload。
   * @param {string} text 原始 JSON 文本。
   * @returns {Promise<Uint8Array>} 压缩字节。
   */
  const compressTextWithDeflateRaw = async (text) => {
    if (typeof CompressionStream !== 'function') {
      throw new Error('当前浏览器不支持 CompressionStream，无法导出当前格式分享码。');
    }
    const stream = new Blob([new TextEncoder().encode(text)])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  /**
   * decompressTextWithDeflateRaw 解压新版压缩分享码。
   * @param {Uint8Array} bytes 压缩字节。
   * @returns {Promise<string>} 解压后的 JSON 文本。
   */
  const decompressTextWithDeflateRaw = async (bytes) => {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('当前浏览器不支持 DecompressionStream，无法读取压缩分享码。');
    }
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };

  /**
   * compactAffixCondition 把词缀条件压成数字 id 或数组，减少 name/affixType 这些重复 key。
   * @param {object} condition 标准词缀条件。
   * @returns {number|Array|string} 精简条件。
   */
  const compactAffixCondition = (condition) => {
    if (isSpecialCondition(condition)) {
      return [
        '$',
        encodeShareEnumValue(condition.metric, SHARE_SPECIAL_METRIC_ENUM),
        encodeShareEnumValue(condition.operator, SHARE_SPECIAL_OPERATOR_ENUM),
        condition.value,
      ];
    }
    if (isRollCondition(condition)) {
      return [
        'r',
        encodeShareEnumValue(condition.metric, SHARE_ROLL_METRIC_ENUM),
        encodeShareEnumValue(condition.operator, SHARE_SPECIAL_OPERATOR_ENUM),
        condition.value,
      ];
    }
    const normalizedCondition = normalizeAffixCondition(condition);
    const affixId = getAffixConditionId(normalizedCondition);
    if (affixId) return affixId;
    return normalizedCondition.affixType ? [normalizedCondition.name, normalizedCondition.affixType] : normalizedCondition.name;
  };

  /**
   * expandAffixCondition 还原新版短码里的词缀条件。
   * @param {number|Array|string|object} compactCondition 精简条件。
   * @returns {object} 标准词缀条件。
   */
  const expandAffixCondition = (compactCondition) => {
    if (typeof compactCondition === 'number') {
      const affixCondition = getAffixConditionById(compactCondition);
      if (!affixCondition) {
        throw new Error(`分享码包含未知词缀 ID：${compactCondition}`);
      }
      return normalizeAffixCondition(affixCondition);
    }
    if (Array.isArray(compactCondition)) {
      if (compactCondition[0] === '$' || compactCondition[0] === 0) {
        return normalizeAffixCondition({
          kind: 'special',
          metric: decodeShareEnumValue(compactCondition[1], SHARE_SPECIAL_METRIC_ENUM, compactCondition[1]),
          operator: decodeShareEnumValue(compactCondition[2], SHARE_SPECIAL_OPERATOR_ENUM, compactCondition[2]),
          value: compactCondition[3],
        });
      }
      if (compactCondition[0] === 'r') {
        return normalizeAffixCondition({
          kind: 'roll',
          metric: decodeShareEnumValue(compactCondition[1], SHARE_ROLL_METRIC_ENUM, compactCondition[1]),
          operator: decodeShareEnumValue(compactCondition[2], SHARE_SPECIAL_OPERATOR_ENUM, compactCondition[2]),
          value: compactCondition[3],
        });
      }
      return normalizeAffixCondition({ name: compactCondition[0], affixType: compactCondition[1] });
    }
    return normalizeAffixCondition(compactCondition);
  };

  /**
   * compactAffixConditionGroups 把条件组压成 [命中数, 条件列表]。
   * @param {Array<object>} groups 标准条件组。
   * @returns {Array<Array>} 精简条件组列表。
   */
  const compactAffixConditionGroups = (groups) => (Array.isArray(groups) ? groups : [])
    .map(normalizeAffixConditionGroup)
    .filter((group) => group.conditions.length > 0)
    .map((group) => [
      Math.min(group.minRequired, group.conditions.length),
      group.conditions.map(compactAffixCondition),
    ]);

  /**
   * expandAffixConditionGroups 还原新版短码条件组。
   * @param {Array<Array|object>} compactGroups 精简条件组列表。
   * @returns {Array<object>} 标准条件组列表。
   */
  const expandAffixConditionGroups = (compactGroups) => (Array.isArray(compactGroups) ? compactGroups : [])
    .map((group) => {
      if (!Array.isArray(group)) return normalizeAffixConditionGroup(group);
      return normalizeAffixConditionGroup({
        minRequired: group[0],
        conditions: (Array.isArray(group[1]) ? group[1] : []).map(expandAffixCondition),
      });
    })
    .filter((group) => group.conditions.length > 0);

  const getContinuousStepFutureTargetLabels = (steps) => {
    const normalizedSteps = normalizeContinuousCraftSteps(steps);
    const stepCount = normalizedSteps.length;
    const labels = [];
    const resolveTarget = (targetStepIndex, fallbackStepIndex) => {
      const rawIndex = Number.isInteger(targetStepIndex) ? targetStepIndex : fallbackStepIndex;
      return Math.max(0, Math.min(rawIndex, stepCount));
    };
    normalizedSteps.forEach((step, stepIndex) => {
      if (step.successHandling === 'jump') {
        const targetIndex = resolveTarget(step.successTargetStepIndex, stepIndex + 1);
        if (targetIndex >= stepCount) {
          labels.push(`步骤${formatContinuousStepCode(stepIndex)} 的下一步/条件成立跳转`);
        }
      }
      if (step.action === 'conditionCheck' && step.failureHandling === 'jump') {
        const targetIndex = resolveTarget(step.failureTargetStepIndex, stepIndex);
        if (targetIndex >= stepCount) {
          labels.push(`步骤${formatContinuousStepCode(stepIndex)} 的条件不成立跳转`);
        }
      }
    });
    return labels;
  };

  const assertNoFutureContinuousStepTargetsForExport = (steps) => {
    const labels = getContinuousStepFutureTargetLabels(steps);
    if (!labels.length) return;
    throw new Error(`不能导出分享码：${labels.join('、')} 仍指向“步骤 ${formatContinuousStepCode(normalizeContinuousCraftSteps(steps).length)}（新增后）”。请先新增该步骤，或把对应处理改为“终止(打造成功/手动操作/异常错误)”。`);
  };

  /**
   * compactContinuousCraftSteps 把自定义打造步骤压成短数组。
   * 格式为 [动作, 条件成立处理, 条件成立目标, 条件不成立处理, 条件不成立目标, 条件组, 工艺部位, 工艺 ID, 花园部位, 花园工艺 key]。
   * @param {Array<object>} steps 标准自定义打造步骤。
   * @returns {Array<Array>} 精简步骤列表。
   */
  const compactContinuousCraftSteps = (steps) => migrateLegacyContinuousCraftCompletionTargets(normalizeContinuousCraftSteps(steps))
    .map((step) => {
      const groups = compactAffixConditionGroups(step.conditionGroups);
      const usesCraftBenchSelection = ['craftBench', 'smartCraftBench'].includes(step.action);
      const usesGardenCraftSelection = step.action === 'gardenCraft';
      return [
        encodeShareEnumValue(step.action, SHARE_ACTION_ENUM),
        encodeShareEnumValue(step.successHandling, SHARE_STEP_HANDLING_ENUM),
        step.successTargetStepIndex,
        encodeShareEnumValue(step.failureHandling, SHARE_STEP_HANDLING_ENUM),
        step.failureTargetStepIndex,
        groups,
        usesCraftBenchSelection ? encodeShareEnumValue(step.craftCategory, SHARE_CRAFT_CATEGORY_ENUM) : '',
        usesCraftBenchSelection ? step.craftId : '',
        usesGardenCraftSelection ? encodeShareEnumValue(step.gardenCraftCategory, SHARE_GARDEN_CRAFT_CATEGORY_ENUM) : '',
        usesGardenCraftSelection ? step.gardenCraftKey : '',
      ];
    });

  /**
   * expandContinuousCraftSteps 还原新版短码自定义打造步骤。
   * @param {Array<Array|object>} compactSteps 精简步骤列表。
   * @returns {Array<object>} 标准步骤列表。
   */
  const expandContinuousCraftSteps = (compactSteps) => {
    if (!Array.isArray(compactSteps)) return [];
    return migrateLegacyContinuousCraftCompletionTargets(normalizeContinuousCraftSteps(compactSteps.map((step) => {
      if (!Array.isArray(step)) return step;
      const action = decodeShareStepAction(step[0]);
      return createContinuousCraftStep(
        action,
        expandAffixConditionGroups(step[5]),
        decodeShareStepHandling(step[3]),
        decodeShareStepHandling(step[1]),
        Number.isInteger(step[2]) ? step[2] : null,
        Number.isInteger(step[4]) ? step[4] : 0,
        decodeShareEnumValue(step[6], SHARE_CRAFT_CATEGORY_ENUM, step[6]),
        step[7],
        '',
        decodeShareEnumValue(step[8], SHARE_GARDEN_CRAFT_CATEGORY_ENUM, step[8]),
        step[9],
      );
    })));
  };

  /**
   * compactCraftPlan 把方案转成短字段对象，只保留和默认值不同的配置。
   * @param {object} plan 标准自定义方案。
   * @returns {object} 可编码的精简方案。
   */
  const compactCraftPlan = (plan) => {
    const normalizedPlan = normalizeCraftPlan(plan);
    const options = normalizedPlan.options;
    const compactOptions = {};
    const continuousSteps = compactContinuousCraftSteps(options.continuousCraftSteps);
    const defaultStepsText = JSON.stringify(compactContinuousCraftSteps(createDefaultContinuousCraftSteps()));
    if (JSON.stringify(continuousSteps) !== defaultStepsText) compactOptions.s = continuousSteps;
    return {
      v: 3,
      n: normalizedPlan.name,
      o: compactOptions,
    };
  };

  /**
   * expandCompactCraftPlan 把当前 v3 短码对象还原成 normalizeCraftPlan 可识别的完整对象。
   * @param {object} compactPlan v3 短码对象。
   * @returns {object} 完整方案对象。
   */
  const expandCompactCraftPlan = (compactPlan) => {
    const options = compactPlan?.o || {};
    const plan = normalizeCraftPlan({
      name: compactPlan?.n || '导入方案',
      options: {
        continuousCraftSteps: expandContinuousCraftSteps(options.s),
        omitTargetFilters: true,
      },
    });
    return plan;
  };

  /**
   * persistCraftPlans 把当前方案列表保存到浏览器本地存储。
   */
  const persistCraftPlans = () => {
    state.craftPlans = normalizeCraftPlanList(state.craftPlans);
    writeAssistantStorageJson(STORAGE_KEYS.craftPlans, state.craftPlans);
  };

  /**
   * refreshCraftPlanSelect 根据本地方案刷新方案下拉框。
   */
  const refreshCraftPlanSelect = () => {
    const selectElement = state.ui.craftPlanSelect;
    if (!selectElement) return;
    persistCraftPlans();
    setSelectOptions(selectElement, state.craftPlans.map((plan) => ({
      value: plan.id,
      label: plan.name,
    })), '选择本地方案');
  };

  /**
   * setInputValue 写入输入控件值，集中处理 undefined/null。
   * @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} inputElement 目标控件。
   * @param {string|number|boolean} value 要写入的值。
   */
  const setInputValue = (inputElement, value) => {
    if (!inputElement) return;
    inputElement.value = String(value ?? '');
  };

  /**
   * applyCraftPlanOptions 把方案参数写回打造 UI。
   * @param {object} rawOptions 方案参数。
   */
  const applyCraftPlanOptions = (rawOptions) => {
    const options = sanitizeCraftPlanOptions(rawOptions);
    if (!options.omitTargetFilters) {
      setInputValue(state.ui.keywordInput, options.keyword);
      setInputValue(state.ui.raritySelect, options.rarity);
      setInputValue(state.ui.targetCountInput, options.targetCount);
      state.useStorage = options.useStorage;
      setInputValue(state.ui.storageSelect, String(state.useStorage));
    }
    state.continuousCraftSteps = normalizeContinuousCraftSteps(options.continuousCraftSteps);
    state.activeContinuousStepIndex = 0;
    renderContinuousCraftSteps();
  };

  const switchToContinuousCraftTab = () => {
    switchMainTab('craft');
    if (typeof state.ui.switchCraftSubTab === 'function') {
      state.ui.switchCraftSubTab('continuous');
    }
  };

  /**
   * encodeCraftPlanShareCode 把单条方案编码成当前唯一分享码格式。
   * 格式固定为：z + deflate-raw(v3 短字段 JSON) 的 base64url。
   * @param {object} plan 自定义方案。
   * @returns {Promise<string>} 分享码。
   */
  const encodeCraftPlanShareCode = async (plan) => {
    const payload = JSON.stringify(compactCraftPlan(plan));
    return `z${encodeBytesBase64Url(await compressTextWithDeflateRaw(payload))}`;
  };

  /**
   * decodeCraftPlanShareCode 从当前 v3 压缩分享码中读取单条方案。
   * @param {string} shareCode 分享码。
   * @returns {Promise<object>} 标准化后的自定义方案。
   */
  const decodeCraftPlanShareCode = async (shareCode) => {
    const cleanCode = String(shareCode || '').trim();
    if (!cleanCode) throw new Error('请先填写自定义方案分享码。');
    try {
      if (!cleanCode.startsWith('z')) {
        throw new Error('分享码已过时不受支持，请使用当前版本重新导出。');
      }
      const payloadText = await decompressTextWithDeflateRaw(decodeBytesBase64Url(cleanCode.slice(1)));
      const payload = JSON.parse(payloadText);
      if (payload?.v !== 3) {
        throw new Error(`分享码版本已过时不受支持：${payload?.v ?? '未知'}，请使用当前版本重新导出。`);
      }
      const plan = expandCompactCraftPlan(payload);
      if (!plan) throw new Error('分享码内容不是有效自定义方案。');
      plan.id = `plan-${Date.now()}`;
      plan.updatedAt = Date.now();
      return plan;
    } catch (error) {
      throw new Error(`分享码解析失败：${error.message || error}`);
    }
  };

  /**
   * saveCurrentCraftPlan 把当前自定义打造配置保存为本地方案；同名方案覆盖前会要求用户确认。
   */
  const saveCurrentCraftPlan = () => {
    const planName = String(state.ui.craftPlanNameInput?.value || '').trim();
    if (!planName) {
      addLog('请先填写自定义方案名称。', 'warn');
      return;
    }
    const existingPlan = state.craftPlans.find((plan) => plan.name === planName);
    if (existingPlan && !window.confirm(`本地已存在名为“${planName}”的自定义方案，继续保存会覆盖原方案。确认覆盖？`)) {
      addLog(`已取消保存自定义方案：${planName}`, 'compact');
      return;
    }
    const plan = normalizeCraftPlan({
      id: existingPlan?.id || `plan-${Date.now()}`,
      name: planName,
      updatedAt: Date.now(),
      options: captureCraftPlanOptions(),
    });
    state.craftPlans = [
      plan,
      ...state.craftPlans.filter((savedPlan) => savedPlan.id !== plan.id && savedPlan.name !== plan.name),
    ];
    persistCraftPlans();
    refreshCraftPlanSelect();
    setInputValue(state.ui.craftPlanSelect, plan.id);
    addLog(`已保存自定义方案：${plan.name}`, 'compact');
  };

  /**
   * loadSelectedCraftPlan 读取当前下拉框选中的本地自定义方案。
   */
  const loadSelectedCraftPlan = () => {
    const planId = state.ui.craftPlanSelect?.value;
    const plan = state.craftPlans.find((savedPlan) => savedPlan.id === planId);
    if (!plan) {
      addLog('请先选择要读取的自定义方案。', 'warn');
      return;
    }
    applyCraftPlanOptions(plan.options);
    switchToContinuousCraftTab();
    setInputValue(state.ui.craftPlanNameInput, plan.name);
    addLog(`已读取自定义方案：${plan.name}`, 'compact');
  };

  /**
   * deleteSelectedCraftPlan 删除当前下拉框选中的本地自定义方案。
   */
  const deleteSelectedCraftPlan = () => {
    const planId = state.ui.craftPlanSelect?.value;
    const plan = state.craftPlans.find((savedPlan) => savedPlan.id === planId);
    if (!plan) {
      addLog('请先选择要删除的自定义方案。', 'warn');
      return;
    }
    if (!window.confirm(`确认删除自定义方案“${plan.name}”？`)) return;
    state.craftPlans = state.craftPlans.filter((savedPlan) => savedPlan.id !== planId);
    persistCraftPlans();
    refreshCraftPlanSelect();
    setInputValue(state.ui.craftPlanNameInput, '');
    addLog(`已删除自定义方案：${plan.name}`, 'compact');
  };

  /**
   * exportSelectedCraftPlanCode 把选中的本地方案导出到分享码文本框；未选择时导出当前界面配置。
   */
  const exportSelectedCraftPlanCode = async () => {
    const plan = normalizeCraftPlan({
      name: String(state.ui.craftPlanNameInput?.value || '').trim() || '临时方案',
      updatedAt: Date.now(),
      options: captureCraftPlanOptions(),
    });
    assertNoFutureContinuousStepTargetsForExport(plan.options.continuousCraftSteps);
    setInputValue(state.ui.craftPlanShareTextarea, await encodeCraftPlanShareCode(plan));
    addLog(`已导出自定义方案分享码：${plan.name}`, 'compact');
  };

  /**
   * importCraftPlanCode 从分享码文本框读取单条方案并应用到当前界面，不自动保存到本地。
   */
  const importCraftPlanCode = async () => {
    const plan = await decodeCraftPlanShareCode(state.ui.craftPlanShareTextarea?.value);
    setInputValue(state.ui.craftPlanSelect, '');
    setInputValue(state.ui.craftPlanNameInput, plan.name);
    applyCraftPlanOptions(plan.options);
    switchToContinuousCraftTab();
    addLog(`已导入并读取自定义方案：${plan.name}。如需保留，请点击保存方案。`, 'compact');
  };

  /**
   * eachTargetEquipment 按目标数量逐件读取装备并执行处理函数。
   * @param {object} options 任务参数。
   * @param {Function} equipmentHandler 单件装备处理函数。
   */
  const eachTargetEquipment = async (options, equipmentHandler) => {
    while (state.isRunning && state.completedCount < options.targetCount) {
      const equipment = await getNextEquipment(options);
      if (!equipment) {
        addLog('没有找到符合条件的下一件装备。', 'warn');
        return;
      }
      await equipmentHandler(equipment);
      await wait(getSpeedDelay());
    }
  };

  /**
   * collectTargetEquipments 先串行锁定本轮批量通货要处理的装备，避免并发查询拿到重复目标。
   * @param {object} options 任务参数。
   * @returns {Promise<Array<object>>} 本轮要处理的装备快照。
   */
  const collectTargetEquipments = async (options) => {
    const equipments = [];
    let nextProgressLogCount = 30;
    const lockTargetText = options.lockLogLabel
      || `${options.keyword ? `关键词“${options.keyword}”` : ''}${options.excludeCorrupted ? '未腐化' : ''}目标装备`;
    addLog(`开始锁定${lockTargetText}，目标 ${options.targetCount} 件。`, 'compact');
    while (state.isRunning && equipments.length < options.targetCount) {
      const alreadyLockedCount = equipments.length;
      const nextEquipments = await getNextEquipmentBatch(options, options.targetCount - equipments.length, (batchLockedCount) => {
        const totalLockedCount = alreadyLockedCount + batchLockedCount;
        while (totalLockedCount >= nextProgressLogCount) {
          addLog(`已锁定${lockTargetText}：${nextProgressLogCount}/${options.targetCount} 件。`, 'detail');
          nextProgressLogCount += 30;
        }
      });
      if (!nextEquipments.length) break;
      equipments.push(...nextEquipments);
    }
    addLog(`最终锁定${lockTargetText}：${equipments.length}/${options.targetCount} 件。`, 'compact');
    return equipments;
  };

  const getDefaultAdvancedBatchStep = () => ({
    keyword: '',
    skipAfterChanceNonUnique: true,
    enableSocket: false,
    socketTargetColor: { red: 0, green: 0, blue: 0 },
    enableQuality: false,
    qualityStoneType: '',
    enableGardenCraft: false,
    gardenCraftSelection: '',
    enableVaal: false,
    enableDestroyNonUnique: false,
    protectHighQualityNonUnique: false,
    enableStoreCorruptedBaseUnique: false,
  });

  const getDefaultAdvancedBatchPlan = () => ({
    rarity: RARITY_TYPES.any,
    targetCount: 1,
    useStorage: false,
    steps: [getDefaultAdvancedBatchStep()],
  });

  const sanitizeAdvancedBatchRarity = (rawRarity) => {
    if (rawRarity === RARITY_TYPES.any || rawRarity === '') return RARITY_TYPES.any;
    const rarity = Number.parseInt(rawRarity, 10);
    return [RARITY_TYPES.normal, RARITY_TYPES.magic, RARITY_TYPES.rare, RARITY_TYPES.unique].includes(rarity)
      ? rarity
      : RARITY_TYPES.any;
  };

  const sanitizeAdvancedBatchStep = (rawStep = {}) => {
    const qualityStoneType = Number.parseInt(rawStep.qualityStoneType, 10);
    const allowedQualityTypes = [MODIFY_TYPES.whetstone, MODIFY_TYPES.armourScrap, MODIFY_TYPES.glassblowerBauble];
    const socketTargetColor = rawStep.socketTargetColor || {};
    return {
      keyword: String(rawStep.keyword || '').trim(),
      skipAfterChanceNonUnique: rawStep.skipAfterChanceNonUnique !== false,
      enableSocket: Boolean(rawStep.enableSocket),
      socketTargetColor: {
        red: Math.max(0, Number.parseInt(socketTargetColor.red, 10) || 0),
        green: Math.max(0, Number.parseInt(socketTargetColor.green, 10) || 0),
        blue: Math.max(0, Number.parseInt(socketTargetColor.blue, 10) || 0),
      },
      enableQuality: Boolean(rawStep.enableQuality),
      qualityStoneType: allowedQualityTypes.includes(qualityStoneType) ? qualityStoneType : '',
      enableGardenCraft: Boolean(rawStep.enableGardenCraft),
      gardenCraftSelection: String(rawStep.gardenCraftSelection || ''),
      enableVaal: Boolean(rawStep.enableVaal),
      enableDestroyNonUnique: Boolean(rawStep.enableDestroyNonUnique),
      protectHighQualityNonUnique: Boolean(rawStep.protectHighQualityNonUnique),
      enableStoreCorruptedBaseUnique: Boolean(rawStep.enableStoreCorruptedBaseUnique),
    };
  };

  const sanitizeAdvancedBatchPlan = (rawPlan = {}) => {
    const rawSteps = Array.isArray(rawPlan.steps) ? rawPlan.steps : [];
    const steps = rawSteps
      .map((step) => sanitizeAdvancedBatchStep(step))
      .filter((step) => step);
    return {
      rarity: sanitizeAdvancedBatchRarity(rawPlan.rarity),
      targetCount: Math.max(1, Number.parseInt(rawPlan.targetCount, 10) || 1),
      useStorage: rawPlan.useStorage === true || rawPlan.useStorage === 'true',
      steps: steps.length ? steps : [getDefaultAdvancedBatchStep()],
    };
  };

  const getAdvancedBatchRarityLabel = (rarity) => {
    if (rarity === RARITY_TYPES.any || rarity === '' || rarity === undefined || rarity === null) return '不限稀有度';
    return SPECIAL_CONDITION_RARITY_LABELS[Number(rarity)] || '指定稀有度';
  };

  const readSavedAdvancedBatchPlan = () => sanitizeAdvancedBatchPlan(
    readAssistantStorageJson(STORAGE_KEYS.advancedBatchPlan, getDefaultAdvancedBatchPlan()),
  );

  const captureAdvancedBatchStepFromUi = () => sanitizeAdvancedBatchStep({
    keyword: state.ui.advancedBatchKeywordInput?.value,
    enableSocket: state.ui.advancedBatchSocketInput?.checked,
    socketTargetColor: {
      red: state.ui.advancedBatchRedInput?.value,
      green: state.ui.advancedBatchGreenInput?.value,
      blue: state.ui.advancedBatchBlueInput?.value,
    },
    enableQuality: state.ui.advancedBatchQualityInput?.checked,
    qualityStoneType: state.ui.advancedBatchQualitySelect?.value,
    enableGardenCraft: state.ui.advancedBatchGardenCraftInput?.checked,
    gardenCraftSelection: state.ui.advancedBatchGardenCraftSelect
      ? (state.ui.advancedBatchGardenCraftSelect.value || state.ui.advancedBatchGardenCraftSelect.dataset.pendingGardenCraftSelection || '')
      : '',
    skipAfterChanceNonUnique: state.ui.advancedBatchSkipNonUniqueInput?.checked,
    enableVaal: state.ui.advancedBatchVaalInput?.checked,
    enableDestroyNonUnique: state.ui.advancedBatchDestroyInput?.checked,
    protectHighQualityNonUnique: state.ui.advancedBatchProtectHighQualityInput?.checked,
    enableStoreCorruptedBaseUnique: state.ui.advancedBatchStoreCorruptedBaseInput?.checked,
  });

  const applyAdvancedBatchStepToUi = (rawStep) => {
    const step = sanitizeAdvancedBatchStep(rawStep);
    setInputValue(state.ui.advancedBatchKeywordInput, step.keyword);
    if (state.ui.advancedBatchSkipNonUniqueInput) state.ui.advancedBatchSkipNonUniqueInput.checked = step.skipAfterChanceNonUnique;
    if (state.ui.advancedBatchSocketInput) state.ui.advancedBatchSocketInput.checked = step.enableSocket;
    setInputValue(state.ui.advancedBatchRedInput, step.socketTargetColor.red);
    setInputValue(state.ui.advancedBatchGreenInput, step.socketTargetColor.green);
    setInputValue(state.ui.advancedBatchBlueInput, step.socketTargetColor.blue);
    if (state.ui.advancedBatchQualityInput) state.ui.advancedBatchQualityInput.checked = step.enableQuality;
    setInputValue(state.ui.advancedBatchQualitySelect, step.qualityStoneType);
    if (state.ui.advancedBatchGardenCraftInput) state.ui.advancedBatchGardenCraftInput.checked = step.enableGardenCraft;
    if (state.ui.advancedBatchGardenCraftSelect) {
      state.ui.advancedBatchGardenCraftSelect.dataset.pendingGardenCraftSelection = step.gardenCraftSelection || '';
      setInputValue(state.ui.advancedBatchGardenCraftSelect, step.gardenCraftSelection);
    }
    if (state.ui.advancedBatchVaalInput) state.ui.advancedBatchVaalInput.checked = step.enableVaal;
    if (state.ui.advancedBatchDestroyInput) state.ui.advancedBatchDestroyInput.checked = step.enableDestroyNonUnique;
    if (state.ui.advancedBatchProtectHighQualityInput) state.ui.advancedBatchProtectHighQualityInput.checked = step.protectHighQualityNonUnique;
    if (state.ui.advancedBatchStoreCorruptedBaseInput) state.ui.advancedBatchStoreCorruptedBaseInput.checked = step.enableStoreCorruptedBaseUnique;
  };

  const getActiveAdvancedBatchStepIndex = () => (
    Math.max(0, Math.min(Number.parseInt(state.ui.advancedBatchStepSelect?.value, 10) || 0, state.advancedBatchSteps.length - 1))
  );

  const saveCurrentAdvancedBatchStepSilently = () => {
    if (!state.ui.advancedBatchKeywordInput) return;
    const stepIndex = Math.max(0, Math.min(state.activeAdvancedBatchStepIndex || 0, state.advancedBatchSteps.length - 1));
    state.advancedBatchSteps[stepIndex] = captureAdvancedBatchStepFromUi();
  };

  const renderAdvancedBatchSteps = () => {
    const selectElement = state.ui.advancedBatchStepSelect;
    if (!selectElement) return;
    const activeIndex = Math.max(0, Math.min(state.activeAdvancedBatchStepIndex || 0, state.advancedBatchSteps.length - 1));
    setSelectOptions(selectElement, state.advancedBatchSteps.map((step, index) => {
      const labelKeyword = String(step.keyword || '').trim() || '未填关键词';
      return { value: index, label: `步骤 ${index + 1}：${labelKeyword}` };
    }));
    selectElement.value = String(activeIndex);
  };

  const loadAdvancedBatchStepForEditing = () => {
    const stepIndex = getActiveAdvancedBatchStepIndex();
    state.activeAdvancedBatchStepIndex = stepIndex;
    applyAdvancedBatchStepToUi(state.advancedBatchSteps[stepIndex] || getDefaultAdvancedBatchStep());
  };

  const applyAdvancedBatchPlanToUi = (rawPlan) => {
    const plan = sanitizeAdvancedBatchPlan(rawPlan);
    setInputValue(state.ui.raritySelect, plan.rarity);
    setInputValue(state.ui.targetCountInput, plan.targetCount);
    state.useStorage = plan.useStorage;
    setInputValue(state.ui.storageSelect, String(state.useStorage));
    state.advancedBatchSteps = plan.steps;
    state.activeAdvancedBatchStepIndex = 0;
    renderAdvancedBatchSteps();
    loadAdvancedBatchStepForEditing();
  };

  const captureAdvancedBatchPlanFromUi = () => {
    saveCurrentAdvancedBatchStepSilently();
    return sanitizeAdvancedBatchPlan({
      rarity: state.ui.raritySelect?.value,
      targetCount: state.ui.targetCountInput?.value,
      useStorage: state.useStorage,
      steps: state.advancedBatchSteps,
    });
  };

  const saveAdvancedBatchPlan = () => {
    const plan = captureAdvancedBatchPlanFromUi();
    writeAssistantStorageJson(STORAGE_KEYS.advancedBatchPlan, plan);
    addLog('已保存连续批量配置。', 'compact');
  };

  const loadAdvancedBatchPlan = () => {
    applyAdvancedBatchPlanToUi(readSavedAdvancedBatchPlan());
    scheduleAdvancedBatchGardenCraftOptionsRefresh(false, state.advancedBatchSteps[state.activeAdvancedBatchStepIndex]?.gardenCraftSelection || '');
    addLog('已读取连续批量配置。', 'compact');
  };

  const refreshAdvancedBatchGardenCraftOptions = async (forceRefresh = false, preferredSelection = '') => {
    if (!state.ui.advancedBatchGardenCraftSelect) return;
    await Promise.all(GARDEN_CRAFT_CATEGORY_OPTIONS.map((category) => ensureGardenCraftList(category.value, forceRefresh)));
    const selectedValue = preferredSelection
      || state.ui.advancedBatchGardenCraftSelect.value
      || state.ui.advancedBatchGardenCraftSelect.dataset.pendingGardenCraftSelection
      || '';
    const options = getAdvancedGardenCraftOptions();
    setSelectOptions(state.ui.advancedBatchGardenCraftSelect, options, '选择花园工艺');
    if (options.some((option) => String(option.value) === String(selectedValue))) {
      state.ui.advancedBatchGardenCraftSelect.value = selectedValue;
      state.ui.advancedBatchGardenCraftSelect.dataset.pendingGardenCraftSelection = '';
    }
  };

  const scheduleAdvancedBatchGardenCraftOptionsRefresh = (forceRefresh = false, preferredSelection = '') => {
    refreshAdvancedBatchGardenCraftOptions(forceRefresh, preferredSelection).catch((error) => {
      addLog(`连续批量花园工艺列表读取失败：${error.message}`, 'error');
    });
  };

  const addAdvancedBatchStep = () => {
    saveCurrentAdvancedBatchStepSilently();
    state.advancedBatchSteps.push(getDefaultAdvancedBatchStep());
    state.activeAdvancedBatchStepIndex = state.advancedBatchSteps.length - 1;
    renderAdvancedBatchSteps();
    loadAdvancedBatchStepForEditing();
  };

  const removeAdvancedBatchStep = () => {
    if (state.advancedBatchSteps.length <= 1) {
      addLog('连续批量至少保留一个步骤。', 'warn');
      return;
    }
    const stepIndex = getActiveAdvancedBatchStepIndex();
    state.advancedBatchSteps.splice(stepIndex, 1);
    state.activeAdvancedBatchStepIndex = Math.max(0, stepIndex - 1);
    renderAdvancedBatchSteps();
    loadAdvancedBatchStepForEditing();
  };

  const logGroupedBatchCurrencyFailures = (failedResults, totalCount) => {
    if (!failedResults.length) return;
    const failureCounts = new Map();
    for (const result of failedResults) {
      const message = result?.error?.message || result?.error || '未知错误';
      failureCounts.set(message, (failureCounts.get(message) || 0) + 1);
    }
    [...failureCounts.entries()]
      .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]), 'zh-Hans-CN'))
      .forEach(([message, count]) => {
        addLog(`批量通货处理失败：${message}${count > 1 ? `（共 ${count} 件）` : ''}`, 'warn');
      });
    addLog(`批量通货完成，但有 ${failedResults.length}/${totalCount} 件处理异常。`, 'warn');
  };

  const logBatchChanceUniqueSummary = (equipments, keyword) => {
    const uniqueCounts = new Map();
    for (const equipment of equipments) {
      if (Number(equipment?.rarity) !== RARITY_TYPES.unique) continue;
      const name = getEquipmentDisplayName(equipment).trim() || '未知暗金';
      uniqueCounts.set(name, (uniqueCounts.get(name) || 0) + 1);
    }
    const keywordLabel = String(keyword || '目标').trim() || '目标';
    const summaryParts = [...uniqueCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hans-CN'))
      .map(([name, count]) => `${count}个${keywordLabel}->${name}`);
    addLog(`批量机会结果统计：${summaryParts.length ? summaryParts.join('；') : '本轮没有产出暗金'}`, summaryParts.length ? 'success' : 'warn');
  };

  const incrementEquipmentNameCount = (countMap, equipment) => {
    const name = getEquipmentDisplayName(equipment).trim() || '未知暗金';
    countMap.set(name, (countMap.get(name) || 0) + 1);
  };

  const incrementCorruptedBaseUniqueCount = (countMap, equipment) => {
    const name = getEquipmentDisplayName(equipment).trim() || '未知暗金';
    const baseName = getEquipmentBaseName(equipment).trim() || '未知基底';
    const key = JSON.stringify([name, baseName]);
    const currentRecord = countMap.get(key) || { name, baseName, count: 0 };
    currentRecord.count += 1;
    countMap.set(key, currentRecord);
  };

  const logAdvancedBatchUniqueSummary = (uniqueCounts, label = '连续批量结果统计') => {
    const summaryParts = [...uniqueCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hans-CN'))
      .map(([name, count]) => `${count}个${name}`);
    addStepLog(`${label}：${summaryParts.length ? summaryParts.join('；') : '本轮没有产出暗金'}`);
  };

  const formatAdvancedBatchUniqueSummary = (uniqueCounts) => {
    const summaryParts = [...uniqueCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hans-CN'))
      .map(([name, count]) => `${count}个${name}`);
    return summaryParts.length ? summaryParts.join('；') : '无暗金';
  };

  const formatAdvancedBatchCorruptedBaseSummary = (corruptedBaseCounts) => {
    const summaryParts = [...corruptedBaseCounts.values()]
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-Hans-CN') || left.baseName.localeCompare(right.baseName, 'zh-Hans-CN'))
      .map((record) => `${record.count}个${record.name}[${record.baseName}]`);
    return summaryParts.length ? summaryParts.join('；') : '无';
  };

  const applyAdvancedBatchCurrencyOnce = async (equipment, modifyType) => {
    const currencyName = getModifyTypeLabel(modifyType);
    recordStepExecution(currencyName);
    addMainLog(`${equipment.name} 使用${currencyName}。`);
    const payload = await modifyEquipment(equipment.id, modifyType);
    if (!payload.success) throw new Error(payload.message || `${currencyName}失败`);
    const nextEquipment = payload.data?.equipment;
    mergeEquipmentUpdate(equipment, nextEquipment);
    if (modifyType === MODIFY_TYPES.vaal && nextEquipment && !Object.prototype.hasOwnProperty.call(nextEquipment, 'fixedMagics')) {
      delete equipment.fixedMagics;
      if (equipment.raw && typeof equipment.raw === 'object') delete equipment.raw.fixedMagics;
    }
    if (modifyType === MODIFY_TYPES.vaal && nextEquipment && !Object.prototype.hasOwnProperty.call(nextEquipment, 'corruptedMagics')) {
      delete equipment.corruptedMagics;
      if (equipment.raw && typeof equipment.raw === 'object') delete equipment.raw.corruptedMagics;
    }
    await wait(getSpeedDelay());
  };

  const applyAdvancedBatchQualityUntilMax = async (equipment, stoneType) => {
    const stoneName = getModifyTypeLabel(stoneType);
    let useCount = 0;
    while (state.isRunning && useCount < state.stepActionSafetyLimit) {
      const currentQuality = Number(equipment.quality);
      if (Number.isFinite(currentQuality) && currentQuality >= EQUIPMENT_TARGET_QUALITY) break;
      recordStepExecution(stoneName);
      addMainLog(`${equipment.name} 使用${stoneName}。`);
      const payload = await modifyEquipment(equipment.id, stoneType);
      if (!payload.success) {
        if (useCount > 0) {
          addStepLog(`${equipment.name} 品质阶段完成：${stoneName} ${useCount} 次。`);
        } else {
          addLog(`${equipment.name} ${stoneName}未生效：${payload.message || '接口返回失败'}。`, 'warn');
        }
        return;
      }
      mergeEquipmentUpdate(equipment, payload.data?.equipment);
      useCount += 1;
      await wait(getSpeedDelay());
    }
    if (state.isRunning && useCount >= state.stepActionSafetyLimit) {
      stopTaskForSafetyLimit(`${equipment.name} ${stoneName}已达到经典动作上限 ${state.stepActionSafetyLimit} 次，已停止所有打造。`);
    }
    if (useCount > 0) addStepLog(`${equipment.name} 品质阶段完成：${stoneName} ${useCount} 次。`);
  };

  const applyAdvancedBatchGardenCraft = async (equipment, gardenCraftSelection) => {
    const { categoryValue, gardenCraftKey } = parseGardenCraftSelectionValue(gardenCraftSelection);
    const category = getGardenCraftCategory(categoryValue);
    await ensureGardenCraftList(category.value);
    const craft = getGardenCraftByKey(category.value, gardenCraftKey);
    if (!craft) throw new Error('请先选择连续批量花园工艺。');
    if (!isGardenCraftForEquipment(category.value, equipment)) {
      throw new Error(`${equipment.name} 的装备类型不能使用该花园工艺分组：${category.label}。`);
    }
    if (craft.type !== 'catalyst') {
      await applyGardenCraft(equipment, category.value, craft.key);
      addStepLog(`${equipment.name} 花园工艺阶段完成：${craft.label} 1 次。`);
      return;
    }
    let useCount = 0;
    while (state.isRunning && useCount < 20) {
      try {
        await applyGardenCraft(equipment, category.value, craft.key);
        useCount += 1;
      } catch (error) {
        if (!state.isRunning || isRequestAbortError(error)) throw error;
        addStepLog(`${equipment.name} 催化剂阶段停止：${craft.label} ${useCount} 次，${error.message || error}；继续后续步骤。`);
        return;
      }
    }
    if (useCount > 0) addStepLog(`${equipment.name} 催化剂阶段完成：${craft.label} ${useCount} 次。`);
  };

  const shouldProtectHighQualityEquipment = (equipment, plan) => (
    Boolean(plan?.protectHighQualityNonUnique) &&
    Number(equipment?.quality) > 21
  );

  const destroyAdvancedBatchNonUniqueEquipment = async (equipment, plan) => {
    if (Number(equipment.rarity) === RARITY_TYPES.unique) return { destroyed: false, protected: false };
    if (shouldProtectHighQualityEquipment(equipment, plan)) {
      addStepLog(`已保护高品质非暗金装备：${equipment.name}，品质 ${equipment.quality}%。`);
      return { destroyed: false, protected: true };
    }
    const payload = await destroyEquipment(equipment.id);
    if (payload.success === false) throw new Error(payload.message || '丢弃失败');
    addStepLog(`已丢弃非暗金装备：${equipment.name}`);
    return { destroyed: true, protected: false };
  };

  const storeAdvancedBatchCorruptedBaseUnique = async (equipment) => {
    const payload = await storageEquipment(equipment.id);
    if (payload.success === false) throw new Error(payload.message || '存入储藏失败');
    addStepLog(`已存入腐化基底暗金：${equipment.name}`);
    return true;
  };

  const processAdvancedBatchEquipment = async (equipment, plan) => {
    const chanceApplied = Number(equipment.rarity) === RARITY_TYPES.normal;
    if (chanceApplied) {
      await applyAdvancedBatchCurrencyOnce(equipment, MODIFY_TYPES.chance);
    } else {
      addStepLog(`${equipment.name} 当前稀有度为${getAdvancedBatchRarityLabel(equipment.rarity)}，跳过机会石。`);
    }
    if (chanceApplied && Number(equipment.rarity) !== RARITY_TYPES.unique && plan.skipAfterChanceNonUnique) {
      let destroyed = false;
      let stageError = null;
      if (plan.enableDestroyNonUnique) {
        try {
          const destroyResult = await destroyAdvancedBatchNonUniqueEquipment(equipment, plan);
          destroyed = Boolean(destroyResult.destroyed);
        } catch (error) {
          if (!state.isRunning || isRequestAbortError(error)) throw error;
          stageError = error;
        }
      }
      return { equipment, unique: false, destroyed, stored: false, stageError };
    }
    let stageError = null;
    let gainedCorruptedBase = false;
    try {
      if (plan.enableSocket && state.isRunning) {
        await processCraftLinkColor(equipment, plan.socketTargetColor, { suppressCompleteCount: true });
      }
      if (plan.enableQuality && state.isRunning) {
        await applyAdvancedBatchQualityUntilMax(equipment, plan.qualityStoneType);
      }
      if (plan.enableGardenCraft && state.isRunning) {
        await applyAdvancedBatchGardenCraft(equipment, plan.gardenCraftSelection);
      }
      if (plan.enableVaal && state.isRunning) {
        const wasUniqueBeforeVaal = Number(equipment.rarity) === RARITY_TYPES.unique;
        const beforeCorruptedBaseSignature = getCorruptedBaseSignature(equipment);
        await applyAdvancedBatchCurrencyOnce(equipment, MODIFY_TYPES.vaal);
        try {
          const freshEquipment = await fetchEquipmentDetail(equipment.id);
          if (freshEquipment) mergeEquipmentUpdate(equipment, freshEquipment);
        } catch (refreshError) {
          addStepLog(`${equipment.name} 瓦尔后刷新装备详情失败，将使用改造接口返回字段判断腐化基底：${refreshError.message || refreshError}`, 'warn');
        }
        gainedCorruptedBase = hasCorruptedBaseChange(beforeCorruptedBaseSignature, equipment, { wasUniqueBeforeVaal });
      }
    } catch (error) {
      if (!state.isRunning || isRequestAbortError(error)) throw error;
      stageError = error;
    }
    const isUnique = Number(equipment.rarity) === RARITY_TYPES.unique;
    let destroyed = false;
    if (!isUnique && plan.enableDestroyNonUnique) {
      try {
        const destroyResult = await destroyAdvancedBatchNonUniqueEquipment(equipment, plan);
        destroyed = Boolean(destroyResult.destroyed);
      } catch (error) {
        if (!state.isRunning || isRequestAbortError(error)) throw error;
        stageError = stageError || error;
      }
    }
    let stored = false;
    if (isUnique && plan.enableStoreCorruptedBaseUnique && gainedCorruptedBase) {
      try {
        stored = await storeAdvancedBatchCorruptedBaseUnique(equipment);
      } catch (error) {
        if (!state.isRunning || isRequestAbortError(error)) throw error;
        stageError = stageError || error;
      }
    }
    return { equipment, unique: isUnique, destroyed, stored, gainedCorruptedBase, stageError };
  };

  /**
   * processBatchCurrencyTargets 对筛选出的装备并发使用批量通货。
   * @param {object} options 任务参数。
   */
  const processBatchCurrencyTargets = async (options) => {
    const equipments = await collectTargetEquipments(options);
    if (!equipments.length) {
      addLog('没有找到符合条件的下一件装备。', 'warn');
      return;
    }
    if (equipments.length < options.targetCount) {
      addLog(`只找到 ${equipments.length}/${options.targetCount} 件符合条件的装备。`, 'detail');
    }
    addLog(`批量通货开始并发 ${BATCH_CURRENCY_CONCURRENCY} 个处理。`, 'compact');
    const qualityStoneTypes = [MODIFY_TYPES.whetstone, MODIFY_TYPES.armourScrap, MODIFY_TYPES.glassblowerBauble];
    const results = await runConcurrentTasks(equipments, BATCH_CURRENCY_CONCURRENCY, async (equipment) => {
      if (qualityStoneTypes.includes(options.batchStoneType)) {
        await processQualityUntilMax(equipment, options.batchStoneType, options.targetCount);
      } else {
        await processSingleStone(equipment, options.batchStoneType, options.targetCount);
      }
      return { success: true };
    });
    const failedResults = results.filter((result) => result?.error);
    logGroupedBatchCurrencyFailures(failedResults, equipments.length);
    if (options.batchStoneType === MODIFY_TYPES.chance) {
      const successfulEquipments = equipments.filter((_, index) => results[index]?.success);
      logBatchChanceUniqueSummary(successfulEquipments, options.keyword);
    }
  };

  const processAdvancedBatchTargets = async (options) => {
    const plan = captureAdvancedBatchPlanFromUi();
    const runnableSteps = plan.steps
      .map((step, index) => ({ ...step, stepIndex: index, keyword: String(step.keyword || '').trim() }))
      .filter((step) => step.keyword);
    if (!runnableSteps.length) {
      throw new Error('请先在连续批量步骤里填写关键词。');
    }
    const missingQualityStoneStep = runnableSteps.find((step) => step.enableQuality && !step.qualityStoneType);
    if (missingQualityStoneStep) {
      throw new Error(`步骤 ${missingQualityStoneStep.stepIndex + 1} 已勾选品质补满，请先选择具体品质通货。`);
    }
    const missingGardenCraftStep = runnableSteps.find((step) => step.enableGardenCraft && !step.gardenCraftSelection);
    if (missingGardenCraftStep) {
      throw new Error(`步骤 ${missingGardenCraftStep.stepIndex + 1} 已勾选花园工艺，请先选择具体花园工艺。`);
    }
    if (runnableSteps.some((step) => step.enableDestroyNonUnique)) {
      const keywordText = runnableSteps.map((step) => step.keyword).join('、');
      const confirmed = window.confirm(`确认开启连续批量的自动丢弃吗？最终非暗金装备会被丢弃。\n关键词：${keywordText}`);
      if (!confirmed) {
        addLog('已取消连续批量自动丢弃任务。', 'compact');
        return;
      }
    }
    const executionOptions = {
      ...options,
      rarity: plan.rarity,
      targetCount: plan.targetCount,
      useStorage: plan.useStorage,
    };
    addMainLog(`连续批量已锁定本次配置快照：${runnableSteps.length} 个步骤，每个步骤目标 ${executionOptions.targetCount} 件，稀有度 ${getAdvancedBatchRarityLabel(executionOptions.rarity)}，读取位置 ${executionOptions.useStorage ? '储藏' : '背包'}。运行期间继续修改 UI 不会影响当前任务。`);
    const totalUniqueCounts = new Map();
    const totalCorruptedBaseCounts = new Map();
    let totalDestroyedCount = 0;
    let totalStoredCount = 0;
    let totalCorruptedBaseCount = 0;
    let totalProcessedCount = 0;
    let totalFailedCount = 0;
    for (const step of runnableSteps) {
      if (!state.isRunning) break;
      state.currentPage = 1;
      state.processedEquipmentIds.clear();
      const keywordOptions = {
        ...executionOptions,
        keyword: step.keyword,
        rarity: executionOptions.rarity,
        targetCount: executionOptions.targetCount,
        lockLogLabel: `${getAdvancedBatchRarityLabel(executionOptions.rarity)}关键词“${step.keyword}”目标装备`,
      };
      const rarityLabel = getAdvancedBatchRarityLabel(keywordOptions.rarity);
      addMainLog(`步骤 ${step.stepIndex + 1}/${runnableSteps.length}：开始处理关键词“${step.keyword}”。`);
      const equipments = await collectTargetEquipments(keywordOptions);
      if (!state.isRunning && !equipments.length) break;
      if (!equipments.length) {
        addLog(`步骤 ${step.stepIndex + 1} 关键词“${step.keyword}”没有找到${rarityLabel}装备。`, 'warn');
        continue;
      }
      if (equipments.length < executionOptions.targetCount) {
        addLog(`步骤 ${step.stepIndex + 1} 关键词“${step.keyword}”只找到 ${equipments.length}/${executionOptions.targetCount} 件${rarityLabel}装备。`, 'detail');
      }
      const keywordUniqueCounts = new Map();
      let keywordStoredCount = 0;
      const results = await runConcurrentTasks(equipments, BATCH_CURRENCY_CONCURRENCY, async (equipment) => (
        processAdvancedBatchEquipment(equipment, step)
      ));
      const failedResults = results.filter((result) => result?.error);
      const stageFailedResults = results
        .filter((result) => result?.stageError)
        .map((result) => ({ error: result.stageError }));
      const keywordFailedCount = failedResults.length + stageFailedResults.length;
      totalFailedCount += keywordFailedCount;
      logGroupedBatchCurrencyFailures(failedResults, equipments.length);
      logGroupedBatchCurrencyFailures(stageFailedResults, equipments.length);
      let keywordDestroyedCount = 0;
      let keywordProcessedCount = 0;
      let keywordCorruptedBaseCount = 0;
      for (const result of results) {
        if (!result || result.error) continue;
        keywordProcessedCount += 1;
        totalProcessedCount += 1;
        if (result.destroyed) {
          totalDestroyedCount += 1;
          keywordDestroyedCount += 1;
        }
        if (result.stored) {
          totalStoredCount += 1;
          keywordStoredCount += 1;
        }
        if (result.unique && Number(result.equipment?.rarity) === RARITY_TYPES.unique) {
          incrementEquipmentNameCount(keywordUniqueCounts, result.equipment);
          incrementEquipmentNameCount(totalUniqueCounts, result.equipment);
          if (result.gainedCorruptedBase) {
            totalCorruptedBaseCount += 1;
            keywordCorruptedBaseCount += 1;
            incrementCorruptedBaseUniqueCount(totalCorruptedBaseCounts, result.equipment);
          }
        }
      }
      const keywordUniqueCount = [...keywordUniqueCounts.values()].reduce((total, count) => total + count, 0);
      const stepSummaryPrefix = state.isRunning ? '结束' : '停止';
      addMainLog(`步骤 ${step.stepIndex + 1}/${runnableSteps.length} ${stepSummaryPrefix}：关键词“${step.keyword}”，处理${keywordProcessedCount}件，暗金${keywordUniqueCount}件，腐化改变基底${keywordCorruptedBaseCount}件，丢弃${keywordDestroyedCount}件，存储${keywordStoredCount}件，异常${keywordFailedCount}件。`);
      logAdvancedBatchUniqueSummary(keywordUniqueCounts, `步骤 ${step.stepIndex + 1} 关键词“${step.keyword}”暗金统计`);
      if (step.enableDestroyNonUnique) {
        addStepLog(`步骤 ${step.stepIndex + 1} 关键词“${step.keyword}”自动丢弃非暗金：${keywordDestroyedCount} 件。`);
      }
      if (step.enableStoreCorruptedBaseUnique) {
        addStepLog(`步骤 ${step.stepIndex + 1} 关键词“${step.keyword}”腐化基底暗金存储：${keywordStoredCount} 件。`);
      }
    }
    const totalUniqueCount = [...totalUniqueCounts.values()].reduce((total, count) => total + count, 0);
    if (totalCorruptedBaseCount) {
      addMainLog(`腐化改变基底暗金：${formatAdvancedBatchCorruptedBaseSummary(totalCorruptedBaseCounts)}。`);
    }
    const summaryPrefix = state.isRunning ? '连续批量完成' : '连续批量停止汇总';
    addLog(`${summaryPrefix}：处理${totalProcessedCount}件，暗金${totalUniqueCount}件，腐化改变基底${totalCorruptedBaseCount}件，丢弃${totalDestroyedCount}件，存储${totalStoredCount}件，异常${totalFailedCount}件；${formatAdvancedBatchUniqueSummary(totalUniqueCounts)}。`, totalFailedCount || !state.isRunning ? 'warn' : 'success');
  };

  /**
   * processCraftSocketTargets 对筛选出的装备并发执行孔洞操作。
   * @param {object} options 任务参数。
   */
  const processCraftSocketTargets = async (options) => {
    const equipments = await collectTargetEquipments({ ...options, excludeCorrupted: true });
    if (!equipments.length) {
      addLog('没有找到符合条件的下一件装备。', 'warn');
      return;
    }
    if (equipments.length < options.targetCount) {
      addLog(`只找到 ${equipments.length}/${options.targetCount} 件符合条件的未腐化装备。`, 'detail');
    }
    addLog(`孔洞操作开始并发 ${CRAFT_SOCKET_CONCURRENCY} 个处理。`, 'compact');
    const results = await runConcurrentTasks(equipments, CRAFT_SOCKET_CONCURRENCY, async (equipment) => {
      await processCraftLinkColor(equipment, options.targetColor);
      return { success: true };
    });
    const failedResults = results.filter((result) => result?.error);
    failedResults.forEach((result) => {
      addLog(`孔洞操作处理失败：${result.error?.message || result.error || '未知错误'}`, 'warn');
    });
    if (failedResults.length) {
      addLog(`孔洞操作完成，但有 ${failedResults.length}/${equipments.length} 件处理异常。`, 'warn');
    }
  };

  /**
   * applyCraftCurrency 调用装备改造接口并把新装备状态合并回当前引用。
   * @param {object} equipment 装备对象。
   * @param {number} modifyType 通货类型编号。
   * @param {string} currencyName 日志中使用的通货名称。
   * @param {object} options 附加选项。
   * @param {string} options.failureLogType 接口明确失败时使用的日志级别。
   * @returns {Promise<boolean>} 接口成功改造时返回 true；接口明确失败时返回 false。
   */
  const applyCraftCurrency = async (equipment, modifyType, currencyName, options = {}) => {
    recordStepExecution(currencyName);
    addMainLog(`${equipment.name} 使用${currencyName}。`);
    const payload = await modifyEquipment(equipment.id, modifyType);
    if (payload.success === false) {
      addLog(`${equipment.name} ${currencyName}停止：${payload.message || '接口返回失败'}`, options.failureLogType || 'warn');
      return false;
    }
    mergeEquipmentUpdate(equipment, payload.data?.equipment);
    addStepLog(`${equipment.name} 已执行：${currencyName}。`, 'info');
    return true;
  };

  /**
   * processCraftLinkColor 执行“工匠石打孔 -> 链接石单组链接 -> 幻色石洗目标颜色”。
   * 腐化装备会被跳过；洗色目标按“至少满足目标颜色数量”判定，0红0绿0蓝表示链接完成后不洗色。
   * @param {object} equipment 初始装备。
   * @param {object} targetColor 目标颜色数量。
   */
  const processCraftLinkColor = async (equipment, targetColor, options = {}) => {
    const targetTotal = targetColor.red + targetColor.green + targetColor.blue;
    if (equipment.corrupted) {
      addLog(`${equipment.name} 已腐化，跳过孔洞操作。`, 'warn');
      return;
    }
    const skipChromatic = targetTotal <= 0;
    let jewellerCount = 0;
    let fusingCount = 0;
    let chromaticCount = 0;
    while (state.isRunning && jewellerCount < state.stepActionSafetyLimit) {
      const success = await applyCraftCurrency(equipment, MODIFY_TYPES.jeweller, '工匠石', { failureLogType: 'info' });
      if (!success) break;
      jewellerCount += 1;
      await wait(getSpeedDelay());
    }
    if (state.isRunning && jewellerCount >= state.stepActionSafetyLimit) {
      stopTaskForSafetyLimit(`${equipment.name} 工匠石已达到经典动作上限 ${state.stepActionSafetyLimit} 次，已停止所有打造。`);
    }
    if (state.isRunning) {
      addLog(`${equipment.name} 工匠石阶段结束，准备进行链接石。`, 'info');
    }
    while (state.isRunning && fusingCount < state.stepActionSafetyLimit) {
      const success = await applyCraftCurrency(equipment, MODIFY_TYPES.fusing, '链接石');
      if (!success) break;
      fusingCount += 1;
      const socketSummary = getSocketSummary(equipment.sockets);
      if (socketSummary.groups === 1 && socketSummary.total > 0) {
        if (options.suppressCompleteCount) {
          addStepLog(`${equipment.name} 链接石完成：${formatSocketSummary(socketSummary)}。`);
        } else {
          addLog(`${equipment.name} 链接石完成：${formatSocketSummary(socketSummary)}。`, 'success');
        }
        break;
      }
      addStepLog(`${equipment.name} 链接石后判断：${formatSocketSummary(socketSummary)}，尚未单组链接。`);
      await wait(getSpeedDelay());
    }
    if (state.isRunning && fusingCount >= state.stepActionSafetyLimit) {
      stopTaskForSafetyLimit(`${equipment.name} 链接石已达到经典动作上限 ${state.stepActionSafetyLimit} 次，已停止所有打造。`);
    }
    const currentSocketSummary = getSocketSummary(equipment.sockets);
    if (skipChromatic) {
      if (currentSocketSummary.groups === 1 && currentSocketSummary.total > 0) {
        if (options.suppressCompleteCount) {
          addStepLog(`${equipment.name} 孔洞阶段完成：当前已满足 ${formatSocketSummary(currentSocketSummary)}，工匠${jewellerCount} 链接${fusingCount} 幻色0。`);
        } else {
          state.completedCount += 1;
          addLog(`完成 ${state.completedCount}：${equipment.name}，当前已满足 ${formatSocketSummary(currentSocketSummary)}，工匠${jewellerCount} 链接${fusingCount} 幻色0。`, 'success');
        }
      } else {
        addLog(`${equipment.name} 链接未命中目标，已跳过幻色石。`, 'warn');
      }
      return;
    }
    if (isColorTargetMatched(currentSocketSummary, targetColor)) {
      if (options.suppressCompleteCount) {
        addStepLog(`${equipment.name} 孔洞阶段完成：当前已满足 ${formatSocketSummary(currentSocketSummary)}，工匠${jewellerCount} 链接${fusingCount} 幻色0。`);
      } else {
        state.completedCount += 1;
        addLog(`完成 ${state.completedCount}：${equipment.name}，当前已满足 ${formatSocketSummary(currentSocketSummary)}，工匠${jewellerCount} 链接${fusingCount} 幻色0。`, 'success');
      }
      return;
    }
    while (state.isRunning && chromaticCount < state.stepActionSafetyLimit) {
      const success = await applyCraftCurrency(equipment, MODIFY_TYPES.chromatic, '幻色石');
      if (!success) throw new Error('幻色石失败');
      chromaticCount += 1;
      const nextSocketSummary = getSocketSummary(equipment.sockets);
      if (isColorTargetMatched(nextSocketSummary, targetColor)) {
        if (options.suppressCompleteCount) {
          addStepLog(`${equipment.name} 孔洞阶段完成：工匠${jewellerCount} 链接${fusingCount} 幻色${chromaticCount}。`);
        } else {
          state.completedCount += 1;
          addLog(`完成 ${state.completedCount}：${equipment.name}，工匠${jewellerCount} 链接${fusingCount} 幻色${chromaticCount}。`, 'success');
        }
        return;
      }
      if (chromaticCount % 10 === 0) {
        addLog(`${equipment.name} 洗色 ${chromaticCount} 次：${formatSocketSummary(nextSocketSummary)}`, 'info');
      }
      await wait(getSpeedDelay());
    }
    if (state.isRunning && chromaticCount >= state.stepActionSafetyLimit) {
      stopTaskForSafetyLimit(`${equipment.name} 幻色石已达到经典动作上限 ${state.stepActionSafetyLimit} 次，已停止所有打造。`);
    }
    addLog(`${equipment.name} 洗色未命中目标。`, 'warn');
  };

  /**
   * processSingleStone 对单件装备使用一次指定通货。
   * @param {object} equipment 装备对象。
   * @param {number} stoneType 通货类型编号。
   * @param {number} targetCount 本轮目标数量，用于并发完成日志封顶。
   */
  const processSingleStone = async (equipment, stoneType, targetCount = Number.POSITIVE_INFINITY) => {
    recordStepExecution(getModifyTypeLabel(stoneType));
    addMainLog(`${equipment.name} 使用${getModifyTypeLabel(stoneType)}。`);
    const payload = await modifyEquipment(equipment.id, stoneType);
    if (!payload.success) throw new Error(payload.message || '通货使用失败');
    mergeEquipmentUpdate(equipment, payload.data?.equipment);
    state.completedCount = Math.min(state.completedCount + 1, targetCount);
    addLog(`完成 ${state.completedCount}：${equipment.name}`, 'success');
  };

  /**
   * processQualityUntilMax 对武器/护甲持续使用品质通货，直到接口提示无法继续。
   * @param {object} equipment 装备对象。
   * @param {number} stoneType 品质通货编号。
   * @param {number} targetCount 本轮目标数量，用于并发完成日志封顶。
   */
  const processQualityUntilMax = async (equipment, stoneType, targetCount = Number.POSITIVE_INFINITY) => {
    let useCount = 0;
    const stoneName = getModifyTypeLabel(stoneType);
    const initialQuality = Number(equipment.quality);
    if (Number.isFinite(initialQuality) && initialQuality >= EQUIPMENT_TARGET_QUALITY) {
      state.completedCount = Math.min(state.completedCount + 1, targetCount);
      addLog(`完成 ${state.completedCount}：${equipment.name}，品质已满 ${initialQuality}%，${stoneName} 0 次。`, 'success');
      return;
    }
    while (state.isRunning && useCount < state.stepActionSafetyLimit) {
      recordStepExecution(stoneName);
      addMainLog(`${equipment.name} 使用${stoneName}。`);
      const payload = await modifyEquipment(equipment.id, stoneType);
      if (!payload.success) {
        if (useCount > 0) {
          state.completedCount = Math.min(state.completedCount + 1, targetCount);
          addLog(`完成 ${state.completedCount}：${equipment.name}，${stoneName} ${useCount} 次。`, 'success');
        } else {
          addLog(`${equipment.name} ${stoneName}未生效：${payload.message || '接口返回失败'}。`, 'warn');
        }
        return;
      }
      mergeEquipmentUpdate(equipment, payload.data?.equipment);
      useCount += 1;
      await wait(getSpeedDelay());
    }
    if (state.isRunning && useCount >= state.stepActionSafetyLimit) {
      stopTaskForSafetyLimit(`${equipment.name} ${stoneName}已达到经典动作上限 ${state.stepActionSafetyLimit} 次，已停止所有打造。`);
    }
  };

  /**
   * scourEquipmentToNormal 把非普通装备先重铸为普通，确保后续机会石可以正常使用。
   * @param {object} equipment 装备对象。
   * @param {Function} shouldStop 外部目标已完成时返回 true，用于并发 worker 及时退出。
   * @returns {Promise<number>} 本次预处理消耗的重铸石数量。
   */
  const scourEquipmentToNormal = async (equipment, shouldStop = () => false) => {
    let scouringCount = 0;
    while (
      state.isRunning &&
      !shouldStop() &&
      equipment.rarity !== RARITY_TYPES.normal &&
      scouringCount < state.stepActionSafetyLimit
    ) {
      const success = await applyCraftCurrency(equipment, MODIFY_TYPES.scouring, '重铸石');
      if (!success) throw new Error('重铸石失败，无法把装备变为普通。');
      scouringCount += 1;
      await wait(getSpeedDelay());
    }
    if (shouldStop()) return scouringCount;
    if (equipment.rarity !== RARITY_TYPES.normal) {
      stopTaskForSafetyLimit(`${equipment.name} 重铸到普通失败，已达到经典动作上限 ${state.stepActionSafetyLimit} 次，已停止所有打造。`);
    }
    return scouringCount;
  };

  /**
   * scourEquipmentOnceForMagicCompatibleRestart 为连续打造重启执行一次重铸。
   * 破裂装备重铸后可能保留破裂词缀并停在魔法装备，此时也应回到步骤 A，而不是继续消耗重铸石。
   * @param {object} equipment 装备对象。
   * @returns {Promise<number>} 实际消耗的重铸石数量。
   */
  const scourEquipmentOnceForMagicCompatibleRestart = async (equipment) => {
    if (equipment.rarity === RARITY_TYPES.normal) {
      addStepLog(`${equipment.name} 当前已是普通装备，重铸重启不额外消耗重铸石。`);
      return 0;
    }
    const success = await applyCraftCurrency(equipment, MODIFY_TYPES.scouring, '重铸石');
    if (!success) throw new Error('重铸石失败，无法重新开始自定义打造。');
    await wait(getSpeedDelay());
    if (![RARITY_TYPES.normal, RARITY_TYPES.magic].includes(Number(equipment.rarity))) {
      throw new Error(`${equipment.name} 重铸后不是普通或魔法装备，已停止以避免继续消耗重铸石。`);
    }
    addStepLog(`${equipment.name} 重铸重启后稀有度：${SPECIAL_CONDITION_RARITY_LABELS[equipment.rarity] || equipment.rarity}。`);
    return 1;
  };

  /**
   * scourEquipmentToMagicCompatibleBase 把装备整理到改造增幅可用的底子。
   * 普通装备可继续蜕变，破裂装备重铸后若成为魔法装备则直接可用。
   * @param {object} equipment 装备对象。
   * @returns {Promise<number>} 实际消耗的重铸石数量。
   */
  const scourEquipmentToMagicCompatibleBase = async (equipment) => {
    if ([RARITY_TYPES.normal, RARITY_TYPES.magic].includes(Number(equipment.rarity))) return 0;
    const success = await applyCraftCurrency(equipment, MODIFY_TYPES.scouring, '重铸石');
    if (!success) throw new Error('重铸石失败，无法准备改造增幅底子。');
    await wait(getSpeedDelay());
    if (![RARITY_TYPES.normal, RARITY_TYPES.magic].includes(Number(equipment.rarity))) {
      throw new Error(`${equipment.name} 重铸后不是普通或魔法装备，已停止以避免继续消耗重铸石。`);
    }
    return 1;
  };

  const ensureEquipmentMagic = async (equipment) => {
    const rarity = Number(equipment.rarity);
    if (rarity === RARITY_TYPES.unique) {
      throw new Error(`${equipment.name} 是暗金装备，不能变为魔法装备。`);
    }
    if (rarity === RARITY_TYPES.magic) {
      addStepLog(`${equipment.name} 已是魔法装备，变为魔法步骤跳过。`);
      return;
    }
    if (rarity !== RARITY_TYPES.normal) {
      const success = await applyCraftCurrency(equipment, MODIFY_TYPES.scouring, '重铸石');
      if (!success) throw new Error('重铸石失败，无法准备魔法底子。');
      await wait(getSpeedDelay());
      if (![RARITY_TYPES.normal, RARITY_TYPES.magic].includes(Number(equipment.rarity))) {
        throw new Error(`${equipment.name} 重铸后不是普通或魔法装备，已停止以避免继续消耗重铸石。`);
      }
      if (Number(equipment.rarity) === RARITY_TYPES.magic) {
        addStepLog(`${equipment.name} 重铸后已是魔法装备，蜕变石跳过。`);
        return;
      }
    }
    const success = await applyCraftCurrency(equipment, MODIFY_TYPES.transmutation, '蜕变石');
    if (!success) throw new Error('蜕变石失败，无法变为魔法装备。');
    await wait(getSpeedDelay());
  };

  const ensureEquipmentRare = async (equipment) => {
    const rarity = Number(equipment.rarity);
    if (rarity === RARITY_TYPES.unique) {
      throw new Error(`${equipment.name} 是暗金装备，不能变为稀有装备。`);
    }
    if (rarity === RARITY_TYPES.rare) {
      addStepLog(`${equipment.name} 已是稀有装备，变为稀有步骤跳过。`);
      return;
    }
    if (rarity !== RARITY_TYPES.normal) {
      const success = await applyCraftCurrency(equipment, MODIFY_TYPES.scouring, '重铸石');
      if (!success) throw new Error('重铸石失败，无法准备点金底子。');
      await wait(getSpeedDelay());
      if (Number(equipment.rarity) !== RARITY_TYPES.normal) {
        throw new Error(`${equipment.name} 重铸后不是普通装备，不能使用点金石，已停止以避免继续消耗重铸石。`);
      }
    }
    const success = await applyCraftCurrency(equipment, MODIFY_TYPES.alchemy, '点金石');
    if (!success) throw new Error('点金石失败，无法变为稀有装备。');
    await wait(getSpeedDelay());
  };

  const smartAugmentEquipment = async (equipment) => {
    if (Number(equipment.rarity) !== RARITY_TYPES.magic) {
      addStepLog(`${equipment.name} 当前不是魔法装备，智能增幅跳过。`);
      return;
    }
    if (!shouldUseAugment(equipment)) {
      addStepLog(`${equipment.name} 当前魔法词缀已满，智能增幅跳过。`);
      return;
    }
    const success = await applyCraftCurrency(equipment, MODIFY_TYPES.augment, '增幅石');
    if (!success) {
      try {
        const freshEquipment = await fetchEquipmentDetail(equipment.id);
        if (freshEquipment) mergeEquipmentUpdate(equipment, freshEquipment);
      } catch (error) {
        addStepLog(`${equipment.name} 智能增幅失败后刷新装备状态失败，将使用当前词缀数量判断：${error.message || error}`, 'warn');
      }
      if (Number(equipment.rarity) !== RARITY_TYPES.magic || !shouldUseAugment(equipment)) {
        addStepLog(`${equipment.name} 智能增幅失败后复查发现已不需要增幅，按跳过处理。`, 'warn');
        await wait(getSpeedDelay());
        return;
      }
      addStepLog(`${equipment.name} 智能增幅失败后复查仍缺词缀，3 秒后重试一次增幅石。`, 'warn');
      await wait(config.requestRetry.timeoutDelayMs);
      const retrySuccess = await applyCraftCurrency(equipment, MODIFY_TYPES.augment, '增幅石');
      if (!retrySuccess) throw new Error('增幅石失败，无法执行智能增幅。');
    }
    await wait(getSpeedDelay());
  };

  const smartExaltEquipment = async (equipment) => {
    if (Number(equipment.rarity) !== RARITY_TYPES.rare) {
      addStepLog(`${equipment.name} 当前不是稀有装备，智能崇高跳过。`);
      return;
    }
    const affixSummary = getMagicAffixSummary(equipment.affixes);
    const affixSlotLimits = getAffixSlotLimits(equipment.rarity, equipment);
    const hasOpenAffix = affixSummary.prefixCount < affixSlotLimits.prefix || affixSummary.suffixCount < affixSlotLimits.suffix;
    if (!hasOpenAffix) {
      addStepLog(`${equipment.name} 当前稀有词缀已满，智能崇高跳过。`);
      return;
    }
    const success = await applyCraftCurrency(equipment, MODIFY_TYPES.exalted, '崇高石');
    if (!success) throw new Error('崇高石失败，无法执行智能崇高。');
    await wait(getSpeedDelay());
  };

  /**
   * transmuteEquipmentToMagic 对普通装备使用蜕变石，让后续改造/增幅可以按魔法装备规则运行。
   * @param {object} equipment 装备对象。
   * @returns {Promise<number>} 本次预处理消耗的蜕变石数量。
   */
  const transmuteEquipmentToMagic = async (equipment) => {
    if (equipment.rarity === RARITY_TYPES.magic) return 0;
    if (equipment.rarity !== RARITY_TYPES.normal) {
      throw new Error(`${equipment.name} 当前不是普通装备，不能直接使用蜕变石。`);
    }
    const success = await applyCraftCurrency(equipment, MODIFY_TYPES.transmutation, '蜕变石');
    if (!success) throw new Error('蜕变石失败，无法把装备变为魔法。');
    if (equipment.rarity !== RARITY_TYPES.magic) {
      throw new Error(`${equipment.name} 使用蜕变石后没有变为魔法装备。`);
    }
    await wait(getSpeedDelay());
    return 1;
  };

  /**
   * alchemizeEquipmentToRare 对普通装备使用点金石，让后续混沌石可以正常作用于稀有装备。
   * @param {object} equipment 装备对象。
   * @returns {Promise<number>} 本次预处理消耗的点金石数量。
   */
  const alchemizeEquipmentToRare = async (equipment) => {
    if (equipment.rarity === RARITY_TYPES.rare) return 0;
    if (equipment.rarity !== RARITY_TYPES.normal) {
      throw new Error(`${equipment.name} 当前不是普通装备，不能直接使用点金石。`);
    }
    const success = await applyCraftCurrency(equipment, MODIFY_TYPES.alchemy, '点金石');
    if (!success) throw new Error('点金石失败，无法把装备变为稀有。');
    if (equipment.rarity !== RARITY_TYPES.rare) {
      throw new Error(`${equipment.name} 使用点金石后没有变为稀有装备。`);
    }
    await wait(getSpeedDelay());
    return 1;
  };

  /**
   * regalEquipmentToRare 对魔法装备使用富豪石，让后续混沌石可以正常作用于稀有装备。
   * @param {object} equipment 装备对象。
   * @returns {Promise<number>} 本次预处理消耗的富豪石数量。
   */
  const regalEquipmentToRare = async (equipment) => {
    if (equipment.rarity === RARITY_TYPES.rare) return 0;
    if (equipment.rarity !== RARITY_TYPES.magic) {
      throw new Error(`${equipment.name} 当前不是魔法装备，不能直接使用富豪石。`);
    }
    const success = await applyCraftCurrency(equipment, MODIFY_TYPES.regal, '富豪石');
    if (!success) throw new Error('富豪石失败，无法把装备变为稀有。');
    if (equipment.rarity !== RARITY_TYPES.rare) {
      throw new Error(`${equipment.name} 使用富豪石后没有变为稀有装备。`);
    }
    await wait(getSpeedDelay());
    return 1;
  };

  /**
   * rollChanceUniqueUntilMatched 用机会石和重铸石循环，直到装备变成暗金或达到保护次数。
   * 这里只返回结果，不更新全局完成数量，方便连续打造步骤复用。
   * @param {object} equipment 装备对象。
   * @returns {Promise<object>} matched 表示是否暗金；chanceCount/scouringCount 记录消耗。
   */
  const rollChanceUniqueUntilMatched = async (equipment, shouldStop = () => false) => {
    if (equipment.rarity === RARITY_TYPES.unique) {
      return { matched: false, skipped: true, chanceCount: 0, scouringCount: 0 };
    }
    let chanceCount = 0;
    let scouringCount = await scourEquipmentToNormal(equipment, shouldStop);
    if (shouldStop()) {
      return { matched: false, skipped: false, stopped: true, chanceCount, scouringCount };
    }
    while (state.isRunning && !shouldStop() && chanceCount < state.stepActionSafetyLimit) {
      recordStepExecution('机会石');
      addMainLog(`${equipment.name} 使用机会石。`);
      const chancePayload = await modifyEquipment(equipment.id, MODIFY_TYPES.chance);
      if (!chancePayload.success) throw new Error(chancePayload.message || '机会石失败');
      mergeEquipmentUpdate(equipment, chancePayload.data?.equipment);
      chanceCount += 1;
      if (equipment.rarity === RARITY_TYPES.unique) {
        return { matched: true, skipped: false, chanceCount, scouringCount };
      }
      if (shouldStop()) {
        return { matched: false, skipped: false, stopped: true, chanceCount, scouringCount };
      }
      recordStepExecution('重铸石');
      addMainLog(`${equipment.name} 使用重铸石。`);
      const scourPayload = await modifyEquipment(equipment.id, MODIFY_TYPES.scouring);
      if (!scourPayload.success) throw new Error(scourPayload.message || '重铸石失败');
      mergeEquipmentUpdate(equipment, scourPayload.data?.equipment);
      scouringCount += 1;
      await wait(getSpeedDelay());
    }
    if (state.isRunning && chanceCount >= state.stepActionSafetyLimit) {
      stopTaskForSafetyLimit(`${equipment.name} 机会石已达到经典动作上限 ${state.stepActionSafetyLimit} 次，已停止所有打造。`);
    }
    return { matched: false, skipped: false, chanceCount, scouringCount };
  };

  /**
   * processChanceUnique 是经典打造里的自动暗金入口。
   * @param {object} equipment 装备对象。
   * @param {number} targetCount 本轮目标数量，用于并发命中后尽快停止其他 worker。
   */
  const processChanceUnique = async (equipment, targetCount = Number.POSITIVE_INFINITY) => {
    const rollResult = await rollChanceUniqueUntilMatched(equipment, () => state.completedCount >= targetCount);
    if (rollResult.skipped) {
      addLog(`${equipment.name} 原本就是暗金，跳过自动暗金。`, 'warn');
      return { matched: false, skipped: true };
    }
    if (rollResult.stopped) {
      addLog(`${equipment.name} 自动暗金停止：目标数量已完成。`, 'compact');
      return { matched: false, stopped: true };
    }
    if (rollResult.matched) {
      const matchedEquipment = { ...equipment };
      if (state.completedCount >= targetCount) {
        addLog(`${equipment.name} 已变为暗金，但目标数量已完成。`, 'compact');
        return { matched: true, counted: false, equipment: matchedEquipment, chanceCount: rollResult.chanceCount, scouringCount: rollResult.scouringCount };
      }
      state.completedCount = Math.min(state.completedCount + 1, targetCount);
      addLog(`暗金 ${state.completedCount}：${equipment.name}，机会${rollResult.chanceCount} 重铸${rollResult.scouringCount}。`, 'success');
      return { matched: true, counted: true, equipment: matchedEquipment, chanceCount: rollResult.chanceCount, scouringCount: rollResult.scouringCount };
    }
    addLog(`${equipment.name} 机会石保护次数用尽。`, 'warn');
    return { matched: false, safetyLimited: true };
  };

  /**
   * logAutoUniqueNameSummary 在批量机会结束后按暗金名称汇总本轮产出。
   * @param {Array<object>} matchedEquipments 本轮机会出来的装备快照。
   * @param {string} keyword 本轮筛选关键词。
   */
  const logAutoUniqueNameSummary = (matchedEquipments, keyword) => {
    const uniqueCounts = new Map();
    for (const equipment of matchedEquipments) {
      if (Number(equipment?.rarity) !== RARITY_TYPES.unique) continue;
      const name = getEquipmentDisplayName(equipment).trim() || '未知暗金';
      uniqueCounts.set(name, (uniqueCounts.get(name) || 0) + 1);
    }
    const keywordLabel = String(keyword || '目标').trim() || '目标';
    const summaryParts = [...uniqueCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-Hans-CN'))
      .map(([name, count]) => `${count}个${keywordLabel}->${name}`);
    addLog(`自动暗金结果统计：${summaryParts.length ? summaryParts.join('；') : '本轮没有产出暗金'}`, summaryParts.length ? 'success' : 'warn');
  };

  /**
   * processAutoUniqueTargets 并发执行经典打造里的自动暗金。
   * 目标数量按成功做出暗金的数量计算；每个 worker 完成一件后立即领取下一件，避免固定批次被慢任务拖住。
   * @param {object} options 任务参数。
   */
  const processAutoUniqueTargets = async (options) => {
    addLog('自动暗金已锁定本次目标筛选快照，运行期间继续修改 UI 不会影响当前任务。', 'compact');
    let exhausted = false;
    let lockedCount = 0;
    let dequeuePromise = Promise.resolve();
    const matchedUniqueEquipments = [];
    const workerCount = Math.max(1, Math.min(AUTO_UNIQUE_CONCURRENCY, options.targetCount));
    const getNextAutoUniqueEquipment = async () => {
      const previousDequeue = dequeuePromise;
      let releaseDequeue;
      dequeuePromise = new Promise((resolve) => { releaseDequeue = resolve; });
      await previousDequeue;
      try {
        if (!state.isRunning || exhausted || state.completedCount >= options.targetCount) return null;
        return await getNextEquipment({
          ...options,
          excludeRarities: [RARITY_TYPES.unique],
        });
      } finally {
        releaseDequeue();
      }
    };
    const runWorker = async (workerIndex) => {
      let processedCount = 0;
      try {
        while (state.isRunning && !exhausted && state.completedCount < options.targetCount) {
          let equipment = null;
          try {
            equipment = await getNextAutoUniqueEquipment();
          } catch (error) {
            if (isRequestAbortError(error)) {
              addLog(`自动暗金 worker ${workerIndex + 1}/${workerCount} 已停止。`, 'compact');
              return { workerIndex, processedCount, stopped: true };
            }
            throw error;
          }
          if (!equipment) {
            if (state.isRunning && state.completedCount < options.targetCount) exhausted = true;
            return { workerIndex, processedCount };
          }
          processedCount += 1;
          lockedCount += 1;
          addLog(`自动暗金 worker ${workerIndex + 1}/${workerCount} 锁定第 ${lockedCount} 件：${equipment.name}。`, 'compact');
          try {
            const result = await processChanceUnique(equipment, options.targetCount);
            if (result?.matched && Number(result.equipment?.rarity) === RARITY_TYPES.unique) {
              matchedUniqueEquipments.push(result.equipment);
            }
          } catch (error) {
            if (isRequestAbortError(error)) {
              addLog(`自动暗金已停止：${equipment.name} 当前请求已中断。`, 'compact');
              return { workerIndex, processedCount, stopped: true };
            }
            addLog(`自动暗金处理失败：${equipment.name}，${error.message || error}`, 'warn');
          }
          await wait(getSpeedDelay());
        }
        return { workerIndex, processedCount };
      } finally {
        addTraceLog(`自动暗金 worker ${workerIndex + 1}/${workerCount} 已退出，处理 ${processedCount} 件。`);
      }
    };
    const workerResults = await Promise.allSettled(
      Array.from({ length: workerCount }, (_, workerIndex) => runWorker(workerIndex)),
    );
    const failedWorkers = workerResults.filter((result) => (
      result.status === 'rejected' && !isRequestAbortError(result.reason)
    ));
    failedWorkers.forEach((result) => {
      addLog(`自动暗金 worker 异常退出：${result.reason?.message || result.reason || '未知错误'}`, 'warn');
    });
    if (exhausted && state.completedCount < options.targetCount) {
      addLog(`没有找到更多符合条件的装备，自动暗金停在 ${state.completedCount}/${options.targetCount}。`, 'warn');
    }
    logAutoUniqueNameSummary(matchedUniqueEquipments, options.keyword);
  };

  /**
   * processChaosUntilMatched 用混沌石循环，直到词缀满足条件。
   * @param {object} equipment 装备对象。
   * @param {Array<object>} conditionGroups 带独立命中数的词缀条件组。
   */
  const processChaosUntilMatched = async (equipment, conditionGroups) => {
    for (let attemptIndex = 1; state.isRunning && attemptIndex <= state.stepActionSafetyLimit; attemptIndex += 1) {
      const success = await applyCraftCurrency(equipment, MODIFY_TYPES.chaos, '混沌石');
      if (!success) throw new Error('混沌石失败');
      if (isAffixMatched(equipment, conditionGroups)) {
        state.completedCount += 1;
        addLog(`命中 ${state.completedCount}：${equipment.name}，混沌${attemptIndex}。`, 'success');
        return true;
      }
      await wait(getSpeedDelay());
    }
    if (state.isRunning) {
      stopTaskForSafetyLimit(`${equipment.name} 混沌筛选已达到经典动作上限 ${state.stepActionSafetyLimit} 次，已停止所有打造。`);
    }
    addLog(`${equipment.name} 混沌筛选未命中。`, 'warn');
    return false;
  };

  /**
   * prepareEquipmentForChaos 把装备准备成混沌石可操作的稀有装备。
   * 暗金装备不参与；普通装备先点金；魔法装备先富豪；稀有装备直接进入混沌筛选。
   * @param {object} equipment 装备对象。
   * @param {number|string} targetRarity 当前 UI 中选择的稀有度筛选值。
   * @returns {Promise<object>} alchemyCount 和 regalCount 记录预处理消耗。
   */
  const prepareEquipmentForChaos = async (equipment, targetRarity) => {
    if (equipment.rarity === RARITY_TYPES.unique || targetRarity === RARITY_TYPES.unique) {
      addLog(`${equipment.name} 是暗金目标或暗金装备，跳过混沌筛选。`, 'warn');
      return { skipped: true, alchemyCount: 0, regalCount: 0 };
    }
    let alchemyCount = 0;
    let regalCount = 0;
    if (equipment.rarity === RARITY_TYPES.normal) {
      alchemyCount = await alchemizeEquipmentToRare(equipment);
    } else if (equipment.rarity === RARITY_TYPES.magic) {
      regalCount = await regalEquipmentToRare(equipment);
    }
    if (equipment.rarity !== RARITY_TYPES.rare) {
      throw new Error(`${equipment.name} 预处理后不是稀有装备，无法执行混沌筛选。`);
    }
    return { skipped: false, alchemyCount, regalCount };
  };

  /**
   * processChaosWithRarityPreparation 按装备稀有度先预处理，再执行正常混沌筛选。
   * @param {object} equipment 装备对象。
   * @param {Array<object>} conditionGroups 带独立命中数的词缀条件组。
   * @param {number|string} targetRarity 当前 UI 中选择的稀有度筛选值。
   */
  const processChaosWithRarityPreparation = async (equipment, conditionGroups, targetRarity) => {
    const prepareResult = await prepareEquipmentForChaos(equipment, targetRarity);
    if (prepareResult.skipped || !state.isRunning) return false;
    const matched = await processChaosUntilMatched(equipment, conditionGroups);
    if (matched && (prepareResult.alchemyCount || prepareResult.regalCount)) {
      addLog(`${equipment.name} 预处理消耗：点金石${prepareResult.alchemyCount} 富豪石${prepareResult.regalCount}。`, 'info');
    }
    return matched;
  };

  /**
   * processAltAugUntilMatched 用改造石和必要时的增幅石筛选魔法词缀。
   * @param {object} equipment 装备对象。
   * @param {Array<object>} conditionGroups 带独立命中数的词缀条件组。
   */
  const processAltAugUntilMatched = async (equipment, conditionGroups) => {
    const rollResult = await rollAltAugUntilMatched(equipment, conditionGroups);
    if (rollResult.matched) {
        state.completedCount += 1;
        addLog(`命中 ${state.completedCount}：${equipment.name}，改造轮次${rollResult.attemptCount}。`, 'success');
        return true;
    }
    addLog(`${equipment.name} 改造增幅未命中。`, 'warn');
    return false;
  };

  /**
   * prepareEquipmentForAltAug 根据稀有度筛选目标，把装备准备成改造增幅可操作的魔法装备。
   * 暗金装备不参与；稀有装备先重铸成普通再蜕变；普通装备先蜕变；魔法装备直接进入改造增幅。
   * @param {object} equipment 装备对象。
   * @param {number|string} targetRarity 当前 UI 中选择的稀有度筛选值。
   * @returns {Promise<object>} scouringCount 和 transmutationCount 记录预处理消耗。
   */
  const prepareEquipmentForAltAug = async (equipment, targetRarity) => {
    if (equipment.rarity === RARITY_TYPES.unique || targetRarity === RARITY_TYPES.unique) {
      addLog(`${equipment.name} 是暗金目标或暗金装备，跳过改造增幅。`, 'warn');
      return { skipped: true, scouringCount: 0, transmutationCount: 0 };
    }
    let scouringCount = 0;
    let transmutationCount = 0;
    if (targetRarity === RARITY_TYPES.rare || equipment.rarity === RARITY_TYPES.rare) {
      scouringCount = await scourEquipmentToMagicCompatibleBase(equipment);
    }
    if (targetRarity === RARITY_TYPES.normal || equipment.rarity === RARITY_TYPES.normal) {
      transmutationCount = await transmuteEquipmentToMagic(equipment);
    }
    if (equipment.rarity !== RARITY_TYPES.magic) {
      throw new Error(`${equipment.name} 预处理后不是魔法装备，无法执行改造增幅。`);
    }
    return { skipped: false, scouringCount, transmutationCount };
  };

  /**
   * processAltAugWithRarityPreparation 按用户选择的稀有度先预处理，再执行正常改造增幅。
   * @param {object} equipment 装备对象。
   * @param {Array<object>} conditionGroups 带独立命中数的词缀条件组。
   * @param {number|string} targetRarity 当前 UI 中选择的稀有度筛选值。
   */
  const processAltAugWithRarityPreparation = async (equipment, conditionGroups, targetRarity) => {
    const prepareResult = await prepareEquipmentForAltAug(equipment, targetRarity);
    if (prepareResult.skipped || !state.isRunning) return false;
    const matched = await processAltAugUntilMatched(equipment, conditionGroups);
    if (matched && (prepareResult.scouringCount || prepareResult.transmutationCount)) {
      addLog(`${equipment.name} 预处理消耗：重铸石${prepareResult.scouringCount} 蜕变石${prepareResult.transmutationCount}。`, 'info');
    }
    return matched;
  };

  /**
   * rollAltAugUntilMatched 只负责把魔法装备改造到命中条件，不更新全局完成数量。
   * @param {object} equipment 装备对象。
   * @param {Array<object>} conditionGroups 带独立命中数的词缀条件组。
   * @param {number} maxAttempts 本轮最多尝试次数。
   * @returns {Promise<object>} matched 表示是否命中，attemptCount 表示改造轮次。
   */
  const rollAltAugUntilMatched = async (equipment, conditionGroups, maxAttempts = state.stepActionSafetyLimit) => {
    for (let attemptIndex = 1; state.isRunning && attemptIndex <= maxAttempts; attemptIndex += 1) {
      recordStepExecution('改造石');
      addMainLog(`${equipment.name} 使用改造石。`);
      const alterationPayload = await modifyEquipment(equipment.id, MODIFY_TYPES.alteration);
      if (!alterationPayload.success) throw new Error(alterationPayload.message || '改造石失败');
      mergeEquipmentUpdate(equipment, alterationPayload.data?.equipment);
      addStepLog(`${equipment.name} 改造增幅第 ${attemptIndex} 轮：已使用改造石。`, 'info');
      if (shouldUseAugment(equipment)) {
        recordStepExecution('增幅石');
        addMainLog(`${equipment.name} 使用增幅石。`);
        const augmentPayload = await modifyEquipment(equipment.id, MODIFY_TYPES.augment);
        if (augmentPayload.success) {
          mergeEquipmentUpdate(equipment, augmentPayload.data?.equipment);
          addStepLog(`${equipment.name} 改造增幅第 ${attemptIndex} 轮：已补增幅石。`, 'info');
        } else {
          addStepLog(`${equipment.name} 改造增幅第 ${attemptIndex} 轮：增幅石未执行，${augmentPayload.message || '接口返回失败'}。`, 'warn');
        }
      }
      if (isAffixMatched(equipment, conditionGroups)) {
        addStepLog(`${equipment.name} 改造增幅第 ${attemptIndex} 轮：条件命中。`, 'success');
        return { matched: true, attemptCount: attemptIndex };
      }
      addStepLog(`${equipment.name} 改造增幅第 ${attemptIndex} 轮：条件未命中。`, 'info');
      await wait(getSpeedDelay());
    }
    if (state.isRunning) {
      stopTaskForSafetyLimit(`${equipment.name} 改造增幅已达到经典动作上限 ${maxAttempts} 次，已停止所有打造。`);
    }
    return { matched: false, attemptCount: maxAttempts };
  };

  /**
   * assertContinuousCraftStepsPossible 在连续打造开跑前逐步检查条件是否可能。
   * 只有“判断条件”步骤会读取条件组；通货步骤只负责执行动作和跳转。
   * @param {Array<object>} steps 连续打造步骤列表。
   */
  const assertContinuousCraftStepsPossible = (steps) => {
    const normalizedSteps = normalizeContinuousCraftSteps(steps);
    normalizedSteps.forEach((step, stepIndex) => {
      const actionConfig = CONTINUOUS_CRAFT_ACTIONS[step.action];
      const conditionGroups = step.conditionGroups.filter((group) => group.conditions.length > 0);
      const stepLabel = `自定义打造步骤 ${formatContinuousStepCode(stepIndex)}：${actionConfig.label}`;
      if (!conditionGroups.length && actionConfig.requiresConditions) {
        throw new Error(`${stepLabel} 需要至少添加一个词缀条件。`);
      }
      if (['craftBench', 'smartCraftBench'].includes(step.action) && !step.craftId) {
        throw new Error(`${stepLabel} 需要先选择具体工艺词缀。`);
      }
      if (step.action === 'gardenCraft' && !step.gardenCraftKey) {
        throw new Error(`${stepLabel} 需要先选择具体花园工艺方法。`);
      }
      if (step.action === 'conditionCheck' && conditionGroups.length) {
        assertAffixConditionsPossible(conditionGroups, actionConfig.limits, stepLabel);
      }
    });
    assertContinuousCraftFlowHasExit(normalizedSteps);
  };

  /**
   * rollChaosUntilMatched 只负责把稀有装备混沌到命中条件，不更新全局完成数量。
   * 这个函数用于连续打造内部步骤，避免中间步骤误算成已完成目标。
   * @param {object} equipment 装备对象。
   * @param {Array<object>} conditionGroups 本步骤条件组。
   * @param {number} maxAttempts 本轮最多尝试次数。
   * @returns {Promise<object>} matched 表示是否命中，attemptCount 表示混沌轮次。
   */
  const rollChaosUntilMatched = async (equipment, conditionGroups, maxAttempts = state.stepActionSafetyLimit) => {
    for (let attemptIndex = 1; state.isRunning && attemptIndex <= maxAttempts; attemptIndex += 1) {
      const success = await applyCraftCurrency(equipment, MODIFY_TYPES.chaos, '混沌石');
      if (!success) throw new Error('混沌石失败');
      if (isAffixMatched(equipment, conditionGroups)) {
        addStepLog(`${equipment.name} 混沌第 ${attemptIndex} 轮：条件命中。`, 'success');
        return { matched: true, attemptCount: attemptIndex };
      }
      addStepLog(`${equipment.name} 混沌第 ${attemptIndex} 轮：条件未命中。`, 'info');
      await wait(getSpeedDelay());
    }
    if (state.isRunning) {
      stopTaskForSafetyLimit(`${equipment.name} 混沌石已达到经典动作上限 ${maxAttempts} 次，已停止所有打造。`);
    }
    return { matched: false, attemptCount: maxAttempts };
  };

  /**
   * rollSingleCurrencyUntilMatched 循环使用单一通货，直到装备词缀满足本步骤条件。
   * 连续打造的“改造石”步骤使用它，和“改造增幅”保持相同的命中式体验。
   * @param {object} equipment 装备对象。
   * @param {number} modifyType 通货类型。
   * @param {string} currencyName 日志中的通货名称。
   * @param {Array<object>} conditionGroups 本步骤条件组。
   * @param {number} maxAttempts 本轮最多尝试次数。
   * @returns {Promise<object>} matched 表示是否命中，attemptCount 表示通货轮次。
   */
  const rollSingleCurrencyUntilMatched = async (equipment, modifyType, currencyName, conditionGroups, maxAttempts = state.stepActionSafetyLimit) => {
    for (let attemptIndex = 1; state.isRunning && attemptIndex <= maxAttempts; attemptIndex += 1) {
      const success = await applyCraftCurrency(equipment, modifyType, currencyName);
      if (!success) throw new Error(`${currencyName}失败`);
      if (isAffixMatched(equipment, conditionGroups)) {
        addStepLog(`${equipment.name} ${currencyName}第 ${attemptIndex} 轮：条件命中。`, 'success');
        return { matched: true, attemptCount: attemptIndex };
      }
      addStepLog(`${equipment.name} ${currencyName}第 ${attemptIndex} 轮：条件未命中。`, 'info');
      await wait(getSpeedDelay());
    }
    if (state.isRunning) {
      stopTaskForSafetyLimit(`${equipment.name} ${currencyName}已达到经典动作上限 ${maxAttempts} 次，已停止所有打造。`);
    }
    return { matched: false, attemptCount: maxAttempts };
  };

  /**
   * prepareEquipmentForContinuousAction 只保留聚合动作自己的智能逻辑。
   * 普通通货和普通工艺步骤必须笨笨地执行一次，不自动预处理、跳过或改用别的通货。
   */
  const prepareEquipmentForContinuousAction = async () => {};

  const applyAltAugOnce = async (equipment) => {
    recordStepExecution('改造石');
    addMainLog(`${equipment.name} 使用改造石。`);
    const alterationPayload = await modifyEquipment(equipment.id, MODIFY_TYPES.alteration);
    if (!alterationPayload.success) throw new Error(alterationPayload.message || '改造石失败');
    mergeEquipmentUpdate(equipment, alterationPayload.data?.equipment);
    addStepLog(`${equipment.name} 已执行：改造石。`);
    if (shouldUseAugment(equipment)) {
      recordStepExecution('增幅石');
      addMainLog(`${equipment.name} 使用增幅石。`);
      const augmentPayload = await modifyEquipment(equipment.id, MODIFY_TYPES.augment);
      if (augmentPayload.success) {
        mergeEquipmentUpdate(equipment, augmentPayload.data?.equipment);
        addStepLog(`${equipment.name} 已执行：增幅石。`);
      } else {
        addStepLog(`${equipment.name} 增幅石未执行：${augmentPayload.message || '接口返回失败'}。`);
      }
    }
    await wait(getSpeedDelay());
  };

  /**
   * executeContinuousCraftStep 执行连续打造中的单个步骤。
   * 返回 false 表示本轮连续打造失败，外层会重新从第一步开始尝试。
   * @param {object} equipment 装备对象。
   * @param {object} step 连续打造步骤。
   * @param {number} stepIndex 步骤下标，用于日志。
   * @returns {Promise<boolean>} 本步骤命中或无需命中时返回 true。
   */
  const executeContinuousCraftStep = async (equipment, step, stepIndex) => {
    const normalizedStep = normalizeContinuousCraftStep(step);
    const actionConfig = CONTINUOUS_CRAFT_ACTIONS[normalizedStep.action];
    const conditionGroups = normalizedStep.conditionGroups.filter((group) => group.conditions.length > 0);
    recordContinuousStepExecution(stepIndex, actionConfig.label);
    addStepLog(`${equipment.name} 自定义打造步骤 ${formatContinuousStepCode(stepIndex)} 开始：${actionConfig.label}，条件组 ${conditionGroups.length} 个。`);
    await prepareEquipmentForContinuousAction(equipment, normalizedStep.action);
    if (!state.isRunning) return false;

    if (normalizedStep.action === 'conditionCheck') {
      const matched = isAffixMatched(equipment, conditionGroups);
      addStepLog(`${equipment.name} 自定义打造步骤 ${formatContinuousStepCode(stepIndex)} 判断条件：条件${matched ? '成立' : '不成立'}。`);
      return matched;
    }
    if (normalizedStep.action === 'none') {
      addStepLog(`${equipment.name} 自定义打造步骤 ${formatContinuousStepCode(stepIndex)} 无动作完成。`);
      return true;
    }
    if (normalizedStep.action === 'alteration') {
      const success = await applyCraftCurrency(equipment, MODIFY_TYPES.alteration, actionConfig.currencyLabel);
      if (!success) throw new Error(`${actionConfig.currencyLabel}失败`);
      await wait(getSpeedDelay());
      return true;
    }
    if (normalizedStep.action === 'chaos') {
      const success = await applyCraftCurrency(equipment, MODIFY_TYPES.chaos, actionConfig.currencyLabel);
      if (!success) throw new Error(`${actionConfig.currencyLabel}失败`);
      await wait(getSpeedDelay());
      return true;
    }
    if (normalizedStep.action === 'ensureMagic') {
      await ensureEquipmentMagic(equipment);
      return true;
    }
    if (normalizedStep.action === 'ensureRare') {
      await ensureEquipmentRare(equipment);
      return true;
    }
    if (normalizedStep.action === 'smartAugment') {
      await smartAugmentEquipment(equipment);
      return true;
    }
    if (normalizedStep.action === 'smartExalted') {
      await smartExaltEquipment(equipment);
      return true;
    }
    if (normalizedStep.action === 'smartCraftBench') {
      await applySmartCraftBench(equipment, normalizedStep.craftId);
      return true;
    }
    if (normalizedStep.action === 'craftBench') {
      await applyCraftBench(equipment, normalizedStep.craftId);
      addStepLog(`${equipment.name} 自定义打造步骤 ${formatContinuousStepCode(stepIndex)} 工艺完成。`);
      return true;
    }
    if (normalizedStep.action === 'gardenCraft') {
      await applyGardenCraft(equipment, normalizedStep.gardenCraftCategory, normalizedStep.gardenCraftKey);
      addStepLog(`${equipment.name} 自定义打造步骤 ${formatContinuousStepCode(stepIndex)} 花园工艺完成。`);
      return true;
    }
    const currencyTypeMap = {
      regal: MODIFY_TYPES.regal,
      scouring: MODIFY_TYPES.scouring,
      transmutation: MODIFY_TYPES.transmutation,
      augment: MODIFY_TYPES.augment,
      alchemy: MODIFY_TYPES.alchemy,
      exalted: MODIFY_TYPES.exalted,
      divine: MODIFY_TYPES.divine,
      annulment: MODIFY_TYPES.annulment,
    };
    const currencyType = currencyTypeMap[normalizedStep.action];
    const success = await applyCraftCurrency(equipment, currencyType, actionConfig.currencyLabel);
    if (!success) throw new Error(`${actionConfig.currencyLabel}失败`);
    await wait(getSpeedDelay());
    return true;
  };

  const resolveContinuousStepTarget = (targetStepIndex, fallbackStepIndex, maxStepCount) => {
    const rawIndex = Number.isInteger(targetStepIndex) ? targetStepIndex : fallbackStepIndex;
    return Math.max(0, Math.min(rawIndex, maxStepCount));
  };

  const normalizeContinuousStepHandling = (handling, fallbackHandling = 'jump') => (
    CONTINUOUS_STEP_HANDLINGS[handling] ? handling : fallbackHandling
  );

  const handleContinuousStepRouting = async (equipment, step, stepIndex, maxStepCount, resultType) => {
    const normalizedStep = normalizeContinuousCraftStep(step);
    const stepCode = formatContinuousStepCode(stepIndex);
    const isSuccess = resultType === 'success';
    const isConditionStep = normalizedStep.action === 'conditionCheck';
    const handling = isConditionStep
      ? (isSuccess ? normalizedStep.successHandling : normalizedStep.failureHandling)
      : normalizedStep.successHandling;
    const targetStepIndex = isSuccess ? normalizedStep.successTargetStepIndex : normalizedStep.failureTargetStepIndex;
    const statusText = isConditionStep
      ? (isSuccess ? '条件成立' : '条件不成立')
      : (isSuccess ? '动作完成' : '动作未完成');
    if (CONTINUOUS_STEP_TERMINATION_HANDLINGS[handling]) {
      const terminateConfig = CONTINUOUS_STEP_TERMINATION_HANDLINGS[handling];
      addLog(`${equipment.name} 自定义打造步骤 ${stepCode} ${statusText}，终止当前装备打造：${terminateConfig.label}。`, terminateConfig.level);
      return terminateConfig.result;
    }
    if (handling === 'jump') {
      const nextStepIndex = resolveContinuousStepTarget(
        targetStepIndex,
        isSuccess ? stepIndex + 1 : stepIndex,
        maxStepCount,
      );
      const targetText = nextStepIndex >= maxStepCount ? '终止(打造成功)' : formatContinuousStepTarget(nextStepIndex);
      addLog(`${equipment.name} 自定义打造步骤 ${stepCode} ${statusText}，跳转到步骤 ${targetText}。`, 'info');
      return nextStepIndex;
    }
    addLog(`${equipment.name} 自定义打造步骤 ${stepCode} ${statusText}，使用一次重铸石后从步骤 A 重新开始。`, 'info');
    await scourEquipmentOnceForMagicCompatibleRestart(equipment);
    return 0;
  };

  const getContinuousRoutingOutcomesForAnalysis = (step, stepIndex, maxStepCount) => {
    const normalizedStep = normalizeContinuousCraftStep(step);
    const isConditionStep = normalizedStep.action === 'conditionCheck';
    const createTarget = (handling, targetStepIndex, fallbackStepIndex) => {
      if (handling === 'terminateSuccess') return [{ type: 'successExit' }];
      if (CONTINUOUS_STEP_TERMINATION_HANDLINGS[handling]) return [{ type: 'exit' }];
      if (handling === 'scourRestart') return [{ type: 'step', index: 0, resetDepth: true }];
      const nextIndex = resolveContinuousStepTarget(targetStepIndex, fallbackStepIndex, maxStepCount);
      return nextIndex >= maxStepCount ? [{ type: 'complete' }] : [{ type: 'step', index: nextIndex }];
    };
    if (!isConditionStep) {
      return createTarget(normalizedStep.successHandling, normalizedStep.successTargetStepIndex, stepIndex + 1);
    }
    return [
      ...createTarget(normalizedStep.successHandling, normalizedStep.successTargetStepIndex, stepIndex + 1),
      ...createTarget(normalizedStep.failureHandling, normalizedStep.failureTargetStepIndex, stepIndex),
    ];
  };

  const getContinuousRoutingTargetsForAnalysis = (step, stepIndex, maxStepCount) => (
    getContinuousRoutingOutcomesForAnalysis(step, stepIndex, maxStepCount)
      .filter((outcome) => outcome.type === 'step')
  );

  const getContinuousConditionDepths = (steps) => {
    const normalizedSteps = normalizeContinuousCraftSteps(steps);
    const conditionDepths = new Map();
    const bestDepthBeforeStep = new Map();
    const queue = [{ index: 0, depthBefore: 0 }];
    while (queue.length) {
      const { index, depthBefore } = queue.shift();
      if (index < 0 || index >= normalizedSteps.length) continue;
      const bestDepth = bestDepthBeforeStep.get(index);
      if (bestDepth !== undefined && bestDepth <= depthBefore) continue;
      bestDepthBeforeStep.set(index, depthBefore);
      const step = normalizedSteps[index];
      const isConditionStep = step.action === 'conditionCheck';
      const depthAfterStep = isConditionStep ? depthBefore + 1 : depthBefore;
      if (isConditionStep) {
        const previousDepth = conditionDepths.get(index);
        if (previousDepth === undefined || depthAfterStep < previousDepth) {
          conditionDepths.set(index, depthAfterStep);
        }
      }
      for (const target of getContinuousRoutingTargetsForAnalysis(step, index, normalizedSteps.length)) {
        const targetIndex = typeof target === 'object' ? target.index : target;
        const targetDepthBefore = typeof target === 'object' && target.resetDepth ? 0 : depthAfterStep;
        if (targetIndex < normalizedSteps.length) queue.push({ index: targetIndex, depthBefore: targetDepthBefore });
      }
    }
    return conditionDepths;
  };

  const assertContinuousCraftFlowHasExit = (steps) => {
    const normalizedSteps = normalizeContinuousCraftSteps(steps);
    if (!normalizedSteps.length) throw new Error('自定义打造至少需要一个步骤。');
    const edges = normalizedSteps.map((step, stepIndex) => (
      getContinuousRoutingOutcomesForAnalysis(step, stepIndex, normalizedSteps.length)
    ));
    const successExitSteps = edges
      .map((outcomes, stepIndex) => outcomes.some((outcome) => outcome.type === 'successExit') ? stepIndex : -1)
      .filter((stepIndex) => stepIndex >= 0);
    if (!successExitSteps.length) {
      throw new Error('自定义打造流程必须至少有一个“终止(打造成功)”出口。');
    }
    normalizedSteps.forEach((step, stepIndex) => {
      const normalizedStep = normalizeContinuousCraftStep(step);
      if (normalizedStep.action !== 'conditionCheck') return;
      const branches = [
        { label: '条件成立', handling: normalizedStep.successHandling, targetStepIndex: normalizedStep.successTargetStepIndex, fallbackStepIndex: stepIndex + 1 },
        { label: '条件不成立', handling: normalizedStep.failureHandling, targetStepIndex: normalizedStep.failureTargetStepIndex, fallbackStepIndex: stepIndex },
      ];
      branches.forEach((branch) => {
        if (branch.handling !== 'jump') return;
        const targetIndex = resolveContinuousStepTarget(
          branch.targetStepIndex,
          branch.fallbackStepIndex,
          normalizedSteps.length,
        );
        if (targetIndex === stepIndex) {
          throw new Error(`自定义打造流程不合法：步骤${formatContinuousStepCode(stepIndex)} ${branch.label}不能跳转到自己。`);
        }
      });
    });
    const canReachExit = new Set();
    const visiting = new Set();
    const canStepReachExit = (stepIndex) => {
      if (stepIndex < 0 || stepIndex >= normalizedSteps.length) return false;
      if (canReachExit.has(stepIndex)) return true;
      if (visiting.has(stepIndex)) return false;
      visiting.add(stepIndex);
      const hasExit = edges[stepIndex].some((outcome) => (
        outcome.type === 'successExit'
        || outcome.type === 'exit'
        || outcome.type === 'complete'
        || (outcome.type === 'step' && canStepReachExit(outcome.index))
      ));
      visiting.delete(stepIndex);
      if (hasExit) canReachExit.add(stepIndex);
      return hasExit;
    };
    const blockedSteps = normalizedSteps
      .map((_, stepIndex) => stepIndex)
      .filter((stepIndex) => !canStepReachExit(stepIndex));
    if (blockedSteps.length) {
      const stepLabels = blockedSteps
        .sort((left, right) => left - right)
        .map((stepIndex) => `步骤${formatContinuousStepCode(stepIndex)}`)
        .join('、');
      throw new Error(`自定义打造流程不合法：${stepLabels} 最终无法到达完成或终止出口，请调整下一步或条件成立/不成立跳转。`);
    }
  };

  /**
   * processContinuousCraftSteps 按用户定义的步骤链循环打造，所有步骤都命中才计为完成。
   * 某一步条件不成立后按照该步骤自己的条件不成立处理决定停止、重铸重来或继续本步骤。
   * @param {object} equipment 装备对象。
   * @param {Array<object>} steps 连续打造步骤列表。
   */
  const processContinuousCraftSteps = async (equipment, steps) => {
    const normalizedSteps = normalizeContinuousCraftSteps(steps);
    const customStepLimit = state.customCraftStepSafetyLimit;
    const conditionDepths = getContinuousConditionDepths(normalizedSteps);
    let stepIndex = 0;
    let attemptIndex = 1;
    let activeConditionDepth = 1;
    const conditionStepCounts = new Map();
    while (state.isRunning && stepIndex < normalizedSteps.length) {
      const conditionDepth = conditionDepths.get(stepIndex);
      if (conditionDepth !== undefined) {
        if (conditionDepth > activeConditionDepth) {
          activeConditionDepth = conditionDepth;
          for (const [trackedStepIndex] of conditionStepCounts) {
            if ((conditionDepths.get(trackedStepIndex) || 0) < activeConditionDepth) {
              conditionStepCounts.delete(trackedStepIndex);
            }
          }
        }
        if (conditionDepth === activeConditionDepth) {
          const currentStepCount = (conditionStepCounts.get(stepIndex) || 0) + 1;
          conditionStepCounts.set(stepIndex, currentStepCount);
          if (currentStepCount > customStepLimit) {
            stopTaskForSafetyLimit(`${equipment.name} 自定义打造步骤 ${formatContinuousStepCode(stepIndex)} 判断条件已执行 ${customStepLimit} 次仍未进入下一层判断，已停止所有打造。`);
          }
        }
      }
      const stepMatched = await executeContinuousCraftStep(equipment, normalizedSteps[stepIndex], stepIndex);
      const currentStep = normalizedSteps[stepIndex];
      if (stepMatched && ['annulment', 'exalted'].includes(currentStep.action)) {
        logContinuousCraftAffixSnapshot(
          equipment,
          stepIndex,
          CONTINUOUS_CRAFT_ACTIONS[currentStep.action]?.label || currentStep.action,
        );
      }
      const previousStepIndex = stepIndex;
      if (stepMatched) {
        stepIndex = await handleContinuousStepRouting(equipment, normalizedSteps[stepIndex], stepIndex, normalizedSteps.length, 'success');
      } else {
        if (!state.isRunning) return false;
        stepIndex = await handleContinuousStepRouting(equipment, normalizedSteps[stepIndex], stepIndex, normalizedSteps.length, 'failure');
      }
      if (stepIndex === CONTINUOUS_STEP_TERMINATION.success) {
        state.completedCount += 1;
        addLog(`命中 ${state.completedCount}：${equipment.name}，自定义打造轮次${attemptIndex}，已按“终止(打造成功)”结束。`, 'success');
        return true;
      }
      if (stepIndex === CONTINUOUS_STEP_TERMINATION.manual) {
        addLog(`${equipment.name} 自定义打造轮次${attemptIndex}已按“终止(手动操作)”结束，当前装备未计为命中。`, 'warn');
        return false;
      }
      if (stepIndex === CONTINUOUS_STEP_TERMINATION.error) {
        throw new Error(`${equipment.name} 自定义打造轮次${attemptIndex}触发“终止(异常错误)”。`);
      }
      if (stepIndex === 0 && previousStepIndex !== 0) attemptIndex += 1;
    }
    if (stepIndex >= normalizedSteps.length) {
      state.completedCount += 1;
      addLog(`命中 ${state.completedCount}：${equipment.name}，自定义打造轮次${attemptIndex}。`, 'success');
      return true;
    }
    return false;
  };

  /**
   * fetchCurrencyData 读取当前角色通货数据。
   * @returns {Promise<object>} 通货数据对象。
   */
  const fetchCurrencyData = async () => {
    const payload = await requestJson(config.endpoints.currency);
    if (!payload.success) throw new Error(payload.message || '获取通货失败');
    return payload.data || {};
  };

  /**
   * convertCurrencyToMailPayload 把角色通货数据转换成邮件发送接口需要的结构。
   * @param {object} currencyData 角色通货数据。
   * @param {number} percentage 发送百分比。
   * @returns {object} 邮件接口 currencies 字段。
   */
  const convertCurrencyToMailPayload = (currencyData, percentage) => {
    const multiplier = Math.max(1, Math.min(100, percentage)) / 100;
    const currencies = {};
    for (const [fieldName, currencyId] of Object.entries(CURRENCY_ID_MAP)) {
      const amount = Math.floor(Number(currencyData[fieldName] || 0) * multiplier);
      if (amount > 0) currencies[currencyId] = amount;
    }
    return currencies;
  };

  /**
   * getMailPercentage 读取通货百分比滑块的数值，并限制在 1-100 范围内。
   * @returns {number} 当前通货发送百分比。
   */
  const getMailPercentage = () => {
    const percentage = Number.parseInt(state.ui.mailPercentageInput?.value || '100', 10);
    return Math.max(1, Math.min(100, Number.isFinite(percentage) ? percentage : 100));
  };

  /**
   * buildCurrencyPreview 按百分比计算预计发送的每种通货数量。
   * @param {object} currencyData 角色通货数据。
   * @param {number} percentage 通货发送百分比。
   * @returns {Array<object>} 可展示的通货预览列表。
   */
  const buildCurrencyPreview = (currencyData, percentage) => {
    const multiplier = Math.max(1, Math.min(100, percentage)) / 100;
    return Object.entries(CURRENCY_ID_MAP)
      .map(([fieldName, currencyId]) => {
        const owned = Number(currencyData[fieldName] || 0);
        return {
          fieldName,
          currencyId,
          owned,
          amount: Math.floor(owned * multiplier),
          name: CURRENCY_NAME_MAP[fieldName] || fieldName,
        };
      })
      .filter((currency) => currency.amount > 0);
  };

  /**
   * renderMailCurrencyPreview 渲染通货百分比滑块对应的预计发送数量。
   * @param {Array<object>} previewList buildCurrencyPreview 返回的预览列表。
   */
  const renderMailCurrencyPreview = (previewList) => {
    const previewElement = state.ui.mailCurrencyPreview;
    if (!previewElement) return;
    previewElement.replaceChildren();
    if (!previewList.length) {
      previewElement.textContent = '当前百分比下没有可发送的通货。';
      return;
    }
    previewElement.append(createElement('div', {
      className: 'poe2-mail-preview-list',
      children: previewList.map((currency) => createElement('span', {
        className: 'poe2-mail-preview-item',
        textContent: `${currency.name} ${currency.amount}/${currency.owned}`,
      })),
    }));
  };

  /**
   * refreshMailCurrencyPreview 刷新邮件通货预览，失败时只提示预览异常，不影响用户继续编辑邮件。
   * @param {boolean} forceRefresh 是否强制重新读取服务端通货数据。
   * @returns {Promise<void>}
   */
  const refreshMailCurrencyPreview = async (forceRefresh = false) => {
    const previewElement = state.ui.mailCurrencyPreview;
    if (!previewElement) return;
    const percentage = getMailPercentage();
    state.ui.mailPercentageValue.textContent = `${percentage}%`;
    try {
      if (!state.mailCurrencyData || forceRefresh) {
        previewElement.textContent = '正在计算预计发送数量...';
        state.mailCurrencyData = await fetchCurrencyData();
      }
      state.mailCurrencyPreview = buildCurrencyPreview(state.mailCurrencyData, percentage);
      renderMailCurrencyPreview(state.mailCurrencyPreview);
    } catch (error) {
      previewElement.textContent = `通货数量预览失败：${error.message}`;
    }
  };

  /**
   * scheduleMailCurrencyPreview 防抖刷新通货预览，滑块拖动时不会连续轰炸接口。
   * @param {boolean} forceRefresh 是否强制重新读取服务端通货数据。
   */
  const scheduleMailCurrencyPreview = (forceRefresh = false) => {
    window.clearTimeout(state.mailCurrencyPreviewTimer);
    state.mailCurrencyPreviewTimer = window.setTimeout(() => {
      refreshMailCurrencyPreview(forceRefresh);
    }, 220);
  };

  /**
   * refreshMailCurrencyInventory 手动刷新邮件页使用的当前通货库存。
   */
  const refreshMailCurrencyInventory = async () => {
    await refreshMailCurrencyPreview(true);
    addLog('已刷新邮件通货库存预览。', 'compact');
  };

  const getCurrencyAmount = (currencyData, fieldName) => (
    Math.max(0, Math.floor(Number(currencyData?.[fieldName] || 0)))
  );

  const calculateRatioScore = (counts, ratios) => {
    const ratioSquareTotal = ratios.reduce((total, ratio) => total + ratio * ratio, 0);
    const unit = ratios.reduce((total, ratio, index) => total + counts[index] * ratio, 0) / ratioSquareTotal;
    return counts.reduce((total, count, index) => {
      const diff = count - ratios[index] * unit;
      return total + diff * diff;
    }, 0);
  };

  const findBestIntegerInRange = (minValue, maxValue, scoreGetter) => {
    let left = Math.ceil(minValue);
    let right = Math.floor(maxValue);
    if (right < left) return left;
    while (right - left > 8) {
      const midLeft = Math.floor((left * 2 + right) / 3);
      const midRight = Math.floor((left + right * 2) / 3);
      if (scoreGetter(midLeft) <= scoreGetter(midRight)) {
        right = midRight - 1;
      } else {
        left = midLeft + 1;
      }
    }
    let bestValue = left;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let value = left; value <= right; value += 1) {
      const score = scoreGetter(value);
      if (score < bestScore) {
        bestScore = score;
        bestValue = value;
      }
    }
    return bestValue;
  };

  const calculateChanceScouringBalancePlan = (currencyData) => {
    const chance = getCurrencyAmount(currencyData, 'orbOfChance');
    const scouring = getCurrencyAmount(currencyData, 'orbOfScouring');
    const maxChanceToScouring = Math.floor(chance / 4);
    const evaluate = (chanceToScouring) => {
      const nextChance = chance - chanceToScouring * 4;
      const nextScouring = scouring + chanceToScouring;
      return {
        chanceToScouring,
        nextChance,
        nextScouring,
        score: calculateRatioScore([nextChance, nextScouring], [1, 1]),
      };
    };
    const candidates = new Set([0]);
    const equalized = (chance - scouring) / 5;
    for (let value = Math.floor(equalized) - 3; value <= Math.ceil(equalized) + 3; value += 1) {
      if (value >= 0 && value <= maxChanceToScouring) candidates.add(value);
    }
    return [...candidates]
      .map(evaluate)
      .filter((plan) => plan.nextChance >= plan.nextScouring)
      .sort((left, right) => left.score - right.score || right.chanceToScouring - left.chanceToScouring)[0] || evaluate(0);
  };

  const calculateAltAugBalancePlan = (currencyData) => {
    const transmutation = getCurrencyAmount(currencyData, 'orbOfTransmutation');
    const augmentation = getCurrencyAmount(currencyData, 'orbOfAugmentation');
    const alteration = getCurrencyAmount(currencyData, 'orbOfAlteration');
    const maxTransmutationToAugmentation = Math.floor(transmutation / 4);
    const evaluate = (transmutationToAugmentation, augmentationToAlteration) => {
      const nextTransmutation = transmutation - transmutationToAugmentation * 4;
      const nextAugmentation = augmentation + transmutationToAugmentation - augmentationToAlteration * 4;
      const nextAlteration = alteration + augmentationToAlteration;
      return {
        transmutationToAugmentation,
        augmentationToAlteration,
        nextTransmutation,
        nextAugmentation,
        nextAlteration,
        score: calculateRatioScore([nextTransmutation, nextAugmentation, nextAlteration], [1, 4, 4]),
      };
    };
    const bestPlanForTransmutationExchange = (transmutationToAugmentation) => {
      const maxAugmentationToAlteration = Math.floor((augmentation + transmutationToAugmentation) / 4);
      const bestAugmentationToAlteration = findBestIntegerInRange(0, maxAugmentationToAlteration, (augmentationToAlteration) => (
        evaluate(transmutationToAugmentation, augmentationToAlteration).score
      ));
      return evaluate(transmutationToAugmentation, bestAugmentationToAlteration);
    };
    const bestTransmutationToAugmentation = findBestIntegerInRange(0, maxTransmutationToAugmentation, (transmutationToAugmentation) => (
      bestPlanForTransmutationExchange(transmutationToAugmentation).score
    ));
    const candidates = new Set([0, maxTransmutationToAugmentation]);
    for (let value = bestTransmutationToAugmentation - 5; value <= bestTransmutationToAugmentation + 5; value += 1) {
      if (value >= 0 && value <= maxTransmutationToAugmentation) candidates.add(value);
    }
    return [...candidates]
      .map(bestPlanForTransmutationExchange)
      .sort((left, right) => (
        left.score - right.score ||
        left.transmutationToAugmentation - right.transmutationToAugmentation ||
        left.augmentationToAlteration - right.augmentationToAlteration
      ))[0];
  };

  const buyShopCurrency = async (itemId, quantity, label) => {
    const totalQuantity = Math.max(0, Math.floor(Number(quantity) || 0));
    if (!totalQuantity) return 0;
    let exchangedQuantity = 0;
    while (state.isRunning && exchangedQuantity < totalQuantity) {
      const batchQuantity = Math.min(99999, totalQuantity - exchangedQuantity);
      const payload = await requestJson(config.endpoints.shopBuy, {
        method: 'POST',
        body: { itemId: String(itemId), quantity: batchQuantity },
      });
      if (!payload.success) throw new Error(payload.message || `${label}兑换失败`);
      exchangedQuantity += batchQuantity;
      addLog(`${label}：已兑换 ${exchangedQuantity}/${totalQuantity}。`, 'compact');
    }
    return exchangedQuantity;
  };

  const refreshCurrencyCachesAfterBalance = async () => {
    state.mailCurrencyData = await fetchCurrencyData();
    if (state.ui.mailCurrencyPreview) {
      state.mailCurrencyPreview = buildCurrencyPreview(state.mailCurrencyData, getMailPercentage());
      renderMailCurrencyPreview(state.mailCurrencyPreview);
    }
    return state.mailCurrencyData;
  };

  const balanceChanceScouringCurrencies = async () => {
    const currencyData = await fetchCurrencyData();
    const plan = calculateChanceScouringBalancePlan(currencyData);
    addLog(`机会/重铸当前：机会${getCurrencyAmount(currencyData, 'orbOfChance')} 重铸${getCurrencyAmount(currencyData, 'orbOfScouring')}；计划兑换重铸石${plan.chanceToScouring}。`, 'info');
    if (!plan.chanceToScouring) {
      addLog(`机会/重铸已接近 1:1：机会${plan.nextChance} 重铸${plan.nextScouring}。`, 'success');
      return;
    }
    await buyShopCurrency(MODIFY_TYPES.scouring, plan.chanceToScouring, '机会兑换重铸石');
    const latest = await refreshCurrencyCachesAfterBalance();
    addLog(`机会/重铸平衡完成：机会${getCurrencyAmount(latest, 'orbOfChance')} 重铸${getCurrencyAmount(latest, 'orbOfScouring')}。`, 'success');
  };

  const balanceAltAugCurrencies = async () => {
    const currencyData = await fetchCurrencyData();
    const plan = calculateAltAugBalancePlan(currencyData);
    addLog(`蜕变/增幅/改造当前：蜕变${getCurrencyAmount(currencyData, 'orbOfTransmutation')} 增幅${getCurrencyAmount(currencyData, 'orbOfAugmentation')} 改造${getCurrencyAmount(currencyData, 'orbOfAlteration')}；计划蜕变换增幅${plan.transmutationToAugmentation}，增幅换改造${plan.augmentationToAlteration}。`, 'info');
    if (!plan.transmutationToAugmentation && !plan.augmentationToAlteration) {
      addLog(`蜕变/增幅/改造已接近 1:4:4：蜕变${plan.nextTransmutation} 增幅${plan.nextAugmentation} 改造${plan.nextAlteration}。`, 'success');
      return;
    }
    await buyShopCurrency(MODIFY_TYPES.augment, plan.transmutationToAugmentation, '蜕变兑换增幅石');
    await buyShopCurrency(MODIFY_TYPES.alteration, plan.augmentationToAlteration, '增幅兑换改造石');
    const latest = await refreshCurrencyCachesAfterBalance();
    addLog(`蜕变/增幅/改造平衡完成：蜕变${getCurrencyAmount(latest, 'orbOfTransmutation')} 增幅${getCurrencyAmount(latest, 'orbOfAugmentation')} 改造${getCurrencyAmount(latest, 'orbOfAlteration')}。`, 'success');
  };

  /**
   * normalizeRecentMailReceivers 清理最近收件人列表，保证最多 3 个且不重复。
   * @param {Array<string>} receivers 原始收件人列表。
   * @returns {Array<string>} 清理后的收件人列表。
   */
  const normalizeRecentMailReceivers = (receivers) => {
    return sanitizeRecentMailReceiverList(receivers);
  };

  /**
   * persistRecentMailReceivers 仅在本次页面会话内维护最近收件人。
   */
  const persistRecentMailReceivers = () => {
    state.recentMailReceivers = normalizeRecentMailReceivers(state.recentMailReceivers);
    updateAssistantSetting('recentMailReceivers', state.recentMailReceivers);
  };

  /**
   * renderRecentMailReceivers 渲染最近 3 个收件人快捷按钮。
   */
  const renderRecentMailReceivers = () => {
    const listElement = state.ui.mailRecentReceiverList;
    if (!listElement) return;
    const receivers = normalizeRecentMailReceivers(state.recentMailReceivers);
    listElement.replaceChildren(...receivers.map((receiverName) => createElement('button', {
      className: 'poe2-mail-recent-button',
      type: 'button',
      textContent: receiverName,
      onClick: () => {
        state.ui.mailReceiverInput.value = receiverName;
        hideMailReceiverSuggestions();
      },
    })));
  };

  /**
   * rememberMailReceiver 在邮件发送成功后把收件人加入最近列表顶部。
   * @param {string} receiverName 收件人角色名。
   */
  const rememberMailReceiver = (receiverName) => {
    const normalizedName = String(receiverName || '').trim();
    if (!normalizedName) return;
    state.recentMailReceivers = normalizeRecentMailReceivers([
      normalizedName,
      ...state.recentMailReceivers.filter((receiver) => receiver !== normalizedName),
    ]);
    persistRecentMailReceivers();
    renderRecentMailReceivers();
  };

  /**
   * searchMailReceivers 调用游戏网页同款角色搜索接口，按输入片段返回收件人提示。
   * @param {string} keyword 输入框中的角色名片段。
   * @returns {Promise<Array<object>>} 收件人候选列表。
   */
  const searchMailReceivers = async (keyword) => {
    const normalizedKeyword = String(keyword || '').trim();
    if (!normalizedKeyword) return [];
    const searchParams = new URLSearchParams({ keyword: normalizedKeyword });
    const payload = await requestJson(`${config.endpoints.characterSearch}?${searchParams.toString()}`);
    const characters = Array.isArray(payload.data) ? payload.data : [];
    return characters
      .map((character) => ({
        name: String(character?.name || '').trim(),
        level: character?.level,
      }))
      .filter((character) => character.name)
      .sort((left, right) => {
        if (left.name === normalizedKeyword) return -1;
        if (right.name === normalizedKeyword) return 1;
        return left.name.localeCompare(right.name);
      })
      .slice(0, 8);
  };

  /**
   * hideMailReceiverSuggestions 隐藏收件人下拉提示。
   */
  const hideMailReceiverSuggestions = () => {
    const suggestionElement = state.ui.mailReceiverSuggestionList;
    if (!suggestionElement) return;
    suggestionElement.hidden = true;
    suggestionElement.replaceChildren();
  };

  /**
   * renderMailReceiverSuggestions 渲染角色名自动补全下拉框。
   * @param {Array<object>} suggestions 角色名候选列表。
   */
  const renderMailReceiverSuggestions = (suggestions) => {
    const suggestionElement = state.ui.mailReceiverSuggestionList;
    if (!suggestionElement) return;
    suggestionElement.replaceChildren();
    if (!suggestions.length) {
      hideMailReceiverSuggestions();
      return;
    }
    suggestionElement.hidden = false;
    suggestionElement.append(...suggestions.map((suggestion) => createElement('button', {
      className: 'poe2-mail-suggestion',
      type: 'button',
      onClick: () => {
        state.ui.mailReceiverInput.value = suggestion.name;
        hideMailReceiverSuggestions();
      },
      children: [
        createElement('span', { textContent: suggestion.name }),
        createElement('span', {
          className: 'poe2-mail-suggestion-level',
          textContent: suggestion.level ? `Lv.${suggestion.level}` : '',
        }),
      ],
    })));
  };

  /**
   * handleMailReceiverInput 防抖处理收件人输入，并同步网页邮件页的自动下拉提示体验。
   */
  const handleMailReceiverInput = () => {
    window.clearTimeout(state.mailReceiverSearchTimer);
    const keyword = state.ui.mailReceiverInput.value.trim();
    if (!keyword) {
      hideMailReceiverSuggestions();
      return;
    }
    state.mailReceiverSearchTimer = window.setTimeout(async () => {
      try {
        const suggestions = await searchMailReceivers(keyword);
        if (state.ui.mailReceiverInput.value.trim() !== keyword) return;
        state.mailReceiverSuggestions = suggestions;
        renderMailReceiverSuggestions(suggestions);
      } catch (error) {
        state.mailReceiverSuggestions = [];
        hideMailReceiverSuggestions();
        addLog(`收件人提示读取失败：${error.message}`, 'warn');
      }
    }, 260);
  };

  /**
   * sendCurrencyMail 发送通货邮件。
   */
  const sendCurrencyMail = async () => {
    const receiverName = state.ui.mailReceiverInput.value.trim();
    const title = state.ui.mailTitleInput.value.trim() || '默认标题';
    const content = state.ui.mailContentInput.value.trim() || '默认内容';
    const percentage = getMailPercentage();
    if (!receiverName) throw new Error('请填写收件人。');
    const currencyData = await fetchCurrencyData();
    state.mailCurrencyData = currencyData;
    const currencies = convertCurrencyToMailPayload(currencyData, percentage);
    if (!Object.keys(currencies).length) throw new Error('没有可发送的通货。');
    const payload = await requestJson(config.endpoints.mailSend, {
      method: 'POST',
      body: { receiverName, title, content, currencies, equipmentIds: [], skillStoneIds: [] },
    });
    if (!payload.success) throw new Error(payload.message || '邮件发送失败');
    rememberMailReceiver(receiverName);
    addLog(`邮件发送成功：${receiverName}，通货种类 ${Object.keys(currencies).length}。`, 'compact');
    try {
      await refreshMailCurrencyInventory();
    } catch (error) {
      addLog(`邮件发送成功，但自动刷新库存失败：${error.message}`, 'warn');
    }
  };

  /**
   * renderSkillStoneOptions 把 state.skillStones 渲染到多选列表。
   * 刷新时会尽量保留用户之前选中的技能石 ID。
   * @param {Set<string>} selectedIds 刷新前已选中的技能石 ID 集合。
   */
  const renderSkillStoneOptions = (selectedIds = new Set()) => {
    const selectElement = state.ui.skillStoneSelect;
    if (!selectElement) return;
    selectElement.replaceChildren();
    state.ui.skillStoneVisualList?.replaceChildren();
    for (const stone of state.skillStones) {
      const fullLabel = `[${stone.sourceLabel}] ${stone.name} | Lv.${stone.level || '?'} | 品质 ${stone.quality || 0}%${stone.corrupted ? ' 已腐化' : ''}`;
      const optionElement = createElement('option', {
        value: stone.id,
        textContent: formatSkillStoneLabel(stone),
      });
      optionElement.title = `${fullLabel}${stone.equipmentName ? ` | ${stone.equipmentName}` : ''}`;
      optionElement.selected = selectedIds.has(stone.id);
      selectElement.append(optionElement);
      if (state.ui.skillStoneVisualList) {
        const checkboxElement = createElement('input', {
          type: 'checkbox',
          checked: optionElement.selected,
        });
        const rowElement = createElement('div', {
          className: `poe2-stone-choice${optionElement.selected ? ' selected' : ''}`,
          dataset: { stoneId: stone.id },
          children: [
            checkboxElement,
            createElement('span', {
              className: 'poe2-stone-choice-text',
              textContent: formatSkillStoneLabel(stone),
            }),
          ],
        });
        checkboxElement.setAttribute('aria-label', formatSkillStoneLabel(stone));
        rowElement.setAttribute('role', 'option');
        rowElement.setAttribute('aria-selected', String(optionElement.selected));
        rowElement.title = `${fullLabel}${stone.equipmentName ? ` | ${stone.equipmentName}` : ''}`;
        checkboxElement.addEventListener('change', () => {
          optionElement.selected = checkboxElement.checked;
          rowElement.classList.toggle('selected', checkboxElement.checked);
          rowElement.setAttribute('aria-selected', String(checkboxElement.checked));
        });
        rowElement.addEventListener('click', (event) => {
          if (event.target === checkboxElement) return;
          checkboxElement.checked = !checkboxElement.checked;
          checkboxElement.dispatchEvent(new Event('change', { bubbles: true }));
        });
        state.ui.skillStoneVisualList.append(rowElement);
      }
    }
    if (state.ui.skillStoneSummary) {
      const backpackCount = state.skillStones.filter((stone) => stone.source === 'backpack').length;
      const equippedCount = state.skillStones.filter((stone) => stone.source === 'equipment').length;
      const practiceSocketText = state.practiceSkillStoneCache?.loaded
        ? `，可调整孔位 ${state.practiceSkillStoneCache.socketRecords.length}`
        : '';
      state.ui.skillStoneSummary.textContent = `已加载 ${state.skillStones.length} 颗技能石（背包 ${backpackCount}，装备 ${equippedCount}${practiceSocketText}）`;
    }
  };

  /**
   * getSelectedSkillStoneIds 读取当前多选列表里选中的技能石 ID。
   * @returns {Array<string>} 去重后的技能石 ID 列表。
   */
  const getSelectedSkillStoneIds = () => {
    const ids = Array.from(state.ui.skillStoneSelect?.selectedOptions || [])
      .map((option) => option.value)
      .filter(Boolean);
    return [...new Set(ids)];
  };

  const syncSkillStoneVisualSelectionFromNative = () => {
    if (!state.ui.skillStoneVisualList) return;
    const selectedIds = new Set(getSelectedSkillStoneIds());
    state.ui.skillStoneVisualList.querySelectorAll('.poe2-stone-choice').forEach((rowElement) => {
      const selected = selectedIds.has(rowElement.dataset.stoneId);
      const checkboxElement = rowElement.querySelector('input[type="checkbox"]');
      if (checkboxElement) checkboxElement.checked = selected;
      rowElement.classList.toggle('selected', selected);
      rowElement.setAttribute('aria-selected', String(selected));
    });
  };

  const updateSkillStoneActionButtonState = () => {
    const shouldDisable = state.isRunning || !state.hasLoadedSkillStones;
    for (const button of state.ui.skillStoneActionButtons || []) {
      button.disabled = shouldDisable;
    }
    if (state.ui.adjustPracticeSkillButton) {
      state.ui.adjustPracticeSkillButton.disabled = state.isRunning
        || !state.hasLoadedSkillStones
        || !state.practiceSkillStoneCache?.loaded;
    }
  };

  /**
   * refreshSkillStoneList 加载技能石多选列表。
   */
  const refreshSkillStoneList = async () => {
    const selectedIds = new Set(getSelectedSkillStoneIds());
    state.skillStones = await fetchAllSkillStones();
    state.hasLoadedSkillStones = true;
    renderSkillStoneOptions(selectedIds);
    updateSkillStoneActionButtonState();
    addLog(`技能石列表加载完成：${state.skillStones.length} 颗。`, 'compact');
  };

  /**
   * rerenderSkillStoneListAfterLocalUpdates 只用本地已更新的数据重绘技能石列表。
   * 升级、棱镜等接口会返回或局部补全被操作技能石，结束后不需要再全量分页和逐颗详情读取。
   * @param {Set<string>} selectedIds 需要保留选中的技能石 ID。
   */
  const rerenderSkillStoneListAfterLocalUpdates = (selectedIds = new Set(getSelectedSkillStoneIds())) => {
    state.hasLoadedSkillStones = true;
    renderSkillStoneOptions(selectedIds);
    updateSkillStoneActionButtonState();
  };

  /**
   * selectAllSkillStones 选中当前列表里的全部技能石。
   */
  const selectAllSkillStones = () => {
    for (const option of state.ui.skillStoneSelect.options) option.selected = true;
    syncSkillStoneVisualSelectionFromNative();
  };

  const isExcludedReservationSkillStone = (stone) => {
    const name = String(stone?.name || '').trim();
    return ['清晰', '精准', '活力'].includes(name);
  };

  const selectAllSkillStonesExceptReservation = () => {
    const stoneById = new Map(state.skillStones.map((stone) => [stone.id, stone]));
    let selectedCount = 0;
    for (const option of state.ui.skillStoneSelect.options) {
      const shouldSelect = !isExcludedReservationSkillStone(stoneById.get(option.value));
      option.selected = shouldSelect;
      if (shouldSelect) selectedCount += 1;
    }
    syncSkillStoneVisualSelectionFromNative();
    addLog(`已全选除清晰、精准、活力外的技能石：${selectedCount} 颗。`, 'compact');
  };

  /**
   * clearSkillStoneSelection 清空当前技能石选择。
   */
  const clearSkillStoneSelection = () => {
    for (const option of state.ui.skillStoneSelect.options) option.selected = false;
    syncSkillStoneVisualSelectionFromNative();
  };

  const isExceptionalSkillStone = (stone) => (
    EXCEPTIONAL_SKILL_STONE_IDS.has(String(stone?.skillId || '').trim())
    || EXCEPTIONAL_SKILL_STONE_NAMES.has(String(stone?.name || '').trim())
  );

  const getSkillStoneMaxLevel = (stone) => (isExceptionalSkillStone(stone) ? 3 : 20);

  const calculatePracticeSkillStoneRemainingExp = (stone) => {
    if (!stone?.hasPracticeProgressData) return null;
    if (Number(stone?.level || 0) >= getSkillStoneMaxLevel(stone)) return 0;
    const level = Math.max(1, Number(stone.level || 1));
    const exp = Math.max(0, Number(stone.exp || 0));
    const levelUpExp = Number(stone.levelUpExp || 0);
    const expCurve = isExceptionalSkillStone(stone)
      ? EXCEPTIONAL_SKILL_STONE_EXP
      : NORMAL_SKILL_STONE_EXP_CURVES.find((curve) => curve[level - 1] === levelUpExp);
    if (!expCurve) return null;
    const remainingTotal = expCurve.slice(level - 1).reduce((total, nextLevelExp) => total + Number(nextLevelExp || 0), 0) - exp;
    return Math.max(0, remainingTotal);
  };

  const isPracticeSkillStoneComplete = (stone) => {
    const remainingExp = calculatePracticeSkillStoneRemainingExp(stone);
    return remainingExp !== null && remainingExp <= 0;
  };

  const getPracticeSkillStoneRemainingExp = (stone) => calculatePracticeSkillStoneRemainingExp(stone);

  const getPracticeSkillStoneExpEfficiency = (stone) => {
    const baseEfficiency = 0.1;
    if (!isExceptionalSkillStone(stone)) return baseEfficiency;
    const quality = Math.max(0, Math.min(20, Number(stone?.quality || 0)));
    return baseEfficiency * (1 + (quality / 20));
  };

  const getPracticeRemainingMinutes = (stone, epm) => {
    const safeRemainingExp = getPracticeSkillStoneRemainingExp(stone);
    const safeEpm = Number(epm || 0);
    if (safeRemainingExp === null) return Infinity;
    if (safeRemainingExp <= 0) return 0;
    if (!Number.isFinite(safeEpm) || safeEpm <= 0) return Infinity;
    const effectiveEpm = safeEpm * getPracticeSkillStoneExpEfficiency(stone);
    if (!Number.isFinite(effectiveEpm) || effectiveEpm <= 0) return Infinity;
    return Math.max(1, Math.round(safeRemainingExp / effectiveEpm));
  };

  const formatPracticeMinutes = (totalMinutes) => {
    if (totalMinutes === 0) return '已满';
    if (!Number.isFinite(totalMinutes)) return '未知';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}时${minutes}分` : `${minutes}分`;
  };

  const formatPracticeRemainingTime = (stone, epm) => formatPracticeMinutes(getPracticeRemainingMinutes(stone, epm));

  const formatPracticeRequiredExp = (requiredExp) => (
    requiredExp === null ? '未知' : formatChineseLargeNumber(requiredExp)
  );

  const formatPracticeSkillStoneDetail = (stone, epm, locationText = '') => {
    const requiredExp = getPracticeSkillStoneRemainingExp(stone);
    const timeText = formatPracticeRemainingTime(stone, epm);
    const locationSuffix = locationText ? `，位置：${locationText}` : '';
    return `${stone.name} Lv.${stone.level || '?'}，总需求经验 ${formatPracticeRequiredExp(requiredExp)}，预估需求时间 ${timeText}${locationSuffix}`;
  };

  const getPracticeStoneSummaryStats = (stones, epm, timeMode = 'parallel', timeDivisor = 1) => {
    const stats = stones.reduce((summary, stone) => {
      const remainingExp = getPracticeSkillStoneRemainingExp(stone);
      if (remainingExp === null) {
        summary.unknownExpCount += 1;
        summary.unknownTimeCount += 1;
        return summary;
      }
      summary.requiredExp += remainingExp;
      const minutes = getPracticeRemainingMinutes(stone, epm);
      if (Number.isFinite(minutes)) {
        if (timeMode === 'parallel') {
          summary.minutes = Math.max(summary.minutes, minutes);
          summary.minMinutes = summary.hasKnownTime ? Math.min(summary.minMinutes, minutes) : minutes;
          summary.maxMinutes = Math.max(summary.maxMinutes, minutes);
          summary.hasKnownTime = true;
        } else {
          summary.minutes += minutes;
        }
      } else {
        summary.unknownTimeCount += 1;
      }
      return summary;
    }, {
      requiredExp: 0,
      minutes: 0,
      minMinutes: 0,
      maxMinutes: 0,
      hasKnownTime: false,
      unknownExpCount: 0,
      unknownTimeCount: 0,
    });
    if (timeMode === 'sumDivided') {
      const divisor = Math.max(1, Math.floor(Number(timeDivisor) || 1));
      stats.minutes = Math.ceil(stats.minutes / divisor);
      stats.timeDivisor = divisor;
    }
    return stats;
  };

  const formatPracticeSummaryRequiredExp = (stats) => (
    stats.unknownExpCount
      ? `${stats.requiredExp > 0 ? `已知 ${formatChineseLargeNumber(stats.requiredExp)}，` : ''}${stats.unknownExpCount} 颗未知`
      : formatChineseLargeNumber(stats.requiredExp)
  );

  const formatPracticeSummaryMinutes = (stats) => (
    stats.unknownTimeCount
      ? `${stats.minutes > 0 ? `已知 ${formatPracticeMinutes(stats.minutes)}，` : ''}${stats.unknownTimeCount} 颗未知`
      : formatPracticeMinutes(stats.minutes)
  );

  const formatPracticeParallelTimeRange = (stats) => {
    const knownText = stats.hasKnownTime
      ? `最短 ${formatPracticeMinutes(stats.minMinutes)}，最长 ${formatPracticeMinutes(stats.maxMinutes)}`
      : '';
    if (!stats.unknownTimeCount) return knownText || '未知';
    return `${knownText ? `${knownText}，` : ''}${stats.unknownTimeCount} 颗未知`;
  };

  const getPracticeSkillStoneColorLabel = (stone, socketRecord = null) => {
    const colorType = Number(stone?.category ?? socketRecord?.socketType);
    if (colorType === 1) return '红色';
    if (colorType === 2) return '绿色';
    if (colorType === 3) return '蓝色';
    if (colorType === 0) return '白色';
    return '未知色';
  };

  const addPracticeStoneColorSummaryLogs = (titlePrefix, stoneDetails, epm, getLocationText, timeMode = 'parallel', timeDivisor = 1) => {
    const resolveTimeDivisor = (groupStones, colorLabel = '') => (
      typeof timeDivisor === 'function'
        ? timeDivisor(groupStones, colorLabel)
        : timeDivisor
    );
    const stones = stoneDetails.map((item) => item.stone).filter(Boolean);
    const totalStats = getPracticeStoneSummaryStats(stones, epm, timeMode, resolveTimeDivisor(stones, ''));
    const getTimeLabel = (stats) => (
      timeMode === 'sumDivided'
        ? `预估完成时间（按 ${stats.timeDivisor || 1} 个可用孔）`
        : '预估完成时间'
    );
    const formatSummaryTime = (stats) => (
      timeMode === 'parallel'
        ? formatPracticeParallelTimeRange(stats)
        : formatPracticeSummaryMinutes(stats)
    );
    addLog(`${titlePrefix}技能宝石信息：${stones.length} 颗，总需求经验 ${formatPracticeSummaryRequiredExp(totalStats)}，${getTimeLabel(totalStats)} ${formatSummaryTime(totalStats)}。`, 'compact');
    const groupsByColor = new Map();
    for (const item of stoneDetails) {
      const colorLabel = getPracticeSkillStoneColorLabel(item.stone, item.socketRecord);
      if (!groupsByColor.has(colorLabel)) groupsByColor.set(colorLabel, []);
      groupsByColor.get(colorLabel).push(item);
    }
    for (const colorLabel of ['红色', '绿色', '蓝色']) {
      const items = groupsByColor.get(colorLabel) || [];
      const colorStones = items.map((item) => item.stone).filter(Boolean);
      const colorStats = getPracticeStoneSummaryStats(colorStones, epm, timeMode, resolveTimeDivisor(colorStones, colorLabel));
      addLog(`${titlePrefix}${colorLabel}技能宝石：${colorStones.length} 颗，总需求经验 ${formatPracticeSummaryRequiredExp(colorStats)}，${getTimeLabel(colorStats)} ${formatSummaryTime(colorStats)}。`, 'main');
    }
    for (const colorLabel of ['白色', '未知色']) {
      const items = groupsByColor.get(colorLabel) || [];
      if (!items.length) continue;
      const colorStones = items.map((item) => item.stone).filter(Boolean);
      const colorStats = getPracticeStoneSummaryStats(colorStones, epm, timeMode, resolveTimeDivisor(colorStones, colorLabel));
      addLog(`${titlePrefix}${colorLabel}技能宝石：${colorStones.length} 颗，总需求经验 ${formatPracticeSummaryRequiredExp(colorStats)}，${getTimeLabel(colorStats)} ${formatSummaryTime(colorStats)}。`, 'main');
    }
    for (const [itemIndex, item] of stoneDetails.entries()) {
      addLog(`${itemIndex + 1}. ${formatPracticeSkillStoneDetail(item.stone, epm, getLocationText(item))}`, 'detail');
    }
  };

  const getTrainableStoneCountByColor = (stones) => {
    const counts = new Map();
    for (const stone of stones) {
      if (!isPracticeSkillStoneTrainable(stone)) continue;
      const colorLabel = getPracticeSkillStoneColorLabel(stone);
      counts.set(colorLabel, (counts.get(colorLabel) || 0) + 1);
      if (Number(stone.category) === 0) {
        for (const label of ['红色', '绿色', '蓝色']) counts.set(label, (counts.get(label) || 0) + 1);
      }
    }
    return counts;
  };

  const formatPracticeEmptySocketReason = (socketRecord, reason) => {
    const colorLabel = getPracticeSkillStoneColorLabel(null, socketRecord);
    return `${socketRecord.slotLabel} · ${socketRecord.equipmentName}（${colorLabel}孔）：${reason}`;
  };

  const addPracticeEmptySocketReasonLogs = (snapshot, freeSockets, remainingBackpackStones) => {
    const trainableStoneCounts = getTrainableStoneCountByColor(remainingBackpackStones);
    const noTrainableStoneSockets = freeSockets.filter((socketRecord) => (
      getPracticeSkillStoneColorLabel(null, socketRecord) === '白色'
        ? remainingBackpackStones.filter(isPracticeSkillStoneTrainable).length <= 0
        : (trainableStoneCounts.get(getPracticeSkillStoneColorLabel(null, socketRecord)) || 0) <= 0
          && (trainableStoneCounts.get('白色') || 0) <= 0
    ));
    const activeSockets = snapshot.excludedEmptySockets?.active || [];
    const specialSockets = snapshot.excludedEmptySockets?.special || [];
    const totalEmptySocketCount = noTrainableStoneSockets.length + activeSockets.length + specialSockets.length;
    if (totalEmptySocketCount <= 0) {
      addLog('空孔提示：全力练级中。', 'success');
      return;
    }
    const reasonTexts = [];
    if (noTrainableStoneSockets.length) reasonTexts.push(`${noTrainableStoneSockets.length} 个是背包没有对应颜色的可练宝石`);
    if (activeSockets.length) reasonTexts.push(`${activeSockets.length} 个是和正在使用的技能在同一组连接里，为避免影响战斗已跳过`);
    if (specialSockets.length) reasonTexts.push(`${specialSockets.length} 个在特殊装备上，可能影响战斗已跳过`);
    addLog(`空孔提示：还有空孔没有放练级宝石。${reasonTexts.join('；')}。`, 'always');
    for (const socketRecord of noTrainableStoneSockets) {
      addLog(formatPracticeEmptySocketReason(socketRecord, '背包没有适合这个孔颜色的可练宝石'), 'detail');
    }
    for (const socketRecord of activeSockets) {
      addLog(formatPracticeEmptySocketReason(socketRecord, '和正在使用的技能在同一组连接里，已跳过'), 'detail');
    }
    for (const socketRecord of specialSockets) {
      addLog(formatPracticeEmptySocketReason(socketRecord, '在特殊装备上，可能影响战斗，已跳过'), 'detail');
    }
  };

  const isPracticeSkillStoneTrainable = (stone) => (
    stone?.id
    && stone.hasCategoryData
    && !isPracticeSkillStoneComplete(stone)
  );

  const getPracticeSkillStoneActiveState = (stone) => {
    if (!stone?.id) return null;
    if (typeof stone.isActive === 'boolean') return stone.isActive;
    if (typeof stone.active === 'boolean') return stone.active;
    if (typeof stone.isSupport === 'boolean') return !stone.isSupport;
    if (typeof stone.support === 'boolean') return !stone.support;
    const skillId = String(stone.skillId || '').trim().toLowerCase();
    if (skillId) return !skillId.endsWith('_support');
    if (Array.isArray(stone.tags) && stone.tags.length) {
      const supportTag = stone.tags.some((tag) => {
        const tagText = String(tag || '').toLowerCase();
        return tagText.includes('辅助') || tagText.includes('support');
      });
      return !supportTag;
    }
    return null;
  };

  const getSocketStoneId = (socket) => String(
    socket?.stoneId ?? socket?.skillStoneId ?? socket?.stone?.stoneId ?? socket?.stone?.id ?? socket?.skillStone?.stoneId ?? socket?.skillStone?.id ?? '',
  ).trim();

  const getSocketId = (socket) => socket?.id ?? socket?.socketId ?? socket?.sid ?? '';

  const canSocketAcceptPracticeStone = (socketRecord, stone) => {
    const socketType = Number(socketRecord?.socketType);
    const stoneType = Number(stone?.category);
    if (!Number.isFinite(socketType) || !Number.isFinite(stoneType)) return false;
    return socketType === 0 || stoneType === 0 || socketType === stoneType;
  };

  const getEnabledSkillStoneIdsFromCharacter = (characterData) => {
    const enabledIds = new Set();
    for (const skill of getCharacterSkills(characterData)) {
      if (skill?.enabled !== true) continue;
      const stoneId = String(skill?.stoneId || '').trim();
      if (stoneId) enabledIds.add(stoneId);
    }
    return enabledIds;
  };

  const buildPracticeSkillStoneSnapshot = async () => {
    if (!state.hasLoadedSkillStones || !state.practiceSkillStoneCache.loaded) {
      throw new Error('请先点击“加载技能石”，再使用智能练技能。');
    }
    const socketRecords = state.practiceSkillStoneCache.socketRecords.map((socketRecord) => ({ ...socketRecord }));
    const playerEpm = Number(state.practiceSkillStoneCache.playerEpm || 0);
    const excludedSummary = state.practiceSkillStoneCache.excludedSummary || { active: 0, special: 0 };
    const excludedEmptySockets = state.practiceSkillStoneCache.excludedEmptySockets || { active: [], special: [] };
    const stoneById = new Map();
    for (const stone of state.skillStones) {
      if (!stone?.id || stoneById.has(stone.id)) continue;
      stoneById.set(stone.id, stone);
    }
    const backpackStones = state.skillStones.filter((stone) => stone?.source === 'backpack');
    const equippedStones = state.skillStones.filter((stone) => stone?.source === 'equipment');
    addLog(`使用已加载技能石数据：可操作孔位 ${socketRecords.length} 个，排除主动技能孔 ${excludedSummary.active || 0} 个，排除特殊装备孔 ${excludedSummary.special || 0} 个。`, 'compact');
    return {
      socketRecords,
      stoneById,
      playerEpm,
      excludedEmptySockets,
      backpackStones,
      equippedStones,
    };
  };

  const mergePracticeSnapshotIntoSkillStoneState = (stoneById) => {
    const selectedIds = new Set(getSelectedSkillStoneIds());
    const mergedById = new Map(state.skillStones.map((stone) => [stone.id, stone]));
    for (const stone of stoneById.values()) mergedById.set(stone.id, stone);
    state.skillStones = Array.from(mergedById.values()).filter((stone) => stone?.id);
    state.hasLoadedSkillStones = true;
    renderSkillStoneOptions(selectedIds);
    updateSkillStoneActionButtonState();
  };

  const addPracticeSummaryLogs = (title, items, formatter, emptyText) => {
    addLog(`${title}：${items.length ? `${items.length} 项` : emptyText}`, items.length ? 'compact' : 'info');
    for (const [itemIndex, item] of items.entries()) {
      addLog(`${itemIndex + 1}. ${formatter(item)}`, 'detail');
    }
  };

  const adjustPracticeSkillStonePositions = async () => {
    addLog('开始扫描智能练技能位置。', 'compact');
    const snapshot = await buildPracticeSkillStoneSnapshot();
    const removedDetails = [];
    const insertedDetails = [];
    const completedSockets = snapshot.socketRecords.filter((socketRecord) => {
      if (!socketRecord.stoneId) return false;
      const stone = snapshot.stoneById.get(socketRecord.stoneId);
      return stone && isPracticeSkillStoneComplete(stone);
    });
    let removedCount = 0;
    if (completedSockets.length) {
      addLog(`准备取下已满练习技能石：${completedSockets.length} 颗。`, 'info');
      const removeResults = await runConcurrentTasks(completedSockets, SKILL_STONE_PRACTICE_CONCURRENCY, async (socketRecord) => {
        const stone = snapshot.stoneById.get(socketRecord.stoneId);
        const detail = {
          stone: { ...stone },
          equipmentName: socketRecord.equipmentName,
          slotLabel: socketRecord.slotLabel,
        };
        const payload = await removeSkillStoneFromEquipment(socketRecord.equipmentId, socketRecord.socketId);
        if (payload.success === false) throw new Error(payload.message || '取下技能石失败');
        socketRecord.stoneId = '';
        Object.assign(stone, {
          source: 'backpack',
          sourceLabel: '背包',
          equipmentId: '',
          equipmentName: '',
          socketId: '',
          socketType: stone.category,
        });
        removedDetails.push(detail);
        addLog(`已取下：${stone.name}（${socketRecord.equipmentName}）。`, 'detail');
        return { removed: true };
      });
      removedCount = removeResults.filter((result) => result?.removed).length;
      const failedCount = removeResults.filter((result) => result?.error && !isRequestAbortError(result.error)).length;
      if (failedCount) addLog(`取下练习技能石有 ${failedCount} 颗失败，已跳过。`, 'warn');
    }

    const freeSockets = snapshot.socketRecords.filter((socketRecord) => !socketRecord.stoneId && socketRecord.canInsert !== false);
    const assignedSocketIds = new Set();
    const assignments = [];
    const skippedUnknownTypeStones = [];
    for (const stone of snapshot.backpackStones) {
      if (!state.isRunning) break;
      if (!isPracticeSkillStoneTrainable(stone)) continue;
      if (getPracticeSkillStoneActiveState(stone) === null) {
        skippedUnknownTypeStones.push(stone);
        continue;
      }
      const socket = freeSockets.find((socketRecord) => (
        !assignedSocketIds.has(`${socketRecord.equipmentId}|${socketRecord.socketId}`)
        && canSocketAcceptPracticeStone(socketRecord, stone)
      ));
      if (!socket) continue;
      assignedSocketIds.add(`${socket.equipmentId}|${socket.socketId}`);
      assignments.push({ socket, stone });
    }
    if (skippedUnknownTypeStones.length) {
      addLog(`智能练技能跳过 ${skippedUnknownTypeStones.length} 颗宝石：接口没有返回 tags/skillId/主动辅助字段，无法判断镶嵌后是否需要关闭主动技能。`, 'warn');
      skippedUnknownTypeStones.slice(0, 10).forEach((stone, index) => {
        addLog(`${index + 1}. ${stone.name || stone.id}`, 'detail');
      });
    }

    let insertedCount = 0;
    if (assignments.length) {
      addLog(`准备镶嵌练习技能石：${assignments.length} 颗，并发 ${SKILL_STONE_PRACTICE_CONCURRENCY} 个。`, 'info');
      const insertResults = await runConcurrentTasks(assignments, SKILL_STONE_PRACTICE_CONCURRENCY, async ({ socket, stone }) => {
        const payload = await insertSkillStoneToEquipment(socket.equipmentId, socket.socketId, stone.id);
        if (payload.success === false) throw new Error(payload.message || '镶嵌技能石失败');
        socket.stoneId = stone.id;
        let disabledAfterInsert = false;
        Object.assign(stone, {
          source: 'equipment',
          sourceLabel: `装备：${socket.equipmentName}`,
          equipmentId: socket.equipmentId,
          equipmentName: socket.equipmentName,
          socketId: socket.socketId,
          socketType: socket.socketType,
        });
        const activeState = getPracticeSkillStoneActiveState(stone);
        if (activeState === null) {
          throw new Error(`无法判断宝石是否主动技能：${stone.name || stone.id}`);
        }
        if (activeState === true) {
          try {
            const enablePayload = await setSkillStoneEnabled(stone.id, false);
            if (enablePayload.success === false) throw new Error(enablePayload.message || '关闭主动技能失败');
            disabledAfterInsert = true;
            addLog(`已关闭主动技能：${stone.name}。`, 'detail');
          } catch (error) {
            addLog(`关闭主动技能失败：${stone.name}，${error.message || error}。`, 'warn');
          }
        }
        insertedDetails.push({
          stone: { ...stone },
          equipmentName: socket.equipmentName,
          slotLabel: socket.slotLabel,
          disabledAfterInsert,
        });
        addLog(`已镶嵌：${stone.name} -> ${socket.equipmentName}。`, 'detail');
        return { inserted: true };
      });
      insertedCount = insertResults.filter((result) => result?.inserted).length;
      const failedCount = insertResults.filter((result) => result?.error && !isRequestAbortError(result.error)).length;
      if (failedCount) addLog(`镶嵌练习技能石有 ${failedCount} 颗失败，已跳过。`, 'warn');
    } else if (freeSockets.length) {
      addLog(`当前有 ${freeSockets.length} 个可用练习孔，但背包里没有匹配颜色且未满的技能石。`, 'info');
    }
    try {
      addLog('智能练技能正在刷新装备状态，用于最终统计。', 'detail');
      const refreshedEquippedStones = await fetchEquippedSkillStones();
      const refreshedStoneById = new Map(
        Array.from(snapshot.stoneById.values())
          .filter((stone) => stone?.id && stone.source !== 'equipment')
          .map((stone) => [stone.id, stone]),
      );
      for (const stone of refreshedEquippedStones) {
        if (stone?.id) refreshedStoneById.set(stone.id, stone);
      }
      snapshot.stoneById = refreshedStoneById;
      snapshot.socketRecords = state.practiceSkillStoneCache.socketRecords.map((socketRecord) => ({ ...socketRecord }));
      snapshot.excludedEmptySockets = state.practiceSkillStoneCache.excludedEmptySockets || { active: [], special: [] };
      snapshot.backpackStones = Array.from(refreshedStoneById.values()).filter((stone) => stone?.source === 'backpack');
      snapshot.equippedStones = refreshedEquippedStones;
    } catch (error) {
      addLog(`智能练技能最终装备状态刷新失败：${error.message || error}。将使用本轮操作缓存统计。`, 'warn');
      state.practiceSkillStoneCache = {
        ...state.practiceSkillStoneCache,
        loaded: true,
        socketRecords: snapshot.socketRecords.map((socketRecord) => ({ ...socketRecord })),
      };
    }
    mergePracticeSnapshotIntoSkillStoneState(snapshot.stoneById);
    addLog(`智能练技能完成：取下 ${removedCount} 颗，镶嵌 ${insertedCount} 颗。`, 'success');
    const managedEquippedStoneDetails = snapshot.socketRecords
      .filter((socketRecord) => socketRecord.stoneId)
      .map((socketRecord) => ({
        stone: snapshot.stoneById.get(socketRecord.stoneId),
        socketRecord,
      }))
      .filter((item) => item.stone)
      .map((item) => ({
        stone: item.stone,
        socketRecord: {
          slotLabel: item.socketRecord.slotLabel,
          equipmentName: item.socketRecord.equipmentName,
          socketType: item.socketRecord.socketType,
        },
      }));
    const completedManagedEquippedStoneDetails = managedEquippedStoneDetails.filter((item) => isPracticeSkillStoneComplete(item.stone));
    if (completedManagedEquippedStoneDetails.length) {
      addLog(`仍有 ${completedManagedEquippedStoneDetails.length} 颗已满技能石留在可管理孔位，可能取下失败或装备状态尚未刷新。`, 'warn');
    }
    const equippedStoneDetails = managedEquippedStoneDetails.filter((item) => !isPracticeSkillStoneComplete(item.stone));
    const insertedIdSet = new Set(insertedDetails.map((item) => item.stone.id));
    const uninsertedBackpackTrainingStones = snapshot.backpackStones
      .filter((stone) => isPracticeSkillStoneTrainable(stone))
      .filter((stone) => !insertedIdSet.has(stone.id));
    const uninsertedBackpackTrainingDetails = uninsertedBackpackTrainingStones.map((stone) => ({ stone }));
    const getBackpackPracticeTimeDivisor = (_stones, colorLabel) => {
      const colorTypeMap = { 红色: 1, 绿色: 2, 蓝色: 3 };
      const targetType = colorTypeMap[colorLabel];
      if (!targetType) return snapshot.socketRecords.length;
      const compatibleSocketCount = snapshot.socketRecords.filter((socketRecord) => {
        const socketType = Number(socketRecord.socketType);
        return socketType === 0 || socketType === targetType;
      }).length;
      return compatibleSocketCount || snapshot.socketRecords.length;
    };
    addPracticeEmptySocketReasonLogs(snapshot, freeSockets.filter((socketRecord) => !socketRecord.stoneId), uninsertedBackpackTrainingStones);
    addPracticeSummaryLogs(
      '经验已满并取下',
      removedDetails,
      (item) => `${item.stone.name} Lv.${item.stone.level || '?'}，原位置：${item.slotLabel} · ${item.equipmentName}`,
      '无',
    );
    addPracticeStoneColorSummaryLogs(
      '装备上的',
      equippedStoneDetails,
      snapshot.playerEpm,
      (item) => `${item.socketRecord.slotLabel} · ${item.socketRecord.equipmentName}`,
      'parallel',
    );
    addPracticeSummaryLogs(
      '本次成功镶嵌',
      insertedDetails,
      (item) => `${formatPracticeSkillStoneDetail(item.stone, snapshot.playerEpm, `${item.slotLabel} · ${item.equipmentName}`)}${item.disabledAfterInsert ? '，已关闭主动技能' : ''}`,
      '无',
    );
    addPracticeStoneColorSummaryLogs(
      '背包未镶嵌的',
      uninsertedBackpackTrainingDetails,
      snapshot.playerEpm,
      () => '背包',
      'sumDivided',
      getBackpackPracticeTimeDivisor,
    );
  };

  /**
   * applyGemcutterPrismBatch 对单颗技能石批量使用宝石匠的棱镜。
   * 每批内部并发执行以提高速度；批次完成后统一汇总进度，避免日志刷屏到难以阅读。
   * @param {object} stone 当前处理的技能石。
   * @param {number} startIndex 本批次从第几次棱镜开始。
   * @param {number} batchSize 本批次请求数量。
   * @returns {Promise<{successCount: number, payloads: Array<object>, error: Error|null}>} 本批次结果。
   */
  const applyGemcutterPrismBatch = async (stone, startIndex, batchSize) => {
    const batchRequests = Array.from({ length: batchSize }, (_, offset) => {
      const useIndex = startIndex + offset;
      return modifySkillStone(stone.id, SKILL_STONE_MODIFY_TYPES.gemcutterPrism)
        .then((payload) => {
          if (payload.success === false) {
            throw new Error(payload.message || '接口返回失败');
          }
          return { useIndex, payload };
        });
    });
    const batchResults = await Promise.allSettled(batchRequests);
    const failedResult = batchResults.find((result) => result.status === 'rejected');
    const fulfilledResults = batchResults.filter((result) => result.status === 'fulfilled');
    return {
      successCount: fulfilledResults.length,
      payloads: fulfilledResults.map((result) => result.value.payload),
      error: failedResult?.reason || null,
    };
  };

  /**
   * applyGemcutterPrismsToSelectedStones 对选中的每颗技能石使用棱镜，直到品质补到 20。
   * 单颗技能石按小批次并发执行，显著减少等待；每批都会写入进度日志。
   */
  const applyGemcutterPrismsToSelectedStones = async () => {
    const selectedIds = getSelectedSkillStoneIds();
    if (!selectedIds.length) {
      throw new Error('请先在技能石列表中选择至少一颗技能石。');
    }
    const selectedIdSet = new Set(selectedIds);
    const stoneById = new Map(state.skillStones.map((stone) => [stone.id, stone]));
    for (const [stoneIndex, stoneId] of selectedIds.entries()) {
      if (!state.isRunning) return;
      const stone = stoneById.get(stoneId) || { id: stoneId, name: stoneId, quality: 0 };
      const initialQuality = Math.max(0, Math.min(GEMCUTTER_TARGET_QUALITY, Number.parseInt(stone.quality, 10) || 0));
      const totalUsesPerStone = Math.max(0, GEMCUTTER_TARGET_QUALITY - initialQuality);
      if (totalUsesPerStone <= 0) {
        addLog(`${stone.name} 当前品质 ${initialQuality}%，已达到 ${GEMCUTTER_TARGET_QUALITY}%，跳过棱镜。`, 'info');
        continue;
      }
      let successCount = 0;
      addLog(`开始处理第 ${stoneIndex + 1}/${selectedIds.length} 颗：${formatSkillStoneLabel(stone)}，当前品质 ${initialQuality}%，目标使用 ${totalUsesPerStone} 次棱镜升至 ${GEMCUTTER_TARGET_QUALITY}%。`, 'info');
      for (let useIndex = 1; state.isRunning && useIndex <= totalUsesPerStone; useIndex += GEMCUTTER_PRISM_BATCH_SIZE) {
        try {
          const batchSize = Math.min(GEMCUTTER_PRISM_BATCH_SIZE, totalUsesPerStone - useIndex + 1);
          const batchResult = await applyGemcutterPrismBatch(stone, useIndex, batchSize);
          successCount += batchResult.successCount;
          for (const payload of batchResult.payloads) {
            if (!payload.data) continue;
            const updatedStone = payload.data.stone || payload.data.skillStone || payload.data;
            Object.assign(stone, normalizeSkillStone({ ...stone, ...updatedStone }));
          }
          if (batchResult.successCount && Number(stone.quality || 0) < initialQuality + successCount) {
            stone.quality = Math.min(GEMCUTTER_TARGET_QUALITY, initialQuality + successCount);
          }
          addLog(`${stone.name} 棱镜进度：${successCount}/${totalUsesPerStone}，预计品质 ${Math.min(GEMCUTTER_TARGET_QUALITY, initialQuality + successCount)}%（本批 ${batchResult.successCount} 次）。`, 'info');
          if (batchResult.error) {
            addLog(`${stone.name} 棱镜进度停在 ${successCount}/${totalUsesPerStone}：${batchResult.error.message}`, 'error');
            break;
          }
        } catch (error) {
          addLog(`${stone.name} 棱镜进度停在 ${successCount}/${totalUsesPerStone}：${error.message}`, 'error');
          break;
        }
      }
      addLog(`${stone.name} 已完成 ${successCount}/${totalUsesPerStone} 次棱镜，当前预计品质 ${Math.min(GEMCUTTER_TARGET_QUALITY, initialQuality + successCount)}%。`, successCount === totalUsesPerStone ? 'success' : 'warn');
    }
    rerenderSkillStoneListAfterLocalUpdates(selectedIdSet);
    addLog('技能石棱镜完成：已按本次返回结果更新列表，未执行全量技能石刷新。', 'compact');
  };

  /**
   * getSkillStoneFromPayload 从不同形状的接口返回中提取技能石对象。
   * @param {object} payload 后端接口返回值。
   * @returns {object|null} 技能石对象。
   */
  const getSkillStoneFromPayload = (payload) => (
    payload?.data?.stone || payload?.data?.skillStone || payload?.data || null
  );

  const applySuccessfulSkillStoneUpgradeLocally = (stone, payload) => {
    const beforeLevel = Number(stone.level || 0);
    const updatedStone = getSkillStoneFromPayload(payload);
    if (updatedStone) {
      Object.assign(stone, normalizeSkillStone({ ...stone, ...updatedStone }));
    }
    const nextLevel = Number(stone.level || 0);
    if (!Number.isFinite(nextLevel) || nextLevel <= beforeLevel) {
      stone.level = beforeLevel > 0 ? beforeLevel + 1 : 1;
    }
  };

  /**
   * canAttemptSkillStoneUpgrade 判断当前本地数据是否看起来还能升级。
   * 如果接口没有返回经验字段，则保持乐观尝试一次，让后端决定是否还能升级。
   * @param {object} stone 标准化技能石。
   * @returns {boolean} 是否值得继续请求升级接口。
   */
  const canAttemptSkillStoneUpgrade = (stone) => {
    const level = Number(stone.level || 0);
    const exp = Number(stone.exp || 0);
    const levelUpExp = Number(stone.levelUpExp || 0);
    if (level >= 20) return false;
    if (levelUpExp <= 0) return true;
    return exp >= levelUpExp;
  };

  /**
   * upgradeSingleSkillStoneToHighest 把单颗技能石升到当前经验允许的最高等级。
   * 每次成功后都会合并返回数据；正常升到经验不足或满级时只输出一次汇总日志。
   * @param {object} stone 当前处理的技能石。
   * @param {number} stoneIndex 当前序号。
   * @param {number} totalCount 总数量。
   * @returns {Promise<number>} 成功升级次数。
   */
  const upgradeSingleSkillStoneToHighest = async (stone, stoneIndex, totalCount) => {
    let successCount = 0;
    let stopReason = '';
    addLog(`开始升级第 ${stoneIndex + 1}/${totalCount} 颗：${formatSkillStoneLabel(stone)}。`, 'info');
    for (let attemptIndex = 1; state.isRunning && attemptIndex <= SKILL_STONE_MAX_UPGRADE_ATTEMPTS; attemptIndex += 1) {
      if (!canAttemptSkillStoneUpgrade(stone)) {
        stopReason = Number(stone.level || 0) >= 20 ? '已满级' : '经验不足';
        break;
      }
      try {
        const payload = await upgradeSkillStone(stone.id);
        if (payload.success === false) {
          const detail = await fetchSkillStoneDetail(stone.id);
          if (detail) Object.assign(stone, normalizeSkillStone({ ...stone, ...detail }));
          if (!canAttemptSkillStoneUpgrade(stone)) {
            stopReason = Number(stone.level || 0) >= 20 ? '已满级' : '经验不足';
          } else {
            addLog(`${stone.name} 升级停止：${payload.message || '接口返回失败'}`, successCount ? 'warn' : 'info');
          }
          break;
        }
        applySuccessfulSkillStoneUpgradeLocally(stone, payload);
        successCount += 1;
        await wait(getSpeedDelay());
      } catch (error) {
        addLog(`${stone.name} 升级停止：${error.message}`, successCount ? 'warn' : 'info');
        break;
      }
    }
    const isFullLevel = Number(stone.level || 0) >= 20;
    if (successCount >= SKILL_STONE_MAX_UPGRADE_ATTEMPTS && !isFullLevel) {
      addLog(`${stone.name} 已达到单次任务安全上限 ${SKILL_STONE_MAX_UPGRADE_ATTEMPTS} 次，已停止。`, 'warn');
    } else if (stopReason || isFullLevel) {
      addLog(`${stone.name} 已完成 ${successCount} 次升级，${stopReason || '已满级'}，预计当前 Lv.${stone.level || '?'}。`, successCount ? 'success' : 'info');
    }
    return successCount;
  };

  /**
   * upgradeSelectedSkillStonesToHighest 升级当前选中的技能石。
   * 用户要求升级动作只作用于选中项，避免误升级背包或装备上的全部技能石。
   */
  const upgradeSelectedSkillStonesToHighest = async () => {
    if (!state.skillStones.length) throw new Error('请先加载技能石。');
    const selectedIds = getSelectedSkillStoneIds();
    if (!selectedIds.length) {
      throw new Error('请先在技能石列表中选择至少一颗技能石。');
    }
    const selectedIdSet = new Set(selectedIds);
    const stoneById = new Map(state.skillStones.map((stone) => [stone.id, stone]));
    const stones = selectedIds
      .map((stoneId) => stoneById.get(stoneId))
      .filter((stone) => stone?.id);
    if (!stones.length) throw new Error('选中的技能石不在当前列表中，请重新加载技能石。');
    const results = await runConcurrentTasks(stones, SKILL_STONE_UPGRADE_CONCURRENCY, async (stone, stoneIndex) => ({
      upgradeCount: await upgradeSingleSkillStoneToHighest(stone, stoneIndex, stones.length),
    }));
    const totalUpgradeCount = results.reduce((total, result) => total + Math.max(0, Number(result?.upgradeCount || 0)), 0);
    const upgradedStoneCount = results.filter((result) => Number(result?.upgradeCount || 0) > 0).length;
    const failedCount = results.filter((result) => result?.error).length;
    addLog(`选中技能石升级完成：${upgradedStoneCount}/${stones.length} 颗发生升级，合计升级 ${totalUpgradeCount} 次。`, 'compact');
    if (failedCount) addLog(`技能石升级有 ${failedCount} 颗请求异常，详情见前面的单颗日志。`, 'warn');
    rerenderSkillStoneListAfterLocalUpdates(selectedIdSet);
    addLog('技能石升级完成：已按本次返回结果更新列表，未执行全量技能石刷新。', 'compact');
  };

  const corruptSelectedSkillStones = async () => {
    if (!state.skillStones.length) throw new Error('请先加载技能石。');
    const selectedIds = getSelectedSkillStoneIds();
    if (!selectedIds.length) {
      throw new Error('请先在技能石列表中选择至少一颗技能石。');
    }
    const stoneById = new Map(state.skillStones.map((stone) => [stone.id, stone]));
    const stones = selectedIds
      .map((stoneId) => stoneById.get(stoneId))
      .filter((stone) => stone?.id);
    if (!stones.length) throw new Error('选中的技能石不在当前列表中，请重新加载技能石。');
    const summary = { levelUp: 0, unchanged: 0, levelDown: 0, unable: 0 };
    const results = await runConcurrentTasks(stones, SKILL_STONE_VAAL_BATCH_SIZE, async (stone, stoneIndex) => {
      if (stone.corrupted) {
        addLog(`${stone.name} 已腐化，无法再次腐化。`, 'warn');
        return { outcome: 'unable' };
      }
      const beforeLevel = Number(stone.level || 0);
      try {
        addLog(`开始腐化第 ${stoneIndex + 1}/${stones.length} 颗：${formatSkillStoneLabel(stone)}。`, 'info');
        const payload = await modifySkillStone(stone.id, SKILL_STONE_MODIFY_TYPES.vaal);
        if (payload.success === false) {
          addLog(`${stone.name} 腐化失败：${payload.message || '接口返回失败'}。`, 'warn');
          return { outcome: 'unable' };
        }
        const updatedStone = getSkillStoneFromPayload(payload);
        if (updatedStone) {
          Object.assign(stone, normalizeSkillStone({ ...stone, ...updatedStone }));
        } else {
          const detail = await fetchSkillStoneDetail(stone.id);
          if (detail) Object.assign(stone, normalizeSkillStone({ ...stone, ...detail }));
        }
        const afterLevel = Number(stone.level || beforeLevel);
        if (afterLevel > beforeLevel) {
          addLog(`${stone.name} 腐化完成：等级 +1，Lv.${beforeLevel} -> Lv.${afterLevel}。`, 'success');
          return { outcome: 'levelUp' };
        }
        if (afterLevel < beforeLevel) {
          addLog(`${stone.name} 腐化完成：等级 -1，Lv.${beforeLevel} -> Lv.${afterLevel}。`, 'warn');
          return { outcome: 'levelDown' };
        }
        addLog(`${stone.name} 腐化完成：等级不变，Lv.${afterLevel}。`, 'info');
        return { outcome: 'unchanged' };
      } catch (error) {
        addLog(`${stone.name} 腐化失败：${error.message || error}。`, 'warn');
        return { outcome: 'unable' };
      }
    });
    results.forEach((result) => {
      const outcome = result?.outcome || (result?.error ? 'unable' : 'unable');
      if (Object.prototype.hasOwnProperty.call(summary, outcome)) summary[outcome] += 1;
    });
    addLog(`技能石腐化完成：${summary.levelUp} 个等级 +1，${summary.unchanged} 个等级不变，${summary.levelDown} 个等级 -1，${summary.unable} 个无法腐化。`, 'compact');
    await refreshSkillStoneList();
  };

  /**
   * destroySelectedSkillStones 丢弃当前选中的技能石。
   * 丢弃是不可逆操作，因此在真正请求接口前使用浏览器确认框做二次确认。
   */
  const destroySelectedSkillStones = async () => {
    const selectedIds = getSelectedSkillStoneIds();
    if (!selectedIds.length) {
      throw new Error('请先在技能石列表中选择至少一颗技能石。');
    }
    const stoneById = new Map(state.skillStones.map((stone) => [stone.id, stone]));
    const selectedLabels = selectedIds
      .map((stoneId) => stoneById.get(stoneId))
      .filter(Boolean)
      .slice(0, 5)
      .map((stone) => `- ${formatSkillStoneLabel(stone)}`)
      .join('\n');
    const extraText = selectedIds.length > 5 ? `\n...以及另外 ${selectedIds.length - 5} 颗` : '';
    const confirmed = window.confirm(`确认丢弃选中的 ${selectedIds.length} 颗技能石吗？该操作不可撤销。\n${selectedLabels}${extraText}`);
    if (!confirmed) {
      addLog('已取消丢弃技能石。', 'compact');
      return;
    }
    const payload = await destroySkillStones(selectedIds);
    if (payload.success === false) {
      throw new Error(payload.message || '丢弃技能石失败');
    }
    addLog(`已丢弃 ${selectedIds.length} 颗技能石。`, 'compact');
    await refreshSkillStoneList();
  };

  /**
   * openFracturedEquipmentModal 读取当前背包破裂装备并打开模态框。
   */
  const openFracturedEquipmentModal = async () => {
    state.fracturedEquipments = await fetchAllFracturedEquipments();
    renderFracturedEquipmentModal();
    state.ui.fracturedModal.hidden = false;
    addLog(`破裂装备扫描完成：${state.fracturedEquipments.length} 件。`, 'compact');
  };

  /**
   * closeFracturedEquipmentModal 关闭破裂装备模态框。
   */
  const closeFracturedEquipmentModal = () => {
    if (state.ui.fracturedModal) state.ui.fracturedModal.hidden = true;
  };

  const updateFracturedEquipmentSummary = (nonTierOneCount = null) => {
    if (!state.ui.fracturedModalSummary) return;
    const nextNonTierOneCount = nonTierOneCount === null
      ? state.fracturedEquipments.filter(shouldDestroyAsNonTierOneFractured).length
      : Math.max(0, nonTierOneCount);
    state.ui.fracturedModalSummary.textContent = `当前背包破裂装备：${state.fracturedEquipments.length} 件，可判断非 T1：${nextNonTierOneCount} 件`;
  };

  const removeFracturedEquipmentElement = (equipmentId) => {
    const escapedId = window.CSS?.escape ? window.CSS.escape(String(equipmentId)) : String(equipmentId).replace(/"/g, '\\"');
    state.ui.fracturedEquipmentList?.querySelector(`[data-equipment-id="${escapedId}"]`)?.remove();
  };

  /**
   * removeFracturedEquipmentFromState 从当前模态框列表里移除指定装备。
   * @param {string} equipmentId 装备 ID。
   */
  const removeFracturedEquipmentFromState = (equipmentId) => {
    state.fracturedEquipments = state.fracturedEquipments.filter((equipment) => equipment.id !== equipmentId);
  };

  const removeFracturedEquipmentIncrementally = (equipmentId, summaryOptions = {}) => {
    removeFracturedEquipmentFromState(equipmentId);
    removeFracturedEquipmentElement(equipmentId);
    updateFracturedEquipmentSummary(summaryOptions.nonTierOneCount);
    if (!state.fracturedEquipments.length && state.ui.fracturedEquipmentList) {
      state.ui.fracturedEquipmentList.replaceChildren(createElement('div', {
        className: 'poe2-empty',
        textContent: '当前背包没有破裂装备。',
      }));
    }
  };

  /**
   * storeSingleFracturedEquipment 把单件破裂装备存入储藏并刷新模态框列表。
   * @param {string} equipmentId 装备 ID。
   */
  const storeSingleFracturedEquipment = async (equipmentId) => {
    const equipment = state.fracturedEquipments.find((item) => item.id === equipmentId);
    if (!equipment) return;
    try {
      const payload = await storageEquipment(equipmentId);
      if (payload.success === false) throw new Error(payload.message || '存入储藏失败');
      removeFracturedEquipmentIncrementally(equipmentId);
      addLog(`已存入储藏：${equipment.name}`, 'compact');
    } catch (error) {
      addLog(`${equipment.name} 存入储藏失败：${error.message}`, 'error');
    }
  };

  const PAGE_MODULE_CACHE = {
    equipment: null,
  };

  const getPageResourceUrls = () => [
    ...Array.from(document.scripts, (script) => script.src),
    ...Array.from(document.querySelectorAll('link[href]'), (link) => link.href),
    ...performance.getEntriesByType('resource').map((entry) => entry.name),
  ].filter(Boolean);

  const findPageAssetUrl = (pattern, fallbackPath) => {
    const resourceUrl = getPageResourceUrls().find((url) => pattern.test(url));
    return resourceUrl || new URL(fallbackPath, location.origin).href;
  };

  const extractModuleImportUrl = (source, ownerUrl, filePattern, fallbackPath) => {
    const match = source.match(new RegExp(`from"\\.\\/(${filePattern})"`));
    return match ? new URL(match[1], ownerUrl).href : findPageAssetUrl(new RegExp(filePattern), fallbackPath);
  };

  const loadPageEquipmentModalModules = async () => {
    if (PAGE_MODULE_CACHE.equipment) return PAGE_MODULE_CACHE.equipment;
    PAGE_MODULE_CACHE.equipment = (async () => {
      const gameCoreUrl = findPageAssetUrl(/\/game-core-[^/]+\.js(?:\?|$)/, '/assets/game-core-CX6Yc2BQ.js');
      const source = await fetch(gameCoreUrl, { cache: 'force-cache' }).then((response) => {
        if (!response.ok) throw new Error(`加载 game-core 失败：${response.status}`);
        return response.text();
      });
      const vueCoreUrl = extractModuleImportUrl(source, gameCoreUrl, 'vue-core-[^"]+\\.js', '/assets/vue-core-AUMxGMvO.js');
      const antdUrl = extractModuleImportUrl(source, gameCoreUrl, 'antd-all-[^"]+\\.js', '/assets/antd-all-BzjB6C9Q.js');
      const [gameCoreModule, vueCoreModule, antdModule] = await Promise.all([
        import(gameCoreUrl),
        import(vueCoreUrl),
        import(antdUrl),
      ]);
      const EquipmentComponent = gameCoreModule.h;
      const createVNode = vueCoreModule.l;
      const Modal = antdModule.M;
      if (!EquipmentComponent || !createVNode || !Modal?.info) {
        throw new Error('网页端装备详情模块不可用');
      }
      return { EquipmentComponent, createVNode, Modal };
    })();
    return PAGE_MODULE_CACHE.equipment;
  };

  const openPageEquipmentDetailModal = async (equipment) => {
    const { EquipmentComponent, createVNode, Modal } = await loadPageEquipmentModalModules();
    Modal.info({
      title: '装备详情',
      icon: null,
      footer: null,
      centered: true,
      closable: true,
      zIndex: 100010,
      style: { width: window.innerWidth > 640 ? '450px' : '95vw', maxWidth: '95vw' },
      content: createVNode(EquipmentComponent, {
        equipment,
        readonly: true,
      }),
    });
  };

  const openFracturedEquipmentDetail = async (equipmentId) => {
    const equipment = state.fracturedEquipments.find((item) => item.id === equipmentId);
    if (!equipment) return;
    try {
      const freshEquipment = await fetchEquipmentDetail(equipmentId);
      const detailEquipment = freshEquipment ? { ...equipment, ...freshEquipment, id: freshEquipment.id || equipment.id } : equipment;
      await openPageEquipmentDetailModal(detailEquipment);
    } catch (error) {
      addLog(`${equipment.name} 查看详情失败：${error.message || error}`, 'error');
    }
  };

  /**
   * destroyAllFracturedEquipments 串行丢弃当前模态框中的全部破裂装备。
   * 操作前会二次确认，避免误删。
   */
  const destroyAllFracturedEquipments = async () => {
    if (!state.fracturedEquipments.length) {
      addLog('当前没有可丢弃的破裂装备。', 'warn');
      return;
    }
    const confirmed = window.confirm(`确认丢弃当前列表中的 ${state.fracturedEquipments.length} 件破裂装备吗？该操作不可撤销。`);
    if (!confirmed) return;
    const pendingEquipments = [...state.fracturedEquipments];
    let successCount = 0;
    for (const equipment of pendingEquipments) {
      try {
        const payload = await destroyEquipment(equipment.id);
        if (payload.success === false) throw new Error(payload.message || '丢弃失败');
        successCount += 1;
        removeFracturedEquipmentIncrementally(equipment.id);
        addLog(`已丢弃破裂装备：${equipment.name}`, 'compact');
        await wait(getSpeedDelay());
      } catch (error) {
        addLog(`${equipment.name} 丢弃失败：${error.message}`, 'error');
      }
    }
    addLog(`破裂装备批量丢弃完成：成功 ${successCount}/${pendingEquipments.length} 件。`, 'compact');
  };

  /**
   * destroyNonTierOneFracturedEquipments 丢弃当前列表中明确不是 T1 破裂词缀的装备。
   * 只处理已返回破裂词缀明细且破裂词缀全都不是 T1 的装备，未知明细会保留。
   */
  const destroyNonTierOneFracturedEquipments = async () => {
    const pendingEquipments = state.fracturedEquipments.filter(shouldDestroyAsNonTierOneFractured);
    if (!pendingEquipments.length) {
      addLog('当前没有可丢弃的非 T1 破裂装备，或接口未返回可判断的破裂词缀明细。', 'warn');
      return;
    }
    const confirmed = window.confirm(`确认丢弃 ${pendingEquipments.length} 件非 T1 破裂词缀装备吗？没有破裂词缀明细的装备不会被丢弃。`);
    if (!confirmed) return;
    let successCount = 0;
    let remainingNonTierOneCount = pendingEquipments.length;
    for (let startIndex = 0; state.isRunning && startIndex < pendingEquipments.length; startIndex += FRACTURED_DESTROY_BATCH_SIZE) {
      const equipmentBatch = pendingEquipments.slice(startIndex, startIndex + FRACTURED_DESTROY_BATCH_SIZE);
      const batchResults = await Promise.allSettled(equipmentBatch.map(async (equipment) => {
        const payload = await destroyEquipment(equipment.id);
        if (payload.success === false) throw new Error(payload.message || '丢弃失败');
        return equipment;
      }));
      for (const [resultIndex, result] of batchResults.entries()) {
        const equipment = equipmentBatch[resultIndex];
        if (result.status === 'fulfilled') {
          successCount += 1;
          remainingNonTierOneCount -= 1;
          removeFracturedEquipmentIncrementally(equipment.id, { nonTierOneCount: remainingNonTierOneCount });
        } else {
          addLog(`${equipment.name} 非 T1 破裂丢弃失败：${result.reason?.message || result.reason}`, 'error');
        }
      }
      addLog(`非 T1 破裂丢弃进度：${successCount}/${pendingEquipments.length}（本批 ${equipmentBatch.length} 件）。`, 'info');
    }
    addLog(`非 T1 破裂装备丢弃完成：成功 ${successCount}/${pendingEquipments.length} 件。`, 'compact');
  };

  /**
   * destroyTailBackpackPages 丢弃背包最后一百页的全部装备。
   * 先扫描最后一百页形成装备 ID 快照，再一次性调用当前页同款批量丢弃接口，避免删除时分页前移导致目标变化。
   */
  const destroyTailBackpackPages = async () => {
    const firstPage = await fetchBackpackCleanupPage(1);
    if (firstPage.totalPages < TAIL_PAGE_DESTROY_CONFIG.pageCount) {
      addLog(`当前背包只有 ${firstPage.totalPages} 页，不足 ${TAIL_PAGE_DESTROY_CONFIG.pageCount} 页，无法使用“丢弃最后一百页”。`, 'warn');
      return;
    }
    const startPage = firstPage.totalPages - TAIL_PAGE_DESTROY_CONFIG.pageCount + 1;
    const endPage = firstPage.totalPages;
    const equipmentMap = new Map();
    addLog(`开始扫描背包最后 ${TAIL_PAGE_DESTROY_CONFIG.pageCount} 页：第 ${startPage}-${endPage} 页。`, 'compact');
    for (let page = startPage; state.isRunning && page <= endPage; page += 1) {
      const pageResult = await fetchBackpackCleanupPage(page);
      for (const item of pageResult.items) {
        equipmentMap.set(item.id, item);
      }
      const scannedPageCount = page - startPage + 1;
      if (scannedPageCount === 1 || scannedPageCount === TAIL_PAGE_DESTROY_CONFIG.pageCount || scannedPageCount % 10 === 0) {
        addLog(`尾页扫描进度：${scannedPageCount}/${TAIL_PAGE_DESTROY_CONFIG.pageCount} 页，已记录 ${equipmentMap.size} 件装备。`, 'info');
      }
    }
    const equipmentIds = [...equipmentMap.keys()];
    if (!equipmentIds.length) {
      addLog('背包最后一百页没有可丢弃装备。', 'warn');
      return;
    }
    const confirmed = window.confirm(`确认丢弃背包最后 ${TAIL_PAGE_DESTROY_CONFIG.pageCount} 页（第 ${startPage}-${endPage} 页）共 ${equipmentIds.length} 件装备吗？将一次性调用批量丢弃接口，该操作不可撤销，且不会丢弃储藏装备。`);
    if (!confirmed) {
      addLog('已取消丢弃背包最后一百页装备。', 'compact');
      return;
    }
    addLog(`开始一次性批量丢弃背包最后 ${TAIL_PAGE_DESTROY_CONFIG.pageCount} 页，共 ${equipmentIds.length} 件装备。`, 'compact');
    const payload = await destroyEquipmentBatch(equipmentIds);
    if (payload.success === false) {
      throw new Error(payload.message || '丢弃最后一百页批量接口失败');
    }
    addLog(`丢弃背包最后一百页完成：已一次性提交 ${equipmentIds.length} 件装备。`, 'compact');
  };

  /**
   * togglePositionAdjustMode 切换外部悬浮入口按钮的调位模式。
   * 调位模式开启后可拖动“助手 2.17”按钮；再次点击关闭并保留当前位置。
   */
  const togglePositionAdjustMode = () => {
    state.isTogglePositionMode = !state.isTogglePositionMode;
    state.ui.toggleButton?.classList.toggle('poe2-toggle-positioning', state.isTogglePositionMode);
    if (state.isTogglePositionMode) {
      addLog('已开启调整位置模式：拖动外部“助手 2.17”按钮即可改变入口位置，再次点击“调整位置”关闭。', 'compact');
    } else {
      addLog('已关闭调整位置模式，外部入口按钮位置已保存。', 'compact');
    }
  };

  /**
   * updateMinimizePauseButton 刷新“最小化暂停脚本”开关的按钮文案和状态样式。
   */
  const updateMinimizePauseButton = () => {
    const button = state.ui.minimizePauseButton;
    if (!button) return;
    button.textContent = `最小化暂停：${state.minimizePausesAutomation ? '开' : '关'}`;
    button.classList.toggle('poe2-toggle-active', state.minimizePausesAutomation);
  };

  /**
   * toggleMinimizePauseMode 切换收起主面板时是否自动停止当前自动化任务。
   * 当前脚本没有真正的恢复队列，因此这里使用现有停止逻辑来保证请求被中断。
   */
  const toggleMinimizePauseMode = () => {
    state.minimizePausesAutomation = !state.minimizePausesAutomation;
    updateAssistantSetting('minimizePausesAutomation', state.minimizePausesAutomation);
    updateMinimizePauseButton();
    addLog(`最小化时暂停脚本已${state.minimizePausesAutomation ? '开启' : '关闭'}。`, 'compact');
  };

  /**
   * updateStepActionSafetyLimit 更新步骤动作安全上限，并立即影响后续打造任务。
   */
  const updateStepActionSafetyLimit = () => {
    const nextLimit = Math.min(100000, Math.max(1, Number.parseInt(state.ui.stepActionSafetyLimitInput?.value, 10) || 500));
    state.stepActionSafetyLimit = nextLimit;
    setInputValue(state.ui.stepActionSafetyLimitInput, nextLimit);
    updateAssistantSetting('stepActionSafetyLimit', nextLimit);
    addLog(`步骤动作安全上限已更新为 ${nextLimit} 次。`, 'compact');
  };

  /**
   * updateCustomCraftStepSafetyLimit 更新自定义打造单个判断条件步骤上限。
   */
  const updateCustomCraftStepSafetyLimit = () => {
    const nextLimit = Math.min(100000, Math.max(1, Number.parseInt(state.ui.customCraftStepSafetyLimitInput?.value, 10) || 300));
    state.customCraftStepSafetyLimit = nextLimit;
    setInputValue(state.ui.customCraftStepSafetyLimitInput, nextLimit);
    updateAssistantSetting('customCraftStepSafetyLimit', nextLimit);
    addLog(`自定义打造步骤上限已更新为 ${nextLimit} 次。`, 'compact');
  };

  /**
   * updateCustomCraftCurrencyLimit 更新自定义打造任务总通货消耗上限。
   */
  const updateCustomCraftCurrencyLimit = () => {
    const nextLimit = Math.min(1000000, Math.max(1, Number.parseInt(state.ui.customCraftCurrencyLimitInput?.value, 10) || 10000));
    state.customCraftCurrencyLimit = nextLimit;
    setInputValue(state.ui.customCraftCurrencyLimitInput, nextLimit);
    updateAssistantSetting('customCraftCurrencyLimit', nextLimit);
    addLog(`自定义打造总通货消耗上限已更新为 ${nextLimit} 个。`, 'compact');
  };

  /**
   * renderFracturedEquipmentModal 渲染破裂装备模态框内容。
   */
  const renderFracturedEquipmentModal = () => {
    const listElement = state.ui.fracturedEquipmentList;
    if (!listElement) return;
    updateFracturedEquipmentSummary();
    if (!state.fracturedEquipments.length) {
      listElement.replaceChildren(createElement('div', {
        className: 'poe2-empty',
        textContent: '当前背包没有破裂装备。',
      }));
      return;
    }
    listElement.replaceChildren(...state.fracturedEquipments.map((equipment) => {
      const fracturedAffixes = getFracturedAffixes(equipment);
      const affixList = createElement('div', {
        className: 'poe2-fractured-affixes',
        children: fracturedAffixes.length
          ? fracturedAffixes.map((affix) => createElement('div', {
            className: 'poe2-fractured-affix',
            textContent: formatFracturedAffixLabel(equipment, affix),
          }))
          : [createElement('div', {
            className: 'poe2-fractured-affix poe2-muted',
            textContent: '接口未返回具体破裂词缀明细',
          })],
      });
      const storeButton = createButton('存入储藏', () => storeSingleFracturedEquipment(equipment.id));
      storeButton.classList.add('poe2-success-button');
      const detailButton = createButton('查看详情', () => openFracturedEquipmentDetail(equipment.id));
      return createElement('div', {
        className: 'poe2-fractured-item',
        dataset: { equipmentId: equipment.id },
        children: [
          createElement('div', {
            className: 'poe2-fractured-head',
            children: [
              createElement('div', {
                className: 'poe2-fractured-name-wrap',
                children: [
                  createElement('div', {
                    className: 'poe2-fractured-name',
                    textContent: `${equipment.name}${equipment.baseName ? ` - ${equipment.baseName}` : ''}`,
                  }),
                ],
              }),
              createElement('div', {
                className: 'poe2-fractured-meta',
                textContent: `物等 ${equipment.itemLevel || '?'} | ${equipment.id}`,
              }),
            ],
          }),
          affixList,
          createElement('div', {
            className: 'poe2-actions poe2-fractured-actions',
            children: [storeButton, detailButton],
          }),
        ],
      });
    }));
  };

  /**
   * createElement 创建 DOM 元素并设置属性、文本和子元素。
   * @param {string} tagName 标签名。
   * @param {object} options 元素选项。
   * @returns {HTMLElement} 创建后的元素。
   */
  const createElement = (tagName, options = {}) => {
    const element = document.createElement(tagName);
    if (options.className) element.className = options.className;
    if (options.textContent !== undefined) element.textContent = options.textContent;
    if (options.type) element.type = options.type;
    if (options.value !== undefined) element.value = options.value;
    if (options.checked !== undefined) element.checked = Boolean(options.checked);
    if (options.placeholder) element.placeholder = options.placeholder;
    if (options.dataset && typeof options.dataset === 'object') {
      Object.entries(options.dataset).forEach(([key, value]) => {
        if (value !== undefined && value !== null) element.dataset[key] = String(value);
      });
    }
    if (options.children) element.append(...options.children);
    if (options.onClick) element.addEventListener('click', options.onClick);
    if (options.onChange) element.addEventListener('change', options.onChange);
    return element;
  };

  /**
   * createLabeledControl 创建带标签的表单行。
   * @param {string|HTMLElement} labelContent 标签文本或自定义标签节点。
   * @param {HTMLElement} controlElement 控件元素。
   * @param {string} extraClassName 附加样式类，用于少数需要跨列的表单行。
   * @returns {HTMLElement} 表单行元素。
   */
  const createLabeledControl = (labelContent, controlElement, extraClassName = '') => createElement('label', {
    className: `poe2-field${extraClassName ? ` ${extraClassName}` : ''}`,
    children: [
      typeof labelContent === 'string' ? createElement('span', { textContent: labelContent }) : labelContent,
      controlElement,
    ],
  });

  const createInlineCheckboxControl = (labelContent, inputElement) => createElement('label', {
    className: 'poe2-inline-check',
    children: [
      typeof labelContent === 'string' ? createElement('span', { textContent: labelContent }) : labelContent,
      inputElement,
    ],
  });

  /**
   * createButton 创建统一样式的按钮。
   * @param {string} text 按钮文本。
   * @param {Function} onClick 点击处理函数。
   * @returns {HTMLButtonElement} 按钮元素。
   */
  const createButton = (text, onClick) => createElement('button', {
    className: 'poe2-button',
    textContent: text,
    onClick,
  });

  /**
   * createStopTaskButton 创建可复用的停止按钮，多个位置共用同一套停止逻辑。
   * @returns {HTMLButtonElement} 停止按钮元素。
   */
  const createStopTaskButton = () => {
    const button = createButton('停止', stopCurrentTask);
    button.classList.add('poe2-stop');
    button.disabled = true;
    return button;
  };

  /**
   * createSelect 创建下拉选择控件。
   * @param {Array<object>} options 选项列表。
   * @param {string|number} selectedValue 默认选中值。
   * @returns {HTMLSelectElement} select 元素。
   */
  const createSelect = (options, selectedValue) => {
    const selectElement = createElement('select', { className: 'poe2-input' });
    for (const option of options) {
      const optionElement = createElement('option', {
        value: String(option.value),
        textContent: option.label,
      });
      if (String(option.value) === String(selectedValue)) optionElement.selected = true;
      selectElement.append(optionElement);
    }
    return selectElement;
  };

  /**
   * setSelectOptions 用一组标准选项重置 select。
   * @param {HTMLSelectElement} selectElement 需要重置的下拉框。
   * @param {Array<object>} options 选项列表，每项包含 value、label 和可选 meta。
   * @param {string} placeholder 空选项显示文本。
   */
  const setSelectOptions = (selectElement, options, placeholder) => {
    selectElement.replaceChildren();
    if (placeholder !== undefined) {
      selectElement.append(createElement('option', {
        value: '',
        textContent: placeholder,
      }));
    }
    for (const option of options) {
      const optionElement = createElement('option', {
        value: String(option.value),
        textContent: option.label,
      });
      if (option.meta) {
        for (const [key, value] of Object.entries(option.meta)) {
          optionElement.dataset[key] = String(value);
        }
      }
      selectElement.append(optionElement);
    }
  };

  /**
   * getAffixEquipmentOptions 读取做装插件移植过来的装备类型列表。
   * @returns {Array<object>} 装备类型下拉选项。
   */
  /**
   * formatAffixEquipmentTypeLabel 把装备类型括号里的属性缩写转为中文，方便下拉框快速识别。
   * 只改变显示文本，不改变 option.value，确保仍能用原始 key 读取 AFFIX_EQUIPMENT_DATA。
   * @param {string} equipmentType 原始装备类型，例如 胸甲(str_dex_int)。
   * @returns {string} 可读装备类型，例如 胸甲(力敏智)。
   */
  const formatAffixEquipmentTypeLabel = (equipmentType) => String(equipmentType || '').replace(/\(([^)]*)\)+/g, (matchedText, attributeText) => {
    const attributeNameMap = {
      str: '力',
      dex: '敏',
      int: '智',
    };
    const formattedAttributes = String(attributeText || '')
      .split('_')
      .map((attributeName) => attributeNameMap[attributeName] || attributeName)
      .join('');
    return formattedAttributes ? `(${formattedAttributes})` : matchedText;
  });

  const AFFIX_EQUIPMENT_SORT_GROUPS = [
    ['爪', '匕首', '符文匕首', '法杖', '短杖', '单手剑', '细剑', '单手斧', '单手锤'],
    ['双手剑', '双手斧', '双手锤', '弓', '长杖', '战杖'],
    ['项链', '戒指', '腰带'],
    ['箭袋', '盾牌'],
    ['头部', '头盔', '胸甲', '手套', '鞋子'],
    ['生命药剂', '魔力药剂', '功能药剂'],
  ];

  const getAffixEquipmentSortInfo = (equipmentType) => {
    const cleanType = String(equipmentType || '').replace(/\(.*/, '');
    for (let groupIndex = 0; groupIndex < AFFIX_EQUIPMENT_SORT_GROUPS.length; groupIndex += 1) {
      const itemIndex = AFFIX_EQUIPMENT_SORT_GROUPS[groupIndex].indexOf(cleanType);
      if (itemIndex >= 0) return { groupIndex, itemIndex };
    }
    return { groupIndex: AFFIX_EQUIPMENT_SORT_GROUPS.length, itemIndex: 0 };
  };

  const compareAffixEquipmentType = (left, right) => {
    const leftSortInfo = getAffixEquipmentSortInfo(left);
    const rightSortInfo = getAffixEquipmentSortInfo(right);
    if (leftSortInfo.groupIndex !== rightSortInfo.groupIndex) {
      return leftSortInfo.groupIndex - rightSortInfo.groupIndex;
    }
    if (leftSortInfo.itemIndex !== rightSortInfo.itemIndex) {
      return leftSortInfo.itemIndex - rightSortInfo.itemIndex;
    }
    return left.localeCompare(right, 'zh-Hans-CN');
  };

  const getAffixEquipmentOptions = () => Object.keys(AFFIX_EQUIPMENT_DATA)
    .sort(compareAffixEquipmentType)
    .map((equipmentType) => ({ value: equipmentType, label: formatAffixEquipmentTypeLabel(equipmentType) }));

  /**
   * getAffixPositionOptions 根据装备类型返回可选的词缀位置。
   * @param {string} equipmentType 装备类型。
   * @returns {Array<object>} 前缀/后缀下拉选项。
   */
  const getAffixPositionOptions = (equipmentType) => Object.keys(AFFIX_EQUIPMENT_DATA[equipmentType] || {})
    .map((positionName) => ({ value: positionName, label: positionName }));

  /**
   * getAffixTypeOptions 根据装备类型和词缀位置返回可选词缀类型。
   * @param {string} equipmentType 装备类型。
   * @param {string} affixPosition 词缀位置。
   * @returns {Array<object>} 词缀类型下拉选项。
   */
  const getAffixTypeOptions = (equipmentType, affixPosition) => {
    const affixes = AFFIX_EQUIPMENT_DATA[equipmentType]?.[affixPosition];
    if (!Array.isArray(affixes)) return [];
    return affixes
      .filter((affix) => affix?.name)
      .map((affix) => ({
        value: affix.name,
        label: affix.name,
        meta: { maxLevel: Number(affix.maxLevel || 0) },
      }));
  };

  const getAffixTierSortWeight = (affixTypeName, tier) => {
    if (affixTypeName !== '功能药剂：生效期间效果') return 0;
    const text = `${tier?.name || ''} ${tier?.value || ''}`;
    if (text.includes('施法速度')) return 1;
    if (text.includes('攻击速度')) return 2;
    if (text.includes('移动速度')) return 3;
    if (text.includes('暴击率')) return 4;
    if (text.includes('元素抗性')) return 5;
    if (text.includes('护甲')) return 6;
    if (text.includes('闪避')) return 7;
    return 20;
  };

  const isOutdatedFlaskEffectTier = (affixTypeName, tier) => {
    if (affixTypeName !== '功能药剂：生效期间效果') return false;
    const text = `${tier?.name || ''} ${tier?.value || ''}`;
    return text.includes('攻击速度') || text.includes('施法速度') || text.includes('命中值');
  };

  /**
   * getAffixTierOptions 根据词缀类型和最高阶级返回具体可选词缀名。
   * 做装插件的原逻辑是倒序显示，并过滤超过 maxLevel 的等阶。
   * @param {string} affixTypeName 词缀类型名称。
   * @param {number} maxLevel 当前装备类型允许的最高阶级。
   * @returns {Array<object>} 具体词缀等级下拉选项。
   */
  const getAffixTierOptions = (affixTypeName, maxLevel) => {
    const tierList = AFFIX_LEVEL_DATA[affixTypeName];
    if (!Array.isArray(tierList)) return [];
    const filteredTierList = [...tierList].filter((tier) => Number(tier?.level || 0) <= maxLevel);
    const sortedTierList = affixTypeName === '功能药剂：生效期间效果'
      ? filteredTierList
      : filteredTierList.sort((left, right) => (
        Number(right.level || 0) - Number(left.level || 0)
        || getAffixTierSortWeight(affixTypeName, left) - getAffixTierSortWeight(affixTypeName, right)
        || String(left.name || '').localeCompare(String(right.name || ''), 'zh-Hans-CN')
      ));
    return sortedTierList
      .map((tier) => ({
        value: tier.name,
        label: `${tier.name}：${tier.value}${isOutdatedFlaskEffectTier(affixTypeName, tier) ? '（已过时）' : ''}`,
        meta: { level: Number(tier.level || 0), affixType: affixTypeName },
      }));
  };

  /**
   * getActiveAffixGroupIndex 返回当前正在编辑的条件组下标。
   * @returns {number} 可安全写入 state.affixConditionGroups 的组下标。
   */
  const getActiveAffixGroupIndex = () => {
    const rawIndex = Number.parseInt(state.ui.affixGroupSelect?.value || '0', 10);
    if (Number.isNaN(rawIndex) || rawIndex < 0) return 0;
    if (!state.affixConditionGroups[rawIndex]) return 0;
    return rawIndex;
  };

  /**
   * formatContinuousStepCode 把连续打造步骤下标转为 A/B/C...，超过 Z 后继续 AA/AB。
   * @param {number} stepIndex 连续打造步骤下标。
   * @returns {string} 步骤字母编号。
   */
  const formatContinuousStepCode = (stepIndex) => {
    let index = Math.max(0, Number.parseInt(stepIndex, 10) || 0);
    let code = '';
    do {
      code = String.fromCharCode(65 + (index % 26)) + code;
      index = Math.floor(index / 26) - 1;
    } while (index >= 0);
    return code;
  };

  const parseContinuousStepCode = (stepCode) => {
    const text = String(stepCode || '').trim().toUpperCase();
    if (!text) return null;
    const numericIndex = Number.parseInt(text, 10);
    if (Number.isFinite(numericIndex)) return Math.max(0, numericIndex - 1);
    if (!/^[A-Z]+$/.test(text)) return null;
    let index = 0;
    for (const character of text) {
      index = index * 26 + (character.charCodeAt(0) - 64);
    }
    return Math.max(0, index - 1);
  };

  const formatContinuousStepTarget = (stepIndex) => (
    Number.isInteger(stepIndex) && stepIndex >= 0 ? formatContinuousStepCode(stepIndex) : ''
  );

  const formatContinuousStepTargetLabel = (stepIndex, stepCount) => (
    Number.isInteger(stepIndex) && stepIndex >= stepCount ? '终止(打造成功)' : formatContinuousStepTarget(stepIndex)
  );

  const formatContinuousStepEditableTargetLabel = (stepIndex, stepCount) => (
    Number.isInteger(stepIndex) && stepIndex >= stepCount ? `${formatContinuousStepCode(stepCount)}（新增后）` : formatContinuousStepTarget(stepIndex)
  );

  const createContinuousStepTargetOptions = (stepCount) => [
    ...Array.from({ length: stepCount }, (_, stepIndex) => ({
      value: String(stepIndex),
      label: `步骤 ${formatContinuousStepCode(stepIndex)}`,
    })),
    { value: String(stepCount), label: `步骤 ${formatContinuousStepCode(stepCount)}（新增后）` },
  ];

  const setContinuousStepTargetSelectValue = (selectElement, targetStepIndex, fallbackStepIndex, stepCount) => {
    if (!selectElement) return;
    const resolvedIndex = resolveContinuousStepTarget(targetStepIndex, fallbackStepIndex, stepCount);
    selectElement.value = String(resolvedIndex);
  };

  const readContinuousStepTargetSelectValue = (selectElement, fallbackStepIndex, stepCount) => {
    const rawIndex = Number.parseInt(selectElement?.value, 10);
    return resolveContinuousStepTarget(Number.isFinite(rawIndex) ? rawIndex : null, fallbackStepIndex, stepCount);
  };

  /**
   * getAffixConditionGroupLabel 根据当前编辑上下文生成条件组标题。
   * 普通洗词缀默认使用“A-1”，连续打造步骤按当前步骤使用“A-1/B-1”。
   * @param {number} groupIndex 条件组下标。
   * @returns {string} 条件组显示名。
   */
  const getAffixConditionGroupLabel = (groupIndex) => {
    if (state.affixConditionContext?.mode === 'continuous') {
      return `${formatContinuousStepCode(state.affixConditionContext.stepIndex)}-${groupIndex + 1}`;
    }
    return `A-${groupIndex + 1}`;
  };

  /**
   * renderAffixConditionBuilder 重绘可视化词缀条件组。
   */
  const renderAffixConditionBuilder = () => {
    const groupSelect = state.ui.affixGroupSelect;
    const groupList = state.ui.affixGroupList;
    if (!groupSelect || !groupList) return;
    if (!state.affixConditionGroups.length) state.affixConditionGroups = [createEmptyAffixConditionGroup()];
    state.affixConditionGroups = state.affixConditionGroups.map(normalizeAffixConditionGroup);
    const selectedIndex = Math.min(getActiveAffixGroupIndex(), state.affixConditionGroups.length - 1);
    groupSelect.replaceChildren(...state.affixConditionGroups.map((group, groupIndex) => {
      const conditions = group.conditions;
      const groupLabel = getAffixConditionGroupLabel(groupIndex);
      const option = createElement('option', {
        value: String(groupIndex),
        textContent: `${groupLabel}（${conditions.length} 条，命中 ${Math.min(group.minRequired, Math.max(conditions.length, 1))}）`,
      });
      option.selected = groupIndex === selectedIndex;
      return option;
    }));
    groupList.replaceChildren(...state.affixConditionGroups.map((group, groupIndex) => {
      const conditions = group.conditions;
      const groupLabel = getAffixConditionGroupLabel(groupIndex);
      const minInput = createElement('input', {
        className: 'poe2-input poe2-affix-min-input',
        type: 'number',
        value: String(group.minRequired),
        onChange: (event) => setAffixGroupMinRequired(groupIndex, event.target.value),
      });
      minInput.min = '1';
      minInput.max = String(Math.max(1, conditions.length));
      minInput.title = '本组至少命中几个条件。命中数不能小于 1，也不能超过本组条件数量。';
      const conditionElements = conditions.length
        ? conditions.map((condition, affixIndex) => createElement('button', {
          className: 'poe2-affix-chip',
          textContent: formatAffixConditionLabel(condition),
          onClick: () => removeAffixCondition(groupIndex, affixIndex),
        }))
        : [createElement('div', { className: 'poe2-affix-empty', textContent: '空条件组' })];
      return createElement('div', {
        className: `poe2-affix-group-card${groupIndex === selectedIndex ? ' active' : ''}`,
        onClick: (event) => {
          if (event.target.closest('button,input,label')) return;
          state.ui.affixGroupSelect.value = String(groupIndex);
          renderAffixConditionBuilder();
        },
        children: [
          createElement('div', {
            className: 'poe2-affix-group-head',
            children: [
              createElement('strong', { textContent: groupLabel }),
              createElement('label', {
                className: 'poe2-affix-min-field',
                children: [
                  createElement('span', { textContent: '本组命中数' }),
                  minInput,
                ],
              }),
              createButton('删除组', () => removeAffixGroup(groupIndex)),
            ],
          }),
          createElement('div', { className: 'poe2-affix-chip-list', children: conditionElements }),
        ],
      });
    }));
  };

  /**
   * addAffixConditions 把词缀选择器选中的具体词缀加入当前条件组。
   * @param {Array<HTMLOptionElement|string>} selectedAffixOptions 用户选择的具体词缀选项。
   */
  const addAffixConditions = (selectedAffixOptions) => {
    const selectedAffixType = String(state.ui.affixTypeSelect?.value || '').trim();
    const cleanConditions = selectedAffixOptions
      .map((option) => {
        if (option && typeof option === 'object' && 'value' in option) {
          return normalizeAffixCondition({
            name: option.value,
            affixType: option.dataset?.affixType || selectedAffixType,
          });
        }
        return normalizeAffixCondition({ name: option, affixType: selectedAffixType });
      })
      .filter((condition) => condition.name);
    if (!cleanConditions.length) {
      addLog('请先选择一个具体词缀等级。', 'warn');
      return;
    }
    const groupIndex = getActiveAffixGroupIndex();
    const currentGroup = normalizeAffixConditionGroup(state.affixConditionGroups[groupIndex]);
    const mergedConditions = [...currentGroup.conditions, ...cleanConditions]
      .map(normalizeAffixCondition);
    const seenConditionKeys = new Set();
    const conditions = mergedConditions.filter((condition) => {
      const conditionKey = getAffixConditionKey(condition);
      if (!condition.name || seenConditionKeys.has(conditionKey)) return false;
      seenConditionKeys.add(conditionKey);
      return true;
    });
    state.affixConditionGroups[groupIndex] = { ...currentGroup, conditions };
    renderAffixConditionBuilder();
  };

  /**
   * addAffixGroup 新增一个必须一并满足的条件组。
   */
  const addAffixGroup = () => {
    state.affixConditionGroups.push(createEmptyAffixConditionGroup());
    state.ui.affixGroupSelect.value = String(state.affixConditionGroups.length - 1);
    renderAffixConditionBuilder();
  };

  const readSpecialConditionValue = (metric) => {
    const metricConfig = SPECIAL_CONDITION_METRICS[metric] || SPECIAL_CONDITION_METRICS.totalAffixCount;
    if (metricConfig.valueType === 'number') {
      return Number.parseInt(state.ui.specialConditionValueInput?.value, 10) || 0;
    }
    if (metricConfig.valueType === 'percent') {
      return Number.parseFloat(state.ui.specialConditionValueInput?.value) || 0;
    }
    if (metricConfig.valueType === 'boolean') {
      return state.ui.specialConditionValueSelect?.value === 'true';
    }
    return Number.parseInt(state.ui.specialConditionValueSelect?.value, 10) || RARITY_TYPES.magic;
  };

  const appendAffixConditionToActiveGroup = (condition) => {
    const groupIndex = getActiveAffixGroupIndex();
    const currentGroup = normalizeAffixConditionGroup(state.affixConditionGroups[groupIndex]);
    const mergedConditions = [...currentGroup.conditions, condition].map(normalizeAffixCondition);
    const seenConditionKeys = new Set();
    const conditions = mergedConditions.filter((item) => {
      const conditionKey = getAffixConditionKey(item);
      if (seenConditionKeys.has(conditionKey)) return false;
      seenConditionKeys.add(conditionKey);
      return true;
    });
    state.affixConditionGroups[groupIndex] = { ...currentGroup, conditions };
    renderAffixConditionBuilder();
  };

  const addSpecialCondition = () => {
    const metric = state.ui.specialConditionMetricSelect?.value || 'totalAffixCount';
    const operator = state.ui.specialConditionOperatorSelect?.value || 'eq';
    const condition = normalizeAffixCondition({
      kind: 'special',
      metric,
      operator,
      value: readSpecialConditionValue(metric),
    });
    appendAffixConditionToActiveGroup(condition);
  };

  const readRollConditionValue = (metric) => {
    const metricConfig = ROLL_CONDITION_METRICS[metric] || ROLL_CONDITION_METRICS.physicalDamageMin;
    const value = Number.parseInt(state.ui.rollConditionValueInput?.value, 10) || 0;
    if (metricConfig.valueType === 'percent') {
      if (value > 100) {
        addLog('Roll 百分比目标值不能超过 100%。', 'error');
        return null;
      }
      return Math.max(0, value);
    }
    return value;
  };

  const addRollCondition = () => {
    const metric = state.ui.rollConditionMetricSelect?.value || 'physicalDamageMin';
    const operator = state.ui.rollConditionOperatorSelect?.value || 'gte';
    const value = readRollConditionValue(metric);
    if (value === null) return;
    const condition = normalizeAffixCondition({
      kind: 'roll',
      metric,
      operator,
      value,
    });
    appendAffixConditionToActiveGroup(condition);
  };

  /**
   * removeAffixCondition 移除指定条件组中的某个词缀条件。
   * @param {number} groupIndex 条件组下标。
   * @param {number} affixIndex 条件下标。
   */
  const removeAffixCondition = (groupIndex, affixIndex) => {
    const group = normalizeAffixConditionGroup(state.affixConditionGroups[groupIndex]);
    if (!group.conditions.length) return;
    group.conditions.splice(affixIndex, 1);
    state.affixConditionGroups[groupIndex] = group;
    renderAffixConditionBuilder();
  };

  /**
   * removeAffixGroup 移除指定条件组；至少保留一个空组，避免 UI 没有可添加目标。
   * @param {number} groupIndex 条件组下标。
   */
  const removeAffixGroup = (groupIndex) => {
    if (state.affixConditionGroups.length <= 1) {
      state.affixConditionGroups = [createEmptyAffixConditionGroup()];
    } else {
      state.affixConditionGroups.splice(groupIndex, 1);
    }
    renderAffixConditionBuilder();
  };

  /**
   * clearAffixConditions 清空所有可视化词缀条件。
   */
  const clearAffixConditions = () => {
    state.affixConditionGroups = [createEmptyAffixConditionGroup()];
    renderAffixConditionBuilder();
  };

  /**
   * getActiveContinuousCraftStepIndex 返回当前正在编辑的连续打造步骤下标。
   * @returns {number} 可安全访问 state.continuousCraftSteps 的下标。
   */
  const getActiveContinuousCraftStepIndex = () => {
    const steps = getContinuousCraftSteps();
    const rawIndex = Number.parseInt(state.ui.continuousStepSelect?.value || String(state.activeContinuousStepIndex), 10);
    if (Number.isNaN(rawIndex) || rawIndex < 0) return 0;
    return Math.min(rawIndex, steps.length - 1);
  };

  const isContinuousConditionAction = (action) => action === 'conditionCheck';

  const getContinuousActionKind = (action) => {
    if (action === 'craftBench') return 'craftBench';
    if (action === 'gardenCraft') return 'gardenCraft';
    if (['ensureMagic', 'ensureRare', 'smartAugment', 'smartExalted', 'smartCraftBench'].includes(action)) return 'aggregate';
    if (action === 'conditionCheck') return 'condition';
    if (action === 'none') return 'none';
    return 'currency';
  };

  const getContinuousActionKindOptions = (kind) => (
    CONTINUOUS_ACTION_KIND_DETAIL_OPTIONS[kind] || []
  ).map((action) => ({
    value: action,
    label: CONTINUOUS_CRAFT_ACTIONS[action]?.label || action,
  }));

  const getActionFromContinuousActionControls = (fallbackAction = 'alteration') => {
    const kind = state.ui.continuousActionKindSelect?.value || getContinuousActionKind(fallbackAction);
    if (kind === 'craftBench') return 'craftBench';
    if (kind === 'gardenCraft') return 'gardenCraft';
    if (kind === 'condition') return 'conditionCheck';
    if (kind === 'none') return 'none';
    const selectedAction = state.ui.continuousActionSelect?.value;
    const validActions = CONTINUOUS_ACTION_KIND_DETAIL_OPTIONS[kind] || [];
    return validActions.includes(selectedAction) ? selectedAction : (validActions[0] || fallbackAction);
  };

  const syncContinuousActionControls = (action) => {
    if (!state.ui.continuousActionKindSelect || !state.ui.continuousActionSelect) return;
    const kind = getContinuousActionKind(action);
    state.ui.continuousActionKindSelect.value = kind;
    const detailOptions = getContinuousActionKindOptions(kind);
    setSelectOptions(state.ui.continuousActionSelect, detailOptions);
    state.ui.continuousActionSelect.hidden = detailOptions.length === 0;
    if (detailOptions.some((option) => option.value === action)) {
      state.ui.continuousActionSelect.value = action;
    } else if (detailOptions.length) {
      state.ui.continuousActionSelect.value = detailOptions[0].value;
    }
  };

  const updateContinuousHandlingTargetVisibility = () => {
    const currentAction = getActionFromContinuousActionControls();
    const isConditionAction = isContinuousConditionAction(currentAction);
    if (state.ui.continuousSuccessHandlingField) {
      state.ui.continuousSuccessHandlingField.hidden = false;
      const labelElement = state.ui.continuousSuccessHandlingField.querySelector('span');
      if (labelElement) labelElement.textContent = isConditionAction ? '条件成立' : '完成后';
    }
    if (state.ui.continuousFailureHandlingField) {
      state.ui.continuousFailureHandlingField.hidden = !isConditionAction;
    }
    if (state.ui.continuousSuccessTargetField) {
      state.ui.continuousSuccessTargetField.hidden = state.ui.continuousSuccessSelect?.value !== 'jump';
      const labelElement = state.ui.continuousSuccessTargetField.querySelector('span');
      if (labelElement) labelElement.textContent = isConditionAction ? '成立跳转步骤' : '下一步';
    }
    if (state.ui.continuousFailureTargetField) {
      state.ui.continuousFailureTargetField.hidden = !isConditionAction || state.ui.continuousFailureSelect?.value !== 'jump';
    }
  };

  const updateContinuousCraftBenchControlsVisibility = () => {
    const currentAction = getActionFromContinuousActionControls();
    const isCraftBenchAction = ['craftBench', 'smartCraftBench'].includes(currentAction);
    const isGardenCraftAction = currentAction === 'gardenCraft';
    if (state.ui.continuousCraftCategoryField) {
      state.ui.continuousCraftCategoryField.hidden = !isCraftBenchAction;
    }
    if (state.ui.continuousCraftIdField) {
      state.ui.continuousCraftIdField.hidden = !isCraftBenchAction;
    }
    if (state.ui.continuousCraftRefreshButton) {
      state.ui.continuousCraftRefreshButton.hidden = !isCraftBenchAction && !isGardenCraftAction;
    }
    if (state.ui.continuousGardenCategoryField) {
      state.ui.continuousGardenCategoryField.hidden = !isGardenCraftAction;
    }
    if (state.ui.continuousGardenCraftField) {
      state.ui.continuousGardenCraftField.hidden = !isGardenCraftAction;
    }
  };

  const refreshContinuousCraftBenchOptions = async (forceRefresh = false, preferredCraftId = '') => {
    if (!state.ui.continuousCraftCategorySelect || !state.ui.continuousCraftIdSelect) return;
    await ensureCraftBenchList(forceRefresh);
    const selectedCraftId = preferredCraftId || state.ui.continuousCraftIdSelect.value;
    const options = getCraftBenchOptionsByCategory(state.ui.continuousCraftCategorySelect.value);
    setSelectOptions(state.ui.continuousCraftIdSelect, options, '选择工艺词缀');
    if (options.some((option) => String(option.value) === String(selectedCraftId))) {
      state.ui.continuousCraftIdSelect.value = selectedCraftId;
    }
    state.ui.continuousCraftIdSelect.dataset.pendingCraftId = '';
    if (forceRefresh) addLog(`工艺列表已刷新：${state.craftBench.list.length} 条。`, 'compact');
  };

  const scheduleContinuousCraftBenchOptionsRefresh = (forceRefresh = false, preferredCraftId = '') => {
    refreshContinuousCraftBenchOptions(forceRefresh, preferredCraftId).catch((error) => {
      addLog(`工艺列表读取失败：${error.message}`, 'error');
    });
  };

  const refreshContinuousGardenCraftOptions = async (forceRefresh = false, preferredGardenCraftKey = '') => {
    if (!state.ui.continuousGardenCategorySelect || !state.ui.continuousGardenCraftSelect) return;
    const categoryValue = state.ui.continuousGardenCategorySelect.value;
    await ensureGardenCraftList(categoryValue, forceRefresh);
    const selectedGardenCraftKey = preferredGardenCraftKey || state.ui.continuousGardenCraftSelect.value;
    const options = getGardenCraftOptionsByCategory(categoryValue);
    setSelectOptions(state.ui.continuousGardenCraftSelect, options, '选择花园工艺方法');
    if (options.some((option) => String(option.value) === String(selectedGardenCraftKey))) {
      state.ui.continuousGardenCraftSelect.value = selectedGardenCraftKey;
    }
    state.ui.continuousGardenCraftSelect.dataset.pendingGardenCraftKey = '';
    if (forceRefresh) addLog(`花园工艺列表已刷新：${options.length} 条。`, 'compact');
  };

  const scheduleContinuousGardenCraftOptionsRefresh = (forceRefresh = false, preferredGardenCraftKey = '') => {
    refreshContinuousGardenCraftOptions(forceRefresh, preferredGardenCraftKey).catch((error) => {
      addLog(`花园工艺列表读取失败：${error.message}`, 'error');
    });
  };

  /**
   * renderContinuousCraftSteps 重绘连续打造步骤列表和当前步骤选择框。
   * 这里只渲染步骤元信息；具体词缀条件复用通用词缀选择器编辑。
   */
  const renderContinuousCraftSteps = () => {
    if (!state.ui.continuousStepSelect || !state.ui.continuousStepList) return;
    const steps = getContinuousCraftSteps();
    const activeIndex = Math.min(state.activeContinuousStepIndex, steps.length - 1);
    state.activeContinuousStepIndex = activeIndex;
    state.ui.continuousStepSelect.replaceChildren(...steps.map((step, stepIndex) => {
      const actionConfig = CONTINUOUS_CRAFT_ACTIONS[step.action];
      const effectiveGroups = step.conditionGroups.filter((group) => group.conditions.length > 0);
      const usesCraftBenchSelection = ['craftBench', 'smartCraftBench'].includes(step.action);
      const usesGardenCraftSelection = step.action === 'gardenCraft';
      const craft = usesCraftBenchSelection ? getCraftBenchById(step.craftId) : null;
      const gardenCraft = usesGardenCraftSelection ? getGardenCraftByKey(step.gardenCraftCategory, step.gardenCraftKey) : null;
      const craftText = usesCraftBenchSelection
        ? `：${craft?.label || (step.craftId ? `工艺 ID ${step.craftId}` : '未选择工艺')}`
        : usesGardenCraftSelection
          ? `：${gardenCraft?.label || (step.gardenCraftKey ? `花园工艺 ${step.gardenCraftKey}` : '未选择花园工艺')}`
        : '';
      const stepCode = formatContinuousStepCode(stepIndex);
      const groupText = step.action === 'conditionCheck' ? `（${effectiveGroups.length} 组）` : '';
      const actionLabel = step.action === 'conditionCheck'
        ? `${actionConfig.label}(${formatConditionStepShortLabel(effectiveGroups)})`
        : actionConfig.label;
      const option = createElement('option', {
        value: String(stepIndex),
        textContent: `步骤 ${stepCode}：${actionLabel}${craftText}${groupText}`,
      });
      option.selected = stepIndex === activeIndex;
      return option;
    }));
    syncContinuousActionControls(steps[activeIndex].action);
    const targetOptions = createContinuousStepTargetOptions(steps.length);
    setSelectOptions(state.ui.continuousSuccessTargetInput, targetOptions);
    setSelectOptions(state.ui.continuousFailureTargetInput, targetOptions);
    if (state.ui.continuousSuccessSelect) {
      state.ui.continuousSuccessSelect.value = steps[activeIndex].successHandling;
      setContinuousStepTargetSelectValue(
        state.ui.continuousSuccessTargetInput,
        steps[activeIndex].successTargetStepIndex ?? activeIndex + 1,
        activeIndex + 1,
        steps.length,
      );
    }
    if (state.ui.continuousFailureSelect) {
      state.ui.continuousFailureSelect.value = steps[activeIndex].failureHandling;
      setContinuousStepTargetSelectValue(
        state.ui.continuousFailureTargetInput,
        steps[activeIndex].failureTargetStepIndex,
        activeIndex,
        steps.length,
      );
    }
    if (state.ui.continuousCraftCategorySelect) {
      state.ui.continuousCraftCategorySelect.value = steps[activeIndex].craftCategory;
      state.ui.continuousCraftIdSelect.dataset.pendingCraftId = steps[activeIndex].craftId || '';
      scheduleContinuousCraftBenchOptionsRefresh(false, steps[activeIndex].craftId || '');
    }
    if (state.ui.continuousGardenCategorySelect) {
      state.ui.continuousGardenCategorySelect.value = steps[activeIndex].gardenCraftCategory;
      state.ui.continuousGardenCraftSelect.dataset.pendingGardenCraftKey = steps[activeIndex].gardenCraftKey || '';
      scheduleContinuousGardenCraftOptionsRefresh(false, steps[activeIndex].gardenCraftKey || '');
    }
    updateContinuousHandlingTargetVisibility();
    updateContinuousCraftBenchControlsVisibility();
    state.ui.continuousStepList.hidden = false;
    state.ui.continuousStepList.replaceChildren(...steps.map((step, stepIndex) => {
      const actionConfig = CONTINUOUS_CRAFT_ACTIONS[step.action];
      const successConfig = CONTINUOUS_STEP_HANDLINGS[step.successHandling];
      const failureConfig = CONTINUOUS_STEP_HANDLINGS[step.failureHandling];
      const effectiveGroups = step.conditionGroups.filter((group) => group.conditions.length > 0);
      const usesCraftBenchSelection = ['craftBench', 'smartCraftBench'].includes(step.action);
      const usesGardenCraftSelection = step.action === 'gardenCraft';
      const craft = usesCraftBenchSelection ? getCraftBenchById(step.craftId) : null;
      const gardenCraft = usesGardenCraftSelection ? getGardenCraftByKey(step.gardenCraftCategory, step.gardenCraftKey) : null;
      const stepCode = formatContinuousStepCode(stepIndex);
      const successText = step.successHandling === 'jump'
        ? `条件成立跳转步骤${formatContinuousStepEditableTargetLabel(step.successTargetStepIndex ?? stepIndex + 1, steps.length)}`
        : `条件成立${successConfig.label}`;
      const failureText = step.failureHandling === 'jump'
        ? `条件不成立跳转步骤${formatContinuousStepEditableTargetLabel(step.failureTargetStepIndex, steps.length)}`
        : `条件不成立${failureConfig.label}`;
      const isConditionStep = step.action === 'conditionCheck';
      const actionLabel = isConditionStep
        ? `${actionConfig.label}(${formatConditionStepShortLabel(effectiveGroups)})`
        : actionConfig.label;
      const actionText = `${actionLabel}${
        craft
          ? `：${craft.label}`
          : gardenCraft
            ? `：${gardenCraft.label}`
            : usesCraftBenchSelection
              ? '：未选择工艺'
              : usesGardenCraftSelection
                ? '：未选择花园工艺'
                : ''
      }`;
      const nextText = step.successHandling === 'jump'
        ? `下一步${formatContinuousStepEditableTargetLabel(step.successTargetStepIndex ?? stepIndex + 1, steps.length)}`
        : `完成后${successConfig.label}`;
      const summaryLines = [
        isConditionStep
          ? `步骤${stepCode} ${actionText} ${successText} ${failureText}`
          : `步骤${stepCode} ${actionText} ${nextText}`,
      ];
      const summaryText = summaryLines.filter(Boolean).join('\n');
      return createElement('div', {
        className: `poe2-continuous-step${stepIndex === activeIndex ? ' active' : ''}`,
        textContent: summaryText,
        onClick: () => {
          saveCurrentContinuousStepSilently();
          state.activeContinuousStepIndex = stepIndex;
          state.ui.continuousStepSelect.value = String(stepIndex);
          loadContinuousCraftStepForEditing();
        },
      });
    }));
  };

  /**
   * saveCurrentContinuousStepSilently 保存当前步骤编辑器内容，不刷新 UI、不写日志。
   * 切换步骤、改动作或新增/删除步骤前调用，避免用户忘记点保存导致条件丢失。
   */
  const saveCurrentContinuousStepSilently = () => {
    if (!state.ui.continuousActionSelect || !state.ui.continuousFailureSelect || !state.ui.continuousSuccessSelect) return;
    if (state.affixConditionContext?.mode !== 'continuous') return;
    const steps = getContinuousCraftSteps();
    const activeIndex = getActiveContinuousCraftStepIndex();
    const stepCount = steps.length;
    steps[activeIndex] = createContinuousCraftStep(
      getActionFromContinuousActionControls(steps[activeIndex].action),
      state.affixConditionGroups,
      state.ui.continuousFailureSelect.value || steps[activeIndex].failureHandling,
      state.ui.continuousSuccessSelect.value || steps[activeIndex].successHandling,
      readContinuousStepTargetSelectValue(state.ui.continuousSuccessTargetInput, activeIndex + 1, stepCount),
      readContinuousStepTargetSelectValue(state.ui.continuousFailureTargetInput, activeIndex, stepCount),
      state.ui.continuousCraftCategorySelect?.value || steps[activeIndex].craftCategory,
      state.ui.continuousCraftIdSelect
        ? (state.ui.continuousCraftIdSelect.value || state.ui.continuousCraftIdSelect.dataset.pendingCraftId || '')
        : steps[activeIndex].craftId,
      '',
      state.ui.continuousGardenCategorySelect?.value || steps[activeIndex].gardenCraftCategory,
      state.ui.continuousGardenCraftSelect
        ? (state.ui.continuousGardenCraftSelect.value || state.ui.continuousGardenCraftSelect.dataset.pendingGardenCraftKey || '')
        : steps[activeIndex].gardenCraftKey,
    );
    state.continuousCraftSteps = steps;
  };

  /**
   * loadContinuousCraftStepForEditing 把当前连续打造步骤的条件载入通用词缀编辑器。
   * 切换步骤时会先自动保存旧步骤，再自动载入新步骤。
   */
  const loadContinuousCraftStepForEditing = (shouldLog = true) => {
    const steps = getContinuousCraftSteps();
    const activeIndex = getActiveContinuousCraftStepIndex();
    state.activeContinuousStepIndex = activeIndex;
    state.affixConditionContext = { mode: 'continuous', stepIndex: activeIndex };
    const step = normalizeContinuousCraftStep(steps[activeIndex]);
    state.affixConditionGroups = step.conditionGroups.length
      ? step.conditionGroups.map(normalizeAffixConditionGroup)
      : [createEmptyAffixConditionGroup()];
    const targetOptions = createContinuousStepTargetOptions(steps.length);
    setSelectOptions(state.ui.continuousSuccessTargetInput, targetOptions);
    setSelectOptions(state.ui.continuousFailureTargetInput, targetOptions);
    syncContinuousActionControls(step.action);
    state.ui.continuousSuccessSelect.value = step.successHandling;
    setContinuousStepTargetSelectValue(
      state.ui.continuousSuccessTargetInput,
      step.successTargetStepIndex ?? activeIndex + 1,
      activeIndex + 1,
      steps.length,
    );
    state.ui.continuousFailureSelect.value = step.failureHandling;
    setContinuousStepTargetSelectValue(
      state.ui.continuousFailureTargetInput,
      step.failureTargetStepIndex,
      activeIndex,
      steps.length,
    );
    if (state.ui.continuousCraftCategorySelect) {
      state.ui.continuousCraftCategorySelect.value = step.craftCategory;
      state.ui.continuousCraftIdSelect.dataset.pendingCraftId = step.craftId || '';
      scheduleContinuousCraftBenchOptionsRefresh(false, step.craftId || '');
    }
    if (state.ui.continuousGardenCategorySelect) {
      state.ui.continuousGardenCategorySelect.value = step.gardenCraftCategory;
      state.ui.continuousGardenCraftSelect.dataset.pendingGardenCraftKey = step.gardenCraftKey || '';
      scheduleContinuousGardenCraftOptionsRefresh(false, step.gardenCraftKey || '');
    }
    updateContinuousHandlingTargetVisibility();
    updateContinuousCraftBenchControlsVisibility();
    renderAffixConditionBuilder();
    renderContinuousCraftSteps();
    if (shouldLog) {
      addLog(`已载入自定义打造步骤 ${formatContinuousStepCode(activeIndex)}，可以编辑本步骤条件。`, 'compact');
    }
  };

  /**
   * addContinuousCraftStep 新增一个连续打造步骤，并切换到新步骤编辑。
   */
  const addContinuousCraftStep = () => {
    saveCurrentContinuousStepSilently();
    const steps = getContinuousCraftSteps();
    steps.push(createContinuousCraftStep('alteration'));
    state.continuousCraftSteps = steps;
    state.activeContinuousStepIndex = steps.length - 1;
    renderContinuousCraftSteps();
    loadContinuousCraftStepForEditing();
  };

  /**
   * removeContinuousCraftStep 删除当前连续打造步骤；至少保留一个步骤，避免配置为空。
   */
  const removeContinuousCraftStep = () => {
    saveCurrentContinuousStepSilently();
    const steps = getContinuousCraftSteps();
    const activeIndex = getActiveContinuousCraftStepIndex();
    if (steps.length <= 1) {
      state.continuousCraftSteps = [createContinuousCraftStep('alteration')];
      state.activeContinuousStepIndex = 0;
    } else {
      steps.splice(activeIndex, 1);
      state.continuousCraftSteps = steps;
      state.activeContinuousStepIndex = Math.min(activeIndex, steps.length - 1);
    }
    renderContinuousCraftSteps();
    loadContinuousCraftStepForEditing();
  };

  /**
   * clearAllContinuousCraftSteps 清除当前流程，并保留一个空白步骤供继续编辑。
   */
  const clearAllContinuousCraftSteps = () => {
    state.continuousCraftSteps = [createContinuousCraftStep('alteration')];
    state.activeContinuousStepIndex = 0;
    renderContinuousCraftSteps();
    loadContinuousCraftStepForEditing(false);
    addLog('已清除所有自定义打造步骤。', 'compact');
  };

  /**
   * applyAltAugRegalPresetToContinuousSteps 把当前主词缀编辑器前两个条件组套用为常用预设。
   * 条件组会放到独立“判断条件”步骤，通货步骤只负责执行动作和跳转。
   */
  const applyAltAugRegalPresetToContinuousSteps = () => {
    const groups = getAffixConditionGroups();
    state.continuousCraftSteps = [
      createContinuousCraftStep('ensureMagic', [createEmptyAffixConditionGroup()], 'jump', 'jump', 1, 0),
      createContinuousCraftStep('alteration', [createEmptyAffixConditionGroup()], 'jump', 'jump', 2, 0),
      createContinuousCraftStep('smartAugment', [createEmptyAffixConditionGroup()], 'jump', 'jump', 3, 0),
      createContinuousCraftStep('conditionCheck', groups[0] ? [groups[0]] : [createEmptyAffixConditionGroup()], 'jump', 'jump', 4, 0),
      createContinuousCraftStep('regal', [createEmptyAffixConditionGroup()], 'jump', 'jump', 5, 0),
      createContinuousCraftStep('conditionCheck', groups[1] ? [groups[1]] : [createEmptyAffixConditionGroup()], 'scourRestart', 'terminateSuccess', null, 0),
    ];
    state.activeContinuousStepIndex = 0;
    renderContinuousCraftSteps();
    loadContinuousCraftStepForEditing();
    addLog('已套用“变为魔法 -> 改造石 -> 智能增幅 -> 判断条件 -> 富豪石 -> 判断条件(成功终止/失败重铸)”自定义打造预设。', 'compact');
  };

  /**
   * refreshAffixPositionSelect 在装备类型变化后刷新前缀/后缀选项。
   */
  const refreshAffixPositionSelect = () => {
    const equipmentType = state.ui.affixEquipmentSelect.value;
    setSelectOptions(state.ui.affixPositionSelect, getAffixPositionOptions(equipmentType), '选择词缀位置');
    setSelectOptions(state.ui.affixTypeSelect, [], '选择词缀类型');
    setSelectOptions(state.ui.affixTierSelect, [], '选择词缀等级');
  };

  /**
   * refreshAffixTypeSelect 在前缀/后缀变化后刷新词缀类型选项。
   */
  const refreshAffixTypeSelect = () => {
    const equipmentType = state.ui.affixEquipmentSelect.value;
    const affixPosition = state.ui.affixPositionSelect.value;
    setSelectOptions(state.ui.affixTypeSelect, getAffixTypeOptions(equipmentType, affixPosition), '选择词缀类型');
    setSelectOptions(state.ui.affixTierSelect, [], '选择词缀等级');
  };

  /**
   * refreshAffixTierSelect 在词缀类型变化后刷新具体等阶词缀。
   */
  const refreshAffixTierSelect = () => {
    const selectedOption = state.ui.affixTypeSelect.selectedOptions[0];
    const affixTypeName = state.ui.affixTypeSelect.value;
    const maxLevel = Number(selectedOption?.dataset?.maxLevel || 0);
    setSelectOptions(state.ui.affixTierSelect, getAffixTierOptions(affixTypeName, maxLevel), '选择词缀等级');
  };

  const getSpecialConditionMetricOptions = () => Object.entries(SPECIAL_CONDITION_METRICS)
    .map(([value, metric]) => ({ value, label: metric.label }));

  const getSpecialConditionOperatorOptions = (metric) => {
    const valueType = SPECIAL_CONDITION_METRICS[metric]?.valueType || 'number';
    const operatorKeys = ['number', 'percent'].includes(valueType)
      ? ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']
      : ['eq', 'ne'];
    return operatorKeys.map((operator) => ({ value: operator, label: SPECIAL_CONDITION_OPERATORS[operator] }));
  };

  const getRollConditionMetricOptions = () => Object.entries(ROLL_CONDITION_METRICS)
    .map(([value, metric]) => ({ value, label: metric.label }));

  const getRollConditionOperatorOptions = () => ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']
    .map((operator) => ({ value: operator, label: SPECIAL_CONDITION_OPERATORS[operator] }));

  const setSpecialConditionValueControl = () => {
    const metric = state.ui.specialConditionMetricSelect?.value || 'totalAffixCount';
    const metricConfig = SPECIAL_CONDITION_METRICS[metric] || SPECIAL_CONDITION_METRICS.totalAffixCount;
    const valueControl = state.ui.specialConditionValueControl;
    if (!valueControl) return;
    valueControl.replaceChildren();
    if (metricConfig.valueType === 'rarity') {
      state.ui.specialConditionValueSelect = createSelect(Object.entries(SPECIAL_CONDITION_RARITY_LABELS)
        .map(([value, label]) => ({ value, label })), RARITY_TYPES.magic);
      valueControl.append(state.ui.specialConditionValueSelect);
      return;
    }
    if (metricConfig.valueType === 'boolean') {
      state.ui.specialConditionValueSelect = createSelect([
        { value: 'true', label: '是' },
        { value: 'false', label: '否' },
      ], 'true');
      valueControl.append(state.ui.specialConditionValueSelect);
      return;
    }
    state.ui.specialConditionValueInput = createElement('input', {
      className: 'poe2-input',
      type: 'number',
      value: metricConfig.valueType === 'percent' ? '80' : '2',
    });
    if (metricConfig.valueType === 'percent') {
      state.ui.specialConditionValueInput.min = '0';
      state.ui.specialConditionValueInput.max = '100';
      state.ui.specialConditionValueInput.step = '0.1';
      state.ui.specialConditionValueInput.title = 'Roll 值按百分比填写，例如 80 表示 80%。';
    }
    valueControl.append(state.ui.specialConditionValueInput);
  };

  const refreshSpecialConditionControls = () => {
    const metric = state.ui.specialConditionMetricSelect?.value || 'totalAffixCount';
    const currentOperator = state.ui.specialConditionOperatorSelect?.value || 'eq';
    setSelectOptions(
      state.ui.specialConditionOperatorSelect,
      getSpecialConditionOperatorOptions(metric),
      '选择比较',
    );
    if ([...state.ui.specialConditionOperatorSelect.options].some((option) => option.value === currentOperator)) {
      state.ui.specialConditionOperatorSelect.value = currentOperator;
    } else {
      state.ui.specialConditionOperatorSelect.value = getSpecialConditionOperatorOptions(metric)[0]?.value || 'eq';
    }
    setSpecialConditionValueControl();
  };

  const refreshRollConditionControls = () => {
    const metric = state.ui.rollConditionMetricSelect?.value || 'physicalDamageMin';
    const metricConfig = ROLL_CONDITION_METRICS[metric] || ROLL_CONDITION_METRICS.physicalDamageMin;
    if (!state.ui.rollConditionValueInput) return;
    state.ui.rollConditionValueInput.step = '1';
    state.ui.rollConditionValueInput.min = metricConfig.valueType === 'percent' ? '0' : '';
    state.ui.rollConditionValueInput.max = metricConfig.valueType === 'percent' ? '100' : '';
    state.ui.rollConditionValueInput.title = metricConfig.valueType === 'percent'
      ? '按整数百分比填写，例如 80 表示 80%。'
      : '填写装备面板上看到的实际数值。';
  };

  const updateAffixConditionTypePanels = () => {
    const conditionType = state.ui.conditionTypeSelect?.value || 'affix';
    if (state.ui.affixConditionPanel) state.ui.affixConditionPanel.hidden = conditionType !== 'affix';
    if (state.ui.specialConditionPanel) state.ui.specialConditionPanel.hidden = conditionType !== 'special';
    if (state.ui.rollConditionPanel) state.ui.rollConditionPanel.hidden = conditionType !== 'roll';
  };

  /**
   * createAffixPickerSection 创建从做装插件移植过来的词缀选取区域。
   * 这里不复用原插件的散落 DOM 写法，而是接入 2.0 的统一表单、按钮和日志体系。
   * @returns {HTMLElement} 词缀选择区域 DOM。
   */
  const createAffixPickerSection = () => {
    state.ui.conditionTypeSelect = createSelect([
      { value: 'affix', label: '词缀选取' },
      { value: 'special', label: '特殊条件' },
      { value: 'roll', label: '词缀Roll值判断' },
    ], 'affix');
    state.ui.affixEquipmentSelect = createSelect([], '');
    state.ui.affixPositionSelect = createSelect([], '');
    state.ui.affixTypeSelect = createSelect([], '');
    state.ui.affixTierSelect = createSelect([], '');
    state.ui.affixTierSelect.multiple = true;
    state.ui.affixTierSelect.size = 4;
    state.ui.specialConditionMetricSelect = createSelect(getSpecialConditionMetricOptions(), 'totalAffixCount');
    state.ui.specialConditionOperatorSelect = createSelect([], '');
    state.ui.specialConditionValueControl = createElement('div', { className: 'poe2-special-value-control' });
    state.ui.rollConditionMetricSelect = createSelect(getRollConditionMetricOptions(), 'physicalDamageMin');
    state.ui.rollConditionOperatorSelect = createSelect(getRollConditionOperatorOptions(), 'gte');
    state.ui.rollConditionValueInput = createElement('input', {
      className: 'poe2-input',
      type: 'number',
      value: '0',
    });
    state.ui.affixGroupSelect = createSelect([], '');
    state.ui.affixGroupList = createElement('div', { className: 'poe2-affix-group-list' });

    setSelectOptions(state.ui.affixEquipmentSelect, getAffixEquipmentOptions(), '选择装备类型');
    setSelectOptions(state.ui.affixPositionSelect, [], '选择词缀位置');
    setSelectOptions(state.ui.affixTypeSelect, [], '选择词缀类型');
    setSelectOptions(state.ui.affixTierSelect, [], '选择词缀等级');
    renderAffixConditionBuilder();

    state.ui.affixEquipmentSelect.addEventListener('change', refreshAffixPositionSelect);
    state.ui.affixPositionSelect.addEventListener('change', refreshAffixTypeSelect);
    state.ui.affixTypeSelect.addEventListener('change', refreshAffixTierSelect);
    state.ui.conditionTypeSelect.addEventListener('change', updateAffixConditionTypePanels);
    state.ui.specialConditionMetricSelect.addEventListener('change', refreshSpecialConditionControls);
    state.ui.rollConditionMetricSelect.addEventListener('change', refreshRollConditionControls);
    refreshSpecialConditionControls();
    refreshRollConditionControls();

    const addAffixButton = createButton('添加条件', () => {
      if (state.ui.conditionTypeSelect.value === 'special') {
        addSpecialCondition();
        return;
      }
      if (state.ui.conditionTypeSelect.value === 'roll') {
        addRollCondition();
        return;
      }
      addAffixConditions(Array.from(state.ui.affixTierSelect.selectedOptions));
    });
    const addGroupButton = createButton('添加条件组', addAffixGroup);
    const clearAffixButton = createButton('清空条件', clearAffixConditions);
    state.ui.affixConditionPanel = createElement('div', {
      className: 'poe2-grid poe2-affix-picker-grid poe2-wide',
      children: [
        createLabeledControl('装备类型', state.ui.affixEquipmentSelect),
        createLabeledControl('位置', state.ui.affixPositionSelect),
        createLabeledControl('词缀类型', state.ui.affixTypeSelect),
        createLabeledControl('词缀等级', state.ui.affixTierSelect, 'poe2-affix-tier-field'),
      ],
    });
    state.ui.specialConditionPanel = createElement('div', {
      className: 'poe2-grid poe2-affix-picker-grid poe2-wide',
      children: [
        createLabeledControl('特殊条件', state.ui.specialConditionMetricSelect),
        createLabeledControl('比较', state.ui.specialConditionOperatorSelect),
        createLabeledControl('目标值', state.ui.specialConditionValueControl),
      ],
    });
    state.ui.rollConditionPanel = createElement('div', {
      className: 'poe2-grid poe2-affix-picker-grid poe2-wide',
      children: [
        createLabeledControl('Roll 条件', state.ui.rollConditionMetricSelect),
        createLabeledControl('比较', state.ui.rollConditionOperatorSelect),
        createLabeledControl('目标值', state.ui.rollConditionValueInput),
      ],
    });
    updateAffixConditionTypePanels();

    return createElement('div', {
      className: 'poe2-section',
      children: [
        createElement('div', {
          className: 'poe2-section-title poe2-section-title-row',
          children: [
            createElement('span', { textContent: '判断条件' }),
            createAffixHelpTooltip(),
            createAffixRollHelpTooltip(),
            createAffixItemLevelHelpTooltip(),
          ],
        }),
        createElement('div', {
          className: 'poe2-grid poe2-affix-picker-grid',
          children: [
            createLabeledControl('条件类型', state.ui.conditionTypeSelect),
            state.ui.affixConditionPanel,
            state.ui.specialConditionPanel,
            state.ui.rollConditionPanel,
            createElement('div', {
              className: 'poe2-actions poe2-affix-actions poe2-affix-picker-actions',
              children: [addAffixButton, addGroupButton, clearAffixButton],
            }),
          ],
        }),
        state.ui.affixGroupList,
      ],
    });
  };

  /**
   * createSkillStoneSection 创建技能石处理区域。
   * 该 UI 复用 2.0 的按钮、分区和日志风格，可管理背包和装备上镶嵌的技能石。
   * @returns {HTMLElement} 技能石处理区域 DOM。
   */
  const createSkillStoneSection = () => {
    state.ui.skillStoneSelect = createElement('select', { className: 'poe2-input poe2-stone-select poe2-native-stone-select' });
    state.ui.skillStoneSelect.multiple = true;
    state.ui.skillStoneSelect.size = 8;
    state.ui.skillStoneVisualList = createElement('div', {
      className: 'poe2-stone-choice-list',
      role: 'listbox',
      ariaMultiselectable: 'true',
    });
    state.ui.skillStoneVisualList.setAttribute('role', 'listbox');
    state.ui.skillStoneVisualList.setAttribute('aria-multiselectable', 'true');
    const skillStoneSelectShell = createElement('div', {
      className: 'poe2-stone-select-shell',
      children: [state.ui.skillStoneSelect, state.ui.skillStoneVisualList],
    });
    state.ui.skillStoneSummary = createElement('div', {
      className: 'poe2-summary',
      textContent: '尚未加载技能石',
    });

    const refreshButton = createButton('加载技能石', () => runTask('加载技能石', refreshSkillStoneList));
    refreshButton.classList.add('poe2-success-button');
    const selectAllButton = createButton('全选', selectAllSkillStones);
    const selectAllExceptReservationButton = createButton('', selectAllSkillStonesExceptReservation);
    selectAllExceptReservationButton.append(
      document.createTextNode('全选'),
      createElement('span', { className: 'poe2-button-small-text', textContent: '(除清晰精准活力)' }),
    );
    const clearButton = createButton('清空选择', clearSkillStoneSelection);
    const upgradeSelectedButton = createButton('升级选中技能石', () => runTask('升级选中技能石', upgradeSelectedSkillStonesToHighest));
    const applyPrismButton = createButton('使用宝石匠的棱镜', () => runTask('技能石棱镜', applyGemcutterPrismsToSelectedStones));
    const adjustPracticeButton = createButton('智能练技能', () => runTask('智能练技能', adjustPracticeSkillStonePositions));
    const adjustPracticeHelp = createHelpTooltip('智能练技能最佳使用方法', [
      '先点击“加载技能石”，确认列表和可调整孔位已经刷新，再点击“智能练技能”。',
      '智能练技能只根据已加载的技能石信息执行镶嵌和取下，不会购买、升级、提升品质或腐化技能石。',
      '插件只会使用安全孔位：没有和正在使用的技能在同一组连接里，也不在特殊装备上的孔。',
      '想最大化练技能孔位，尽量把战斗用的主动技能和辅助放在少数连接组里，让其它连接组保持空闲。',
      '如果空孔被提示“和正在使用的技能在同一组连接里”，可以用工艺“连接”或“取消连接”调整孔位分组。',
      '调整连接后重新点击“加载技能石”，让插件读取最新孔位和连接关系。',
      '背包里准备好对应颜色的未满级技能石；白孔可以放任意颜色，普通颜色孔只能放匹配颜色。',
    ]);
    const corruptButton = createButton('使用瓦尔宝珠', () => runTask('使用瓦尔宝珠', corruptSelectedSkillStones));
    const destroyButton = createButton('丢弃选中技能石', () => runTask('丢弃技能石', destroySelectedSkillStones));
    upgradeSelectedButton.classList.add('poe2-success-button');
    applyPrismButton.classList.add('poe2-success-button');
    adjustPracticeButton.classList.add('poe2-success-button');
    corruptButton.classList.add('poe2-warning-button');
    destroyButton.classList.add('poe2-stop');
    state.ui.stopButtons = state.ui.stopButtons || {};
    state.ui.stopButtons.skillStone = createStopTaskButton();
    state.ui.adjustPracticeSkillButton = adjustPracticeButton;
    state.ui.skillStoneActionButtons = [
      selectAllButton,
      selectAllExceptReservationButton,
      clearButton,
      upgradeSelectedButton,
      applyPrismButton,
      adjustPracticeButton,
      destroyButton,
      corruptButton,
    ];
    state.ui.taskButtons?.push(refreshButton, upgradeSelectedButton, applyPrismButton, adjustPracticeButton, corruptButton, destroyButton);
    updateSkillStoneActionButtonState();

    return createElement('div', {
      className: 'poe2-section',
      children: [
        createElement('div', { className: 'poe2-section-title', textContent: '技能石' }),
        createElement('div', {
          className: 'poe2-field',
          children: [
            createElement('span', { textContent: '选择技能石（点击勾选多选）' }),
            skillStoneSelectShell,
          ],
        }),
        state.ui.skillStoneSummary,
        createElement('div', {
          className: 'poe2-actions poe2-affix-actions',
          children: [
            selectAllButton,
            selectAllExceptReservationButton,
            clearButton,
            upgradeSelectedButton,
            applyPrismButton,
            refreshButton,
            destroyButton,
            corruptButton,
            state.ui.stopButtons.skillStone,
            adjustPracticeButton,
            adjustPracticeHelp,
          ],
        }),
      ],
    });
  };

  /**
   * createTabButton 创建主面板顶部的 Tab 按钮。
   * @param {string} tabId Tab 标识。
   * @param {string} label Tab 显示名称。
   * @returns {HTMLButtonElement} Tab 按钮。
   */
  const createTabButton = (tabId, label) => {
    const tabButton = createElement('button', {
      className: 'poe2-tab-button',
      textContent: label,
      onClick: () => switchMainTab(tabId),
    });
    tabButton.dataset.tabId = tabId;
    return tabButton;
  };

  /**
   * createTabPane 创建一个可切换的 Tab 内容区。
   * @param {string} tabId Tab 标识。
   * @param {Array<HTMLElement>} children 内容节点。
   * @returns {HTMLElement} Tab 内容区。
   */
  const createTabPane = (tabId, children) => {
    const tabPane = createElement('div', {
      className: `poe2-tab-pane poe2-tab-pane-${tabId}`,
      children,
    });
    tabPane.dataset.tabId = tabId;
    return tabPane;
  };

  /**
   * createCraftSubTabs 创建打造装备页内部的二级 Tab。
   * @param {Array<object>} tabDefinitions 二级 Tab 定义。
   * @param {Function} onSwitch 切换后的回调，用于联动子 Tab 外部区域。
   * @returns {HTMLElement} 二级 Tab 容器。
   */
  const createCraftSubTabs = (tabDefinitions, onSwitch = null) => {
    const subTabButtons = tabDefinitions.map((tab, tabIndex) => {
      const button = createElement('button', {
        className: `poe2-subtab-button${tabIndex === 0 ? ' active' : ''}`,
        textContent: tab.label,
      });
      button.dataset.tabId = tab.id;
      return button;
    });
    const subTabPanes = tabDefinitions.map((tab, tabIndex) => {
      const pane = createElement('div', {
        className: 'poe2-subtab-pane',
        children: tab.children,
      });
      pane.dataset.tabId = tab.id;
      pane.hidden = tabIndex !== 0;
      return pane;
    });
    const switchCraftSubTab = (tabId) => {
      state.ui.activeCraftSubTabId = tabId;
      for (const button of subTabButtons) {
        button.classList.toggle('active', button.dataset.tabId === tabId);
      }
      for (const pane of subTabPanes) {
        pane.hidden = pane.dataset.tabId !== tabId;
      }
      if (typeof onSwitch === 'function') onSwitch(tabId);
    };
    state.ui.switchCraftSubTab = switchCraftSubTab;
    for (const button of subTabButtons) {
      button.addEventListener('click', () => switchCraftSubTab(button.dataset.tabId));
    }
    return createElement('div', {
      className: 'poe2-subtabs',
      children: [
        createElement('div', { className: 'poe2-subtab-list', children: subTabButtons }),
        createElement('div', { className: 'poe2-subtab-content', children: subTabPanes }),
      ],
    });
  };

  /**
   * switchMainTab 切换主面板当前显示的 Tab。
   * @param {string} tabId 目标 Tab 标识。
   */
  const switchMainTab = (tabId) => {
    state.ui.activeTabId = tabId;
    for (const button of state.ui.tabButtons || []) {
      button.classList.toggle('active', button.dataset.tabId === tabId);
    }
    for (const pane of state.ui.tabPanes || []) {
      pane.hidden = pane.dataset.tabId !== tabId;
    }
  };

  /**
   * createMainTabs 组装主面板的一级 Tab。
   * @param {object} sections 已创建好的功能分区。
   * @returns {HTMLElement} Tab 容器。
   */
  const createMainTabs = (sections) => {
    const tabDefinitions = [
      {
        id: 'craft',
        label: '打造装备',
        children: [
          sections.commonSection,
          sections.craftPlanSection,
          sections.actionSection,
        ],
      },
      {
        id: 'skillStones',
        label: '技能石',
        children: [sections.skillStoneSection],
      },
      {
        id: 'mail',
        label: '发送邮件',
        children: [sections.mailSection],
      },
      {
        id: 'analysis',
        label: '数据分析',
        children: [
          sections.battleAnalysisSection,
          sections.skillTreeTransferSection,
          sections.rankAnalysisSection,
        ],
      },
      {
        id: 'other',
        label: '其他功能',
        children: [
          sections.systemManagementSection,
          sections.assistantBehaviorSection,
          sections.equipmentUtilitySection,
          sections.safetyLimitSection,
        ],
      },
      {
        id: 'logs',
        label: '查看日志',
        children: [sections.logSection],
      },
    ];
    state.ui.tabButtons = tabDefinitions.map((tab) => createTabButton(tab.id, tab.label));
    state.ui.tabPanes = tabDefinitions.map((tab) => createTabPane(tab.id, tab.children));
    const tabsElement = createElement('div', {
      className: 'poe2-tabs',
      children: [
        createElement('div', {
          className: 'poe2-tab-list',
          children: state.ui.tabButtons,
        }),
        createElement('div', {
          className: 'poe2-tab-content',
          children: state.ui.tabPanes,
        }),
      ],
    });
    switchMainTab('craft');
    return tabsElement;
  };

  /**
   * createAssistantBehaviorSection 创建助手行为控制区。
   * @returns {HTMLElement} 助手行为控制区 DOM。
   */
  const createAssistantBehaviorSection = () => {
    const positionButton = createButton('调整位置', togglePositionAdjustMode);
    state.ui.minimizePauseButton = createButton('', toggleMinimizePauseMode);
    updateMinimizePauseButton();
    return createElement('div', {
      className: 'poe2-section',
      children: [
        createElement('div', { className: 'poe2-section-title', textContent: '助手行为' }),
        createElement('div', {
          className: 'poe2-summary',
          textContent: '调整助手入口位置，并控制最小化时是否暂停自动化执行。',
        }),
        createElement('div', {
          className: 'poe2-actions poe2-affix-actions',
          children: [positionButton, state.ui.minimizePauseButton],
        }),
      ],
    });
  };

  /**
   * createEquipmentUtilitySection 创建装备相关工具区。
   * @returns {HTMLElement} 装备相关工具区 DOM。
   */
  const createEquipmentUtilitySection = () => {
    const openModalButton = createButton('查看破裂装备', () => runTask('查看破裂装备', openFracturedEquipmentModal));
    const destroyTailPagesButton = createButton('丢弃最后一百页', () => runTask('丢弃最后一百页', destroyTailBackpackPages));
    const balanceChanceScouringButton = createButton('平衡机会/重铸', () => runTask('平衡机会/重铸', balanceChanceScouringCurrencies));
    const balanceAltAugButton = createButton('平衡蜕变/增幅/改造', () => runTask('平衡蜕变/增幅/改造', balanceAltAugCurrencies));
    destroyTailPagesButton.classList.add('poe2-stop');
    balanceChanceScouringButton.classList.add('poe2-success-button');
    balanceAltAugButton.classList.add('poe2-success-button');
    state.ui.stopButtons = state.ui.stopButtons || {};
    state.ui.stopButtons.other = createStopTaskButton();
    state.ui.taskButtons?.push(openModalButton, destroyTailPagesButton, balanceChanceScouringButton, balanceAltAugButton);
    return createElement('div', {
      className: 'poe2-section',
      children: [
        createElement('div', {
          className: 'poe2-section-title poe2-title-with-help',
          children: [
            createElement('span', { textContent: '其他功能' }),
            createHelpTooltip('其他功能说明', [
              '查看破裂装备：扫描背包里的破裂装备，方便检查词缀和批量处理。',
              '丢弃最后一百页：背包页数足够时，批量丢弃最后一百页装备，执行前会二次确认。',
              '平衡机会/重铸：按当前库存把部分机会石兑换成重铸石，尽量让机会:重铸接近 1:1。',
              '平衡蜕变/增幅/改造：按当前库存把部分蜕变石兑换成增幅石，再把部分增幅石兑换成改造石，尽量让蜕变:增幅:改造接近 1:4:4。',
              '平衡只使用蜕变兑换增幅、增幅兑换改造、机会兑换重铸。',
            ]),
          ],
        }),
        createElement('div', {
          className: 'poe2-summary',
          textContent: '扫描破裂装备、清理背包尾页，或按当前库存兑换通货到常用比例。',
        }),
        createElement('div', {
          className: 'poe2-actions poe2-affix-actions poe2-utility-actions',
          children: [openModalButton, destroyTailPagesButton, state.ui.stopButtons.other, balanceChanceScouringButton, balanceAltAugButton],
        }),
      ],
    });
  };

  /**
   * createBattleAnalysisSection 创建其他功能里的轻量战斗分析区。
   * @returns {HTMLElement} 战斗分析区 DOM。
   */
  const createBattleAnalysisSection = () => {
    const startButton = createButton('开始战斗分析', () => {
      startBattleAnalysis();
    });
    const stopButton = createButton('停止战斗分析', stopBattleAnalysis);
    stopButton.classList.add('poe2-stop');
    const resetButton = createButton('重置统计', resetBattleAnalysis);
    state.ui.battleAnalysisSummary = createElement('div', {
      className: 'poe2-summary poe2-battle-summary',
    });
    renderBattleAnalysisSummary();
    return createElement('div', {
      className: 'poe2-section',
      children: [
        createElement('div', {
          className: 'poe2-section-title poe2-title-with-help',
          children: [
            createElement('span', { textContent: '战斗分析' }),
            createHelpTooltip('战斗分析说明', [
              '战斗分析会连接当前页面的战斗 WebSocket，读取 battle_init、battle_event 和 monster_drop 数据。',
              '当前 URL 为 /watch/battle/{角色ID} 时，会按网页观战模式连接 /api/battle/ws/watch/{角色ID} 并统计该观战用户的战斗数据。',
              '统计内容包括战斗时间、怪物数量、战斗事件、奖励经验、奖励通货、每分钟怪物数量等。',
              '时间倍率用服务器战斗时间和本地真实时间对比，用来观察是否出现时间推进异常。',
              '开始后会忽略初始同步补推帧，避免把历史战斗数据当成当前速度。',
              '停止只会关闭分析连接，不会影响游戏战斗本身。',
            ]),
          ],
        }),
        createElement('div', {
          className: 'poe2-summary',
          textContent: '连接战斗数据，简单统计每分钟怪物数量，并根据本地真实时间判断是否出现时间膨胀。',
        }),
        createElement('div', {
          className: 'poe2-actions poe2-affix-actions',
          children: [startButton, stopButton, resetButton],
        }),
        state.ui.battleAnalysisSummary,
      ],
    });
  };

  /**
   * createSkillTreeTransferSection 创建天赋导入导出区。
   * 导入只暂存并刷新天赋页面，不会直接调用保存接口。
   */
  const createSkillTreeTransferSection = () => {
    state.ui.skillTreeTransferText = createElement('textarea', {
      className: 'poe2-input poe2-textarea',
      placeholder: '点击导出生成字符串，或粘贴本插件生成的 T1…T7 天赋字符串。',
    });
    state.ui.skillTreeTransferText.rows = 4;
    state.ui.skillTreeTransferText.spellcheck = false;
    state.ui.skillTreeTransferSummary = createElement('div', {
      className: 'poe2-summary',
      textContent: '导出读取服务器当前已保存的天赋；导入必须位于网页“天赋”页面，并只修改页面预览。',
    });
    const exportButton = createButton('导出已保存天赋', () => runTask('导出天赋', exportSkillTree));
    exportButton.classList.add('poe2-success-button');
    const copyButton = createButton('复制字符串', async () => {
      try {
        await copyTextToClipboard(state.ui.skillTreeTransferText.value.trim());
        addLog('天赋字符串已复制到剪贴板。', 'compact');
      } catch (error) {
        addLog(`复制天赋字符串失败：${error.message}`, 'error');
      }
    });
    const importButton = createButton('导入到当前天赋页', () => runTask('导入天赋', importSkillTreeToPage));
    const clearButton = createButton('清空', () => {
      state.ui.skillTreeTransferText.value = '';
    });
    state.ui.taskButtons?.push(exportButton, importButton);
    return createElement('div', {
      className: 'poe2-section',
      children: [
        createElement('div', {
          className: 'poe2-section-title poe2-title-with-help',
          children: [
            createElement('span', { textContent: '天赋导入/导出' }),
            createHelpTooltip('天赋导入/导出说明', [
              '新格式用 T 加一位职业编号开头；职业起点不重复保存，节点按当前版本字典索引压缩，因此仅适用于同一天赋树版本。',
              '导出成功后会写入下方文本框，并在浏览器允许时自动复制到剪贴板。',
              '导入必须处于 /skilltree 天赋页面，会先检查职业、节点连通性、专精选项和可用天赋点。',
              '导入只替换页面预览并刷新页面，不会直接调用 POST /api/skilltree。',
              '确认页面显示无误后，需要由用户点击网页原生“保存”按钮提交。',
            ]),
          ],
        }),
        state.ui.skillTreeTransferSummary,
        createLabeledControl('天赋字符串', state.ui.skillTreeTransferText, 'poe2-wide'),
        createElement('div', {
          className: 'poe2-actions poe2-affix-actions',
          children: [exportButton, copyButton, importButton, clearButton],
        }),
      ],
    });
  };

  /**
   * createRankAnalysisSection 创建排行榜分析区。
   * @returns {HTMLElement} 排行榜分析区 DOM。
   */
  const createRankAnalysisSection = () => {
    const loadButton = createButton('加载排行榜', () => runTask('加载排行榜', loadRankPlayers));
    loadButton.classList.add('poe2-success-button');
    const analyzeButton = createButton('分析选中玩家', () => runTask('分析选中玩家', analyzeSelectedRankPlayer));
    const copyButton = createButton('复制玩家战斗信息', () => runTask('复制玩家战斗信息', copySelectedRankBattleInfo));
    const batchButton = createButton('分析等级以上玩家', () => runTask('分析等级以上玩家', analyzeRankPlayersAboveLevel));
    state.ui.rankLevelThresholdInput = createElement('input', {
      className: 'poe2-input',
      type: 'number',
      min: '1',
      max: '200',
      value: '100',
    });
    state.ui.rankPlayerSelect = createSelect([], '');
    state.ui.rankPlayerSelect.addEventListener('change', () => {
      state.rankAnalysis.selectedPlayerId = state.ui.rankPlayerSelect.value;
    });
    state.ui.rankAnalysisSummary = createElement('div', {
      className: 'poe2-summary',
      textContent: '加载排行榜后，可以查看单个玩家技能连接，或统计等级段玩家的技能和装备占比。',
    });
    state.ui.rankAnalysisReport = createElement('pre', {
      className: 'poe2-rank-output',
      textContent: '加载排行榜后，选择玩家并点击“分析选中玩家”。',
    });
    state.ui.rankPlayerReport = state.ui.rankAnalysisReport;
    state.ui.rankBatchReport = state.ui.rankAnalysisReport;
    state.ui.rankAnalysisActionButtons = [analyzeButton, copyButton, batchButton];
    state.ui.taskButtons?.push(loadButton, analyzeButton, copyButton, batchButton);
    updateRankAnalysisActionButtonState();
    return createElement('div', {
      className: 'poe2-section',
      children: [
        createElement('div', { className: 'poe2-section-title', textContent: '排行榜分析' }),
        state.ui.rankAnalysisSummary,
        createElement('div', {
          className: 'poe2-grid poe2-rank-grid',
          children: [
            createLabeledControl('排行榜玩家', state.ui.rankPlayerSelect),
            createLabeledControl('等级以上', state.ui.rankLevelThresholdInput),
          ],
        }),
        createElement('div', {
          className: 'poe2-actions poe2-affix-actions',
          children: [loadButton, analyzeButton, copyButton, batchButton],
        }),
        createElement('div', { className: 'poe2-muted poe2-rank-title', textContent: '分析结果' }),
        state.ui.rankAnalysisReport,
      ],
    });
  };

  /**
   * createSystemManagementSection 创建系统管理区，集中放置助手级别的偏好设置。
   * @returns {HTMLElement} 系统管理区 DOM。
   */
  const createSystemManagementSection = () => {
    state.ui.themeModeSelect = createSelect([
      { value: THEME_MODES.auto, label: '跟随网页' },
      { value: THEME_MODES.light, label: '浅色模式' },
      { value: THEME_MODES.dark, label: '深色模式' },
    ], normalizeThemeMode(state.themeMode));
    state.ui.themeModeSelect.addEventListener('change', () => {
      setAssistantThemeMode(state.ui.themeModeSelect.value);
    });
    state.ui.speedSelect = createSelect(Object.entries(SPEED_OPTIONS).map(([value, option]) => ({
      value,
      label: option.label,
    })), normalizeSpeedMode(state.speedMode));
    state.ui.speedSelect.addEventListener('change', () => {
      setSpeedMode(state.ui.speedSelect.value);
    });
    state.ui.logModeSelect = createSelect(Object.entries(LOG_MODES).map(([value, option]) => ({
      value,
      label: option.label,
    })), normalizeLogMode(state.logMode));
    state.ui.logModeSelect.addEventListener('change', () => {
      setLogMode(state.ui.logModeSelect.value);
    });
    // state.ui.refreshEquipmentAfterCraftInput = createElement('input', {
    //   type: 'checkbox',
    //   checked: state.refreshEquipmentAfterCraft,
    //   onChange: () => {
    //     state.refreshEquipmentAfterCraft = Boolean(state.ui.refreshEquipmentAfterCraftInput.checked);
    //     addLog(`每步做装后重新查询装备信息已${state.refreshEquipmentAfterCraft ? '开启' : '关闭'}。`, 'compact');
    //   },
    // });
    return createElement('div', {
      className: 'poe2-section',
      children: [
        createElement('div', { className: 'poe2-section-title', textContent: '系统管理' }),
        createElement('div', {
          className: 'poe2-grid poe2-system-grid',
          children: [
            createLabeledControl('UI 风格', state.ui.themeModeSelect),
            createLabeledControl(createHelpedLabel('自动化速度', '速度档位说明', [
              '速度只控制自动化步骤之间额外等待多久，不决定日志多少。',
              '逐步：每步后等待 1.5 秒，适合观察每一步。',
              '普通：每步后等待 0.5 秒，适合日常使用。',
              '快速：每步后等待 0.05 秒，接近旧版快速行为。',
              '立即：不额外等待，只受接口和页面响应速度影响。',
            ]), state.ui.speedSelect),
            createLabeledControl(createHelpedLabel('日志等级', '日志等级说明', [
              '日志等级只控制显示多少信息，不改变自动化执行方式。',
              '逐条：接口调用、判断结果、步骤细节都会显示，适合排查问题。',
              '详细：每个步骤至少说明一次，隐藏过细的接口流水。',
              '主要：重点显示会消耗通货或工艺的动作。',
              '精简：只显示任务开始、结束、错误、成功，以及每 200 个通货的消耗和步骤统计。',
              '较详细的等级会包含较精简等级的信息。',
            ]), state.ui.logModeSelect),
            // createLabeledControl('每步做装后重新查询装备', state.ui.refreshEquipmentAfterCraftInput),
          ],
        }),
      ],
    });
  };

  /**
   * createSafetyLimitSection 创建自动化安全上限配置区。
   * @returns {HTMLElement} 安全上限配置区 DOM。
   */
  const createSafetyLimitSection = () => {
    state.ui.stepActionSafetyLimitInput = createElement('input', {
      className: 'poe2-input',
      type: 'number',
      min: '1',
      max: '100000',
      value: String(state.stepActionSafetyLimit),
    });
    state.ui.stepActionSafetyLimitInput.addEventListener('change', updateStepActionSafetyLimit);
    state.ui.customCraftStepSafetyLimitInput = createElement('input', {
      className: 'poe2-input',
      type: 'number',
      min: '1',
      max: '100000',
      value: String(state.customCraftStepSafetyLimit),
    });
    state.ui.customCraftStepSafetyLimitInput.addEventListener('change', updateCustomCraftStepSafetyLimit);
    state.ui.customCraftCurrencyLimitInput = createElement('input', {
      className: 'poe2-input',
      type: 'number',
      min: '1',
      max: '1000000',
      value: String(state.customCraftCurrencyLimit),
    });
    state.ui.customCraftCurrencyLimitInput.addEventListener('change', updateCustomCraftCurrencyLimit);
    return createElement('div', {
      className: 'poe2-section',
      children: [
        createElement('div', {
          className: 'poe2-section-title poe2-title-with-help',
          children: [
            createElement('span', { textContent: '安全上限' }),
            createHelpTooltip('安全上限说明', [
              '安全上限用于阻止自动化在明显无法达成目标时无限消耗资源。',
              '经典动作上限：经典打造、孔洞操作、自动暗金等对同一装备连续尝试的最大次数。',
              '自定义步骤上限：自定义打造里同一逻辑层级的判断条件反复执行过多次仍没有进入下一层时，会停止当前任务。',
              '自定义通货上限：点击一次自定义打造后，整次任务最多允许消耗的通货总数，达到后立刻停止。',
              '这些限制不会改变步骤逻辑，只是在异常循环或消耗过大时保护任务。',
            ]),
          ],
        }),
        createElement('div', {
          className: 'poe2-summary',
          textContent: '自定义打造会限制同一逻辑层级判断条件执行次数和整件装备总步骤次数；经典打造会限制同一装备上的连续尝试次数。',
        }),
        createElement('div', {
          className: 'poe2-grid poe2-safety-grid',
          children: [
            createLabeledControl('经典动作上限', state.ui.stepActionSafetyLimitInput),
            createLabeledControl('自定义步骤上限', state.ui.customCraftStepSafetyLimitInput),
            createLabeledControl('自定义通货上限', state.ui.customCraftCurrencyLimitInput),
          ],
        }),
      ],
    });
  };

  /**
   * createHelpTooltip 创建通用问号悬浮说明，保持各处帮助提示的样式一致。
   * @param {string} title 提示标题。
   * @param {Array<string>} lines 提示正文，每个字符串单独一行。
   * @returns {HTMLElement} 问号提示节点。
   */
  const createHelpTooltip = (title, lines) => createElement('div', {
    className: 'poe2-help',
    children: [
      createElement('button', {
        className: 'poe2-help-button',
        type: 'button',
        textContent: '?',
      }),
      createElement('div', {
        className: 'poe2-help-panel',
        children: [
          createElement('div', { className: 'poe2-help-title', textContent: title }),
          ...lines.map((line) => createElement('div', { textContent: line })),
        ],
      }),
    ],
  });

  /**
   * createHelpedLabel 创建带问号说明的表单标签。
   * @param {string} labelText 标签文本。
   * @param {string} helpTitle 说明标题。
   * @param {Array<string>} helpLines 说明正文。
   * @returns {HTMLElement} 标签节点。
   */
  const createHelpedLabel = (labelText, helpTitle, helpLines) => createElement('span', {
    className: 'poe2-label-with-help',
    children: [
      createElement('span', { textContent: labelText }),
      createHelpTooltip(helpTitle, helpLines),
    ],
  });

  /**
   * createAffixHelpTooltip 创建词缀条件构建器的悬浮说明。
   * 说明条件组与条件的逻辑关系，并给出多词缀目标的选择例子。
   * @returns {HTMLElement} 问号提示节点。
   */
  const createAffixHelpTooltip = () => createElement('div', {
    className: 'poe2-help',
    children: [
      createElement('button', {
        className: 'poe2-help-button',
        type: 'button',
        textContent: '?',
      }),
      createElement('div', {
        className: 'poe2-help-panel',
        children: [
          createElement('div', { className: 'poe2-help-title', textContent: '条件组' }),
          createElement('div', { textContent: '一个判断步骤可以有多个条件组。条件组之间是“或”：任意一个条件组达标，这个判断步骤就成立。' }),
          createElement('div', { textContent: '每个条件组有自己的“本组命中数”。例如组里有 3 条条件，命中数填 2，就表示任意 2 条满足即可。' }),
          createElement('div', { textContent: '命中数为 1 时，只要组内任意一条满足；命中数等于条件数量时，组内所有条件都必须满足。' }),
          createElement('div', { className: 'poe2-help-title', textContent: '条件类型' }),
          createElement('div', { textContent: '词缀条件用于判断装备当前是否拥有指定词缀。选择词缀时会同时保存词缀名和所属词缀类型，避免同名词缀混淆。' }),
          createElement('div', { textContent: '特殊条件用于判断装备状态，例如稀有度、前后缀数量、是否有空词缀、是否腐化、是否已有工艺词缀或后缀大师之。' }),
          createElement('div', { textContent: '词缀Roll值判断用于看装备数值是不是够高。可以判断武器伤害，也可以判断前缀、后缀、全部词缀或工艺词缀的平均/最低 Roll 百分比。' }),
          createElement('div', { textContent: '自定义打造里只有“判断条件”步骤会读取这些条件；普通通货、工艺和智能操作不会读取本步骤条件组。' }),
          createElement('div', { className: 'poe2-help-title', textContent: '例子' }),
          createElement('div', { textContent: '如果目标是“命中 A 或者同时命中 B+C”，就建两个条件组。' }),
          createElement('div', { textContent: '条件组 1 放 A，命中数填 1。条件组 2 放 B 和 C，命中数填 2。' }),
        ],
      }),
    ],
  });

  const createAffixRollHelpTooltip = () => createHelpTooltip('Roll 值判断说明', [
    'Roll 可以理解为“这条数值在本档词缀里算低还是算高”。越接近上限，Roll 百分比越高。',
    '武器伤害类条件按装备面板上的伤害数值判断，目标值直接填想要的伤害数值。',
    '前缀、后缀、全部词缀和工艺词缀的 Roll 条件按百分比判断，目标值填 0 到 100 的整数。',
    '例如某条词缀范围是 34 到 47，当前是 38，大约就是 31% Roll；当前接近 47 时就接近 100%。',
    '基底的显性/前缀/后缀幅度加成和催化剂品质会先从实际数值中还原，再按词缀字典的原始范围计算 Roll。',
    '“平均 Roll”会综合所选范围内所有可计算词缀；“最低 Roll”只看其中最低的那一条。',
    '一条词缀如果有多段数值，每段都会参与计算。某段特别低时，最低 Roll 也会被拉低。',
    '如果只想要整体不错，用平均 Roll；如果不想接受任何一条低数值，用最低 Roll。',
  ]);

  const createAffixItemLevelHelpTooltip = () => createHelpTooltip('词缀物品等级说明', [
    '不同的词缀需要的物品等级不同。',
    '较低的物品等级无法洗出强力的词缀。',
    '具体词缀需求的等级可以参考流亡编年史或者官方 wiki。',
    '一般来说 86+ 的物品等级可以洗出所有词缀。',
    '魔法装备通常最多一条前缀和一条后缀，稀有装备通常最多三条前缀和三条后缀。',
    '如果装备返回了“允许的前缀/后缀”这类基底词缀，空前缀、空后缀和空词缀判断会使用修正后的上限。',
    '同一个词缀类型中的词缀，在每件物品上最多出现一条。',
    '也就是说，不可能有一件物品，前缀是 +90 最大生命和 +80 最大生命。',
    'fpoe 里词缀不受权重控制影响，也就是说所有能出现的词缀都是等概率的。',
  ]);

  /**
   * createFracturedEquipmentModal 创建破裂装备模态框。
   * @returns {HTMLElement} 模态框 DOM。
   */
  const createFracturedEquipmentModal = () => {
    state.ui.fracturedModalSummary = createElement('div', {
      className: 'poe2-summary',
      textContent: '当前背包破裂装备：0 件',
    });
    state.ui.fracturedEquipmentList = createElement('div', { className: 'poe2-fractured-list' });
    const destroyAllButton = createButton('全部丢弃', () => runTask('丢弃破裂装备', destroyAllFracturedEquipments));
    destroyAllButton.classList.add('poe2-stop');
    const destroyNonTierOneButton = createButton('丢弃非 T1', () => runTask('丢弃非 T1 破裂', destroyNonTierOneFracturedEquipments));
    destroyNonTierOneButton.classList.add('poe2-stop');
    const refreshButton = createButton('重新扫描', () => runTask('查看破裂装备', openFracturedEquipmentModal));
    const closeButton = createButton('关闭', closeFracturedEquipmentModal);
    state.ui.stopButtons = state.ui.stopButtons || {};
    state.ui.stopButtons.fractured = createStopTaskButton();
    state.ui.taskButtons?.push(destroyAllButton, destroyNonTierOneButton, refreshButton);

    const modalElement = createElement('div', {
      className: 'poe2-modal',
      children: [
        createElement('div', {
          className: 'poe2-modal-dialog',
          children: [
            createElement('div', {
              className: 'poe2-modal-header',
              children: [
                createElement('div', { className: 'poe2-modal-title', textContent: '背包破裂装备' }),
                createElement('div', {
                  className: 'poe2-actions',
                  children: [refreshButton, state.ui.stopButtons.fractured, destroyNonTierOneButton, destroyAllButton, closeButton],
                }),
              ],
            }),
            createElement('div', {
              className: 'poe2-modal-body',
              children: [state.ui.fracturedModalSummary, state.ui.fracturedEquipmentList],
            }),
          ],
        }),
      ],
    });
    modalElement.hidden = true;
    modalElement.addEventListener('click', (event) => {
      if (event.target === modalElement) closeFracturedEquipmentModal();
    });
    state.ui.fracturedModal = modalElement;
    return modalElement;
  };

  /**
   * installStyles 注入脚本 UI 所需样式。
   */
  const installStyles = () => {
    GM_addStyle(`
      .poe2-toggle{position:fixed;right:18px;bottom:22px;z-index:99999;padding:8px 12px;border:0;border-radius:6px;background:#2f6fed;color:#fff;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer}
      .poe2-toggle-positioning{cursor:move;outline:2px solid #f59e0b;outline-offset:2px}
      .poe2-panel{position:fixed;left:20px;top:80px;z-index:99998;width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 40px);overflow:auto;background:rgba(250,250,250,.98);color:#1b1f29;border:1px solid rgba(0,0,0,.25);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.28);font-size:13px}
      .poe2-panel[hidden]{display:none}
      .poe2-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#1f2937;color:#fff;cursor:move}
      .poe2-title{font-weight:700}
      .poe2-tabs{display:flex;flex-direction:column;min-height:0}
      .poe2-tab-list{display:grid;grid-template-columns:repeat(6,1fr);gap:0;border-bottom:1px solid #cfd6e2;background:#eef2f7}
      .poe2-tab-button{height:38px;border:0;border-right:1px solid #cfd6e2;background:#eef2f7;color:#374151;font-size:13px;cursor:pointer}
      .poe2-tab-button:last-child{border-right:0}
      .poe2-tab-button.active{background:#fff;color:#1d4ed8;font-weight:700;box-shadow:inset 0 -2px 0 #315fba}
      .poe2-tab-pane[hidden]{display:none}
      .poe2-tab-pane-craft{max-height:calc(80vh - 32px);overflow:auto}
      .poe2-subtabs{display:flex;flex-direction:column;gap:10px}
      .poe2-subtab-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(86px,1fr));gap:6px}
      .poe2-subtab-button{height:30px;border:1px solid #b8c0cc;border-radius:5px;background:#f8fafc;color:#374151;cursor:pointer}
      .poe2-subtab-button.active{border-color:#315fba;background:#eaf1ff;color:#1d4ed8;font-weight:700}
      .poe2-subtab-pane[hidden]{display:none}
      .poe2-subtab-pane{display:grid;gap:10px}
      .poe2-section{padding:10px 12px;border-top:1px solid #d6dbe3}
      .poe2-tab-pane>.poe2-section:first-child{border-top:0}
      .poe2-section-title{font-weight:700;margin-bottom:8px;color:#111827}
      .poe2-title-with-help{display:flex;align-items:center;gap:6px}
      .poe2-section-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .poe2-label-with-help{display:inline-flex;align-items:center;gap:6px}
      .poe2-help{position:relative;display:inline-flex;align-items:center}
      .poe2-help-button{width:22px;height:22px;border:1px solid #9ca3af;border-radius:50%;background:#fff;color:#374151;font-weight:700;line-height:20px;cursor:help}
      .poe2-help-panel{display:none;position:fixed;left:50%;top:50%;z-index:100001;width:min(420px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;transform:translate(-50%,-50%);padding:10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#111827;box-shadow:0 10px 28px rgba(15,23,42,.22);font-weight:400;font-size:12px;line-height:1.55}
      .poe2-help:hover .poe2-help-panel,.poe2-help:focus-within .poe2-help-panel{display:grid;gap:6px}
      .poe2-help-title{font-weight:700;color:#1d4ed8}
      .poe2-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .poe2-continuous-editor-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;align-items:start}
      .poe2-continuous-column{display:flex;flex-direction:column;gap:8px;min-width:0}
      .poe2-craft-common-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
      .poe2-system-grid,.poe2-safety-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
      .poe2-system-grid .poe2-field span,.poe2-safety-grid .poe2-field span{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .poe2-socket-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
      .poe2-affix-picker-grid{grid-template-columns:minmax(0,1fr) minmax(72px,.5fr) minmax(0,1.5fr);align-items:end}
      .poe2-affix-tier-field{grid-column:1 / -1}
      .poe2-actions.poe2-affix-picker-actions{grid-column:1 / -1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-self:end;margin-top:0;width:100%}
      .poe2-actions.poe2-affix-picker-actions .poe2-button{width:100%;white-space:nowrap}
      .poe2-field{display:flex;flex-direction:column;gap:4px;min-width:0}
      .poe2-field span{font-size:12px;color:#4b5563}
      .poe2-inline-check-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px}
      .poe2-inline-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--poe2-muted);white-space:nowrap}
      .poe2-inline-check input{width:16px;height:16px;margin:0;accent-color:#2563eb}
      .poe2-inline-check input:disabled{opacity:.85;cursor:not-allowed}
      .poe2-advanced-step-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;align-items:end}
      .poe2-advanced-batch-row{display:grid;grid-template-columns:repeat(3,minmax(52px,.4fr)) minmax(110px,1fr) minmax(140px,1.35fr);gap:8px;align-items:end}
      .poe2-plan-toggle-field .poe2-button{width:100%}
      .poe2-input{box-sizing:border-box;width:100%;height:30px;border:1px solid #b8c0cc;border-radius:5px;padding:4px 7px;background:#fff;color:#111827}
      select.poe2-input[multiple]{height:96px}
      .poe2-native-stone-select{display:none!important}
      .poe2-stone-select-shell{min-width:0;width:100%}
      .poe2-stone-choice-list{box-sizing:border-box;width:100%;height:240px;overflow:auto;overflow-x:auto;border:1px solid #b8c0cc;border-radius:5px;background:#fff;color:#111827;padding:4px;-webkit-overflow-scrolling:touch}
      .poe2-stone-choice{display:flex;align-items:flex-start;gap:8px;min-width:100%;box-sizing:border-box;padding:6px 7px;border-radius:5px;line-height:1.35;cursor:pointer}
      .poe2-stone-choice:hover{background:#eef2ff}
      .poe2-stone-choice.selected{background:#eaf1ff;color:#1d4ed8;font-weight:700}
      .poe2-stone-choice input{flex:0 0 auto;width:16px;height:16px;margin:1px 0 0;accent-color:#2563eb}
      .poe2-stone-choice-text{min-width:0;white-space:normal;overflow-wrap:anywhere;word-break:break-word}
      .poe2-stone-select{height:240px!important}
      .poe2-summary{font-size:12px;color:#4b5563;margin:8px 0 0}
      .poe2-battle-summary{padding:8px;border:1px solid #d6dbe3;border-radius:6px;background:#f9fafb;line-height:1.5;word-break:break-word}
      .poe2-rank-grid{margin-top:8px}
      .poe2-rank-title{margin-top:10px;font-size:12px;font-weight:700}
      .poe2-rank-output{box-sizing:border-box;width:100%;max-height:180px;overflow:auto;margin:6px 0 0;padding:8px;border:1px solid #d6dbe3;border-radius:6px;background:#f9fafb;color:#374151;font-family:Consolas,monospace;font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
      .poe2-rank-output a{color:#2563eb;text-decoration:underline;text-underline-offset:2px}
      .poe2-rank-output a:hover{color:#1d4ed8}
      .poe2-textarea{height:54px;resize:vertical}
      .poe2-share-code{height:72px;font-family:Consolas,monospace;font-size:11px;line-height:1.35}
      .poe2-range{box-sizing:border-box;width:100%;height:30px;accent-color:#315fba}
      .poe2-range-row{display:grid;grid-template-columns:minmax(0,1fr) 48px;align-items:center;gap:8px}
      .poe2-range-value{text-align:right;font-weight:700;color:#111827}
      .poe2-mail-field-stack{display:grid;gap:6px}
      .poe2-mail-receiver-box{position:relative}
      .poe2-mail-suggestions{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:100002;display:grid;gap:2px;max-height:180px;overflow:auto;padding:4px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;box-shadow:0 10px 28px rgba(15,23,42,.22)}
      .poe2-mail-suggestions[hidden]{display:none}
      .poe2-mail-suggestion{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;border:0;border-radius:4px;background:transparent;color:#111827;padding:6px 8px;text-align:left;cursor:pointer}
      .poe2-mail-suggestion:hover{background:#eaf1ff;color:#1d4ed8}
      .poe2-mail-suggestion-level{font-size:11px;color:#6b7280}
      .poe2-mail-recent-list{display:flex;flex-wrap:wrap;gap:6px;min-height:0}
      .poe2-mail-recent-button{border:1px solid #a7b3c4;border-radius:999px;background:#fff;color:#374151;padding:3px 8px;font-size:12px;line-height:16px;cursor:pointer}
      .poe2-mail-recent-button:hover{border-color:#315fba;color:#1d4ed8;background:#eaf1ff}
      .poe2-mail-currency-preview{min-height:36px;padding:8px;border:1px solid #d6dbe3;border-radius:6px;background:#f9fafb;color:#374151;font-size:12px;line-height:1.5}
      .poe2-mail-preview-list{display:flex;flex-wrap:wrap;gap:6px}
      .poe2-mail-preview-item{border:1px solid #d6dbe3;border-radius:999px;background:#fff;color:#374151;padding:3px 8px;line-height:16px}
      .poe2-actions{display:flex;flex-wrap:wrap;gap:8px}
      .poe2-affix-group-list{display:grid;gap:8px;margin-top:8px}
      .poe2-affix-group-card{box-sizing:border-box;border:1px solid #d6dbe3;border-radius:6px;padding:8px;background:#f9fafb;cursor:pointer}
      .poe2-affix-group-card.active{border:2px solid #16a34a;font-weight:700}
      .poe2-affix-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
      .poe2-affix-group-head strong{font-size:12px;color:#111827}
      .poe2-affix-group-head .poe2-button{height:24px;padding:2px 8px;font-size:12px}
      .poe2-affix-min-field{display:inline-flex;align-items:center;gap:6px;margin-left:auto;font-size:12px;color:#4b5563;white-space:nowrap}
      .poe2-affix-min-input{width:64px;height:26px;padding:3px 6px}
      .poe2-affix-chip-list{display:flex;flex-wrap:wrap;gap:6px;min-height:24px}
      .poe2-affix-chip{border:1px solid #a7b3c4;border-radius:999px;background:#fff;color:#111827;padding:3px 8px;font-size:12px;line-height:16px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
      .poe2-affix-chip:hover{border-color:#ef4444;color:#991b1b;background:#fff5f5}
      .poe2-affix-empty{font-size:12px;color:#6b7280;line-height:24px}
      .poe2-affix-actions{margin-top:8px}
      .poe2-utility-actions{display:flex;flex-wrap:wrap;width:auto}
      .poe2-utility-actions .poe2-button{width:auto;white-space:nowrap;line-height:1.2}
      .poe2-continuous-step-list{display:grid;gap:6px;margin-top:8px;max-height:208px;overflow:auto;padding-right:4px}
      .poe2-continuous-step{box-sizing:border-box;border:1px solid #d6dbe3;border-radius:6px;background:#f9fafb;color:#374151;padding:7px 9px;font-size:12px;line-height:1.45;white-space:pre-line;cursor:pointer}
      .poe2-continuous-step.active{border:2px solid #16a34a;background:#ecfdf5;color:#166534;font-weight:700}
      .poe2-wide{grid-column:1 / -1}
      .poe2-button{height:30px;border:1px solid #264a8a;border-radius:5px;background:#315fba;color:#fff;padding:0 10px;cursor:pointer}
      .poe2-button:disabled{opacity:.5;cursor:not-allowed}
      .poe2-button-small-text{font-size:80%;margin-left:2px}
      .poe2-success-button{background:#16a34a;border-color:#15803d}
      .poe2-warning-button{background:#facc15;border-color:#ca8a04;color:#374151}
      .poe2-toggle-active{background:#047857;border-color:#065f46}
      .poe2-stop{background:#b42318;border-color:#8f1d14}
      .poe2-log-list{height:420px;overflow:auto;background:#111827;color:#d1d5db;border-radius:6px;padding:8px;font-family:Consolas,monospace;font-size:12px}
      .poe2-log-row{margin-bottom:4px;white-space:pre-wrap;word-break:break-word}
      .poe2-log-detail{color:#9ca3af}
      .poe2-log-success{color:#86efac}
      .poe2-log-warn{color:#fde68a}
      .poe2-log-error{color:#fca5a5}
      .poe2-modal{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.58)}
      .poe2-modal[hidden]{display:none}
      .poe2-modal-dialog{width:min(860px,calc(100vw - 28px));max-height:calc(100vh - 42px);display:flex;flex-direction:column;background:#f9fafb;color:#111827;border:1px solid rgba(255,255,255,.35);border-radius:8px;box-shadow:0 18px 50px rgba(0,0,0,.42)}
      .poe2-modal-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;background:#1f2937;color:#fff;border-radius:8px 8px 0 0}
      .poe2-modal-title{font-weight:700}
      .poe2-modal-body{padding:12px 14px;overflow:auto}
      .poe2-empty,.poe2-muted{color:#6b7280}
      .poe2-fractured-list{display:flex;flex-direction:column;gap:10px}
      .poe2-fractured-item{border:1px solid #d3d9e3;border-radius:6px;background:#fff;padding:10px}
      .poe2-fractured-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
      .poe2-fractured-name-wrap{position:relative;min-width:0}
      .poe2-fractured-name{font-weight:700;color:#7c2d12}
      .poe2-fractured-meta{font-size:12px;color:#6b7280;text-align:right;word-break:break-all}
      .poe2-fractured-affixes{margin-top:8px;display:flex;flex-direction:column;gap:4px}
      .poe2-fractured-affix{padding:5px 7px;border-left:3px solid #d97706;background:#fff7ed;border-radius:4px;line-height:1.45;word-break:break-word}
      .poe2-fractured-actions{margin-top:8px}
      @media (max-width: 640px){
        .poe2-toggle{right:12px;bottom:calc(12px + env(safe-area-inset-bottom));min-width:76px;min-height:40px;padding:9px 12px;font-size:13px;touch-action:none}
        .poe2-panel{left:8px!important;right:auto;top:8px!important;width:calc(100vw - 16px);max-height:calc(100dvh - 16px);border-radius:7px;font-size:13px}
        .poe2-header{padding:9px 10px;gap:8px;touch-action:none}
        .poe2-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .poe2-header .poe2-button{flex:0 0 auto}
        .poe2-tab-list{display:flex;overflow-x:auto;gap:0;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch}
        .poe2-tab-button{flex:0 0 92px;height:40px;padding:0 8px;font-size:12px;white-space:nowrap;scroll-snap-align:start}
        .poe2-subtab-list{display:flex;overflow-x:auto;gap:6px;padding-bottom:2px;-webkit-overflow-scrolling:touch}
        .poe2-subtab-button{flex:0 0 auto;min-width:86px;height:34px;padding:0 10px;white-space:nowrap}
        .poe2-grid{grid-template-columns:1fr}
        .poe2-continuous-editor-grid{grid-template-columns:1fr}
        .poe2-craft-common-grid{grid-template-columns:1fr 1fr}
        .poe2-system-grid,.poe2-safety-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
        .poe2-socket-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
        .poe2-advanced-step-row{grid-template-columns:1fr}
        .poe2-advanced-batch-row{grid-template-columns:repeat(2,minmax(0,1fr))}
        .poe2-affix-picker-grid{grid-template-columns:1fr 1fr}
        .poe2-affix-tier-field{grid-column:1 / -1}
        .poe2-actions.poe2-affix-picker-actions{grid-column:1 / -1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
        .poe2-section{padding:10px}
        .poe2-section-title-row{align-items:flex-start}
        .poe2-input{height:36px;font-size:16px}
        .poe2-range{height:36px}
        .poe2-mail-suggestions{max-height:220px}
        .poe2-textarea{height:82px}
        .poe2-share-code{height:96px}
        select.poe2-input[multiple],.poe2-stone-select{height:190px!important}
        .poe2-stone-choice-list{height:190px}
        .poe2-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%}
        .poe2-actions .poe2-button{width:100%;min-height:36px;padding:0 8px;white-space:normal;line-height:1.2}
        .poe2-utility-actions{display:flex;width:auto}
        .poe2-actions.poe2-utility-actions .poe2-button{width:auto;min-height:36px}
        .poe2-actions.poe2-affix-picker-actions .poe2-button{white-space:nowrap;font-size:12px}
        .poe2-affix-actions .poe2-button:last-child:nth-child(odd){grid-column:1 / -1}
        .poe2-actions.poe2-affix-picker-actions .poe2-button:last-child:nth-child(odd){grid-column:auto}
        .poe2-affix-group-head{display:grid;grid-template-columns:1fr auto;align-items:center}
        .poe2-affix-min-field{grid-column:1 / -1;justify-content:space-between;margin-left:0}
        .poe2-affix-min-input{width:88px}
        .poe2-affix-chip{max-width:100%;white-space:normal;text-align:left}
        .poe2-modal{align-items:stretch;justify-content:stretch;padding:8px}
        .poe2-modal-dialog{width:100%;max-height:calc(100dvh - 16px);border-radius:7px}
        .poe2-modal-header{display:grid;grid-template-columns:1fr;align-items:start;padding:10px;border-radius:7px 7px 0 0}
        .poe2-modal-header .poe2-actions{grid-template-columns:1fr 1fr}
        .poe2-modal-body{padding:10px}
        .poe2-fractured-head{display:grid;grid-template-columns:1fr;gap:6px}
        .poe2-fractured-meta{text-align:left}
        .poe2-log-list{height:440px}
      }
      @media (max-width: 380px){
        .poe2-actions{grid-template-columns:1fr}
        .poe2-utility-actions{display:flex}
        .poe2-actions.poe2-affix-picker-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
        .poe2-tab-button{flex-basis:86px}
        .poe2-craft-common-grid{grid-template-columns:1fr}
        .poe2-system-grid,.poe2-safety-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
        .poe2-socket-grid{grid-template-columns:1fr}
        .poe2-advanced-batch-row{grid-template-columns:1fr}
        .poe2-affix-picker-grid{grid-template-columns:1fr}
        .poe2-affix-tier-field{grid-column:1 / -1}
      }
      .poe2-theme-light{--poe2-bg:rgba(250,250,250,.98);--poe2-surface:#fff;--poe2-surface-soft:#f9fafb;--poe2-surface-muted:#eef2f7;--poe2-text:#111827;--poe2-text-soft:#374151;--poe2-muted:#6b7280;--poe2-border:#d6dbe3;--poe2-border-strong:#b8c0cc;--poe2-header:#f8fafc;--poe2-header-text:#111827;--poe2-primary:#4b5563;--poe2-primary-soft:#e5e7eb;--poe2-help-bg:#fff;--poe2-shadow:0 10px 30px rgba(0,0,0,.18);--poe2-chip-hover:#fff5f5;--poe2-warning-bg:#fff7ed;--poe2-log-bg:#111827;--poe2-log-text:#d1d5db}
      .poe2-theme-dark{--poe2-bg:rgba(24,28,36,.98);--poe2-surface:#1f2430;--poe2-surface-soft:#252b38;--poe2-surface-muted:#151a23;--poe2-text:#e5e7eb;--poe2-text-soft:#cbd5e1;--poe2-muted:#9ca3af;--poe2-border:#374151;--poe2-border-strong:#4b5563;--poe2-header:#111827;--poe2-header-text:#f8fafc;--poe2-primary:#cbd5e1;--poe2-primary-soft:#374151;--poe2-help-bg:#111827;--poe2-shadow:0 10px 34px rgba(0,0,0,.48);--poe2-chip-hover:#3b1d23;--poe2-warning-bg:#3a2815;--poe2-log-bg:#050816;--poe2-log-text:#d1d5db}
      .poe2-toggle.poe2-theme-light,.poe2-toggle.poe2-theme-dark{background:var(--poe2-header);color:var(--poe2-header-text);border:1px solid var(--poe2-border);box-shadow:var(--poe2-shadow)}
      .poe2-panel.poe2-theme-light,.poe2-panel.poe2-theme-dark{background:var(--poe2-bg);color:var(--poe2-text);border-color:var(--poe2-border);box-shadow:var(--poe2-shadow)}
      .poe2-theme-light .poe2-header,.poe2-theme-dark .poe2-header,.poe2-theme-light .poe2-modal-header,.poe2-theme-dark .poe2-modal-header{background:var(--poe2-header);color:var(--poe2-header-text)}
      .poe2-theme-light .poe2-tab-list,.poe2-theme-dark .poe2-tab-list{background:var(--poe2-surface-muted);border-bottom-color:var(--poe2-border)}
      .poe2-theme-light .poe2-tab-button,.poe2-theme-dark .poe2-tab-button{background:var(--poe2-surface-muted);color:var(--poe2-text-soft);border-right-color:var(--poe2-border)}
      .poe2-theme-light .poe2-tab-button.active,.poe2-theme-dark .poe2-tab-button.active{background:var(--poe2-surface);color:var(--poe2-primary);box-shadow:inset 0 -2px 0 var(--poe2-primary)}
      .poe2-theme-light .poe2-subtab-button,.poe2-theme-dark .poe2-subtab-button{background:var(--poe2-surface-soft);color:var(--poe2-text-soft);border-color:var(--poe2-border-strong)}
      .poe2-theme-light .poe2-subtab-button.active,.poe2-theme-dark .poe2-subtab-button.active{background:var(--poe2-primary-soft);color:var(--poe2-primary);border-color:var(--poe2-primary)}
      .poe2-theme-light .poe2-section,.poe2-theme-dark .poe2-section{border-top-color:var(--poe2-border)}
      .poe2-theme-light .poe2-section-title,.poe2-theme-dark .poe2-section-title,.poe2-theme-light .poe2-affix-group-head strong,.poe2-theme-dark .poe2-affix-group-head strong{color:var(--poe2-text)}
      .poe2-theme-light .poe2-modal-header .poe2-modal-title,.poe2-theme-dark .poe2-modal-header .poe2-modal-title{color:var(--poe2-header-text)}
      .poe2-theme-light .poe2-field span,.poe2-theme-dark .poe2-field span,.poe2-theme-light .poe2-summary,.poe2-theme-dark .poe2-summary,.poe2-theme-light .poe2-empty,.poe2-theme-dark .poe2-empty,.poe2-theme-light .poe2-muted,.poe2-theme-dark .poe2-muted,.poe2-theme-light .poe2-fractured-meta,.poe2-theme-dark .poe2-fractured-meta,.poe2-theme-light .poe2-affix-empty,.poe2-theme-dark .poe2-affix-empty,.poe2-theme-light .poe2-affix-min-field,.poe2-theme-dark .poe2-affix-min-field{color:var(--poe2-muted)}
      .poe2-theme-light .poe2-input,.poe2-theme-dark .poe2-input{background:var(--poe2-surface);color:var(--poe2-text);border-color:var(--poe2-border-strong)}
      .poe2-theme-light .poe2-range,.poe2-theme-dark .poe2-range{accent-color:var(--poe2-primary)}
      .poe2-theme-light .poe2-range-value,.poe2-theme-dark .poe2-range-value{color:var(--poe2-text)}
      .poe2-theme-light .poe2-mail-suggestions,.poe2-theme-dark .poe2-mail-suggestions{background:var(--poe2-surface);border-color:var(--poe2-border);box-shadow:var(--poe2-shadow)}
      .poe2-theme-light .poe2-mail-suggestion,.poe2-theme-dark .poe2-mail-suggestion{color:var(--poe2-text)}
      .poe2-theme-light .poe2-mail-suggestion:hover,.poe2-theme-dark .poe2-mail-suggestion:hover{background:var(--poe2-primary-soft);color:var(--poe2-primary)}
      .poe2-theme-light .poe2-mail-suggestion-level,.poe2-theme-dark .poe2-mail-suggestion-level{color:var(--poe2-muted)}
      .poe2-theme-light .poe2-mail-recent-button,.poe2-theme-dark .poe2-mail-recent-button,.poe2-theme-light .poe2-mail-preview-item,.poe2-theme-dark .poe2-mail-preview-item{background:var(--poe2-surface);color:var(--poe2-text-soft);border-color:var(--poe2-border-strong)}
      .poe2-theme-light .poe2-mail-currency-preview,.poe2-theme-dark .poe2-mail-currency-preview{background:var(--poe2-surface-soft);color:var(--poe2-text-soft);border-color:var(--poe2-border)}
      .poe2-theme-light .poe2-help-button,.poe2-theme-dark .poe2-help-button{background:var(--poe2-surface);color:var(--poe2-text-soft);border-color:var(--poe2-border-strong)}
      .poe2-theme-light .poe2-help-panel,.poe2-theme-dark .poe2-help-panel{background:var(--poe2-help-bg);color:var(--poe2-text);border-color:var(--poe2-border);box-shadow:var(--poe2-shadow)}
      .poe2-theme-light .poe2-help-title,.poe2-theme-dark .poe2-help-title{color:var(--poe2-primary)}
      .poe2-theme-light .poe2-affix-group-card,.poe2-theme-dark .poe2-affix-group-card,.poe2-theme-light .poe2-fractured-item,.poe2-theme-dark .poe2-fractured-item{background:var(--poe2-surface-soft);border-color:var(--poe2-border)}
      .poe2-theme-light .poe2-battle-summary,.poe2-theme-dark .poe2-battle-summary,.poe2-theme-light .poe2-rank-output,.poe2-theme-dark .poe2-rank-output{background:var(--poe2-surface-soft);border-color:var(--poe2-border);color:var(--poe2-text-soft)}
      .poe2-theme-light .poe2-rank-output a,.poe2-theme-dark .poe2-rank-output a{color:var(--poe2-accent)}
      .poe2-theme-light .poe2-affix-group-card.active,.poe2-theme-dark .poe2-affix-group-card.active{border-color:#16a34a}
      .poe2-theme-light .poe2-continuous-step,.poe2-theme-dark .poe2-continuous-step{background:var(--poe2-surface-soft);color:var(--poe2-text-soft);border-color:var(--poe2-border)}
      .poe2-theme-light .poe2-continuous-step.active,.poe2-theme-dark .poe2-continuous-step.active{background:#064e3b;color:#bbf7d0;border-color:#16a34a}
      .poe2-theme-light .poe2-affix-chip,.poe2-theme-dark .poe2-affix-chip{background:var(--poe2-surface);color:var(--poe2-text);border-color:var(--poe2-border-strong)}
      .poe2-theme-light .poe2-affix-chip:hover,.poe2-theme-dark .poe2-affix-chip:hover{background:var(--poe2-chip-hover);border-color:#ef4444;color:#fca5a5}
      .poe2-theme-light .poe2-log-list,.poe2-theme-dark .poe2-log-list{background:var(--poe2-log-bg);color:var(--poe2-log-text)}
      .poe2-modal.poe2-theme-light .poe2-modal-dialog,.poe2-modal.poe2-theme-dark .poe2-modal-dialog{background:var(--poe2-surface-soft);color:var(--poe2-text);border-color:var(--poe2-border);box-shadow:var(--poe2-shadow)}
      .poe2-theme-light .poe2-fractured-name,.poe2-theme-dark .poe2-fractured-name{color:#f97316}
      .poe2-theme-light .poe2-fractured-affix,.poe2-theme-dark .poe2-fractured-affix{background:var(--poe2-warning-bg)}
    `);
  };

  /**
   * syncPanelVisibility 根据 state.isPanelVisible 更新主面板显示状态。
   */
  const syncPanelVisibility = () => {
    if (state.ui.panel) state.ui.panel.hidden = !state.isPanelVisible;
    if (!state.isPanelVisible && state.minimizePausesAutomation && state.isRunning) {
      addLog('面板已最小化，按设置暂停当前自动化任务。', 'warn');
      stopCurrentTask();
    }
  };

  /**
   * makePanelDraggable 给主面板添加拖拽移动能力。
   * @param {HTMLElement} panelElement 面板元素。
   * @param {HTMLElement} handleElement 拖拽手柄元素。
   */
  const makePanelDraggable = (panelElement, handleElement) => {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;
    handleElement.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button,input,select,textarea,a')) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      isDragging = true;
      offsetX = event.clientX - panelElement.offsetLeft;
      offsetY = event.clientY - panelElement.offsetTop;
      document.body.style.userSelect = 'none';
      handleElement.setPointerCapture?.(event.pointerId);
    });
    document.addEventListener('pointermove', (event) => {
      if (!isDragging) return;
      const nextLeft = Math.max(0, Math.min(window.innerWidth - panelElement.offsetWidth, event.clientX - offsetX));
      const nextTop = Math.max(0, Math.min(window.innerHeight - panelElement.offsetHeight, event.clientY - offsetY));
      panelElement.style.left = `${nextLeft}px`;
      panelElement.style.top = `${nextTop}px`;
    });
    const stopDragging = () => {
      if (!isDragging) return;
      isDragging = false;
      document.body.style.userSelect = '';
      state.panelPosition = {
        left: panelElement.offsetLeft,
        top: panelElement.offsetTop,
      };
      updateAssistantSetting('panelPosition', state.panelPosition);
    };
    document.addEventListener('pointerup', stopDragging);
    document.addEventListener('pointercancel', stopDragging);
  };

  /**
   * makeToggleButtonPositionable 让外部悬浮入口按钮支持按需拖动并保存位置。
   * 只有“其他功能 > 调整位置”开启后才会响应拖拽，普通点击仍用于展开/收起主面板。
   * @param {HTMLButtonElement} toggleButton 外部入口按钮。
   */
  const makeToggleButtonPositionable = (toggleButton) => {
    let isDragging = false;
    let didDrag = false;
    let offsetX = 0;
    let offsetY = 0;
    toggleButton.addEventListener('pointerdown', (event) => {
      if (!state.isTogglePositionMode || (event.pointerType === 'mouse' && event.button !== 0)) return;
      isDragging = true;
      didDrag = false;
      offsetX = event.clientX - toggleButton.offsetLeft;
      offsetY = event.clientY - toggleButton.offsetTop;
      document.body.style.userSelect = 'none';
      toggleButton.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    document.addEventListener('pointermove', (event) => {
      if (!isDragging) return;
      didDrag = true;
      const nextLeft = Math.max(0, Math.min(window.innerWidth - toggleButton.offsetWidth, event.clientX - offsetX));
      const nextTop = Math.max(0, Math.min(window.innerHeight - toggleButton.offsetHeight, event.clientY - offsetY));
      toggleButton.style.left = `${nextLeft}px`;
      toggleButton.style.top = `${nextTop}px`;
      toggleButton.style.right = 'auto';
      toggleButton.style.bottom = 'auto';
    });
    const stopDragging = () => {
      if (!isDragging) return;
      isDragging = false;
      document.body.style.userSelect = '';
      state.togglePosition = {
        left: toggleButton.offsetLeft,
        top: toggleButton.offsetTop,
      };
      updateAssistantSetting('togglePosition', state.togglePosition);
      setTimeout(() => { didDrag = false; }, 0);
    };
    document.addEventListener('pointerup', stopDragging);
    document.addEventListener('pointercancel', stopDragging);
    toggleButton.addEventListener('click', (event) => {
      if (didDrag) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (state.isTogglePositionMode) {
        togglePositionAdjustMode();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  };

  /**
   * buildUserInterface 创建主按钮、主面板和所有控件。
   */
  const buildUserInterface = () => {
    const toggleButton = createButton('助手 2.17', () => {
      state.isPanelVisible = !state.isPanelVisible;
      syncPanelVisibility();
    });
    toggleButton.className = 'poe2-toggle';
    if (state.togglePosition) {
      toggleButton.style.left = `${state.togglePosition.left}px`;
      toggleButton.style.top = `${state.togglePosition.top}px`;
      toggleButton.style.right = 'auto';
      toggleButton.style.bottom = 'auto';
    }

    const panelElement = createElement('div', { className: 'poe2-panel' });
    panelElement.style.left = `${state.panelPosition?.left ?? 20}px`;
    panelElement.style.top = `${state.panelPosition?.top ?? 80}px`;

    const collapseButton = createButton('收起', (event) => {
      event.stopPropagation();
      state.isPanelVisible = false;
      syncPanelVisibility();
    });
    const headerElement = createElement('div', {
      className: 'poe2-header',
      children: [
        createElement('div', { className: 'poe2-title', textContent: '助手测试服版 2.17' }),
        collapseButton,
      ],
    });

    state.ui.keywordInput = createElement('input', { className: 'poe2-input', placeholder: '装备关键词' });
    state.ui.raritySelect = createSelect([
      { value: RARITY_TYPES.any, label: '不限' },
      { value: RARITY_TYPES.normal, label: '普通' },
      { value: RARITY_TYPES.magic, label: '魔法' },
      { value: RARITY_TYPES.rare, label: '稀有' },
      { value: RARITY_TYPES.unique, label: '暗金' },
    ], RARITY_TYPES.any);
    state.ui.targetCountInput = createElement('input', { className: 'poe2-input', type: 'number', value: '1' });
    state.ui.storageSelect = createSelect([
      { value: 'false', label: '背包' },
      { value: 'true', label: '储藏' },
    ], String(state.useStorage));
    state.ui.storageSelect.addEventListener('change', () => {
      state.useStorage = state.ui.storageSelect.value === 'true';
    });
    state.ui.craftPlanToggleButton = createButton('显示自定义打造方案读取', () => {
      const planSection = state.ui.craftPlanSection;
      if (!planSection) return;
      planSection.hidden = !planSection.hidden;
      state.ui.craftPlanToggleButton.textContent = planSection.hidden ? '显示自定义打造方案读取' : '隐藏自定义打造方案读取';
    });
    state.ui.redInput = createElement('input', { className: 'poe2-input', type: 'number', value: '0' });
    state.ui.greenInput = createElement('input', { className: 'poe2-input', type: 'number', value: '0' });
    state.ui.blueInput = createElement('input', { className: 'poe2-input', type: 'number', value: '0' });
    state.ui.batchStoneSelect = createSelect(BATCH_STONE_OPTIONS.map((option) => ({
      value: option.type,
      label: option.label,
    })), MODIFY_TYPES.chance);
    state.ui.advancedBatchStepSelect = createSelect([], '0');
    state.ui.advancedBatchKeywordInput = createElement('input', {
      className: 'poe2-input',
      placeholder: '当前步骤关键词',
    });
    state.ui.advancedBatchChanceInput = createElement('input', { type: 'checkbox', checked: true });
    state.ui.advancedBatchChanceInput.disabled = true;
    state.ui.advancedBatchSkipNonUniqueInput = createElement('input', { type: 'checkbox', checked: true });
    state.ui.advancedBatchSocketInput = createElement('input', { type: 'checkbox' });
    state.ui.advancedBatchRedInput = createElement('input', { className: 'poe2-input', type: 'number', value: '0' });
    state.ui.advancedBatchGreenInput = createElement('input', { className: 'poe2-input', type: 'number', value: '0' });
    state.ui.advancedBatchBlueInput = createElement('input', { className: 'poe2-input', type: 'number', value: '0' });
    state.ui.advancedBatchQualityInput = createElement('input', { type: 'checkbox' });
    state.ui.advancedBatchQualitySelect = createSelect([], '');
    setSelectOptions(state.ui.advancedBatchQualitySelect, [
      { value: MODIFY_TYPES.whetstone, label: '磨刀石' },
      { value: MODIFY_TYPES.armourScrap, label: '护甲片' },
      { value: MODIFY_TYPES.glassblowerBauble, label: '玻璃弹珠' },
    ], '选择品质通货');
    state.ui.advancedBatchGardenCraftInput = createElement('input', { type: 'checkbox' });
    state.ui.advancedBatchGardenCraftSelect = createSelect([], '');
    setSelectOptions(state.ui.advancedBatchGardenCraftSelect, [], '选择花园工艺');
    state.ui.advancedBatchVaalInput = createElement('input', { type: 'checkbox' });
    state.ui.advancedBatchDestroyInput = createElement('input', { type: 'checkbox' });
    state.ui.advancedBatchProtectHighQualityInput = createElement('input', { type: 'checkbox' });
    state.ui.advancedBatchStoreCorruptedBaseInput = createElement('input', { type: 'checkbox' });
    state.ui.craftPlanNameInput = createElement('input', { className: 'poe2-input', placeholder: '自定义方案名称' });
    state.ui.craftPlanSelect = createSelect([], '');
    state.ui.craftPlanShareTextarea = createElement('textarea', {
      className: 'poe2-input poe2-textarea poe2-share-code',
      placeholder: '自定义方案分享码',
    });
    state.ui.craftPlanSelect.addEventListener('change', () => {
      const plan = state.craftPlans.find((savedPlan) => savedPlan.id === state.ui.craftPlanSelect.value);
      if (plan) setInputValue(state.ui.craftPlanNameInput, plan.name);
    });
    const saveCraftPlanButton = createButton('保存方案', saveCurrentCraftPlan);
    const loadCraftPlanButton = createButton('读取方案', loadSelectedCraftPlan);
    const deleteCraftPlanButton = createButton('删除方案', deleteSelectedCraftPlan);
    const exportCraftPlanButton = createButton('导出分享码', async () => {
      try {
        await exportSelectedCraftPlanCode();
      } catch (error) {
        const message = error.message || String(error);
        addLog(message, 'error');
        window.alert(message);
      }
    });
    const importCraftPlanButton = createButton('导入分享码', async () => {
      try {
        await importCraftPlanCode();
      } catch (error) {
        addLog(error.message || String(error), 'error');
      }
    });
    refreshCraftPlanSelect();

    const commonSection = createElement('div', {
      className: 'poe2-section poe2-grid poe2-craft-common-grid',
      children: [
        createLabeledControl('关键词', state.ui.keywordInput),
        createLabeledControl('稀有度', state.ui.raritySelect),
        createLabeledControl('目标数量', state.ui.targetCountInput),
        createLabeledControl('读取位置', state.ui.storageSelect),
        createElement('div', {
          className: 'poe2-field poe2-plan-toggle-field',
          children: [
            createElement('span', { textContent: '自定义打造方案读取' }),
            state.ui.craftPlanToggleButton,
          ],
        }),
      ],
    });
    state.ui.craftPlanSection = createElement('div', {
      className: 'poe2-section',
      children: [
        createElement('div', {
          className: 'poe2-section-title poe2-title-with-help',
          children: [
            createElement('span', { textContent: '自定义打造方案读取' }),
            createHelpTooltip('自定义打造方案说明', [
              '保存方案：保存到浏览器本地，只保存打造装备里的自定义打造方案。',
              '本地方案包含：方案名称、关键词、稀有度、目标数量、读取位置、自定义打造步骤、步骤动作、工艺选择、条件成立/不成立跳转和判断条件。',
              '读取方案：把选中的本地方案套回当前界面，并自动切到自定义打造页。',
              '导出分享码：按当前自定义打造方案配置导出短码，不依赖下拉框当前选中项。',
              '分享码包含：方案名称、自定义打造步骤、动作、工艺选择、条件成立/不成立跳转和判断条件。',
              '分享码不包含：关键词、稀有度、目标数量、读取位置、日志等级、自动化速度和安全上限。',
              '导入分享码：只应用到当前界面，不自动保存到本地；需要保留时再点保存方案。',
            ]),
          ],
        }),
        createElement('div', {
          className: 'poe2-grid',
          children: [
            createLabeledControl('自定义方案名称', state.ui.craftPlanNameInput),
            createLabeledControl('本地自定义方案', state.ui.craftPlanSelect),
            createElement('label', {
              className: 'poe2-field poe2-wide',
              children: [
                createElement('span', { textContent: '分享码' }),
                state.ui.craftPlanShareTextarea,
              ],
            }),
          ],
        }),
        createElement('div', {
          className: 'poe2-actions poe2-affix-actions',
          children: [
            saveCraftPlanButton,
            loadCraftPlanButton,
            deleteCraftPlanButton,
            exportCraftPlanButton,
            importCraftPlanButton,
          ],
        }),
      ],
    });
    state.ui.craftPlanSection.hidden = true;

    const startFullButton = createButton('工匠链接幻色', () => runTask('工匠链接幻色', async () => {
      const options = readTaskOptions();
      await processCraftSocketTargets(options);
    }));
    const startBatchButton = createButton('批量通货', () => runTask('批量通货', async () => {
      const options = readTaskOptions();
      await processBatchCurrencyTargets(options);
    }));
    const startAdvancedBatchButton = createButton('连续批量', () => runTask('连续批量', async () => {
      const options = readTaskOptions();
      await processAdvancedBatchTargets(options);
    }));
    const saveAdvancedBatchButton = createButton('保存配置', saveAdvancedBatchPlan);
    const loadAdvancedBatchButton = createButton('读取配置', loadAdvancedBatchPlan);
    const addAdvancedBatchStepButton = createButton('新增步骤', addAdvancedBatchStep);
    const removeAdvancedBatchStepButton = createButton('删除步骤', removeAdvancedBatchStep);
    state.ui.advancedBatchStepSelect.addEventListener('change', () => {
      saveCurrentAdvancedBatchStepSilently();
      state.activeAdvancedBatchStepIndex = getActiveAdvancedBatchStepIndex();
      loadAdvancedBatchStepForEditing();
    });
    const syncAdvancedBatchStepEditor = () => {
      saveCurrentAdvancedBatchStepSilently();
      renderAdvancedBatchSteps();
    };
    [
      state.ui.advancedBatchKeywordInput,
      state.ui.advancedBatchSkipNonUniqueInput,
      state.ui.advancedBatchSocketInput,
      state.ui.advancedBatchRedInput,
      state.ui.advancedBatchGreenInput,
      state.ui.advancedBatchBlueInput,
      state.ui.advancedBatchQualityInput,
      state.ui.advancedBatchQualitySelect,
      state.ui.advancedBatchGardenCraftInput,
      state.ui.advancedBatchGardenCraftSelect,
      state.ui.advancedBatchVaalInput,
      state.ui.advancedBatchDestroyInput,
      state.ui.advancedBatchProtectHighQualityInput,
      state.ui.advancedBatchStoreCorruptedBaseInput,
    ].forEach((controlElement) => {
      controlElement.addEventListener('change', syncAdvancedBatchStepEditor);
      if (controlElement === state.ui.advancedBatchGardenCraftSelect) {
        controlElement.addEventListener('change', () => {
          controlElement.dataset.pendingGardenCraftSelection = '';
        });
      }
      if (controlElement === state.ui.advancedBatchKeywordInput) {
        controlElement.addEventListener('input', syncAdvancedBatchStepEditor);
      }
    });
    const startUniqueButton = createButton('自动暗金', () => runTask('自动暗金', async () => {
      const options = readTaskOptions();
      await processAutoUniqueTargets(options);
    }));
    const startChaosButton = createButton('混沌筛选', () => runTask('混沌筛选', async () => {
      const options = createClassicCraftSnapshot('混沌筛选', { prefix: 3, suffix: 3, total: 6 });
      await ensureCraftBenchListForRollConditions(options);
      const conditionGroups = options.affixConditionGroups;
      await eachTargetEquipment({ ...options, excludeRarities: [RARITY_TYPES.unique] }, (equipment) => (
        processChaosWithRarityPreparation(equipment, conditionGroups, options.rarity)
      ));
    }));
    const startAltAugButton = createButton('改造增幅', () => runTask('改造增幅', async () => {
      const options = createClassicCraftSnapshot('改造增幅', { prefix: 1, suffix: 1, total: 2 });
      await ensureCraftBenchListForRollConditions(options);
      const conditionGroups = options.affixConditionGroups;
      await eachTargetEquipment({ ...options, excludeRarities: [RARITY_TYPES.unique] }, (equipment) => (
        processAltAugWithRarityPreparation(equipment, conditionGroups, options.rarity)
      ));
    }));
    state.ui.continuousStepSelect = createSelect([], '0');
    state.ui.continuousActionKindSelect = createSelect(CONTINUOUS_ACTION_KIND_OPTIONS, 'currency');
    state.ui.continuousActionSelect = createSelect(getContinuousActionKindOptions('currency'), 'alteration');
    state.ui.continuousCraftCategorySelect = createSelect(CRAFT_BENCH_CATEGORY_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label,
    })), CRAFT_BENCH_CATEGORY_OPTIONS[0].value);
    state.ui.continuousCraftIdSelect = createSelect([], '');
    state.ui.continuousGardenCategorySelect = createSelect(GARDEN_CRAFT_CATEGORY_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label,
    })), GARDEN_CRAFT_CATEGORY_OPTIONS[0].value);
    state.ui.continuousGardenCraftSelect = createSelect([], '');
    state.ui.continuousSuccessSelect = createSelect(Object.entries(CONTINUOUS_STEP_HANDLINGS).map(([value, handlingConfig]) => ({
      value,
      label: handlingConfig.label,
    })), 'jump');
    state.ui.continuousFailureSelect = createSelect(Object.entries(CONTINUOUS_STEP_HANDLINGS).map(([value, handlingConfig]) => ({
      value,
      label: handlingConfig.label,
    })), 'scourRestart');
    state.ui.continuousSuccessTargetInput = createSelect([], '');
    state.ui.continuousFailureTargetInput = createSelect([], '');
    state.ui.continuousStepList = createElement('div', { className: 'poe2-continuous-step-list' });
    state.ui.continuousStepSelect.addEventListener('change', () => {
      saveCurrentContinuousStepSilently();
      state.activeContinuousStepIndex = getActiveContinuousCraftStepIndex();
      loadContinuousCraftStepForEditing();
    });
    state.ui.continuousActionKindSelect.addEventListener('change', () => {
      const detailOptions = getContinuousActionKindOptions(state.ui.continuousActionKindSelect.value);
      setSelectOptions(state.ui.continuousActionSelect, detailOptions);
      state.ui.continuousActionSelect.hidden = detailOptions.length === 0;
      if (detailOptions.length) state.ui.continuousActionSelect.value = detailOptions[0].value;
      saveCurrentContinuousStepSilently();
      updateContinuousHandlingTargetVisibility();
      updateContinuousCraftBenchControlsVisibility();
      if (['craftBench', 'smartCraftBench'].includes(getActionFromContinuousActionControls())) {
        scheduleContinuousCraftBenchOptionsRefresh(false);
      } else if (getActionFromContinuousActionControls() === 'gardenCraft') {
        scheduleContinuousGardenCraftOptionsRefresh(false);
      }
      renderContinuousCraftSteps();
    });
    state.ui.continuousActionSelect.addEventListener('change', () => {
      saveCurrentContinuousStepSilently();
      updateContinuousHandlingTargetVisibility();
      updateContinuousCraftBenchControlsVisibility();
      if (['craftBench', 'smartCraftBench'].includes(getActionFromContinuousActionControls())) {
        scheduleContinuousCraftBenchOptionsRefresh(false);
      } else if (getActionFromContinuousActionControls() === 'gardenCraft') {
        scheduleContinuousGardenCraftOptionsRefresh(false);
      }
      renderContinuousCraftSteps();
    });
    state.ui.continuousCraftCategorySelect.addEventListener('change', () => {
      state.ui.continuousCraftIdSelect.value = '';
      state.ui.continuousCraftIdSelect.dataset.pendingCraftId = '';
      saveCurrentContinuousStepSilently();
      scheduleContinuousCraftBenchOptionsRefresh(false);
      renderContinuousCraftSteps();
    });
    state.ui.continuousCraftIdSelect.addEventListener('change', () => {
      saveCurrentContinuousStepSilently();
      renderContinuousCraftSteps();
    });
    state.ui.continuousGardenCategorySelect.addEventListener('change', () => {
      state.ui.continuousGardenCraftSelect.value = '';
      state.ui.continuousGardenCraftSelect.dataset.pendingGardenCraftKey = '';
      saveCurrentContinuousStepSilently();
      scheduleContinuousGardenCraftOptionsRefresh(false);
      renderContinuousCraftSteps();
    });
    state.ui.continuousGardenCraftSelect.addEventListener('change', () => {
      saveCurrentContinuousStepSilently();
      renderContinuousCraftSteps();
    });
    state.ui.continuousSuccessSelect.addEventListener('change', () => {
      updateContinuousHandlingTargetVisibility();
      saveCurrentContinuousStepSilently();
      renderContinuousCraftSteps();
    });
    state.ui.continuousFailureSelect.addEventListener('change', () => {
      updateContinuousHandlingTargetVisibility();
      saveCurrentContinuousStepSilently();
      renderContinuousCraftSteps();
    });
    state.ui.continuousSuccessTargetInput.addEventListener('change', () => {
      saveCurrentContinuousStepSilently();
      renderContinuousCraftSteps();
    });
    state.ui.continuousFailureTargetInput.addEventListener('change', () => {
      saveCurrentContinuousStepSilently();
      renderContinuousCraftSteps();
    });
    const addContinuousStepButton = createButton('新增步骤', addContinuousCraftStep);
    const removeContinuousStepButton = createButton('删除步骤', removeContinuousCraftStep);
    const clearAllContinuousStepsButton = createButton('清除所有步骤', clearAllContinuousCraftSteps);
    const presetAltAugRegalButton = createButton('套用改造增幅富豪预设', applyAltAugRegalPresetToContinuousSteps);
    state.ui.continuousCraftRefreshButton = createButton('刷新工艺列表', () => {
      if (getActionFromContinuousActionControls() === 'gardenCraft') {
        scheduleContinuousGardenCraftOptionsRefresh(true);
      } else {
        scheduleContinuousCraftBenchOptionsRefresh(true);
      }
    });
    const startContinuousCraftButton = createButton('开始自定义打造', () => runTask('自定义打造', async () => {
      const options = createCustomCraftSnapshot();
      await ensureCraftBenchListForRollConditions(options);
      const steps = options.continuousCraftSteps;
      const excludeRarities = options.rarity === RARITY_TYPES.unique ? [] : [RARITY_TYPES.unique];
      await eachTargetEquipment({ ...options, excludeRarities }, (equipment) => (
        processContinuousCraftSteps(equipment, steps)
      ));
    }));
    [
      startFullButton,
      startBatchButton,
      startAdvancedBatchButton,
      startUniqueButton,
      startChaosButton,
      startAltAugButton,
      startContinuousCraftButton,
    ].forEach((button) => button.classList.add('poe2-success-button'));
    state.ui.stopButtons = {
      socket: createStopTaskButton(),
      classic: createStopTaskButton(),
      continuous: createStopTaskButton(),
      batch: createStopTaskButton(),
    };
    state.ui.taskButtons = [
      startFullButton,
      startBatchButton,
      startUniqueButton,
      startChaosButton,
      startAltAugButton,
      startContinuousCraftButton,
      startAdvancedBatchButton,
    ];
    state.ui.taskButtons?.push(saveAdvancedBatchButton, loadAdvancedBatchButton, addAdvancedBatchStepButton, removeAdvancedBatchStepButton);
    applyAdvancedBatchPlanToUi(getDefaultAdvancedBatchPlan());

    const socketSection = createElement('div', {
      className: 'poe2-section poe2-grid poe2-socket-grid',
      children: [
        createLabeledControl('红孔', state.ui.redInput),
        createLabeledControl('绿孔', state.ui.greenInput),
        createLabeledControl('蓝孔', state.ui.blueInput),
        createElement('div', {
          className: 'poe2-actions poe2-wide',
          children: [
            startFullButton,
            createHelpTooltip('孔洞操作说明', [
              '按目标颜色数量处理当前筛选装备。',
              '会先用工匠石尝试孔数，再用链接石尝试单组链接，最后用幻色石洗到至少满足目标颜色。',
              '红绿蓝都填 0 时，只做到单组链接，成功后不再使用幻色石。',
              '达到经典动作上限会立刻停止整次任务。',
            ]),
            state.ui.stopButtons.socket,
          ],
        }),
      ],
    });
    const affixPickerSection = createAffixPickerSection();
    affixPickerSection.hidden = true;
    const affixActionSection = createElement('div', {
      className: 'poe2-section poe2-actions',
      children: [
        startChaosButton,
        createHelpTooltip('混沌筛选说明', [
          '把目标装备准备为稀有后，循环使用混沌石直到命中当前词缀条件。',
          '达到经典动作上限会立刻停止整次任务。',
        ]),
        startAltAugButton,
        createHelpTooltip('改造增幅说明', [
          '把目标装备准备为魔法后，循环使用改造石，并在需要时补增幅石。',
          '达到经典动作上限会立刻停止整次任务。',
        ]),
        startUniqueButton,
        createHelpTooltip('自动暗金说明', [
          '把目标装备准备为普通后，循环机会石和重铸石，直到变为暗金。',
          '达到经典动作上限会立刻停止整次任务。',
        ]),
        state.ui.stopButtons.classic,
      ],
    });
    const continuousSection = createElement('div', {
      className: 'poe2-section',
      children: [
        createElement('div', {
          className: 'poe2-continuous-editor-grid',
          children: [
            createElement('div', {
              className: 'poe2-continuous-column',
              children: [
                createElement('div', { className: 'poe2-section-title', textContent: '步骤动作' }),
                createLabeledControl(createHelpedLabel('动作类型', '步骤动作说明', [
                  '每个步骤先执行自己的动作，再根据规则进入下一步。',
                  '使用通货：只使用所选通货一次，不自动判断、不自动补底子、不自动跳过。操作失败会终止打造。',
                  '工艺：只执行所选工艺一次，不判断是否已有工艺词缀。',
                  '智能操作：内置判断逻辑，只在需要时消耗通货或工艺。包括变为魔法、变为稀有、智能增幅、智能崇高、智能工艺。',
                  '条件判断：不消耗通货，只判断当前装备状态或词缀条件，并根据成立/不成立走不同步骤。',
                  '无动作：不改装备，只按下一步继续，适合占位或整理流程。',
                ]), state.ui.continuousActionKindSelect),
                createLabeledControl('动作明细', state.ui.continuousActionSelect),
                state.ui.continuousCraftCategoryField = createLabeledControl('工艺部位', state.ui.continuousCraftCategorySelect),
                state.ui.continuousCraftIdField = createLabeledControl('工艺词缀', state.ui.continuousCraftIdSelect),
                state.ui.continuousGardenCategoryField = createLabeledControl('花园类型', state.ui.continuousGardenCategorySelect),
                state.ui.continuousGardenCraftField = createLabeledControl('工艺方法', state.ui.continuousGardenCraftSelect),
              ],
            }),
            createElement('div', {
              className: 'poe2-continuous-column',
              children: [
                createElement('div', { className: 'poe2-section-title', textContent: '成功' }),
                state.ui.continuousSuccessHandlingField = createLabeledControl(createHelpedLabel('条件成立', '条件成立处理说明', [
                  '条件判断步骤中表示“条件成立”后的处理；普通动作步骤中表示“完成后”的处理。',
                  '跳转到步骤：条件成立或动作完成后跳到你选择的步骤。',
                  '重铸后从步骤 A 开始：使用一次重铸石，再从第一个步骤重新开始。',
                  '终止(打造成功)：结束当前装备，并计为一次命中。',
                  '终止(异常错误)：停止任务并显示错误。',
                  '终止(手动操作)：结束当前装备，不计为命中。',
                  '普通通货、工艺、智能操作和无动作步骤会使用“完成后”设置，可跳转或按原因终止。',
                ]), state.ui.continuousSuccessSelect),
                state.ui.continuousSuccessTargetField = createLabeledControl('成立跳转步骤', state.ui.continuousSuccessTargetInput),
              ],
            }),
            createElement('div', {
              className: 'poe2-continuous-column',
              children: [
                createElement('div', { className: 'poe2-section-title', textContent: '失败' }),
                state.ui.continuousFailureHandlingField = createLabeledControl(createHelpedLabel('条件不成立', '条件不成立处理说明', [
                  '这个设置只对“条件判断”步骤生效。',
                  '跳转到步骤：条件不成立后跳到你选择的步骤。',
                  '重铸后从步骤 A 开始：条件不成立后只使用一次重铸石，再从第一个步骤重新开始。破裂装备重铸后如果停在魔法，也会继续流程。',
                  '终止(异常错误)：停止任务并显示错误。',
                  '终止(打造成功)：结束当前装备，并计为一次命中。',
                  '终止(手动操作)：结束当前装备，不计为命中。',
                  '条件步骤不允许继续当前步骤；需要循环时请明确选择要跳回的步骤。',
                ]), state.ui.continuousFailureSelect),
                state.ui.continuousFailureTargetField = createLabeledControl('不成立跳转步骤', state.ui.continuousFailureTargetInput),
              ],
            }),
          ],
        }),
        state.ui.continuousStepList,
        createElement('div', {
          className: 'poe2-actions poe2-affix-actions',
          children: [
            addContinuousStepButton,
            removeContinuousStepButton,
            clearAllContinuousStepsButton,
            startContinuousCraftButton,
            state.ui.stopButtons.continuous,
          ],
        }),
        createElement('div', {
          className: 'poe2-actions poe2-affix-actions',
          children: [presetAltAugRegalButton, state.ui.continuousCraftRefreshButton],
        }),
      ],
    });
    updateContinuousCraftBenchControlsVisibility();
    renderContinuousCraftSteps();
    const batchSection = createElement('div', {
      className: 'poe2-section poe2-grid',
      children: [
        createLabeledControl('批量通货', state.ui.batchStoneSelect),
        createElement('div', {
          className: 'poe2-actions poe2-wide',
          children: [
            startBatchButton,
            createHelpTooltip('批量通货说明', [
              '对筛选出的装备最多 5 件并发使用所选通货。',
              '选择磨刀石、护甲片或玻璃弹珠时，会持续使用到接口提示不能继续或达到经典动作上限。',
              '达到经典动作上限会立刻停止整次任务。',
            ]),
            state.ui.stopButtons.batch,
          ],
        }),
        createElement('div', { className: 'poe2-section-title poe2-wide', textContent: '连续批量' }),
        createElement('div', {
          className: 'poe2-advanced-step-row poe2-wide',
          children: [
            createLabeledControl('步骤动作', state.ui.advancedBatchStepSelect),
            createLabeledControl('关键词', state.ui.advancedBatchKeywordInput),
          ],
        }),
        createElement('div', {
          className: 'poe2-inline-check-row poe2-wide',
          children: [
            createInlineCheckboxControl('使用机会石', state.ui.advancedBatchChanceInput),
            createInlineCheckboxControl('非暗金跳过', state.ui.advancedBatchSkipNonUniqueInput),
            createInlineCheckboxControl('执行孔洞操作', state.ui.advancedBatchSocketInput),
            createInlineCheckboxControl('品质补满', state.ui.advancedBatchQualityInput),
            createInlineCheckboxControl('花园工艺', state.ui.advancedBatchGardenCraftInput),
            createInlineCheckboxControl('使用瓦尔宝珠', state.ui.advancedBatchVaalInput),
            createInlineCheckboxControl('自动丢弃非暗金', state.ui.advancedBatchDestroyInput),
            createInlineCheckboxControl('保护高品质', state.ui.advancedBatchProtectHighQualityInput),
            createInlineCheckboxControl('腐化基底暗金存储', state.ui.advancedBatchStoreCorruptedBaseInput),
          ],
        }),
        createElement('div', {
          className: 'poe2-advanced-batch-row poe2-wide',
          children: [
            createLabeledControl('红孔', state.ui.advancedBatchRedInput),
            createLabeledControl('绿孔', state.ui.advancedBatchGreenInput),
            createLabeledControl('蓝孔', state.ui.advancedBatchBlueInput),
            createLabeledControl('品质通货', state.ui.advancedBatchQualitySelect),
            createLabeledControl('花园工艺', state.ui.advancedBatchGardenCraftSelect),
          ],
        }),
        createElement('div', {
          className: 'poe2-actions poe2-wide',
          children: [
            startAdvancedBatchButton,
            addAdvancedBatchStepButton,
            removeAdvancedBatchStepButton,
            saveAdvancedBatchButton,
            loadAdvancedBatchButton,
            createHelpTooltip('连续批量说明', [
              '每个步骤动作都有自己的关键词、孔洞颜色、品质类型和后续开关，任务会按步骤顺序执行。',
              '每个步骤会按顶部稀有度和目标数量锁定装备；普通装备先使用一次机会石，非普通装备跳过机会石并继续后续勾选操作。',
              '非暗金跳过开启时，只有实际使用机会石后仍不是暗金的装备会跳过孔洞、品质、花园工艺和瓦尔；开启自动丢弃时会直接丢弃。',
              '取消非暗金跳过后，机会石失败的装备也会继续执行本步骤后续操作，最后仍可按自动丢弃处理非暗金。',
              '保护高品质只在自动丢弃非暗金时生效；勾选后品质大于 21% 的非暗金不会丢弃，不勾选则照常丢弃。',
              '机会石后成为暗金的装备会按勾选项继续执行孔洞、品质补满、花园工艺和瓦尔。',
              '花园工艺在品质补满之后、瓦尔之前执行；催化剂最多使用 20 次或到接口提示后停止该装备的花园步骤并继续后续步骤，附魔类工艺只执行一次。',
              '腐化基底暗金存储会在自动丢弃非暗金之后执行；只有瓦尔前后都为暗金、且瓦尔后 affixes 里 type 为 8 的腐化属性新增或变化的装备会存入储藏处。',
              '保存高级配置只有一个槽位，保存的是所有步骤动作和顶部筛选参数。',
            ]),
          ],
        }),
      ],
    });
    const updateCraftAffixPickerVisibility = (tabId) => {
      saveCurrentContinuousStepSilently();
      const shouldShowAffixPicker = ['affixes', 'continuous'].includes(tabId);
      affixPickerSection.hidden = !shouldShowAffixPicker;
      if (!shouldShowAffixPicker) return;
      if (tabId === 'continuous') {
        loadContinuousCraftStepForEditing(false);
        return;
      }
      state.affixConditionContext = { mode: 'normal', stepIndex: 0 };
      renderAffixConditionBuilder();
    };
    const actionSection = createElement('div', {
      className: 'poe2-section',
      children: [
        createCraftSubTabs([
          { id: 'socket', label: '孔洞操作', children: [socketSection] },
          { id: 'affixes', label: '经典打造', children: [affixActionSection] },
          { id: 'continuous', label: '自定义打造', children: [continuousSection] },
          { id: 'batch', label: '批量通货', children: [batchSection] },
        ], updateCraftAffixPickerVisibility),
        affixPickerSection,
      ],
    });

    state.ui.mailReceiverInput = createElement('input', { className: 'poe2-input', placeholder: '收件人角色名' });
    state.ui.mailReceiverSuggestionList = createElement('div', { className: 'poe2-mail-suggestions' });
    state.ui.mailReceiverSuggestionList.hidden = true;
    state.ui.mailRecentReceiverList = createElement('div', { className: 'poe2-mail-recent-list' });
    state.ui.mailReceiverBox = createElement('div', {
      className: 'poe2-mail-receiver-box',
      children: [
        state.ui.mailReceiverInput,
        state.ui.mailReceiverSuggestionList,
      ],
    });
    state.ui.mailReceiverInput.addEventListener('input', handleMailReceiverInput);
    state.ui.mailReceiverInput.addEventListener('focus', handleMailReceiverInput);
    document.addEventListener('click', (event) => {
      if (!state.ui.mailReceiverBox?.contains(event.target)) hideMailReceiverSuggestions();
    });
    state.ui.mailTitleInput = createElement('input', { className: 'poe2-input', placeholder: '默认标题' });
    state.ui.mailContentInput = createElement('textarea', { className: 'poe2-input poe2-textarea', placeholder: '默认内容' });
    state.ui.mailPercentageInput = createElement('input', { className: 'poe2-range', type: 'range', value: '100' });
    state.ui.mailPercentageInput.min = '1';
    state.ui.mailPercentageInput.max = '100';
    state.ui.mailPercentageInput.step = '1';
    state.ui.mailPercentageValue = createElement('span', { className: 'poe2-range-value', textContent: '100%' });
    state.ui.mailPercentageInput.addEventListener('input', () => scheduleMailCurrencyPreview(false));
    state.ui.mailCurrencyPreview = createElement('div', {
      className: 'poe2-mail-currency-preview poe2-wide',
      textContent: '调整通货百分比后显示预计发送数量。',
    });
    const mailReceiverControl = createElement('div', {
      className: 'poe2-mail-field-stack',
      children: [
        state.ui.mailReceiverBox,
        state.ui.mailRecentReceiverList,
      ],
    });
    const mailPercentageControl = createElement('div', {
      className: 'poe2-range-row',
      children: [
        state.ui.mailPercentageInput,
        state.ui.mailPercentageValue,
      ],
    });
    renderRecentMailReceivers();
    scheduleMailCurrencyPreview(true);
    const refreshMailInventoryButton = createButton('刷新当前库存', () => runTask('刷新当前库存', refreshMailCurrencyInventory));
    const sendMailButton = createButton('发送通货邮件', () => runTask('发送通货邮件', sendCurrencyMail));
    sendMailButton.classList.add('poe2-success-button');
    const mailSection = createElement('div', {
      className: 'poe2-section poe2-grid',
      children: [
        createLabeledControl('收件人', mailReceiverControl),
        createLabeledControl('标题', state.ui.mailTitleInput),
        createLabeledControl('通货百分比', mailPercentageControl),
        createLabeledControl('内容', state.ui.mailContentInput),
        state.ui.mailCurrencyPreview,
        createElement('div', {
          className: 'poe2-actions poe2-wide',
          children: [sendMailButton, refreshMailInventoryButton],
        }),
      ],
    });

    state.ui.logList = createElement('div', { className: 'poe2-log-list' });
    const logSection = createElement('div', {
      className: 'poe2-section',
      children: [state.ui.logList],
    });

    panelElement.append(
      headerElement,
      createMainTabs({
        commonSection,
        craftPlanSection: state.ui.craftPlanSection,
        skillStoneSection: createSkillStoneSection(),
        systemManagementSection: createSystemManagementSection(),
        assistantBehaviorSection: createAssistantBehaviorSection(),
        equipmentUtilitySection: createEquipmentUtilitySection(),
        battleAnalysisSection: createBattleAnalysisSection(),
        skillTreeTransferSection: createSkillTreeTransferSection(),
        rankAnalysisSection: createRankAnalysisSection(),
        safetyLimitSection: createSafetyLimitSection(),
        actionSection,
        mailSection,
        logSection,
      }),
    );
    document.body.append(toggleButton, panelElement, createFracturedEquipmentModal());
    state.ui.toggleButton = toggleButton;
    state.ui.panel = panelElement;
    makeToggleButtonPositionable(toggleButton);
    makePanelDraggable(panelElement, headerElement);
    syncPanelVisibility();
    applyAssistantTheme();
    window.setInterval(() => {
      if (state.themeMode === THEME_MODES.auto && resolveAssistantTheme() !== state.resolvedTheme) {
        applyAssistantTheme();
      }
    }, 1500);
    setRunningState(false);
  };

  /**
   * initialize 启动脚本：注入样式、创建 UI、写入初始日志。
   */
  const initialize = () => {
    installStyles();
    buildUserInterface();
    addLog('助手 2.17 已加载。', 'compact');
    try {
      const importStatusText = sessionStorage.getItem(SKILL_TREE_IMPORT_STATUS_SESSION_KEY);
      if (importStatusText) {
        sessionStorage.removeItem(SKILL_TREE_IMPORT_STATUS_SESSION_KEY);
        const importStatus = JSON.parse(importStatusText);
        if (state.ui.skillTreeTransferSummary) state.ui.skillTreeTransferSummary.textContent = importStatus.message;
        addLog(importStatus.message, importStatus.success ? 'success' : 'error');
      }
    } catch (error) {
      console.warn('[AssistantV2] 读取天赋导入状态失败：', error);
    }
  };

  AssistantV2.initialize = initialize;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', AssistantV2.initialize, { once: true });
  } else {
    AssistantV2.initialize();
  }
})();

