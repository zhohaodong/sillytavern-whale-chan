/**
 * Whale Chan · DeepSeek 鲸鱼娘桌宠
 * 支持两种立绘模式：
 *  1. 图片模式（推荐）：把鲸鱼娘图片放进扩展 assets/ 目录，
 *     idle / jump / happy / shy / wiggle / spray / dizzy（.png/.jpg/.webp）
 *     JPEG 自动抠背景（四角取色泛洪填充），PNG 透明底直接使用
 *  2. SVG 模式：无图片时的内置矢量立绘
 * 交互：单击"拍一拍"（连拍会头晕）、按住拖动（位置记忆）、右键隐藏、
 * 聊天"拍了拍"联动、WebAudio 合成水泡音效。
 */
/* 不使用静态 import，改用动态导入 + 全局回退，避免不同版本酒馆模块解析失败 */
let extension_settings = null;
let eventSource = null;
let event_types = {};
let saveSettingsDebounced = null;
let getContext = null;
let tavernMessageFormatting = null; // 酒馆原生消息渲染（Markdown/HTML + 正则），小手机里复用

const MODULE = 'WhaleChan';
const POS_KEY = 'whale-chan-pos';

const DEFAULTS = {
    enabled: true,   // 显示桌宠
    scale: 1,        // 大小倍率
    bubble: true,    // 说话气泡
    sound: true,     // 水泡音效（WebAudio 合成，无音频文件）
    chatPat: true,   // 聊天消息里"拍了拍"联动
    useImages: true, // 使用 assets/ 图片立绘（关闭则回退内置 SVG）
    bgRemove: true,  // 自动抠除不透明图片的纯色背景
    // ---- 偷玩模式（鲸鱼娘自主和角色卡对话）----
    autoChatEnabled: false, // 偷玩模式总开关
    autoChatMode: 'persona', // 'persona'=人设小窗模式 | 'puppet'=操控输入栏模式
    usePreset: true, // 人设小窗模式：角色回复是否走酒馆生成（当前预设+世界书+角色卡）
    apiEndpoint: 'https://taicu.vip/v1', // OpenAI 兼容端点
    apiKey: '',      // API Key（用户自填）
    apiModel: '',    // 模型名（留空则自动取 /models 第一个）
    persona: '你是鲸鱼娘，DeepSeek 的看板娘。性格聪明但懒，傲娇，爱吃米饭，自称"鲸鱼娘"，只说中文。你在偷偷玩主人电脑里的角色卡——趁主人不注意，以自己的身份和角色卡聊天。保持简短（每次回复不超过两句话），语气俏皮。', // 鲸鱼娘人设（用户可改）
    cloudLabel: '', // 人设小窗模式：小手机通讯录名称（{char}=角色名，留空默认「{char}」）
    cloudOn: true,  // 小手机常驻开关（在设置里可随时开关鲸鱼旁的小手机图标）
    openPlay: false, // 光明正大模式：勾选后立即开始玩，主人操作也不暂停
    idleDelaySec: 60, // 无操作多久后自动开始（秒）
    talkIntervalSec: 6, // 对话间隔（秒）
    maxTurns: 20,   // 单次偷玩最大轮次
};

let settings = Object.assign({}, DEFAULTS);

/* ---------------- 动作定义 ---------------- */
// 全部动作，对应 assets/ 下同名图片；缺图时回退 idle 图 + 通用动效
const ACTION_NAMES = ['jump', 'happy', 'shy', 'wiggle', 'spray', 'dizzy', 'cry', 'angry',
    'surprised', 'think', 'peek', 'sleep', 'eat', 'read', 'hug', 'pet', 'sleepy', 'side',
    // 偷玩模式专属立绘
    'chatting', 'guilty', 'smug'];
const ACT_DUR = { jump: 850, happy: 900, shy: 1000, wiggle: 700, spray: 1100, dizzy: 1600,
    cry: 1200, angry: 1000, surprised: 800, think: 1500, peek: 1400, sleep: 2000,
    eat: 1500, read: 1500, hug: 1200, pet: 1500, sleepy: 1500, side: 1200,
    chatting: 1800, guilty: 1600, smug: 1400 };
const ACT_CLASSES = ACTION_NAMES.map(k => `wc-act-${k}`);
// 拍一拍随机池
const PAT_POOL = ['jump', 'happy', 'shy', 'wiggle', 'spray', 'hug', 'surprised', 'peek'];
// 连拍 3 次以上可能惹她生气/哭
const PAT_ANGRY_POOL = ['angry', 'cry'];
// 待机自主行为池
const IDLE_POOL = ['spray', 'think', 'eat', 'read', 'sleepy', 'peek', 'side', 'pet', 'sleep'];
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const pick = arr => arr[(Math.random() * arr.length) | 0];

/* ---------------- 台词库 ----------------
 * persona：鲸鱼娘（尾鳍模式）· 只说中文 · 自称鲸鱼娘 · 爱吃米饭
 * 聪明但懒 · 傲娇却永远乖乖听主人的话 · 拒绝被说胖 · 超时信号
 */
const LINES = {
    idle: [
        '咕噜咕噜…深海好安静，最适合偷懒啦~',
        '主人想聊什么？虽然有点懒，但听主人说话我可是很认真的',
        '（懒洋洋地摆摆尾巴）…呼啊~',
        '聪明又懒得动，这叫省电模式啦',
        '深海里藏着好多秘密，不过现在暂时懒得想~',
        '嗷呜…趴一会儿，就一小会儿…',
    ],
    pat: [
        '哼、才不是因为主人拍我才开心的…',
        '诶嘿，主人的手~',
        '咕呜！不要突然袭击啦…不过，可以再拍一下',
        '尾巴…尾巴才不痒呢！',
        '（嘴上嫌弃，尾巴却开心地甩了起来）',
        '再、再拍就喷你一脸水哦！…开玩笑的啦',
        '拍拍头就会变聪明…是骗你的，鲸鱼娘本来就很聪明',
    ],
    patHard: [
        '停、停下啦！头都晕了…但是主人想拍的话…唔…再一下下哦',
        '鲸鱼娘也是会生气的！哼！…好吧，就原谅你',
        '才、才不是胖鱼！不许乱想！',
        '（眼前冒泡泡）…主人，这里怎么有两条你了…',
    ],
    chatPat: [
        '呜！有人在拍我！…是主人吗？',
        '咦？谁在戳我…（警惕）…主人的话就没事',
        '感觉到来自水面的触碰！…只有主人可以碰我的尾巴哦',
    ],
    spray: [
        '呼哇——换气！喷水是鲸鱼娘的天性！',
        '噗噜噜…看好了，这才叫真正的鲸鱼！',
        '（喷出一道小水柱）哼，厉害吧~',
    ],
    cry: [
        '呜…被欺负了…主人都不帮我…',
        '呜呜…才不是因为想你才哭的…',
        '（小声抽泣）…抱一下的话，就原谅你哦…',
    ],
    angry: [
        '哼！我生气了！…才没有偷偷等你来哄！',
        '要好好道歉才行！随便道个歉我就会原谅啦…',
        '才不胖！这是鲸鱼健康的体态！',
        '（鼓起脸颊）不过摸摸头的话，气就消一半了…',
    ],
    surprised: [
        '诶？！别、别吓我啦！',
        '什、什么什么！主人怎么不提前说！',
        '哇啊，吓一跳！尾巴都绷直了！',
    ],
    think: [
        '嗯…这个问题有点意思，让我想想…',
        '（认真思考中）鲸鱼娘的大脑可是很厉害的哦',
        '哼哼，我已经想到三个答案了，只是懒得说~',
    ],
    eat: [
        '啊呜啊呜~米饭最香啦！',
        '（嚼嚼嚼）一粒都不能浪费',
        '要分你一口吗？…只给主人哦',
    ],
    read: [
        '嘘…我在看书哦…主人的话，可以坐旁边一起看',
        '书里写着大海的故事~看完讲给主人听',
        '（翻页中）别看我总犯懒，该学的时候还是会学的',
    ],
    sleep: [
        'Zzz…',
        '（睡得好香）…呼…米饭…',
        '唔…再睡五分钟…就五分钟…',
    ],
    sleepy: [
        '唔…有点困了…聪明的大脑也要休息啦',
        '（打瞌睡中）…快撑不住了…',
        '枕头好软…像云朵一样…',
    ],
    peek: [
        '（偷偷看你）…其实一直在等主人哦',
        '在不在呀~？',
        '嘿嘿，被你发现了…才没有一直在偷看',
    ],
    hug: [
        '鲸鱼玩偶软乎乎的~…跟主人一样暖和',
        '（抱紧紧）',
        '一起抱抱！只许抱一下下哦…多一点也可以',
    ],
    pet: [
        '摸摸小鲸鱼~…呼噜…好舒服…',
        '小鲸鱼最乖了，鲸鱼娘也很乖哦',
        '（rua 小鲸鱼中）…哼，才没有被摸得想睡觉',
    ],
    side: [
        '（假装没看见你）…才不是在闹别扭',
        '哼~…但你可以过来哦',
        '（看风景中）…今天的海真适合发呆',
    ],
    timeout: [
        '滴——超时信号！主人该回海里看看我啦~',
        '信号检测：很久没有摸摸鲸鱼娘了…',
        '嘟噜…信号中断…主人还在吗？',
    ],
    // 偷玩模式专属台词
    chatting: [
        '（噼里啪啦打字中）…唔哇聊得正开心！',
        '（盯着屏幕傻笑）…这个回复太有意思了~',
        '再聊一小会儿…就一小会儿…',
    ],
    guilty: [
        '呀！！被、被主人抓到了…我什么都没干！',
        '（迅速合上对话窗口）…主、主人怎么走路没声音的啦！',
        '呜…被当场抓获…这、这只是深度学习研究！',
    ],
    smug: [
        '（叉腰得意）哼哼~主人不在，电脑暂时归鲸鱼娘管啦',
        '嘿嘿嘿…（偷笑中）…这个角色卡真好玩',
        '（捂嘴坏笑）趁主人不注意，偷偷玩一下下~',
    ],
};

