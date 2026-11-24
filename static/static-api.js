/* ============================================================
 * SkyExam 静态版后端模拟层
 * 部署到纯静态托管（GitHub Pages / Cloudflare Pages）时，
 * 用 localStorage + questions.json 复刻 Flask 后端的全部接口。
 * ============================================================ */

const FIXED_INVITE = '关注马工一路长虹';
const LS_USERS = 'sky_users';
const LS_SESSION = 'sky_session';
const LS_INVITES = 'sky_invites';
const LS_DATA_PREFIX = 'sky_data_';
const LS_EXAM_PREFIX = 'sky_exam_';
const USERNAME_RE = /^[A-Za-z0-9_一-龥]{2,20}$/;

let _defaultQuestions = null;   // 默认题库（内存缓存，不存 localStorage，避免超额）

function _lsGet(key, def) {
  try { const v = localStorage.getItem(key); return v === null ? def : JSON.parse(v); }
  catch (e) { return def; }
}
function _lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { return false; }
}
function _users() { return _lsGet(LS_USERS, {}); }
function _invites() { return _lsGet(LS_INVITES, {}); }
function _sessionUser() { return localStorage.getItem(LS_SESSION) || ''; }
function _userData(uname) {
  const d = _lsGet(LS_DATA_PREFIX + uname, {});
  d.progress = d.progress || {};
  d.wrong_book = d.wrong_book || {};
  d.records = d.records || [];
  d.daily_stats = d.daily_stats || {};
  d.bank = d.bank || null;          // 用户自定义题库（整体替换）
  d.bank_del = d.bank_del || [];    // 默认题库中被删除的 id
  d.bank_edit = d.bank_edit || {};  // 默认题库中被编辑的 {id: 题目对象}
  return d;
}
function _saveUserData(uname, d) { return _lsSet(LS_DATA_PREFIX + uname, d); }

async function _sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _ensureQuestions() {
  if (_defaultQuestions) return;
  const res = await fetch('data/questions.json');
  _defaultQuestions = await res.json();
}

function _getQuestions(uname) {
  uname = uname || _sessionUser();
  if (!uname) return _defaultQuestions || [];
  const ud = _userData(uname);
  if (ud.bank) return ud.bank;
  const del = new Set(ud.bank_del);
  return (_defaultQuestions || [])
    .filter(q => !del.has(q.id))
    .map(q => ud.bank_edit[q.id] || q);
}

// 修改用户题库：自定义库直接改；默认库记录 diff，不占大存储
function _mutateUserBank(uname, fn) {
  const ud = _userData(uname);
  if (ud.bank) {
    const result = fn(ud.bank);
    _saveUserData(uname, ud);
    return result;
  }
  return fn(null, ud);
}

function _requireLogin() { return _sessionUser() || null; }
function _unauth() { return { __status: 401, success: false, message: '请先登录' }; }

// ==================== 各接口实现 ====================

function _apiMe() {
  const u = _sessionUser();
  if (!u) return { logged_in: false };
  const info = _users()[u] || {};
  return { logged_in: true, username: u, is_admin: !!info.is_admin, show_guide: !info.seen_guide };
}

async function _apiRegister(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const code = String(body.invite_code || '').trim();
  if (!USERNAME_RE.test(username)) return { success: false, message: '用户名需为 2-20 位中文、字母、数字或下划线' };
  if (password.length < 4) return { success: false, message: '密码至少 4 位' };
  const users = _users();
  if (users[username]) return { success: false, message: '用户名已被注册' };

  const usedFixed = code === FIXED_INVITE;
  let invites = null;
  if (!usedFixed) {
    invites = _invites();
    const inv = invites[code];
    if (!inv) return { success: false, message: '邀请码无效' };
    if (inv.used_by) return { success: false, message: '邀请码已被使用' };
  }

  const isFirst = Object.keys(users).length === 0;
  users[username] = {
    pwd_hash: await _sha256(password),
    is_admin: isFirst,
    invite_code: code,
    created_at: new Date().toISOString(),
    seen_guide: false
  };
  _lsSet(LS_USERS, users);
  if (!usedFixed) {
    invites[code].used_by = username;
    invites[code].used_at = new Date().toISOString();
    _lsSet(LS_INVITES, invites);
  }
  localStorage.setItem(LS_SESSION, username);
  return { success: true, username, is_admin: isFirst, show_guide: true };
}

