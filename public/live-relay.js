/* 把工作台的实时驱动帧中继给本机 WebSocket。
 * 这样 OBS 的「浏览器源」、哔哩哔哩直播姬的「网页素材」、手机同网段预览
 * 都能收到和挂件窗口一样的实时表情/口型，而不是只播待机动画。
 */
(() => {
  const channel = new BroadcastChannel('youxing-live');
  const initialProject = new URLSearchParams(location.search).get('project') || '';
  let ws = null, retry = null, lastSent = 0, pending = null, room = null;

  function currentProject() {
    const sel = document.querySelector('#project-select');
    return (sel && sel.value) || initialProject || '_all';
  }
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws/live?project=' + encodeURIComponent(room || currentProject());
  }
  function schedule() {
    clearTimeout(retry);
    retry = setTimeout(connect, 2000);
  }
  function connect() {
    clearTimeout(retry);
    if (ws) {
      try { ws.onclose = null; ws.onmessage = null; ws.close(); } catch {}
      ws = null;
    }
    room = currentProject();
    try { ws = new WebSocket(wsUrl()); } catch { return schedule(); }
    ws.onopen = () => { if (pending) { send(pending); pending = null; } };
    ws.onclose = () => { ws = null; schedule(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  function send(msg) {
    if (!ws || ws.readyState !== 1) { pending = msg; return; }
    pending = null;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  channel.onmessage = (event) => {
    const data = event.data;
    if (!data || data.type !== 'frame') return;
    if (currentProject() !== room) { connect(); return; }
    const now = performance.now();
    if (now - lastSent < 33) return; /* 最多 30 fps */
    lastSent = now;
    send(data);
  };

  connect();
})();