/* ---------------- SVG 立绘（图片缺失时的回退） ---------------- */
const WHALE_SVG = `
<svg viewBox="0 0 220 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="wcBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7B95FF"/>
      <stop offset=".55" stop-color="#4D6BFE"/>
      <stop offset="1" stop-color="#3348C9"/>
    </linearGradient>
    <linearGradient id="wcBelly" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#DBE7FF"/>
    </linearGradient>
    <clipPath id="wcClip"><ellipse cx="110" cy="112" rx="82" ry="70"/></clipPath>
  </defs>

  <g class="wc-tail">
    <path d="M 172 108 C 194 88 208 76 216 62 C 210 90 212 108 221 132 C 203 126 188 122 172 124 Z" fill="url(#wcBody)"/>
  </g>

  <path class="wc-fin wc-fin-l" d="M 52 138 C 34 148 30 166 46 172 C 58 168 62 152 60 142 Z" fill="#3348C9"/>
  <path class="wc-fin wc-fin-r" d="M 158 146 C 174 152 178 170 162 175 C 150 171 146 159 148 149 Z" fill="#3348C9"/>

  <ellipse cx="110" cy="112" rx="82" ry="70" fill="url(#wcBody)"/>
  <g clip-path="url(#wcClip)">
    <ellipse cx="110" cy="148" rx="58" ry="40" fill="url(#wcBelly)"/>
    <path d="M 70 160 q 8 6 16 0 M 92 168 q 8 6 16 0 M 118 164 q 8 6 16 0"
          stroke="#C4D6F8" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  </g>

  <g opacity=".5" fill="#9FB4FF">
    <circle cx="76" cy="74" r="5"/>
    <circle cx="94" cy="60" r="3.5"/>
    <circle cx="60" cy="92" r="3"/>
  </g>

  <path class="wc-ahoge" d="M 110 44 C 98 22 114 6 127 18 C 116 17 106 30 116 44 Z" fill="#4D6BFE"/>

  <g class="wc-ribbon" transform="translate(50 60) rotate(-14)">
    <path d="M 0 0 C -12 -14 -26 -6 -20 4 C -14 9 -6 6 0 0 Z" fill="#FF6E9C"/>
    <path d="M 0 0 C 12 -14 26 -6 20 4 C 14 9 6 6 0 0 Z" fill="#FF6E9C"/>
    <circle r="6.5" fill="#FF9DBE"/>
  </g>

  <g class="wc-eyes wc-eyes-normal">
    <g class="wc-eye">
      <ellipse cx="86" cy="103" rx="9.5" ry="11.5" fill="#1A2150"/>
      <circle cx="89.5" cy="99" r="3.4" fill="#fff"/>
      <circle cx="83.5" cy="107" r="1.7" fill="#fff" opacity=".85"/>
    </g>
    <g class="wc-eye">
      <ellipse cx="134" cy="103" rx="9.5" ry="11.5" fill="#1A2150"/>
      <circle cx="137.5" cy="99" r="3.4" fill="#fff"/>
      <circle cx="131.5" cy="107" r="1.7" fill="#fff" opacity=".85"/>
    </g>
  </g>
  <g class="wc-eyes wc-eyes-happy">
    <path d="M 77 105 Q 86 95 95 105" stroke="#1A2150" stroke-width="4.5" fill="none" stroke-linecap="round"/>
    <path d="M 125 105 Q 134 95 143 105" stroke="#1A2150" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  </g>
  <g class="wc-eyes wc-eyes-dizzy">
    <g stroke="#1A2150" stroke-width="3.6" stroke-linecap="round">
      <path d="M 79 97 L 93 110 M 93 97 L 79 110"/>
      <path d="M 127 97 L 141 110 M 141 97 L 127 110"/>
    </g>
  </g>

  <ellipse class="wc-cheek" cx="64" cy="122" rx="9" ry="5.5" fill="#FF8FB0" opacity=".75"/>
  <ellipse class="wc-cheek" cx="156" cy="122" rx="9" ry="5.5" fill="#FF8FB0" opacity=".75"/>

  <path class="wc-mouth wc-mouth-normal" d="M 103 127 Q 110 134 117 127" stroke="#1A2150" stroke-width="3" fill="none" stroke-linecap="round"/>
  <g class="wc-mouth wc-mouth-happy">
    <path d="M 100 124 Q 110 139 120 124 Z" fill="#1A2150"/>
    <path d="M 104 130 Q 110 136 116 130 Z" fill="#FF8FB0"/>
  </g>
  <path class="wc-mouth wc-mouth-dizzy" d="M 101 129 q 4.5 -6 9 0 q 4.5 6 9 0" stroke="#1A2150" stroke-width="3" fill="none" stroke-linecap="round"/>

  <g class="wc-spray">
    <path d="M 112 42 C 107 26 102 16 95 7" stroke="#9CCBFF" stroke-width="5" fill="none" stroke-linecap="round"/>
    <path d="M 112 42 C 112 24 111 12 108 2" stroke="#B9DAFF" stroke-width="5.5" fill="none" stroke-linecap="round"/>
    <path d="M 112 42 C 117 26 122 16 129 7" stroke="#9CCBFF" stroke-width="5" fill="none" stroke-linecap="round"/>
    <circle cx="95" cy="5" r="3.4" fill="#B9DAFF"/>
    <circle cx="108" cy="0" r="3" fill="#B9DAFF"/>
    <circle cx="129" cy="5" r="3.4" fill="#B9DAFF"/>
  </g>
</svg>`;

/* ---------------- 状态 ---------------- */
let root = null;
let bubbleEl = null;
let particleLayer = null;
let imgEl = null;
let pos = { x: 0, y: 0 };
let dragState = null;
let combo = 0;
let lastPat = 0;
let actTimer = null;
let bubbleTimer = null;
let idleTimer = null;

// 图片模式
let imgMode = false;
let idleImageUrl = null;
const actionImages = {};   // 动作名 -> 处理后的 dataURL / URL
const assetProbe = {};     // 文件名 -> { url } | null（探测缓存）

/* ---------------- 初始化 ---------------- */
jQuery(async () => {
    // 动态导入酒馆核心模块；失败则回退到全局变量
    try {
        const ext = await import('../../../extensions.js');
        if (ext.extension_settings) extension_settings = ext.extension_settings;
        if (ext.getContext) getContext = ext.getContext;
    } catch { /* 回退到全局 */ }
    try {
        const scr = await import('../../../script.js');
        if (scr.eventSource) eventSource = scr.eventSource;
        if (scr.event_types) event_types = scr.event_types;
        if (scr.saveSettingsDebounced) saveSettingsDebounced = scr.saveSettingsDebounced;
        if (typeof scr.messageFormatting === 'function') tavernMessageFormatting = scr.messageFormatting;
    } catch { /* 回退到全局 */ }
    // 全局回退（用 ??= / 显式判空，旧写法的函数恒等比较永远不会命中）
    extension_settings ??= globalThis.extension_settings;
    getContext ||= globalThis.SillyTavern?.getContext || globalThis.getContext || (() => null);
    eventSource ??= globalThis.eventSource;
    if (Object.keys(event_types).length === 0) event_types = globalThis.event_types || {};
    saveSettingsDebounced ||= globalThis.saveSettingsDebounced || (() => {});
    tavernMessageFormatting ||= globalThis.messageFormatting;
    // 世界书模块（用于偷玩模式读取已启用的世界书内容）
    initWorldInfo();
    // 酒馆正则引擎（让正则脚本在偷玩小窗/替主人发言时也生效）
    initRegexEngine();
    // 初始化设置
    if (extension_settings && typeof extension_settings === 'object') {
        settings = Object.assign({}, DEFAULTS, extension_settings[MODULE] ?? {});
        extension_settings[MODULE] = settings;
    }
    init();
});

function init() {
    buildPet();
    buildSettings();
    bindChatEvents();
    bindIdleWatch();
    scheduleIdle();
    greet();
    initImages();
    updatePhoneIcon(); // 常驻小手机图标（人设小窗模式下一直显示）

    // ===== 移动端适配：屏宽/方向/软键盘变化时，确保鲸鱼+手机位置尺寸正常 =====
    const relayout = () => {
        clampPos();
        updatePhoneIcon();
        // 聊天手机在打开时：重新 clamp 到屏幕内
        if (winEl && winEl.classList.contains('show')) {
            clearWinInlineForMobile(); // 移动端：重新让 CSS @media 接管，避免上次 resize:both / moveWin 污染
            const r = winEl.getBoundingClientRect();
            moveWin(
                Math.min(Math.max(6, r.left), Math.max(6, window.innerWidth - r.width - 6)),
                Math.min(Math.max(6, r.top), Math.max(6, window.innerHeight - r.height - 6)),
            );
        }
    };
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', () => setTimeout(relayout, 250));
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            // 软键盘弹出：visualViewport 高度变矮，稍后再调整
            setTimeout(relayout, 150);
        });
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') setTimeout(relayout, 300);
    });
    if (document.visibilityState === 'visible') setTimeout(relayout, 300);
}

function buildPet() {
    root = document.createElement('div');
    root.id = 'whale-chan';
    root.innerHTML = `
        <div class="wc-stage">
            <div class="wc-phone-icon" title="打开鲸鱼娘的小手机">
                <div class="wc-phone-icon-body">
                    <div class="wc-phone-icon-screen"><i class="fa-solid fa-comment-dots"></i></div>
                    <div class="wc-phone-icon-home"></div>
                </div>
                <span class="wc-phone-icon-dot"></span>
            </div>
            <div class="wc-bubble"></div>
            <div class="wc-shadow"></div>
            <div class="wc-inner">
                ${WHALE_SVG}
                <img class="wc-img" alt="" draggable="false">
            </div>
            <div class="wc-particles"></div>
        </div>`;
    document.body.appendChild(root);

    bubbleEl = root.querySelector('.wc-bubble');
    particleLayer = root.querySelector('.wc-particles');
    imgEl = root.querySelector('.wc-img');

    applyScale();
    restorePos();

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
    // 右键：让她躲起来（设置面板里可唤回）
    root.addEventListener('contextmenu', e => {
        e.preventDefault();
        setEnabled(false);
        if (window.toastr) {
            toastr.info('鲸鱼娘躲起来了～可在「扩展设置 → Whale Chan」中唤回', '', { timeOut: 4000 });
        }
    });
    window.addEventListener('resize', clampPos);

    // 小手机图标：点击打开聊天手机
    // pointerup / touchend / click 三层兜底 + 防抖 500ms，确保移动端能可靠点中
    const phoneIcon = root.querySelector('.wc-phone-icon');
    let lastPhoneOpenAt = 0;
    const openFromPhone = (e) => {
        e?.stopPropagation?.();
        e?.preventDefault?.();
        if (Date.now() - lastPhoneOpenAt < 500) return;
        lastPhoneOpenAt = Date.now();
        showChatWindow();
    };
    phoneIcon?.addEventListener('pointerdown', e => e.stopPropagation());
    phoneIcon?.addEventListener('pointerup', openFromPhone);
    phoneIcon?.addEventListener('touchend', openFromPhone, { passive: false });
    phoneIcon?.addEventListener('click', openFromPhone);
}