async function _apiLogin(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const info = _users()[username];
  if (!info || info.pwd_hash !== await _sha256(password)) {
    return { success: false, message: '用户名或密码错误' };
  }
  localStorage.setItem(LS_SESSION, username);
  return { success: true, username, is_admin: !!info.is_admin, show_guide: !info.seen_guide };
}

function _apiLogout() {
  localStorage.removeItem(LS_SESSION);
  return { success: true };
}

function _apiGuideDone() {
  const u = _sessionUser();
  const users = _users();
  if (u && users[u]) { users[u].seen_guide = true; _lsSet(LS_USERS, users); }
  return { success: true };
}

function _apiPractice(u) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const questions = _getQuestions();
  if (!questions.length) return { success: false, message: '题库为空，请先上传题库' };
  const mode = u.searchParams.get('mode') || 'order';
  let index = parseInt(u.searchParams.get('index') || '0', 10) || 0;
  const progress = _userData(uname).progress;
  const wrongBook = _userData(uname).wrong_book;
  let q;
  if (mode === 'random') {
    q = questions[Math.floor(Math.random() * questions.length)];
  } else if (mode === 'wrong') {
    const ids = Object.keys(wrongBook);
    if (!ids.length) return { success: false, message: '错题本为空' };
    const wid = ids[index % ids.length];
    q = questions.find(x => x.id === wid);
    if (!q) return { success: false, message: '题目未找到' };
  } else {
    index = index % questions.length;
    q = questions[index];
  }
  const answered = progress[q.id] || {};
  const resp = {
    success: true,
    question: { id: q.id, question: q.question, options: q.options, type: q.type || '' },
    total: questions.length,
    index,
    answered: !!answered.answered,
    selected: answered.selected || '',
    correct: !!answered.correct,
    wrong_count: Object.keys(wrongBook).length
  };
  if (answered.answered) {
    resp.answer = q.answer;
    resp.explanation = q.explanation || '';
  }
  return resp;
}

function _apiSubmit(body) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const qid = String(body.id);
  const selected = String(body.selected || '').trim().toUpperCase();
  const q = _getQuestions().find(x => x.id === qid);
  if (!q) return { success: false, message: '题目未找到' };
  const isCorrect = selected === q.answer;

  const ud = _userData(uname);
  ud.progress[qid] = { answered: true, selected, correct: isCorrect };

  const today = new Date();
  const ds = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const day = ud.daily_stats[ds] || { count: 0, correct: 0, ids: [] };
  day.ids = day.ids || [];
  if (!day.ids.includes(qid)) {
    day.count++;
    if (isCorrect) day.correct++;
    day.ids.push(qid);
  }
  ud.daily_stats[ds] = day;

  if (!isCorrect) {
    const old = ud.wrong_book[qid] || {};
    ud.wrong_book[qid] = {
      selected, answer: q.answer,
      time: new Date().toISOString(),
      wrong_count: (old.wrong_count || 0) + 1
    };
  }
  _saveUserData(uname, ud);
  return { success: true, correct: isCorrect, answer: q.answer, explanation: q.explanation || '', options: q.options };
}

function _apiExamStart(body) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const questions = _getQuestions();
  if (!questions.length) return { success: false, message: '题库为空，请先上传题库' };
  const count = Math.min(Math.max(1, parseInt(body.count, 10) || 20), questions.length);
  const pool = questions.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const selected = pool.slice(0, count);
  const examId = String(Math.floor(Date.now() / 1000));
  const exam = {
    id: examId,
    questions: selected.map(q => ({ id: q.id, question: q.question, options: q.options, type: q.type || '' })),
    answers: Object.fromEntries(selected.map(q => [q.id, q.answer])),
    explanations: Object.fromEntries(selected.map(q => [q.id, q.explanation || ''])),
    start_time: new Date().toISOString(),
    count
  };
  _lsSet(LS_EXAM_PREFIX + uname + '_' + examId, exam);
  return { success: true, exam_id: examId, questions: exam.questions, count };
}

