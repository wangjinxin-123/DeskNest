'use strict';
/**
 * 桌面项目自动分类（主进程与自测脚本共用）
 * 纯关键词打分，无依赖、无 IO，单次调用 <1ms。
 */

const CATEGORY_ORDER = [
  'dev', 'folder', 'office', 'social', 'media', 'game',
  'design', 'browser', 'sys', 'other'
];

const CATEGORY_META = {
  dev:     { name: '编程开发',   color: '#4f8cff' },
  folder:  { name: '桌面文件夹', color: '#37d5ff' },
  office:  { name: '办公学习',   color: '#5ad1a8' },
  social:  { name: '社交通讯',   color: '#7d7bff' },
  media:   { name: '影音娱乐',   color: '#ff7ac8' },
  game:    { name: '游戏',       color: '#ffa64f' },
  design:  { name: '设计创作',   color: '#b478ff' },
  browser: { name: '浏览器',     color: '#4fd6ff' },
  sys:     { name: '系统工具',   color: '#9fb0c8' },
  other:   { name: '其他',       color: '#8a94a6' }
};

// 关键词表：命中即 +1，命中多则按最高分的类别归属
const RULES = {
  dev: ['code', 'visual studio', 'vs code', 'vscode', 'idea', 'pycharm', 'webstorm', 'goland', 'clion',
    'android studio', 'eclipse', 'git', 'github', 'gitlab', 'sourcetree', 'tortoise', 'node', 'npm',
    'python', 'pycharm', 'anaconda', 'jupyter', 'docker', 'postman', 'apifox', 'navicat', 'dbeaver',
    'mysql', 'redis', 'mongodb', 'sql', 'terminal', 'powershell', 'cmd', 'wsl', 'putty', 'xshell',
    'xftp', 'mobaxterm', 'final shell', 'finalshell', 'jenkins', 'unity', 'unreal', 'hbuilder',
    'dev-c++', 'devcpp', 'keil', 'iar', 'quartus', 'matlab', 'rstudio', 'cmake', 'llvm',
    '编程', '开发', '代码', '数据库', '调试', '编译', '终端', '命令行', '抓包', '接口'],

  office: ['word', 'excel', 'powerpoint', 'ppt', 'wps', 'office', 'onenote', 'outlook', 'acrobat',
    'adobe reader', 'foxit', 'pdf', 'xmind', 'mindmaster', 'notepad', 'typora', 'obsidian',
    'evernote', '印象笔记', '有道云', 'youdao', 'baidu netdisk', '百度网盘', 'aliyunpan', '阿里云盘',
    'onedrive', '坚果云', 'nutstore', 'dida', '滴答清单', 'todo', 'iflytek', '翻译', '有道词典',
    '办公', '文档', '表格', '笔记', '学习', '网课', '阅读', '词典', '笔记本', '考', '词典'],

  social: ['qq', 'wechat', '微信', 'weixin', 'dingtalk', '钉钉', 'feishu', '飞书', 'lark', 'telegram',
    'discord', 'slack', 'whatsapp', 'skype', 'zoom', 'tencent meeting', '腾讯会议', 'voov', '会议',
    'mail', 'foxmail', 'thunderbird', '新浪', 'weibo', '微博', '小红书', 'zhihu', '知乎', 'tieba',
    '贴吧', 'bilibili link', 'yy语音', '聊天', '通讯', '交友', '社交', '邮件'],

  media: ['potplayer', 'vlc', 'mpv', 'kmplayer', '爱奇艺', 'iqiyi', '腾讯视频', '优酷', 'youku',
    'bilibili', '哔哩', '抖音', 'douyin', '快手', 'kuaishou', '西瓜视频', '网易云音乐', 'cloudmusic', 'qqmusic', 'kugou', '酷狗', 'spotify', 'foobar',
    'audition', '格式工厂', 'formatfactory', 'obs', '剪映', 'capcut', 'pr', 'premiere', '达芬奇',
    'davinci', '音乐', '视频', '播放器', '影视', '影音', '听歌', '直播', '录屏', '录音'],

  game: ['steam', 'epic', 'battle.net', '战网', 'ubisoft', 'uplay', 'origin', 'ea app', 'wegame',
    'league of legends', '英雄联盟', 'lol', 'garena', 'dota', 'csgo', 'cs2', 'valorant', '原神',
    'genshin', '王者荣耀', '和平精英', 'minecraft', '我的世界', '植物大战', 'roblox', '微软商店游戏',
    '4399', 'ldplayer', '雷电模拟器', '夜神', 'nox', 'mumu', '模拟器', '游戏', 'gaming', '游戏加速'],

  design: ['photoshop', 'ps', 'illustrator', 'ai', 'coreldraw', 'figma', 'sketch', 'axure',
    'xd', 'indesign', 'lightroom', 'capture one', 'blender', '3ds max', 'maya', 'c4d', 'cinema 4d',
    'sketchup', 'rhino', 'autocad', 'solidworks', 'proe', 'creo', 'catia', 'keyshot', 'zbrush',
    'substance', 'krita', 'sai', 'clip studio', 'medibang', 'paint', 'canva', '美图', '秀秀',
    '设计', '绘图', '建模', '渲染', '剪辑', '修图', '图片', '海报'],

  browser: ['chrome', 'google chrome', 'edge', 'microsoft edge', 'firefox', '360se', '360浏览器',
    'qq浏览器', '搜狗浏览器', 'sogou', 'opera', 'brave', 'vivaldi', 'tor browser', 'uc浏览器',
    '猎豹', '傲游', 'maxthon', '浏览器', 'browser'],

  sys: ['控制面板', 'control panel', 'settings', '设置', '任务管理器', 'task manager', '注册表',
    'regedit', '计算机管理', '磁盘管理', '设备管理器', '回收站', 'recycle', '此电脑', 'this pc',
    '资源监视器', '服务', 'services', '系统配置', 'msconfig', '优化大师', '鲁大师', '驱动',
    'geforce', 'nvidia', 'amd software', 'armoury', 'aura', 'msi', 'rog', '联想', 'lenovo',
    '火力全开', 'ccleaner', 'dism', '火绒', 'huorong', '360安全', '360安全卫士', '杀毒',
    'defender', 'clean', '清理', '卸载', '驱动精灵', '分区', '备份', '还原', '截图', '输入法',
    'sogou input', '搜狗拼音', '系统', '工具', '助理', '电脑管家']
};

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// 短拉丁关键词（≤3 字符，如 ps / pr / ai / xd / qq / cmd）必须整词命中。
// 否则 includes() 会把 ps 命中 photoshop、pr 命中 program、ai 命中 paint，
// 无关软件被吸进别的分类，真正该归类的项目又被挤到「其他」。
const SHORT_KW_MAX = 3;
const LATIN_ONLY = /^[a-z0-9+#.-]+$/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hit(text, kw) {
  if (kw.length > SHORT_KW_MAX || !LATIN_ONLY.test(kw)) return text.includes(kw);
  // 前面必须是词边界（不允许字母/数字），后面允许直接跟版本号：PS2024 / PR2023 也算命中
  return new RegExp('(^|[^a-z0-9])' + escapeRe(kw) + '($|[^a-z])').test(text);
}

/**
 * @param {{name:string,type:string,target?:string}} item
 * @returns {string} catKey
 */
function classify(item) {
  if (!item) return 'other';
  if (item.type === 'folder') return 'folder';

  const name = norm(item.name);
  const target = norm(item.target);
  const hay = name + ' ' + target;

  let best = 'other';
  let bestScore = 0;

  for (const catKey in RULES) {
    const words = RULES[catKey];
    let score = 0;
    for (const w of words) {
      const kw = norm(w);
      if (!kw) continue;
      if (!hit(hay, kw)) continue;
      // 名称命中权重高于目标路径命中；整词相等再加权
      score += hit(name, kw) ? 2 : 1;
      if (name === kw) score += 3;
      if (name.startsWith(kw)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = catKey; }
  }

  // 扩展名兜底
  if (bestScore === 0) {
    if (item.type === 'url') return 'other';
  }
  return best;
}

// 主进程 require() 时导出；渲染进程 <script> 加载时这里的 module 不存在，直接跳过
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classify, CATEGORY_ORDER, CATEGORY_META, RULES };
}