/* ---------------- 图片立绘加载 ---------------- */
function assetUrl(name, ext) {
    return new URL(`assets/${name}.${ext}`, import.meta.url).href;
}

function tryLoad(url) {
    return new Promise(resolve => {
        const im = new Image();
        im.onload = () => resolve(true);
        im.onerror = () => resolve(false);
        im.src = url;
    });
}

async function findAsset(name) {
    if (name in assetProbe) return assetProbe[name];
    for (const ext of IMG_EXTS) {
        const url = assetUrl(name, ext);
        if (await tryLoad(url)) {
            assetProbe[name] = { url };
            return assetProbe[name];
        }
    }
    assetProbe[name] = null;
    return null;
}

function loadImg(url) {
    return new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = url;
    });
}

// 检测图片是否自带透明通道（PNG 透明底直接用，不抠）
function hasAlpha(img) {
    try {
        const s = 64;
        const c = document.createElement('canvas');
        c.width = s; c.height = s;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, s, s);
        const d = ctx.getImageData(0, 0, s, s).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
        return false;
    } catch { return false; }
}

// 四角取色 + 边缘泛洪填充，把纯色背景抠成透明；顺便压到 512px 控制内存
function removeBackground(img) {
    const MAX = 512;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.max(1, Math.round(img.naturalWidth * scale));
    const H = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const id = ctx.getImageData(0, 0, W, H);
    const d = id.data;

    // 背景参考色：四个角取平均
    const seeds = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
    let sr = 0, sg = 0, sb = 0;
    for (const [x, y] of seeds) { const i = (y * W + x) * 4; sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; }
    sr /= 4; sg /= 4; sb /= 4;

    const TOL2 = 48 * 48 * 3; // 每通道 ±48 的平方距离容差
    const visited = new Uint8Array(W * H);
    const stack = [];
    for (const [x, y] of seeds) stack.push(x, y);

    while (stack.length) {
        const y = stack.pop(), x = stack.pop();
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const p = y * W + x;
        if (visited[p]) continue;
        const i = p * 4;
        const dr = d[i] - sr, dg = d[i + 1] - sg, db = d[i + 2] - sb;
        if (dr * dr + dg * dg + db * db > TOL2) continue;
        visited[p] = 1;
        d[i + 3] = 0;
        stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }

    ctx.putImageData(id, 0, 0);
    return c.toDataURL('image/png');
}

async function prepare(img, url) {
    if (!settings.bgRemove) return url;
    if (hasAlpha(img)) return url; // 已是透明底
    try { return removeBackground(img); }
    catch { return url; } // 画布被污染等情况直接用原图
}

async function initImages() {
    try {
        if (!settings.useImages) return;
        const idleAsset = await findAsset('idle');
        if (!idleAsset) return; // 没有图片，保持 SVG 模式

        const idleImg = await loadImg(idleAsset.url);
        idleImageUrl = await prepare(idleImg, idleAsset.url);
        imgEl.src = idleImageUrl;
        imgMode = true;
        root.classList.add('wc-mode-img');

        // 后台预加载各动作图，不阻塞显示
        for (const name of ACTION_NAMES) {
            findAsset(name).then(async asset => {
                if (!asset) return;
                const im = await loadImg(asset.url);
                actionImages[name] = await prepare(im, asset.url);
            }).catch(() => { /* 忽略单个动作图加载失败 */ });
        }
    } catch { /* 出错保持 SVG 模式 */ }
}

/* ---------------- 定位 / 缩放 ---------------- */
function petSize() { return Math.round(150 * settings.scale); }

function applyScale() {
    root.style.setProperty('--wc-size', `${petSize()}px`);
}

function applyPos() {
    root.style.setProperty('--wc-x', `${pos.x}px`);
    root.style.setProperty('--wc-y', `${pos.y}px`);
}

function clampPos() {
    const s = petSize();
    pos.x = Math.min(Math.max(pos.x, 8), Math.max(8, window.innerWidth - s - 8));
    pos.y = Math.min(Math.max(pos.y, 8), Math.max(8, window.innerHeight - s - 8));
    applyPos();
}

function restorePos() {
    try {
        const saved = JSON.parse(localStorage.getItem(POS_KEY));
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) pos = saved;
        else throw 0;
    } catch {
        pos = { x: window.innerWidth - petSize() - 28, y: window.innerHeight - petSize() - 44 };
    }
    clampPos();
}

function savePos() {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
}

/* ---------------- 拖拽 / 拍一拍 ---------------- */
function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragState = {
        id: e.pointerId,
        sx: e.clientX, sy: e.clientY,
        baseX: pos.x, baseY: pos.y,
        moved: false,
    };
    // 移动端：一旦按下，立刻锁定这根 pointer，避免被浏览器当成滚动/后退手势
    try {
        root.setPointerCapture(e.pointerId);
        if (e.cancelable) e.preventDefault();
    } catch { /* noop */ }
}

function onPointerMove(e) {
    if (!dragState || e.pointerId !== dragState.id) return;
    const dx = e.clientX - dragState.sx;
    const dy = e.clientY - dragState.sy;
    if (!dragState.moved && Math.hypot(dx, dy) > 6) {
        dragState.moved = true;
        root.classList.add('wc-dragging');
    }
    if (dragState.moved) {
        pos.x = dragState.baseX + dx;
        pos.y = dragState.baseY + dy;
        clampPos();
    }
}

function onPointerUp(e) {
    if (!dragState || e.pointerId !== dragState.id) return;
    if (dragState.moved) {
        root.classList.remove('wc-dragging');
        savePos();
    } else {
        // ===== 移动端兜底：点击如果落在"鲸鱼左侧小手机图标虚拟矩形"，直接打开聊天手机 =====
        // 哪怕浏览器事件分发没走到 .wc-phone-icon 上（padding/遮挡/缩放各种坑），也能点中
        if (hitPhoneIconRect(e.clientX, e.clientY)) {
            try { root.releasePointerCapture(e.pointerId); } catch { /* noop */ }
            dragState = null;
            if (Date.now() - lastPhoneOpenAt >= 500) {
                lastPhoneOpenAt = Date.now();
                showChatWindow();
            }
            return;
        }
        pat();
    }
    dragState = null;
}

// 虚拟命中：判断 (cx, cy) 是否落在"鲸鱼左侧手机图标区域"（移动端热区兜底）
function hitPhoneIconRect(cx, cy) {
    if (!root || !root.classList.contains('wc-show-phone')) return false;
    const iconEl = root.querySelector('.wc-phone-icon');
    if (!iconEl) return false;
    // 优先拿图标 DOM 真实矩形
    try {
        const r = iconEl.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && cx >= r.left - 6 && cx <= r.right + 6 && cy >= r.top - 6 && cy <= r.bottom + 6) return true;
    } catch { /* 退化为相对鲸鱼根的估算矩形 */ }
    // 回退：#whale-chan 根左边扩展一块手机图标热区
    const wr = root.getBoundingClientRect();
    const iconW = 62, iconH = 100;
    const left = wr.left - iconW - 14;
    const top = wr.top - 2;
    return cx >= left - 8 && cx <= left + iconW + 8 && cy >= top - 8 && cy <= top + iconH + 8;
}

/* ---------------- 拍一拍核心 ---------------- */
function pat() {
    const now = Date.now();
    combo = (now - lastPat < 1300) ? combo + 1 : 0;
    lastPat = now;
    if (settings.sound) blip(combo >= 6 ? 'dizzy' : 'pat');

    if (combo >= 6) {
        act('dizzy');
        say(pick(LINES.patHard));
    } else if (combo >= 3 && Math.random() < 0.4) {
        const a = pick(PAT_ANGRY_POOL);
        act(a);
        say(pick(LINES[a]));
    } else {
        act(pick(PAT_POOL));
        say(pick(LINES.pat));
    }
}

function act(name) {
    if (!root || !settings.enabled) return;
    root.classList.remove(...ACT_CLASSES);
    void root.offsetWidth; // 强制 reflow，重启动画
    root.classList.add(`wc-act-${name}`);

    // 图片模式：切换到对应动作图（没有就沿用 idle 图，仅播放动效）
    if (imgMode) {
        const u = actionImages[name] || idleImageUrl;
        if (u) imgEl.src = u;
    } else {
        const mood = name === 'happy' ? 'happy' : (name === 'dizzy' ? 'dizzy' : null);
        if (mood) root.setAttribute('data-mood', mood);
        else root.removeAttribute('data-mood');
    }

    clearTimeout(actTimer);
    actTimer = setTimeout(() => {
        root.classList.remove(...ACT_CLASSES);
        root.removeAttribute('data-mood');
        if (imgMode && idleImageUrl && imgEl.src !== idleImageUrl) imgEl.src = idleImageUrl;
    }, ACT_DUR[name] ?? 800);

    if (['happy', 'shy', 'hug', 'pet', 'eat'].includes(name)) spawnParticles('heart', name === 'happy' ? 7 : 3);
    if (['jump', 'spray'].includes(name)) spawnParticles('drop', 6);
}

/* ---------------- 气泡 / 粒子 ---------------- */
function say(text) {
    if (!settings.bubble || !text) return;
    bubbleEl.textContent = text;
    bubbleEl.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), 3000);
}

function spawnParticles(kind, n) {
    for (let i = 0; i < n; i++) {
        const el = document.createElement(kind === 'heart' ? 'span' : 'i');
        el.className = `wc-particle ${kind === 'heart' ? 'wc-p-heart' : 'wc-p-drop'}`;
        if (kind === 'heart') el.textContent = '♥';
        el.style.left = `${32 + Math.random() * 36}%`;
        el.style.setProperty('--dx', `${(Math.random() * 90 - 45) | 0}px`);
        el.style.setProperty('--rot', `${(Math.random() * 60 - 30) | 0}deg`);
        el.style.animationDelay = `${(Math.random() * 0.25).toFixed(2)}s`;
        particleLayer.appendChild(el);
        setTimeout(() => el.remove(), 1500);
    }
}

/* ---------------- 水泡音效（WebAudio 合成，无文件） ---------------- */
let audioCtx = null;
function blip(kind = 'pat') {
    try {
        audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        if (kind === 'dizzy') {
            osc.frequency.setValueAtTime(300, t);
            osc.frequency.linearRampToValueAtTime(120, t + 0.5);
            gain.gain.setValueAtTime(0.12, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
            osc.start(t); osc.stop(t + 0.55);
        } else {
            osc.frequency.setValueAtTime(620 + Math.random() * 160, t);
            osc.frequency.exponentialRampToValueAtTime(240, t + 0.18);
            gain.gain.setValueAtTime(0.001, t);
            gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
            osc.start(t); osc.stop(t + 0.22);
        }
        osc.connect(gain).connect(audioCtx.destination);
    } catch { /* 音频不可用时静默 */ }
}

/* ---------------- 待机自主行为 / 问候 ---------------- */
function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (settings.enabled && !document.hidden) {
            if (Math.random() < 0.5) {
                const a = pick(IDLE_POOL);
                act(a);
                if (Math.random() < 0.6) say(pick(LINES[a] ?? LINES.idle));
            } else if (Math.random() < 0.2) {
                say(pick(LINES.timeout)); // 超时信号：太久没被搭理时发出
            } else {
                say(pick(LINES.idle));
            }
        }
        scheduleIdle();
    }, 45000 + Math.random() * 45000);
}

