'use strict';
const $ = (s) => document.querySelector(s);
let current = null;
let platform = 'bili';

const HINTS = {
  bili: '直播姬 →「添加素材」→ 网页/浏览器，粘贴地址、1080×1080。背景有黑边就点「切绿幕备用」再加色度键。',
  obs: 'OBS →「来源 +」→ 浏览器 → 粘贴地址，1080×1080。想要更顺的透明画面，改用「窗口采集」抓 RuiC-2D 挂件并勾选「允许透明」。',
  web: '任何 Chromium 内核的网页源（vMix、Streamlabs 等）都能用，1080×1080、背景透明。工作台窗口要保持开着，否则会退回待机动画。',
};
const TOAST = {bili: '粘贴到直播姬的网页素材里', obs: '粘贴到 OBS 的浏览器源里', web: '粘贴到网页源里'};

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2400);
}

function render(s) {
  if (!s) return;
  current = s;
  $('#ver').textContent = 'v' + s.version;

  const server = $('.chip[data-k="server"]');
  server.className = 'chip ' + (s.ready ? 'ok' : s.error ? 'bad' : 'busy');
  server.querySelector('span').textContent = s.ready ? '本地服务 ' + s.port : s.error ? '服务启动失败' : '服务启动中';

  const py = $('.chip[data-k="python"]');
  py.className = 'chip ' + (s.python.ok ? 'ok' : 'bad');
  py.querySelector('span').textContent = s.python.ok ? '图像处理 ' + s.python.label : '图像处理未就绪';

  const ff = $('.chip[data-k="ffmpeg"]');
  ff.className = 'chip ' + (s.ffmpeg.ok ? 'ok' : 'bad');
  ff.querySelector('span').textContent = s.ffmpeg.ok ? '音频转码 已就绪' : '音频转码未就绪';

  $('#ov-toggle').textContent = s.overlay.open ? '隐藏' : '显示';
  $('#ov-pin').classList.toggle('on', s.overlay.pinned);
  $('#ov-lock').classList.toggle('on', s.overlay.clickThrough);
  for (const b of document.querySelectorAll('#bg-seg button')) b.classList.toggle('on', b.dataset.bg === s.overlay.bg);
  for (const b of document.querySelectorAll('#size-seg button')) b.classList.toggle('on', Number(b.dataset.size) === s.overlay.size);
  $('#power').classList.toggle('on', s.stayAwake);
  document.querySelectorAll('[data-act="app:live"],[data-act="app:import"],[data-act="app:open"]')
    .forEach((b) => { b.disabled = !s.ready; b.style.opacity = s.ready ? 1 : .5; });

  $('#plat-url').textContent = (platform === 'bili' ? s.biliUrl : s.obsUrl) || '—';
  $('#plat-hint').textContent = HINTS[platform];
  for (const b of document.querySelectorAll('#plat-seg button')) b.classList.toggle('on', b.dataset.plat === platform);
}

async function run(action, arg) {
  const r = await window.ruic.action(action, arg);
  if (r && r.state) render(r.state);
  if (r && r.ok === false) toast(r.error || '操作失败');
  return r;
}

document.addEventListener('click', async (e) => {
  const platBtn = e.target.closest('#plat-seg button');
  if (platBtn) {
    platform = platBtn.dataset.plat;
    render(current);
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) {
    const name = act.dataset.act;
    if (name === 'plat:copy') {
      const r = await run('plat:copy', platform);
      if (r && r.ok) toast('地址已复制，' + TOAST[platform]);
      return;
    }
    if (name === 'plat:prepare') {
      const r = await run('plat:prepare', platform);
      if (r && r.ok) toast('挂件已就绪（1080），地址已复制，' + TOAST[platform]);
      return;
    }
    if (name === 'plat:green') {
      await run('overlay:bg', 'green');
      toast('已切绿幕，在平台里给这个素材加色度键/抠像即可');
      return;
    }
    if (name === 'quit') { await run('quit'); return; }
    await run(name);
    return;
  }
  const bg = e.target.closest('#bg-seg button');
  if (bg) { await run('overlay:bg', bg.dataset.bg); return; }
  const size = e.target.closest('#size-seg button');
  if (size) { await run('overlay:size', Number(size.dataset.size)); return; }
});

render = ((inner) => (s) => { inner(s); window.scrollTo(0, 0); })(render);
window.ruic.onState(render);
window.ruic.getState().then(render);