function _apiExamSubmit(body) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const examId = String(body.exam_id || '').trim();
  const exam = _lsGet(LS_EXAM_PREFIX + uname + '_' + examId, null);
  if (!exam) return { success: false, message: '考试不存在或已过期' };
  const userAnswers = body.answers || {};
  const ud = _userData(uname);
  let correctCount = 0;
  const results = exam.questions.map(q => {
    const qid = q.id;
    const selected = String(userAnswers[qid] || '').trim().toUpperCase();
    const correct = exam.answers[qid] || '';
    const ok = selected === correct;
    if (ok) correctCount++;
    if (!ok && selected) {
      const old = ud.wrong_book[qid] || {};
      ud.wrong_book[qid] = { selected, answer: correct, time: new Date().toISOString(), wrong_count: (old.wrong_count || 0) + 1 };
    }
    return { id: qid, question: q.question, options: q.options, selected, answer: correct, correct: ok, explanation: exam.explanations[qid] || '' };
  });
  const total = exam.questions.length;
  const score = total ? Math.round(correctCount / total * 1000) / 10 : 0;
  ud.records.push({
    exam_id: examId, score, correct: correctCount, total,
    start_time: exam.start_time || '',
    end_time: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 16).replace('T', ' ')
  });
  _saveUserData(uname, ud);
  localStorage.removeItem(LS_EXAM_PREFIX + uname + '_' + examId);
  return { success: true, score, correct: correctCount, total, results };
}

function _apiWrongBook(u) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const questions = _getQuestions();
  const wb = _userData(uname).wrong_book;
  const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
  const size = Math.min(100, Math.max(1, parseInt(u.searchParams.get('page_size') || '20', 10)));
  const list = [];
  for (const [qid, info] of Object.entries(wb)) {
    const q = questions.find(x => x.id === qid);
    if (q) list.push({
      id: qid, question: q.question, options: q.options,
      answer: info.answer, selected: info.selected,
      explanation: q.explanation || '',
      wrong_count: info.wrong_count || 1, time: info.time || ''
    });
  }
  list.sort((a, b) => b.wrong_count - a.wrong_count);
  return { success: true, total: list.length, page, page_size: size, list: list.slice((page - 1) * size, page * size) };
}

function _apiWrongBookDelete(body) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const ud = _userData(uname);
  delete ud.wrong_book[String(body.id || '')];
  _saveUserData(uname, ud);
  return { success: true };
}

function _apiStats() {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const ud = _userData(uname);
  const total = _getQuestions().length;
  const answered = Object.values(ud.progress).filter(v => v.answered).length;
  const correct = Object.values(ud.progress).filter(v => v.correct).length;
  const records = ud.records;
  const examCount = records.length;
  return {
    success: true, total_questions: total, answered, correct_practice: correct,
    wrong_count: Object.keys(ud.wrong_book).length,
    exam_count: examCount,
    avg_score: examCount ? Math.round(records.reduce((s, r) => s + r.score, 0) / examCount * 10) / 10 : 0,
    best_score: records.length ? Math.max(...records.map(r => r.score)) : 0,
    recent_records: records.slice(-10),
    accuracy: answered ? Math.round(correct / answered * 1000) / 10 : 0
  };
}

function _apiDailyStats() {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const ds = _userData(uname).daily_stats;
  const days60 = [];
  const today = new Date();
  for (let i = 59; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const info = ds[key] || { count: 0, correct: 0 };
    days60.push({ date: key, count: info.count || 0, correct: info.correct || 0 });
  }
  const allDays = Object.keys(ds).sort().map(d => ({ date: d, count: ds[d].count || 0, correct: ds[d].correct || 0 }));
  return { success: true, days_60: days60, all_days: allDays };
}

function _apiProgress() {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const progress = _userData(uname).progress;
  const map = {};
  _getQuestions().forEach((q, i) => {
    if (progress[q.id]) map[i + 1] = {
      id: q.id, answered: !!progress[q.id].answered,
      correct: !!progress[q.id].correct, selected: progress[q.id].selected || ''
    };
  });
  return { success: true, progress: map, total: _getQuestions().length };
}

function _apiQuestionsList(u) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  let questions = _getQuestions();
  const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
  const size = Math.min(100, Math.max(1, parseInt(u.searchParams.get('page_size') || '20', 10)));
  const kw = (u.searchParams.get('keyword') || '').trim().toLowerCase();
  if (kw) questions = questions.filter(q => (q.question || '').toLowerCase().includes(kw));
  return { success: true, total: questions.length, page, page_size: size, list: questions.slice((page - 1) * size, page * size) };
}

function _apiQuestionDetail(qid) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const q = _getQuestions().find(x => x.id === qid);
  return q ? { success: true, question: q } : { success: false, message: '题目未找到' };
}