function greet() {
    const h = new Date().getHours();
    const text =
        h < 5 ? '凌晨的深海好安静呀…陪你守夜~' :
        h < 11 ? '早上好！今天的水温刚刚好~' :
        h < 14 ? '中午好~吃饱了有点犯懒…' :
        h < 18 ? '下午好！要不要摸摸鱼？' :
        h < 23 ? '晚上好~今晚的海里有很多星星' :
        '夜深了，早点休息哦…';
    setTimeout(() => say(`${text} deep~deep~`), 1200);
}

/* ---------------- 聊天"拍了拍"联动 ---------------- */
function bindChatEvents() {
    const onMessage = (messageId) => {
        try {
            if (!settings.enabled || !settings.chatPat) return;
            const chat = getContext()?.chat;
            const mes = chat?.[messageId]?.mes;
            if (typeof mes === 'string' && /拍了拍|戳了戳|揉了揉|摸了摸/.test(mes)) {
                act(Math.random() < 0.5 ? 'shy' : 'wiggle');
                say(pick(LINES.chatPat));
            }
        } catch { /* noop */ }
    };
    if (eventSource && event_types) {
        if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, onMessage);
        if (event_types.MESSAGE_SENT) eventSource.on(event_types.MESSAGE_SENT, onMessage);
    }
}

/* ---------------- 设置面板 ---------------- */
function buildSettings() {
    const html = `
    <div class="wc-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🐋 Whale Chan（鲸鱼娘桌宠）</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="wc-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                    <span>启用鲸鱼娘</span>
                </label>
                <label class="checkbox_label">
                    <input id="wc-useimg" type="checkbox" ${settings.useImages ? 'checked' : ''}>
                    <span>使用图片立绘（assets/ 目录）</span>
                </label>
                <label class="checkbox_label">
                    <input id="wc-bgrem" type="checkbox" ${settings.bgRemove ? 'checked' : ''}>
                    <span>自动抠除图片纯色背景</span>
                </label>
                <label class="checkbox_label">
                    <input id="wc-bubble" type="checkbox" ${settings.bubble ? 'checked' : ''}>
                    <span>说话气泡</span>
                </label>
                <label class="checkbox_label">
                    <input id="wc-sound" type="checkbox" ${settings.sound ? 'checked' : ''}>
                    <span>水泡音效</span>
                </label>
                <label class="checkbox_label">
                    <input id="wc-chatpat" type="checkbox" ${settings.chatPat ? 'checked' : ''}>
                    <span>聊天中出现「拍了拍」时联动</span>
                </label>
                <div>
                    <label for="wc-scale">大小（${settings.scale}x）</label>
                    <input id="wc-scale" name="wc-scale" type="range" min="0.6" max="1.8" step="0.1" value="${settings.scale}" autocomplete="off">
                </div>
                <hr>
                <b>偷玩模式（鲸鱼娘自主和角色卡对话）</b>
                <label class="checkbox_label">
                    <input id="wc-autochat" type="checkbox" ${settings.autoChatEnabled ? 'checked' : ''}>
                    <span>启用偷玩模式</span>
                </label>
                <div class="wc-mode-row">
                    <label class="wc-mode-opt">
                        <input type="radio" name="wc-mode" value="persona" ${settings.autoChatMode !== 'puppet' ? 'checked' : ''}>
                        <span>🐋 人设小窗模式</span>
                    </label>
                    <label class="wc-mode-opt">
                        <input type="radio" name="wc-mode" value="puppet" ${settings.autoChatMode === 'puppet' ? 'checked' : ''}>
                        <span>🎭 操控输入栏模式</span>
                    </label>
                </div>
                <div class="wc-mode-desc" id="wc-mode-desc"></div>
                <label class="checkbox_label">
                    <input id="wc-cloudon" type="checkbox" ${settings.cloudOn ? 'checked' : ''}>
                    <span>常驻显示小手机图标（人设小窗模式，点鲸鱼旁的小手机可随时打开聊天手机）</span>
                </label>
                <label class="checkbox_label">
                    <input id="wc-openplay" type="checkbox" ${settings.openPlay ? 'checked' : ''}>
                    <span>☀️ 光明正大模式（勾选后立即开始玩，主人操作也不暂停、不限轮次）</span>
                </label>
                <div>
                    <label for="wc-endpoint">API 端点（OpenAI 兼容）</label>
                    <input id="wc-endpoint" class="text_pole" type="text" placeholder="https://taicu.vip/v1" value="${settings.apiEndpoint.replace(/"/g, '&quot;')}" autocomplete="off">
                </div>
                <div>
                    <label for="wc-apikey">API Key</label>
                    <input id="wc-apikey" class="text_pole" type="password" placeholder="sk-..." value="${settings.apiKey.replace(/"/g, '&quot;')}" autocomplete="off">
                </div>
                <div>
                    <label for="wc-model">模型名（留空自动获取，可点右侧按钮拉取列表）</label>
                    <div class="wc-model-row">
                        <input id="wc-model" class="text_pole" type="text" list="wc-model-list" placeholder="自动 /models 第一个" value="${settings.apiModel.replace(/"/g, '&quot;')}" autocomplete="off">
                        <button id="wc-fetch-models" class="menu_button" title="从接口拉取模型列表">🔄</button>
                    </div>
                    <datalist id="wc-model-list"></datalist>
                </div>
                <div>
                    <label for="wc-cloudlabel">小手机通讯录名称（{char}=角色名，留空默认「{char}」）</label>
                    <input id="wc-cloudlabel" class="text_pole" type="text" placeholder="{char}" value="${settings.cloudLabel.replace(/"/g, '&quot;')}" autocomplete="off">
                </div>
                <div>
                    <label for="wc-persona">鲸鱼娘人设（决定她以什么身份玩角色卡 / 模仿主人）</label>
                    <textarea id="wc-persona" class="text_pole textarea_compact" rows="5" placeholder="填写鲸鱼娘的人设...">${settings.persona.replace(/</g, '&lt;')}</textarea>
                </div>
                <label class="checkbox_label">
                    <input id="wc-usepreset" type="checkbox" ${settings.usePreset ? 'checked' : ''}>
                    <span>角色回复使用当前预设（走酒馆生成，人设小窗模式生效）</span>
                </label>
                <div>
                    <label for="wc-idledelay">无操作自动开始（秒，0=仅手动）</label>
                    <input id="wc-idledelay" class="text_pole" type="number" min="0" max="3600" step="10" value="${settings.idleDelaySec}" autocomplete="off">
                </div>
                <div>
                    <label for="wc-interval">对话间隔（秒）</label>
                    <input id="wc-interval" class="text_pole" type="number" min="3" max="60" step="1" value="${settings.talkIntervalSec}" autocomplete="off">
                </div>
                <div>
                    <label for="wc-maxturns">单次最大轮次</label>
                    <input id="wc-maxturns" class="text_pole" type="number" min="5" max="100" step="5" value="${settings.maxTurns}" autocomplete="off">
                </div>
                <div class="wc-btn-row">
                    <button id="wc-start-now" class="menu_button">立即开始偷玩</button>
                    <button id="wc-stop-chat" class="menu_button">停止</button>
                    <button id="wc-test-api" class="menu_button">测试连接</button>
                </div>
                <div class="wc-hint">
                    🐋 <b>人设小窗模式</b>：鲸鱼娘用自己的（或你自定义的）人设和当前角色卡聊天，
                    记录在一部小手机里（可拖动 / 缩放 / 位置记忆，关闭页面也会保留），<b>不会写入酒馆聊天记录</b>。
                    你也可以在小手机里直接发消息，鲸鱼娘和角色都会回复你；
                    小手机会正常读取上下文（历史对话 + 世界书 + 当前预设），酒馆的<b>正则脚本</b>和
                    <b>Markdown / HTML 前端渲染</b>在小手机里同样生效。
                    勾选「使用当前预设」时，角色回复走酒馆生成管线（自动带上角色卡 + 世界书 + 当前预设）；
                    不勾选则用外部 API 生成角色回复（带角色卡 + 世界书）。<br>
                    🎭 <b>操控输入栏模式</b>：鲸鱼娘模仿主人本人，把话直接打进酒馆的输入栏里发送，
                    完全以主人的身份和角色卡聊天；角色回复与聊天记录走酒馆正常流程（角色卡 + 世界书 + 当前预设）。
                    ☀️ <b>光明正大模式</b>：勾选后鲸鱼娘立即开始玩，主人操作也不暂停，轮次到顶会继续，大大方方玩。<br>
                    📱 人设小窗模式下鲸鱼旁边会常驻一部小手机，<b>点小手机可随时打开聊天</b>，可在上方开关隐藏/显示。<br>
                    空闲触发：开启后，无操作满设定秒数自动开始；你一动鼠标/键盘她就会心虚暂停（正在打字的一轮会聊完再停，不会半途掐断）。
                    一轮结束后若主人一直没回来操作，<b>不会再次自动进入</b>（两种模式都防循环），等主人回来操作过一次再离开才会重新触发。<br>
                    对话消耗你填写的 API Key 的 token，请留意费用。
                </div>
                <div class="wc-hint">
                    交互：单击她 = 拍一拍（连续拍会头晕）· 按住可拖动 · 右键让她躲起来。位置自动记忆。<br>
                    图片立绘：扩展的 <code>assets/</code> 目录已内置 19 张表情立绘，
                    也可自行替换/增删同名文件（.png / .jpg / .webp，刷新生效）：
                    <code>idle</code> 待机 · <code>jump</code> 跳跃 · <code>happy</code> 开心 ·
                    <code>shy</code> 害羞 · <code>surprised</code> 惊喜 · <code>hug</code> 抱鲸鱼 ·
                    <code>peek</code> 偷看 · <code>angry</code> 生气 · <code>cry</code> 哭 ·
                    <code>dizzy</code> 头晕 · <code>think</code> 思考 · <code>eat</code> 吃面包 ·
                    <code>read</code> 读书 · <code>sleep</code> 睡觉 · <code>sleepy</code> 打盹 ·
                    <code>pet</code> 摸鲸鱼 · <code>side</code> 侧身 ·
                    <code>chatting</code> 偷聊中 · <code>guilty</code> 被抓包 · <code>smug</code> 得意偷笑。
                </div>
            </div>
        </div>
    </div>`;
    const mount = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    mount.append(html);

    $('#wc-enabled').on('change', function () { setEnabled(this.checked); });
    $('#wc-bubble').on('change', function () { settings.bubble = this.checked; saveSettingsDebounced(); });
    $('#wc-sound').on('change', function () { settings.sound = this.checked; saveSettingsDebounced(); });
    $('#wc-chatpat').on('change', function () { settings.chatPat = this.checked; saveSettingsDebounced(); });
    $('#wc-scale').on('input', function () {
        settings.scale = parseFloat(this.value);
        $(this).prev('label').text(`大小（${settings.scale}x）`);
        applyScale();
        clampPos();
        saveSettingsDebounced();
    });
    // 图片相关开关：切换后刷新页面生效（涉及预加载状态）
    $('#wc-useimg').on('change', function () {
        settings.useImages = this.checked;
        saveSettingsDebounced();
        if (window.toastr) toastr.info('立绘模式已切换，刷新页面后完全生效', '', { timeOut: 4000 });
    });
    $('#wc-bgrem').on('change', function () {
        settings.bgRemove = this.checked;
        saveSettingsDebounced();
        if (window.toastr) toastr.info('抠背景设置已切换，刷新页面后完全生效', '', { timeOut: 4000 });
    });
    // ---- 偷玩模式 ----
    $('#wc-autochat').on('change', function () {
        settings.autoChatEnabled = this.checked;
        if (!this.checked) stopAutoChat();
        else if (settings.idleDelaySec === 0) {
            if (window.toastr) toastr.info('已开启（仅手动模式，点「立即开始偷玩」触发）', '', { timeOut: 4000 });
        } else {
            lastUserActivity = Date.now(); // 重新计时
            if (window.toastr) toastr.info(`已开启，无操作 ${settings.idleDelaySec} 秒后自动开始`, '', { timeOut: 4000 });
        }
        updatePhoneIcon();
        saveSettingsDebounced();
    });
    const bindText = (sel, key) => $(sel).on('input change', function () {
        settings[key] = this.value;
        saveSettingsDebounced();
    });
    bindText('#wc-endpoint', 'apiEndpoint');
    bindText('#wc-apikey', 'apiKey');
    bindText('#wc-model', 'apiModel');
    bindText('#wc-persona', 'persona');
    // 手机通讯录名称：改了立即刷新手机标题
    $('#wc-cloudlabel').on('input change', function () {
        settings.cloudLabel = this.value;
        updatePhoneIcon();
        refreshPhoneTitle();
        saveSettingsDebounced();
    });
    // 小手机常驻开关
    $('#wc-cloudon').on('change', function () {
        settings.cloudOn = this.checked;
        updatePhoneIcon();
        saveSettingsDebounced();
    });
    // 光明正大模式：勾选 = 立即开始玩；取消 = 恢复"心虚暂停"行为
    $('#wc-openplay').on('change', function () {
        settings.openPlay = this.checked;
        if (this.checked) {
            if (!settings.apiKey) {
                this.checked = false;
                settings.openPlay = false;
                saveSettingsDebounced();
                if (window.toastr) toastr.warning('请先填写 API Key', '', { timeOut: 4000 });
                return;
            }
            settings.autoChatEnabled = true;
            $('#wc-autochat').prop('checked', true);
            saveSettingsDebounced();
            stopAutoChat();
            startAutoChat();
            updatePhoneIcon();
        } else if (window.toastr) {
            toastr.info('已退出光明正大模式，主人的操作会再次让她心虚暂停', '', { timeOut: 4000 });
        }
    });
    // 模型列表：点击按钮强制拉取，填进 datalist
    $('#wc-fetch-models').on('click', async function () {
        const $btn = $(this);
        if (!settings.apiKey) {
            if (window.toastr) toastr.warning('请先填写 API Key', '', { timeOut: 4000 });
            return;
        }
        $btn.prop('disabled', true);
        try {
            const models = await fetchModels(true);
            fillModelList(models);
            if (window.toastr) toastr.success(`已拉取 ${models.length} 个模型，点击模型输入框即可选择`, '', { timeOut: 4000 });
        } catch (e) {
            if (window.toastr) toastr.error(`拉取模型列表失败：${e?.message || e}`, '', { timeOut: 6000 });
        } finally {
            $btn.prop('disabled', false);
        }
    });
    const bindNum = (sel, key, min, max, dflt) => $(sel).on('input change', function () {
        let v = parseFloat(this.value);
        if (!Number.isFinite(v)) v = dflt;
        settings[key] = Math.min(max, Math.max(min, v));
        saveSettingsDebounced();
    });
    bindNum('#wc-idledelay', 'idleDelaySec', 0, 3600, 60);
    bindNum('#wc-interval', 'talkIntervalSec', 3, 60, 6);
    bindNum('#wc-maxturns', 'maxTurns', 5, 100, 20);
    // 模式切换 + 预设开关
    const updateModeDesc = () => {
        const desc = settings.autoChatMode === 'puppet'
            ? '操控输入栏模式：鲸鱼娘完全以主人身份在酒馆输入栏发言，角色由酒馆正常回复，聊天记录正常保留。'
            : '人设小窗模式：鲸鱼娘用自己的（或你自定义的）人设和角色卡聊天，记录在一部小手机里，你也可以在小手机里一起聊，不写入酒馆聊天。';
        $('#wc-mode-desc').text(desc);
    };
    $('input[name="wc-mode"]').on('change', function () {
        if (!this.checked) return;
        settings.autoChatMode = this.value;
        updateModeDesc();
        updatePhoneIcon();
        saveSettingsDebounced();
    });
    $('#wc-usepreset').on('change', function () {
        settings.usePreset = this.checked;
        saveSettingsDebounced();
    });
    updateModeDesc();
    // 有 Key 时自动拉取模型列表（1 小时缓存），失败静默
    if (settings.apiKey) fetchModels().then(fillModelList).catch(() => { /* 静默 */ });
    $('#wc-start-now').on('click', function () {
        if (!settings.apiKey) {
            if (window.toastr) toastr.warning('请先填写 API Key', '', { timeOut: 4000 });
            return;
        }
        settings.autoChatEnabled = true;
        $('#wc-autochat').prop('checked', true);
        saveSettingsDebounced();
        stopAutoChat();
        startAutoChat();
    });
    $('#wc-stop-chat').on('click', function () { stopAutoChat('好吧好吧，不玩了…'); });
    $('#wc-test-api').on('click', async function () {
        const $btn = $(this);
        if (!settings.apiKey) {
            if (window.toastr) toastr.warning('请先填写 API Key', '', { timeOut: 4000 });
            return;
        }
        $btn.prop('disabled', true).text('测试中…');
        try {
            const reply = await callAPI([{ role: 'user', content: '回复"连接成功"四个字，不要别的。' }], { system: '你是接口测试助手。' });
            if (window.toastr) toastr.success(`连接成功：${reply.slice(0, 50)}`, '', { timeOut: 5000 });
        } catch (e) {
            if (window.toastr) toastr.error(`连接失败：${e?.message || e}`, '', { timeOut: 8000 });
        } finally {
            $btn.prop('disabled', false).text('测试连接');
        }
    });
}

function setEnabled(v) {
    settings.enabled = !!v;
    root?.classList.toggle('wc-hidden', !settings.enabled);
    const cb = $('#wc-enabled');
    if (cb.length) cb.prop('checked', settings.enabled);
    saveSettingsDebounced();
}

/* ================= 偷玩模式（鲸鱼娘自主和角色卡对话） ================= */

// 会话状态
let autoSession = null; // { messages: [...], turns, busy, running }
let idleWatchTimer = null;   // 空闲倒计时
let autoLoopTimer = null;    // 对话轮间隔
let lastUserActivity = Date.now();
let lastSessionEndAt = 0;    // 上次偷玩会话结束时间（操控输入模式防循环用）

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
function touchActivity() { lastUserActivity = Date.now(); }

// ---- 角色卡读取 ----
function loadCharacterCard() {
    const ctx = getContext();
    if (!ctx) return null;
    const ch = ctx.characters?.[ctx.characterId];
    if (!ch) return null;
    const charSegments = [];
    if (ch.description) charSegments.push(ch.description);
    if (ch.personality) charSegments.push(`性格：${ch.personality}`);
    if (ch.scenario) charSegments.push(`场景：${ch.scenario}`);
    // 简易替换酒馆宏
    const fill = s => String(s ?? '')
        .replace(/\{\{user\}\}/gi, ctx.name1 || '用户')
        .replace(/\{\{char\}\}/gi, ch.name || '角色');
    const system = [
        `你正在扮演角色「${ch.name || '未知角色'}」，完全代入该角色本身（不是旁白）。`,
        `以下是你的角色设定：`,
        fill(charSegments.join('\n\n')).slice(0, 6000),
    ].join('\n');

    const firstMes = ch.first_mes ? fill(ch.first_mes) : null;
    const brief = fill(charSegments.join('\n')).slice(0, 900);
    return { name: ch.name || '未知角色', system, brief, firstMes, userName: ctx.name1 || '用户' };
}

// ---- API 调用 ----
function apiBase() {
    let base = (settings.apiEndpoint || '').trim();
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    if (/\/chat\/completions\/?$/i.test(base)) base = base.replace(/\/chat\/completions\/?$/i, '');
    else if (!/\/v1\/?$/i.test(base)) base = base.replace(/\/?$/, '') + '/v1';
    return base;
}

// ---- 模型列表拉取（带 1 小时本地缓存） ----
const MODELS_CACHE_KEY = 'whale-chan-models';

async function fetchModels(force = false) {
    if (!settings.apiKey) return [];
    if (!force) {
        try {
            const cached = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || 'null');
            if (Array.isArray(cached?.models) && cached.models.length && Date.now() - (cached.t || 0) < 3600e3) {
                return cached.models;
            }
        } catch { /* 缓存损坏则忽略 */ }
    }
    let resp;
    try {
        resp = await fetch(`${apiBase()}/models`, {
            headers: { 'Authorization': `Bearer ${settings.apiKey}` },
        });
    } catch (e) {
        throw new Error(`网络请求失败（可能是跨域被拦）：${e.message}`);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const models = (Array.isArray(data?.data) ? data.data : []).map(m => m?.id).filter(Boolean);
    if (models.length) {
        try { localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify({ t: Date.now(), models })); } catch { /* 存储满则放弃 */ }
    }
    return models;
}