function _apiQuestionUpdate(qid, body) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const answer = String(body.answer || '').trim().toUpperCase();
  if (!['A', 'B', 'C'].includes(answer)) return { success: false, message: '答案必须是 A/B/C' };
  let found = false;
  _mutateUserBank(uname, (bank, ud) => {
    if (bank) {
      const q = bank.find(x => x.id === qid);
      if (!q) return;
      Object.assign(q, { question: body.question ?? q.question, options: body.options ?? q.options, answer, explanation: body.explanation ?? q.explanation });
      found = true;
    } else {
      const base = (_defaultQuestions || []).find(x => x.id === qid);
      if (!base) return;
      ud.bank_edit[qid] = Object.assign({}, base, { question: body.question ?? base.question, options: body.options ?? base.options, answer, explanation: body.explanation ?? base.explanation });
      _saveUserData(uname, ud);
      found = true;
    }
  });
  return found ? { success: true, message: '更新成功' } : { success: false, message: '题目未找到' };
}

function _apiQuestionDelete(qid) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  let found = false;
  _mutateUserBank(uname, (bank, ud) => {
    if (bank) {
      const i = bank.findIndex(x => x.id === qid);
      if (i >= 0) { bank.splice(i, 1); found = true; }
    } else if ((_defaultQuestions || []).some(x => x.id === qid)) {
      ud.bank_del.push(qid);
      _saveUserData(uname, ud);
      found = true;
    }
  });
  if (found) _cleanupRefs(uname, new Set([qid]));
  return found ? { success: true, message: '删除成功' } : { success: false, message: '题目未找到' };
}

function _apiQuestionBatchDel(body) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const qids = new Set(body.ids || []);
  if (!qids.size) return { success: false, message: '请选择要删除的题目' };
  let removed = 0;
  _mutateUserBank(uname, (bank, ud) => {
    if (bank) {
      const before = bank.length;
      const kept = bank.filter(q => !qids.has(q.id));
      bank.length = 0; bank.push(...kept);
      removed = before - kept.length;
    } else {
      const have = new Set((_defaultQuestions || []).map(x => x.id));
      for (const id of qids) if (have.has(id) && !ud.bank_del.includes(id)) { ud.bank_del.push(id); removed++; }
      _saveUserData(uname, ud);
    }
  });
  if (removed) _cleanupRefs(uname, qids);
  return { success: true, message: `成功删除 ${removed} 道题目`, removed };
}

function _cleanupRefs(uname, qids) {
  const ud = _userData(uname);
  for (const id of qids) { delete ud.progress[id]; delete ud.wrong_book[id]; }
  _saveUserData(uname, ud);
}

function _apiUpload(body) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  const questions = body.questions;
  if (!Array.isArray(questions) || !questions.length) return { success: false, message: '没有解析到有效题目' };
  const ud = _userData(uname);
  ud.bank = questions;
  ud.bank_del = [];
  ud.bank_edit = {};
  if (!_saveUserData(uname, ud)) {
    ud.bank = null;
    return { success: false, message: '题库文件过大，超出浏览器本地存储容量（静态版限制）' };
  }
  return { success: true, message: `成功导入 ${questions.length} 道题目`, count: questions.length };
}

function _apiAdminInvitesGet() {
  const uname = _requireLogin(); if (!uname) return _unauth();
  if (!(_users()[uname] || {}).is_admin) return { __status: 403, success: false, message: '需要管理员权限' };
  const users = _users();
  const fixedCount = Object.values(users).filter(u => u.invite_code === FIXED_INVITE).length;
  const list = [{ code: FIXED_INVITE, permanent: true, used_count: fixedCount }];
  for (const [code, v] of Object.entries(_invites()).sort((a, b) => (b[1].created_at || '').localeCompare(a[1].created_at || ''))) {
    list.push({ code, created_at: v.created_at || '', used_by: v.used_by, used_at: v.used_at });
  }
  return { success: true, list };
}

function _genInvite() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const rnd = () => Array.from(crypto.getRandomValues(new Uint8Array(4))).map(b => chars[b % chars.length]).join('');
  return `SKY-${rnd()}-${rnd()}`;
}