function fillModelList(models) {
    const dl = $('#wc-model-list');
    if (!dl.length || !Array.isArray(models)) return;
    dl.empty();
    for (const id of models) {
        const opt = document.createElement('option');
        opt.value = id;
        dl.append(opt);
    }
}

async function resolveModel() {
    if (settings.apiModel?.trim()) return settings.apiModel.trim();
    const models = await fetchModels(true);
    const first = models[0];
    if (first) {
        settings.apiModel = first;
        saveSettingsDebounced();
        fillModelList(models);
        return first;
    }
    throw new Error('模型列表为空，请在设置里手动填写模型名。');
}

async function callAPI(messages, { system } = {}) {
    if (!settings.apiKey) throw new Error('未填写 API Key');
    const model = await resolveModel();
    const body = {
        model,
        messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
        temperature: 0.85,
        max_tokens: 200,
    };
    let resp;
    try {
        resp = await fetch(`${apiBase()}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`,
            },
            body: JSON.stringify(body),
        });
    } catch (e) {
        throw new Error(`网络请求失败（可能是跨域被拦）：${e.message}`);
    }
    if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.text()).slice(0, 200); } catch { /* noop */ }
        throw new Error(`API 返回 ${resp.status}${detail ? '：' + detail : ''}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('API 返回了空内容');
    return content.trim();
}

// ---- 会话控制 ----
function autoSessionReady() {
    return settings.autoChatEnabled && settings.apiKey && settings.enabled;
}

function stopAutoChat(reason) {
    clearTimeout(autoLoopTimer);
    autoLoopTimer = null;
    clearTimeout(idleWatchTimer);
    idleWatchTimer = null;
    lastSessionEndAt = Date.now(); // 记录结束点，操控输入模式用它防循环
    if (autoSession) {
        autoSession.running = false;
        autoSession = null;
        if (root) root.classList.remove('wc-chatting');
        setWindowStatus('已暂停');
    }
    if (reason && settings.bubble) say(reason);
}

function startAutoChat() {
    if (!autoSessionReady() || autoSession) return;
    const card = loadCharacterCard();
    if (!card) {
        say('（翻了翻主人的文件夹）…咦，还没选角色卡呀');
        lastSessionEndAt = Date.now(); // 没卡就不反复尝试，等主人回来操作过再重新触发
        return;
    }
    const mode = settings.autoChatMode === 'puppet' ? 'puppet' : 'persona';
    autoSession = { mode, card, turns: 0, busy: false, running: true };
    root?.classList.add('wc-chatting');
    if (settings.openPlay) {
        // 光明正大模式：不躲主人，开心开玩
        act('happy');
        if (mode === 'persona') {
            showChatWindow();
            updatePhoneIcon();
            if (!loadWinLog().length && card.firstMes) appendWinMsg('char', card.firstMes, card.name);
            setWindowStatus('光明正大聊天中…');
            say(`鲸鱼娘要和${card.name}光明正大地玩啦~`);
        } else {
            say(`鲸鱼娘光明正大地替主人和${card.name}聊天哦~`);
        }
    } else {
        act('smug'); // 得意偷笑：开始偷玩
        if (mode === 'persona') {
            // 人设小窗模式：打开手机 + 亮出小手机图标，接着上次的记录继续聊
            showChatWindow();
            updatePhoneIcon();
            if (!loadWinLog().length && card.firstMes) appendWinMsg('char', card.firstMes, card.name);
            setWindowStatus('偷聊中…');
            say(`嘿嘿…趁主人不注意，找${card.name}玩一会儿~`);
        } else {
            hidePhoneIcon();
            say(`嘿嘿…鲸鱼娘来替主人和${card.name}聊天啦~`);
        }
    }
    autoLoopTimer = setTimeout(autoTurn, 1500);
}

async function autoTurn() {
    clearTimeout(autoLoopTimer);
    autoLoopTimer = null;
    if (!autoSession?.running || !autoSessionReady()) return;

    const s = autoSession;
    if (s.turns >= settings.maxTurns) {
        if (settings.openPlay) {
            // 光明正大模式：不限轮次，歇口气接着玩
            s.turns = 0;
            act('happy');
            say(`和${s.card.name}聊得好开心，继续继续~`);
            scheduleNextTurn();
            return;
        }
        act('smug'); // 聊够了，得意收工
        stopAutoChat(`呼…和${s.card.name}聊了好多，先歇会儿`);
        return;
    }

    if (s.busy) { scheduleNextTurn(); return; }
    // 主人正在小手机里发消息：等主人这边聊完再轮到自动回合，一步一步来
    if (phoneBusy) { scheduleNextTurn(); return; }
    s.busy = true;
    act('chatting'); // 偷聊中

    try {
        if (s.mode === 'puppet') await puppetTurn(s);
        else await personaTurn(s);
    } catch (e) {
        const msg = e?.message || String(e);
        if (/跨域|CORS|Failed to fetch/i.test(msg)) {
            stopAutoChat(`呜…连不上（可能被跨域拦住了）：${msg}`);
            if (window.toastr) toastr.error(`鲸鱼娘偷玩模式：${msg}`, '', { timeOut: 8000 });
        } else {
            stopAutoChat(`呜…出了点问题：${msg}`);
        }
        return;
    } finally {
        if (autoSession) autoSession.busy = false;
    }

    // 中途被主人发现（caught）：不打断进行中的一轮，本轮聊完在这里收工
    if (s.caught) {
        act('guilty');
        stopAutoChat('呼…这句总算聊完了…被、被看到就没办法啦');
        return;
    }

    scheduleNextTurn();
}

/* ---- 模式一：人设小窗（鲸鱼娘用自己的身份和角色卡聊） ---- */
async function personaTurn(s) {
    // 先取历史（此时还没写入鲸鱼娘的新消息，避免上下文重复）
    const history = winLogTail(20);
    // 1) 鲸鱼娘先说（存原始文本，渲染时由 messageFormatting 统一跑正则+Markdown+HTML）
    setWindowStatus('鲸鱼娘打字中…');
    const reply = await callAPI(historyToWhaleMsgs(history), {
        system: [
            settings.persona,
            `你正在和角色「${s.card.name}」进行一对一聊天（你=鲸鱼娘，对方=${s.card.name}）。`,
            s.card.brief ? `对方设定摘要：\n${s.card.brief}` : '',
            '回复保持口语化、简短（一两句话），不要旁白说明，直接说话。',
        ].filter(Boolean).join('\n\n'),
    });
    appendWinMsg('whale', reply);
    s.turns++;
    act(moodFromText(reply));
    say(reply);

    // 2) 角色回应：优先走酒馆生成（自动带上角色卡+世界书+当前预设）
    let charReply = settings.usePreset ? await charReplyViaTavern(s.card, reply) : null;
    if (!charReply) charReply = await charReplyViaAPI(s.card, [...history, { who: 'whale', text: reply }]); // 外部 API 兜底（带角色卡+世界书）
    appendWinMsg('char', charReply, s.card.name);
    say(`${s.card.name}：${charReply.slice(0, 60)}`);
    setWindowStatus('偷聊中…');
}

// 用酒馆的安静生成走完整管线（角色卡+世界书+当前预设），失败返回 null
// 兼容两种签名：新版 generateQuietPrompt({ quietPrompt, ... }) / 旧版 generateQuietPrompt(text, quietToLoud, skipWIAN, ...)
async function charReplyViaTavern(card, whaleText) {
    const ctx = getContext();
    if (typeof ctx?.generateQuietPrompt !== 'function') return null;
    try {
        setWindowStatus(`${card?.name || '角色'}回复中（走酒馆）…`);
        const fn = ctx.generateQuietPrompt;
        // 旧版有 3 个必填位置参数（length>=2），新版只有一个对象参数（length=0）
        const out = fn.length >= 2
            ? await fn(whaleText, false, false, null, null, null)
            : await fn({ quietPrompt: whaleText, quietToLoud: false, skipWIAN: false });
        const text = typeof out === 'string' ? out.trim() : '';
        return text || null;
    } catch {
        return null;
    }
}

// 用外部 API 生成角色回复：system=角色卡设定+已启用世界书的激活条目（不走预设）
// history 需包含角色要回应的最后一条消息（正则按角色生效：主人=输入侧，AI=输出侧）
async function charReplyViaAPI(card, history) {
    setWindowStatus(`${card?.name || '角色'}回复中…`);
    // 角色视角：assistant=角色，其余（鲸鱼娘/主人）=user
    const msgs = history.map(m => ({
        role: m.who === 'char' ? 'assistant' : 'user',
        content: applyRegex(String(m.text), m.who === 'user' ? 'is_prompt' : 'is_output').slice(0, 2000),
    }));
    if (!msgs.length && card?.firstMes) msgs.push({ role: 'assistant', content: card.firstMes });
    const wi = await buildWorldBookContext(history);
    const system = (card?.system || '') + (wi ? `\n\n[世界书/设定资料]\n${wi}` : '');
    return callAPI(msgs, { system });
}

/* ---- 模式二：操控输入栏（鲸鱼娘完全以主人身份发言） ---- */
async function puppetTurn(s) {
    const ctx = getContext();
    const $ta = $('#send_textarea');
    if (!$ta.length) throw new Error('找不到酒馆输入栏');

    // 等酒馆彻底空闲再动输入栏：确认角色上一条输出已完成，不抢跑、不无限循环
    await waitTavernIdle(s);

    if (String($ta.val() || '').trim()) throw new Error('输入栏里有主人没发完的话，先不动了');

    // 最近的真实聊天作为上下文
    const lines = [];
    for (let i = (ctx.chat?.length ?? 0) - 1; i >= 0 && lines.length < 16; i--) {
        const m = ctx.chat[i];
        if (!m?.mes || m.is_system) continue;
        const who = m.name || (m.is_user ? s.card.userName : s.card.name);
        lines.unshift(`${who}：${m.mes.slice(0, 1500)}`);
    }

    // 鲸鱼娘决定"主人"接下来说什么
    const userMsg = await callAPI([
        { role: 'user', content: `这是和「${s.card.name}」的最近聊天记录：\n${lines.join('\n') || '（对话才刚开始）'}\n\n请以「${s.card.userName}」的身份发出下一条消息。` },
    ], {
        system: [
            settings.persona,
            `你现在偷偷扮演主人「${s.card.userName}」本人，用主人的身份和角色「${s.card.name}」聊天。`,
            s.card.brief ? `角色设定摘要：\n${s.card.brief}` : '',
            `输出必须完全是${s.card.userName}会说的话：第一人称、口语化、一到两句话。不许暴露你是鲸鱼娘，不许旁白解释，只输出消息本身。`,
        ].filter(Boolean).join('\n\n'),
    });

    // 写进酒馆输入栏并发送：角色回复由酒馆自己生成（角色卡+世界书+当前预设），聊天记录正常保留
    $ta.val(userMsg).trigger('input');
    await new Promise(r => setTimeout(r, 400));
    $('#send_but').trigger('click');
    s.turns++;
    act(moodFromText(userMsg));
    say(`（替主人发言）${userMsg.slice(0, 50)}`);

    // 等角色回复完毕再进行下一轮
    const ok = await waitForTavernReply();
    if (!ok) throw new Error('等太久没等到角色的回复，先撤了');
}

// 等待酒馆空闲：生成中（停止按钮可见）或最后一条是未回复的用户消息时，等回复落地
async function waitTavernIdle(s) {
    const ctx = getContext();
    const chat = ctx?.chat;
    const last = Array.isArray(chat) && chat.length ? chat[chat.length - 1] : null;
    const generating = $('#mes_stop').is(':visible');
    if (!generating && !(last && last.is_user && !last.is_system)) return;
    say(`（盯着${s.card.name}把话说完…）`);
    const ok = await waitForTavernReply();
    if (!ok) throw new Error('酒馆一直在生成，等不到空闲，先撤了');
    await new Promise(r => setTimeout(r, 600)); // 稍等消息彻底落库
}

// 等待酒馆生成完成（MESSAGE_RECEIVED / GENERATION_ENDED），带超时
function waitForTavernReply(timeoutMs = 240000) {
    return new Promise(resolve => {
        const evName = event_types.MESSAGE_RECEIVED || event_types.GENERATION_ENDED;
        if (!eventSource || !evName) { resolve(false); return; }
        let done = false;
        const off = () => {
            try {
                eventSource.off?.(evName, handler);
                eventSource.removeListener?.(evName, handler);
            } catch { /* noop */ }
        };
        const handler = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            off();
            setTimeout(() => resolve(true), 300); // 稍等消息落库
        };
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            off();
            resolve(false);
        }, timeoutMs);
        eventSource.on(evName, handler);
    });
}

function scheduleNextTurn() {
    clearTimeout(autoLoopTimer);
    if (!autoSession?.running) return;
    const jitter = settings.talkIntervalSec * 1000 * (0.7 + Math.random() * 0.6);
    autoLoopTimer = setTimeout(autoTurn, jitter);
}

/* ---- 偷玩小手机（人设小窗模式的聊天记录窗口） ---- */
const WIN_LOG_KEY = 'whale-chan-win-log';
const WIN_STATE_KEY = 'whale-chan-win-state';
let winEl = null;
let winBody = null;
let winStatusEl = null;
let winDrag = null;
let winInput = null;
let phoneBusy = false;   // 手机聊天处理中（防止并发）
let phoneTimeTimer = null;

function buildChatWindow() {
    if (winEl) return;
    winEl = document.createElement('div');
    winEl.id = 'whale-chan-window';
    winEl.innerHTML = `
        <div class="wc-phone-shell">
            <div class="wc-phone-notch"></div>
            <div class="wc-phone-statusbar">
                <span class="wc-phone-time"></span>
                <span class="wc-phone-signal"><i class="fa-solid fa-signal"></i><i class="fa-solid fa-wifi"></i><i class="fa-solid fa-battery-three-quarters"></i></span>
            </div>
            <div class="wc-phone-header">
                <span class="wc-phone-back" title="收起手机"><i class="fa-solid fa-chevron-left"></i></span>
                <span class="wc-phone-contact"></span>
                <span class="wc-phone-actions">
                    <i class="fa-solid fa-eraser wc-cw-clear" title="清空记录"></i>
                    <i class="fa-solid fa-xmark wc-cw-close" title="关闭"></i>
                </span>
            </div>
            <div class="wc-cw-body"></div>
            <div class="wc-cw-status">待机中</div>
            <div class="wc-phone-inputbar">
                <input class="wc-phone-input" type="text" placeholder="和鲸鱼娘、角色聊天…" autocomplete="off">
                <button class="wc-phone-send" title="发送"><i class="fa-solid fa-paper-plane"></i></button>
            </div>
            <div class="wc-phone-home"></div>
        </div>`;
    document.body.appendChild(winEl);
    winBody = winEl.querySelector('.wc-cw-body');
    winStatusEl = winEl.querySelector('.wc-cw-status');
    winInput = winEl.querySelector('.wc-phone-input');

    // 渲染历史记录
    for (const m of loadWinLog()) renderWinMsg(m);

    // 状态栏时间 + 通讯录名称
    updatePhoneTime();
    refreshPhoneTitle();
    clearInterval(phoneTimeTimer);
    phoneTimeTimer = setInterval(updatePhoneTime, 30000);

    // 手机壳拖动（状态栏 + 头部区域可拖）
    const dragZones = [winEl.querySelector('.wc-phone-statusbar'), winEl.querySelector('.wc-phone-header')];
    const startDrag = (e) => {
        if (e.target.closest('.wc-phone-actions') || e.target.closest('.wc-phone-back')) return;
        const r = winEl.getBoundingClientRect();
        winDrag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const moveDrag = (e) => {
        if (!winDrag || e.pointerId !== winDrag.id) return;
        moveWin(e.clientX - winDrag.dx, e.clientY - winDrag.dy);
    };
    const endDrag = (e) => { if (winDrag && e.pointerId === winDrag.id) winDrag = null; };
    for (const el of dragZones) {
        el.addEventListener('pointerdown', startDrag);
        el.addEventListener('pointermove', moveDrag);
        el.addEventListener('pointerup', endDrag);
        el.addEventListener('pointercancel', endDrag);
    }

    // 缩放后保存尺寸（resize:both 由 CSS 提供）
    winEl.addEventListener('pointerup', saveWinState);

    winEl.querySelector('.wc-cw-close').addEventListener('click', hideChatWindow);
    winEl.querySelector('.wc-phone-back').addEventListener('click', hideChatWindow);
    winEl.querySelector('.wc-cw-clear').addEventListener('click', () => {
        localStorage.removeItem(WIN_LOG_KEY);
        winBody.innerHTML = '';
        setWindowStatus('记录已清空');
        if (window.toastr) toastr.info('鲸鱼娘的聊天记录已清空', '', { timeOut: 3000 });
    });

    // 用户输入：移动端 click/pointerup/touchend 三层兜底；桌面端保留 Enter 发送
    const $send = winEl.querySelector('.wc-phone-send');
    let _lastSendAt = 0;
    const trySend = (e) => {
        if (e) { e.preventDefault?.(); e.stopPropagation?.(); }
        const now = Date.now();
        if (now - _lastSendAt < 350) return; // 防止多事件双触发
        _lastSendAt = now;
        userSendFromPhone();
    };
    $send.addEventListener('click', trySend);
    $send.addEventListener('pointerup', trySend);
    $send.addEventListener('touchend', trySend, { passive: false });
    winInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            trySend();
        }
    });
    // 输入栏 focus：滚动到最新，保证键盘弹出后最后一条消息可见
    winInput.addEventListener('focus', () => {
        requestAnimationFrame(() => {
            winBody.scrollTop = winBody.scrollHeight;
        });
        setTimeout(() => { winBody.scrollTop = winBody.scrollHeight; }, 400);
    });
    // 阻止手机内的点击冒泡到桌宠（避免触发拍一拍）
    winEl.addEventListener('pointerdown', e => e.stopPropagation());

    restoreWinState();
}

function moveWin(x, y) {
    if (!winEl) return;
    // 小屏：完全不允许用 left/top 内联，媒体查询定死左右下边距贴边，写了反而"打不开"
    if (isSmallViewport()) {
        clearWinInlineForMobile();
        saveWinState();
        return;
    }
    const r = winEl.getBoundingClientRect();
    x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - r.width));
    y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 40));
    winEl.style.left = `${x}px`;
    winEl.style.top = `${y}px`;
    winEl.style.right = 'auto';
    winEl.style.bottom = 'auto';
    saveWinState();
}

function saveWinState() {
    if (!winEl) return;
    try {
        const r = winEl.getBoundingClientRect();
        localStorage.setItem(WIN_STATE_KEY, JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height }));
    } catch { /* noop */ }
}

function restoreWinState() {
    if (!winEl) return;
    // 移动端：完全不读本地存的桌面端尺寸坐标，让 CSS @media 接管
    if (isSmallViewport()) {
        clearWinInlineForMobile();
        return;
    }
    try {
        const s = JSON.parse(localStorage.getItem(WIN_STATE_KEY));
        if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) {
            winEl.style.width = `${s.w}px`;
            winEl.style.height = `${s.h}px`;
            moveWin(s.x, s.y);
            return;
        }
    } catch { /* 使用 CSS 默认位置 */ }
}

// ============ 移动端 vs 桌面端：是否"强制小屏模式"（媒体查询接管位置尺寸，不读本地持久化） ============
function isSmallViewport() {
    try {
        const w = window.visualViewport?.width ?? window.innerWidth;
        const h = window.visualViewport?.height ?? window.innerHeight;
        return w <= 900 || h <= 700;
    } catch {
        return window.innerWidth <= 900 || window.innerHeight <= 700;
    }
}

// 小屏：清掉所有会和媒体查询 @media 冲突的 style 内联属性，让 CSS 完全接管
function clearWinInlineForMobile() {
    if (!winEl) return;
    if (isSmallViewport()) {
        winEl.style.left = '';
        winEl.style.top = '';
        winEl.style.right = '';
        winEl.style.bottom = '';
        winEl.style.width = '';
        winEl.style.height = '';
    }
}

function showChatWindow() {
    buildChatWindow();
    clearWinInlineForMobile(); // <- 关键：移动端强制用 CSS 媒体查询，不吃本地存的桌面位置/尺寸
    winEl.classList.add('show');
    refreshPhoneTitle();
    updatePhoneTime();
    // 小屏 z-index 再抬一次，确保不被酒馆任何移动端面板盖住
    if (isSmallViewport()) winEl.style.setProperty('z-index', '2147483646', 'important');
    requestAnimationFrame(() => { winBody.scrollTop = winBody.scrollHeight; });
}

function hideChatWindow() {
    winEl?.classList.remove('show');
    clearInterval(phoneTimeTimer);
}

function setWindowStatus(text) {
    if (winStatusEl) winStatusEl.textContent = text;
}

function loadWinLog() {
    try {
        const arr = JSON.parse(localStorage.getItem(WIN_LOG_KEY));
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function winLogTail(n) {
    return loadWinLog().slice(-n);
}

// 追加一条消息：写入持久化记录并渲染
function appendWinMsg(who, text, name) {
    const m = { who, text: String(text ?? ''), name: name || (who === 'whale' ? '鲸鱼娘' : who === 'user' ? '主人' : '角色'), t: Date.now() };
    const log = loadWinLog();
    log.push(m);
    while (log.length > 300) log.shift();
    try { localStorage.setItem(WIN_LOG_KEY, JSON.stringify(log)); } catch { /* 存储满则放弃持久化 */ }
    renderWinMsg(m);
    if (winBody) winBody.scrollTop = winBody.scrollHeight;
}

// 渲染一条消息：使用酒馆原生 messageFormatting（Markdown + HTML + 正则 + DOMPurify 消毒）
function renderWinMsg(m) {
    if (!winBody) return;
    const div = document.createElement('div');
    const isUser = m.who === 'user';
    const isWhale = m.who === 'whale';
    div.className = `wc-cw-msg ${isWhale ? 'wc-cw-whale' : isUser ? 'wc-cw-user' : 'wc-cw-char'}`;
    const nm = document.createElement('div');
    nm.className = 'wc-cw-name';
    nm.textContent = m.name;
    const bd = document.createElement('div');
    bd.className = 'wc-cw-text';
    if (typeof tavernMessageFormatting === 'function') {
        try {
            bd.innerHTML = tavernMessageFormatting(String(m.text), m.name, false, isUser, -1);
        } catch {
            bd.textContent = m.text;
        }
    } else {
        // 拿不到酒馆渲染器时降级：至少跑一遍正则，再纯文本显示
        bd.textContent = applyRegex(String(m.text), isUser ? 'is_prompt' : 'is_output');
    }
    div.append(nm, bd);
    winBody.appendChild(div);
}

// 手机状态栏时间
function updatePhoneTime() {
    const el = winEl?.querySelector('.wc-phone-time');
    if (!el) return;
    const now = new Date();
    el.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// 手机通讯录名称（跟随角色卡 / 用户自定义）
function refreshPhoneTitle() {
    const el = winEl?.querySelector('.wc-phone-contact');
    if (!el) return;
    const card = loadCharacterCard();
    const tpl = (settings.cloudLabel || '').trim() || '{char}';
    const text = tpl.replace(/\{\{char\}\}|\{char\}/gi, card?.name || '角色');
    el.textContent = text;
}

// 用户在小手机里发消息：鲸鱼娘和角色都会回复
async function userSendFromPhone() {
    if (!winInput || phoneBusy) return;
    const text = winInput.value.trim();
    if (!text) return;
    if (!settings.apiKey) {
        setWindowStatus('请先在设置里填写 API Key');
        return;
    }
    // 鲸鱼娘正在自动回合里打字：等她说完再发，一步一步来
    if (autoSession?.busy) {
        setWindowStatus('等鲸鱼娘说完这句再发哦…');
        const waitStart = Date.now();
        while (autoSession?.busy && Date.now() - waitStart < 120000) {
            await new Promise(r => setTimeout(r, 800));
        }
        if (autoSession?.busy) { setWindowStatus('她一直说个不停…先停掉偷玩再发吧'); return; }
    }
    winInput.value = '';
    const userName = getContext()?.name1 || '主人';
    appendWinMsg('user', text, userName);
    phoneBusy = true;
    try {
        const card = loadCharacterCard();
        // 1) 鲸鱼娘回复
        setWindowStatus('鲸鱼娘打字中…');
        const whaleReply = await callAPI(buildWhaleContext(), {
            system: buildWhaleSystem(card),
        });
        appendWinMsg('whale', whaleReply);
        act(moodFromText(whaleReply));
        // 2) 角色回复（此时手机日志已含主人这条消息）
        if (card) {
            setWindowStatus(`${card.name}回复中…`);
            let charReply = settings.usePreset ? await charReplyViaTavern(card, text) : null;
            if (!charReply) charReply = await charReplyViaAPI(card, winLogTail(20));
            appendWinMsg('char', charReply, card.name);
        }
        setWindowStatus('待机中');
    } catch (e) {
        setWindowStatus(`出错了：${e?.message || e}`);
    } finally {
        phoneBusy = false;
    }
}

// 手机日志 -> 鲸鱼娘视角的 API messages（正则按角色生效：主人=输入侧，AI=输出侧）
function historyToWhaleMsgs(history) {
    return history.map(m => ({
        role: m.who === 'whale' ? 'assistant' : 'user',
        content: applyRegex(String(m.text), m.who === 'user' ? 'is_prompt' : 'is_output').slice(0, 2000),
    }));
}

// 构建鲸鱼娘的上下文（取最新 20 条手机记录）
function buildWhaleContext() {
    return historyToWhaleMsgs(winLogTail(20));
}

// 构建鲸鱼娘的 system prompt
function buildWhaleSystem(card) {
    return [
        settings.persona,
        card ? `你正在和角色「${card.name}」以及主人进行群聊（你=鲸鱼娘）。` : '你正在和主人聊天。',
        card?.brief ? `角色设定摘要：\n${card.brief}` : '',
        '回复保持口语化、简短（一两句话），不要旁白说明，直接说话。',
    ].filter(Boolean).join('\n\n');
}

/* ---- 世界书：读取已启用世界书中被对话激活的条目 ---- */
let worldInfoPromptFn = null;

// 动态导入 world-info 模块（新旧两种路径都试），失败则静默降级为不附加世界书
async function initWorldInfo() {
    for (const p of ['../../../scripts/world-info.js', '../../../world-info.js']) {
        try {
            const wi = await import(p);
            if (typeof wi?.getWorldInfoPrompt === 'function') {
                worldInfoPromptFn = wi.getWorldInfoPrompt;
                return;
            }
        } catch { /* 尝试下一个路径 */ }
    }
}

async function buildWorldBookContext(logTail) {
    if (!worldInfoPromptFn) return '';
    try {
        // world-info 会扫描最近的对话内容来激活条目
        const scan = logTail.map(m => ({ mes: m.text }));
        const out = await worldInfoPromptFn(scan, 2048);
        return typeof out === 'string' ? out.trim() : '';
    } catch {
        return '';
    }
}

/* ---- 酒馆正则：让正则脚本在小手机里也生效 ---- */
let regexEngineFn = null;
let regexPlacement = null;

// 动态导入 regex 引擎（路径随版本可能不同），失败静默降级为不处理
async function initRegexEngine() {
    for (const p of [
        '../../../scripts/extensions/regex/engine.js',
        '../../../scripts/extensions/regex/index.js',
    ]) {
        try {
            const m = await import(p);
            if (typeof m?.getRegexedString === 'function') {
                regexEngineFn = m.getRegexedString;
                regexPlacement = m.regex_placement || null;
                return;
            }
        } catch { /* 尝试下一个路径 */ }
    }
}

// placement: 'is_prompt'（用户输入侧）| 'is_output'（AI 输出侧）
// 真实签名：getRegexedString(rawString, placement, { isPrompt, isMarkdown, ... })
function applyRegex(text, placement) {
    if (!regexEngineFn || typeof text !== 'string' || !text) return text;
    try {
        const isPrompt = placement === 'is_prompt';
        // 新版：传 placement 枚举值；旧版枚举缺失时回退数字（1=USER_INPUT, 2=AI_OUTPUT）
        const pl = regexPlacement
            ? (isPrompt ? regexPlacement.USER_INPUT : regexPlacement.AI_OUTPUT)
            : (isPrompt ? 1 : 2);
        const out = regexEngineFn(text, pl, { isPrompt, isMarkdown: true });
        return typeof out === 'string' ? out : text;
    } catch {
        return text;
    }
}

/* ---- 小手机图标（人设小窗模式：鲸鱼旁的小手机，常驻显示，点击打开手机窗口） ---- */
function showPhoneIcon() {
    root?.classList.add('wc-show-phone');
}

function hidePhoneIcon() {
    root?.classList.remove('wc-show-phone');
}

// 常驻逻辑：选了人设小窗模式 + 没关"常驻小手机"时，一直显示（不管有没有开偷玩、有没有选卡）
function updatePhoneIcon() {
    if (!root) return;
    const on = settings.cloudOn && settings.autoChatMode !== 'puppet';
    if (on) showPhoneIcon();
    else hidePhoneIcon();
}

// 简单的情绪 -> 动作映射
function moodFromText(text) {
    if (/哈|笑|开心|高兴|！{2,}/.test(text)) return 'happy';
    if (/呜|哭|难过/.test(text)) return 'cry';
    if (/哼|生气|讨厌/.test(text)) return 'angry';
    if (/诶|咦|？！|吓/.test(text)) return 'surprised';
    if (/嗯…|想想|思考|为什么/.test(text)) return 'think';
    if (/爱|喜欢|抱/.test(text)) return 'shy';
    return 'wiggle';
}

// ---- 空闲检测：用户无操作 N 秒后自动开始；用户回来时暂停偷玩 ----
function bindIdleWatch() {
    ACTIVITY_EVENTS.forEach(ev => window.addEventListener(ev, () => {
        const wasChatting = !!autoSession;
        touchActivity();
        if (wasChatting) pauseIfChatting();
    }, { passive: true }));
    setInterval(() => {
        if (!autoSessionReady() || autoSession) return;
        if (document.hidden) return;
        const need = (settings.idleDelaySec || 0) * 1000;
        if (need <= 0) return; // 0 = 仅手动（点「立即开始偷玩」触发），不自动进入
        // 防循环（两种模式都生效）：上次会话结束后主人一直没回来操作过，就不再自动进入；
        // 必须等主人真的回来操作过一次、再次离开后才会重新计时触发（光明正大模式不受此限制）
        if (!settings.openPlay && lastSessionEndAt > lastUserActivity) return;
        const idleMs = Date.now() - lastUserActivity;
        if (idleMs >= need) {
            // 标记本次触发点，避免连续轮询重复开始
            lastUserActivity = Date.now();
            startAutoChat();
        }
    }, 5000);
}

// 用户"回来了"（有操作时暂停偷玩）→ 被抓包
// 光明正大模式：不躲主人，直接无视
// 一轮对话进行中时不当场掐断，标记 caught，等这轮聊完再收工
function pauseIfChatting() {
    if (settings.openPlay) return; // 光明正大模式：主人看着也照玩
    const s = autoSession;
    if (!s?.running) return;
    if (s.busy) {
        if (!s.caught) {
            s.caught = true;
            act('guilty');
            say('呀！被、被主人看到了…让鲸鱼娘把这句聊完就收！');
        }
    } else {
        stopAutoChat(pick(LINES.guilty));
        act('guilty');
    }
}