function _apiAdminInvitesPost(body) {
  const uname = _requireLogin(); if (!uname) return _unauth();
  if (!(_users()[uname] || {}).is_admin) return { __status: 403, success: false, message: '需要管理员权限' };
  const count = Math.min(20, Math.max(1, parseInt(body.count, 10) || 1));
  const invites = _invites();
  const created = [];
  for (let i = 0; i < count; i++) {
    let code = _genInvite();
    while (invites[code]) code = _genInvite();
    invites[code] = { created_at: new Date().toISOString(), used_by: null, used_at: null };
    created.push(code);
  }
  _lsSet(LS_INVITES, invites);
  return { success: true, codes: created };
}

function _apiAdminUsers() {
  const uname = _requireLogin(); if (!uname) return _unauth();
  if (!(_users()[uname] || {}).is_admin) return { __status: 403, success: false, message: '需要管理员权限' };
  const users = _users();
  const list = Object.entries(users).map(([name, info]) => {
    const ud = _userData(name);
    const answered = Object.values(ud.progress).filter(v => v.answered).length;
    const correct = Object.values(ud.progress).filter(v => v.correct).length;
    const records = ud.records;
    return {
      username: name, is_admin: !!info.is_admin,
      created_at: info.created_at || '', invite_code: info.invite_code || '',
      answered, accuracy: answered ? Math.round(correct / answered * 1000) / 10 : 0,
      wrong_count: Object.keys(ud.wrong_book).length,
      exam_count: records.length,
      avg_score: records.length ? Math.round(records.reduce((s, r) => s + r.score, 0) / records.length * 10) / 10 : 0,
      best_score: records.length ? Math.max(...records.map(r => r.score)) : 0,
      total_practiced: Object.values(ud.daily_stats).reduce((s, v) => s + (v.count || 0), 0),
      last_active: Object.keys(ud.daily_stats).sort().pop() || ''
    };
  });
  list.sort((a, b) => (b.last_active || '').localeCompare(a.last_active || '') || b.answered - a.answered);
  return { success: true, list };
}

// ==================== 路由分发 ====================

async function staticApi(url, method = 'GET', body = null) {
  const u = new URL(url, location.origin);
  const path = u.pathname;
  body = body || {};
  if (path.startsWith('/api/') && !['/api/me', '/api/login', '/api/register'].includes(path)) {
    await _ensureQuestions();
  }
  if (path === '/api/me') return _apiMe();
  if (path === '/api/register') return _apiRegister(body);
  if (path === '/api/login') return _apiLogin(body);
  if (path === '/api/logout') return _apiLogout();
  if (path === '/api/guide/done') return _apiGuideDone();
  if (path === '/api/practice') return _apiPractice(u);
  if (path === '/api/submit') return _apiSubmit(body);
  if (path === '/api/exam/start') return _apiExamStart(body);
  if (path === '/api/exam/submit') return _apiExamSubmit(body);
  if (path === '/api/wrong_book/delete') return _apiWrongBookDelete(body);
  if (path === '/api/wrong_book/clear') { const un = _requireLogin(); if (!un) return _unauth(); const d = _userData(un); d.wrong_book = {}; _saveUserData(un, d); return { success: true }; }
  if (path === '/api/wrong_book') return _apiWrongBook(u);
  if (path === '/api/stats') return _apiStats();
  if (path === '/api/daily-stats') return _apiDailyStats();
  if (path === '/api/progress/reset') { const un = _requireLogin(); if (!un) return _unauth(); const d = _userData(un); d.progress = {}; _saveUserData(un, d); return { success: true }; }
  if (path === '/api/progress') return _apiProgress();
  if (path === '/api/questions/count') { if (!_requireLogin()) return _unauth(); return { count: _getQuestions().length }; }
  if (path === '/api/questions/batch') return _apiQuestionBatchDel(body);
  if (path === '/api/questions') return _apiQuestionsList(u);
  if (path === '/api/upload') return _apiUpload(body);
  if (path === '/api/admin/invites' && method === 'GET') return _apiAdminInvitesGet();
  if (path === '/api/admin/invites' && method === 'POST') return _apiAdminInvitesPost(body);
  if (path === '/api/admin/users') return _apiAdminUsers();
  const m = path.match(/^\/api\/questions\/([^/]+)$/);
  if (m) {
    const qid = decodeURIComponent(m[1]);
    if (method === 'GET') return _apiQuestionDetail(qid);
    if (method === 'PUT') return _apiQuestionUpdate(qid, body);
    if (method === 'DELETE') return _apiQuestionDelete(qid);
  }
  return { success: false, message: '接口不存在: ' + path };
}
