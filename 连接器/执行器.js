'use strict';
// Figma 连接器 — 通用执行桥：模型(脑) 发指令 → 本机服务器 → 本插件(手) 调 Plugin API → 结果原路返回。
// 设计原则：执行器零设计逻辑；逐操作容错不中断；任何字体加载绝不挂死（超时报错，不降级）。
var TAG = 'figma-connector-key';
var DEFAULT_PORT = 17658;

var TYPES = { FRAME: 'createFrame', TEXT: 'createText', RECTANGLE: 'createRectangle',
  ELLIPSE: 'createEllipse', LINE: 'createLine', VECTOR: 'createVector', SVG: '__svg__', COMPONENT: 'createComponent' };

var PROPS = new Set(('name x y width height rotation opacity visible locked blendMode ' +
  'fills strokes strokeWeight strokeAlign strokeCap strokeJoin dashPattern ' +
  'cornerRadius topLeftRadius topRightRadius bottomLeftRadius bottomRightRadius ' +
  'clipsContent effects ' +
  'layoutMode primaryAxisSizingMode counterAxisSizingMode primaryAxisAlignItems counterAxisAlignItems ' +
  'paddingTop paddingBottom paddingLeft paddingRight itemSpacing layoutWrap ' +
  'layoutSizingHorizontal layoutSizingVertical ' +
  'characters fontName fontSize textAlignHorizontal textAlignVertical textAutoResize ' +
  'lineHeight letterSpacing paragraphSpacing textCase textDecoration vectorPaths').split(/\s+/));

var EARLY = ['layoutMode', 'fontName', 'fontSize', 'characters', 'textAutoResize', 'vectorPaths'];
var LATE = ['layoutSizingHorizontal', 'layoutSizingVertical', 'locked'];

// ---------- 工具 ----------
function plain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function withTimeout(p, ms, label) {
  return Promise.race([p, sleep(ms).then(function () { throw new Error('超时: ' + label); })]);
}
function b64len(s) { return typeof s === 'string' ? s.length : -1; }

function validateBatch(batch) {
  if (!plain(batch) || !Array.isArray(batch.operations)) throw new Error('指令需为 {operations: [...]}');
  if (batch.operations.length < 1 || batch.operations.length > 200) throw new Error('每批 1—200 项操作');
  var keys = Object.create(null);
  batch.operations.forEach(function (op, i) {
    var label = '第' + (i + 1) + '项';
    if (!plain(op) || typeof op.action !== 'string') throw new Error(label + ': 缺 action');
    var A = op.action;
    if (A === 'upsert') {
      if (typeof op.key !== 'string' || !op.key || op.key.length > 160) throw new Error(label + ': 需 key');
      if (keys[op.key]) throw new Error(label + ': 批内 key 重复 ' + op.key);
      keys[op.key] = 1;
      if (!TYPES[op.type]) throw new Error(label + ': 不支持的 type ' + op.type);
      if (op.type === 'SVG' && b64len(op.svg) < 0) throw new Error(label + ': SVG 需 svg 字符串');
      if (op.type === 'SVG' && op.svg.length > 4000000) throw new Error(label + ': SVG 过大(>4MB)');
    } else if (A === 'image') {
      if (typeof op.base64 !== 'string' || op.base64.length > 14000000) throw new Error(label + ': base64 缺失或过大');
    } else if (A !== 'update' && A !== 'delete' && A !== 'select' && A !== 'inspect' && A !== 'tree' &&
               A !== 'page' && A !== 'pages' && A !== 'gotoPage' && A !== 'createPage' && A !== 'fonts' && A !== 'export' && !['capabilities','clone','instance','styles','bindStyle','variables','bindVariable','reorder','textStyle','combineVariants','componentProperty','setProperties'].includes(A)) {
      throw new Error(label + ': 未知 action ' + A);
    }
    if (op.props !== undefined && !plain(op.props)) throw new Error(label + ': props 需为对象');
  });
}

// ---------- 节点读写 ----------
function makeIndex(page) {
  var index = new Map();
  page.findAll(function (n) {
    var k = n.getPluginData(TAG);
    if (k) index.set(k, index.has(k) ? null : n); // Ambiguous keys require explicit node IDs.
    return false;
  });
  return index;
}

async function resolve(ref, index, page) {
  var n;
  if (typeof ref === 'string' && ref.indexOf('id:') === 0) n = await figma.getNodeByIdAsync(ref.slice(3));
  else { if (index.has(ref) && index.get(ref) === null) throw new Error('重复key，请使用id:节点ID'); n = index.get(ref); }
  if (!n || n.removed) throw new Error('找不到图层 ' + ref);
  var a = n;
  while (a && a.type !== 'PAGE') a = a.parent;
  if (a !== page) throw new Error('目标不在当前页: ' + ref);
  return n;
}

function describe(n, deep) {
  var out = { id: n.id, key: n.getPluginData(TAG) || undefined, type: n.type, name: n.name,
    x: Math.round(n.x * 100) / 100, y: Math.round(n.y * 100) / 100,
    width: Math.round(n.width * 100) / 100, height: Math.round(n.height * 100) / 100 };
  if ('children' in n) {
    out.childCount = n.children.length;
    if (deep === 'deep') out.children = n.children.slice(0, 400).map(function (c) { return describe(c, 'deep'); });
    else {
      var keys = [];
      for (var i = 0; i < n.children.length && keys.length < 120; i++) {
        var k = n.children[i].getPluginData(TAG);
        if (k) keys.push(k);
      }
      if (keys.length) out.childKeys = keys;
    }
  }
  return out;
}

function describeFull(n) {
  var out = describe(n);
  PROPS.forEach(function (k) {
    if (k in n && out[k] === undefined) {
      var v = n[k];
      if (typeof v === 'symbol') return;
      if (k === 'fills' || k === 'effects' || k === 'strokes') {
        try { v = JSON.parse(JSON.stringify(v)); } catch (e) { return; }
        var s = JSON.stringify(v);
        if (s.length > 1500) return;
      }
      if (typeof v === 'function') return;
      out[k] = v;
    }
  });
  ['textStyleId','fillStyleId','strokeStyleId','effectStyleId','boundVariables'].forEach(function(k){if(k in n && typeof n[k] !== 'symbol')out[k]=n[k];});
  return out;
}

// ---------- 字体（绝不挂死） ----------
async function loadFontSafe(font, ms) {
  if (!font || typeof font.family !== 'string') return false;
  try {
    await withTimeout(figma.loadFontAsync(font), ms || 6000, font.family + ' ' + font.style);
    return true;
  } catch (e) { return false; }
}

async function ensureFonts(n, props, warn) {
  if (n.type !== 'TEXT') return props;
  var needed = [];
  if (props.fontName) needed.push(props.fontName);
  try {
    if (n.characters && n.characters.length) needed = needed.concat(n.getRangeAllFontNames(0, n.characters.length));
  } catch (e) { /* 忽略 */ }
  var uniq = new Map(needed.map(function (f) { return [JSON.stringify(f), f]; }));
  for (var f of uniq.values()) {
    if (!await loadFontSafe(f)) throw new Error('字体不可用，已停止，未降级: ' + f.family + ' ' + f.style);
  }
  return props;
}

async function loadSubtreeFonts(n) {
  var texts = n.type === 'TEXT' ? [n] : ('findAll' in n ? n.findAll(function(c){return c.type==='TEXT';}) : []);
  for(var t of texts) await ensureFonts(t,{},function(){});
}
// ---------- 属性应用 ----------
async function applyProps(n, propsIn, warn) {
  var props = Object.assign({}, propsIn || {});
  props = await ensureFonts(n, props, warn);
  for (var k of Object.keys(props)) {
    if (!PROPS.has(k)) throw new Error('不支持属性 ' + k);
    var v = props[k];
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(k + ' 必须是有限数值');
    if ((k === 'width' || k === 'height') && (!(typeof v === 'number') || v <= 0)) throw new Error(k + ' 必须大于零');
  }
  EARLY.forEach(function (k) { if (k in props) n[k] = props[k]; });
  if ('width' in props || 'height' in props) {
    n.resize('width' in props ? props.width : n.width, 'height' in props ? props.height : n.height);
  }
  Object.keys(props).forEach(function (k) {
    if (EARLY.indexOf(k) >= 0 || k === 'width' || k === 'height' || LATE.indexOf(k) >= 0) return;
    n[k] = props[k];
  });
  LATE.forEach(function (k) { if (k in props) n[k] = props[k]; });
}

// ---------- 执行 ----------
async function execute(batch) {
  validateBatch(batch);
  var page = figma.currentPage;
  if (!batch.expectedPageId || batch.expectedPageId !== page.id) throw new Error('目标页面不匹配，请重新读取连接状态');
  var index = makeIndex(page);
  var results = [];
  var writes = false;
  batch.operations.forEach(function (op) { if (['upsert','update','delete','clone','instance','bindStyle','bindVariable','reorder','textStyle','combineVariants','componentProperty','setProperties','image','createPage'].includes(op.action)) writes = true; });
  if (writes) figma.commitUndo();

  for (var i = 0; i < batch.operations.length; i++) {
    var op = batch.operations[i];
    var item = { index: i, action: op.action, ok: true };
    try {
      if (figma.currentPage !== page) throw new Error('执行期间页面被切换');
      if (op.action === 'capabilities') {
        item.version = '0.2.0'; item.features = ['clone','component','instance','styles','bindStyle','variables','bindVariable','reorder','strictFonts','textStyle','combineVariants','componentProperty','setProperties'];
      } else if (op.action === 'textStyle') {
        if(!op.name || !op.fontName || !Number.isFinite(op.fontSize))throw new Error('文字样式参数不完整');
        if(!await loadFontSafe(op.fontName))throw new Error('样式字体不可用');
        var allStyles=await figma.getLocalTextStylesAsync();
        var style=allStyles.find(function(s){return s.name===op.name;}) || figma.createTextStyle();
        style.name=op.name;style.fontName=op.fontName;style.fontSize=op.fontSize;
        if(op.lineHeight)style.lineHeight=op.lineHeight;
        item.styleId=style.id;item.name=style.name;
      } else if (op.action === 'combineVariants') {
        if(!op.key || index.has(op.key))throw new Error('组件集key已存在或缺失');
        var children=[];for(var ref of op.nodes){var child=await resolve(ref,index,page);if(child.type!=='COMPONENT')throw new Error('必须是主组件');await loadSubtreeFonts(child);children.push(child);}
        var parent=op.parent?await resolve(op.parent,index,page):page;
        var set=figma.combineAsVariants(children,parent);set.setPluginData(TAG,op.key);index.set(op.key,set);
        await applyProps(set,op.props||{},function(m){item.warning=m;});item.nodeId=set.id;
      } else if(op.action === 'componentProperty') {
        var main=await resolve(op.target,index,page);
        var existing=Object.keys(main.componentPropertyDefinitions).find(function(k){return k.split('#')[0]===op.name;});
        var property=existing || main.addComponentProperty(op.name,op.propertyType,op.defaultValue);
        if(op.child){var child=await resolve(op.child,index,page);child.componentPropertyReferences=Object.assign({},child.componentPropertyReferences||{}, {[op.field]:property});}
        item.propertyName=property;item.nodeId=main.id;
      } else if(op.action === 'setProperties') {
        var inst=await resolve(op.target,index,page);await loadSubtreeFonts(inst);inst.setProperties(op.values);item.nodeId=inst.id;
      } else if (op.action === 'styles') {
        var styles = [].concat(await figma.getLocalTextStylesAsync(), await figma.getLocalPaintStylesAsync(), await figma.getLocalEffectStylesAsync());
        item.styles = styles.filter(function(s){return !op.filter || s.name.includes(op.filter);}).map(function(s){
          var o={id:s.id,name:s.name,type:s.type};
          ['fontName','fontSize','lineHeight','paints','effects'].forEach(function(k){if(k in s)o[k]=s[k];});return o;
        });
      } else if (op.action === 'variables') {
        item.variables = (await figma.variables.getLocalVariablesAsync()).filter(function(v){return !op.filter || v.name.includes(op.filter);}).map(function(v){return {id:v.id,name:v.name,resolvedType:v.resolvedType,valuesByMode:v.valuesByMode};});
      } else if (op.action === 'clone' || op.action === 'instance') {
        if (!op.key || index.has(op.key)) throw new Error('新建key缺失或已存在，先查询结果');
        var source = await resolve(op.source,index,page);
        await loadSubtreeFonts(source);
        var parent = op.parent ? await resolve(op.parent,index,page) : page;
        var made = op.action === 'instance' ? source.createInstance() : source.clone();
        var descendants = 'findAll' in made ? made.findAll(function(){return true;}) : [];
        descendants.forEach(function(c){c.setPluginData(TAG,'');});
        made.setPluginData(TAG,op.key); parent.appendChild(made); index.set(op.key,made);
        item.nodeId=made.id; item.created=true;
        await applyProps(made,op.props||{},function(m){item.warning=m;}); item.node=describe(made,'deep');
      } else if (op.action === 'bindStyle' || op.action === 'bindVariable' || op.action === 'reorder') {
        var target = await resolve(op.target,index,page); await loadSubtreeFonts(target);
        if(op.action === 'reorder') {
          var parent = op.parent ? await resolve(op.parent,index,page) : target.parent;
          parent.insertChild(op.index,target);
        } else if(op.action === 'bindStyle') {
          var methods={text:'setTextStyleIdAsync',fill:'setFillStyleIdAsync',stroke:'setStrokeStyleIdAsync',effect:'setEffectStyleIdAsync'};
          if(!methods[op.kind])throw new Error('未知样式类型');
          if(op.kind==='text') {var st=await figma.getStyleByIdAsync(op.styleId);if(!st || !await loadFontSafe(st.fontName))throw new Error('样式字体不可用');}
          await target[methods[op.kind]](op.styleId);
        } else {
          var variable=await figma.variables.getVariableByIdAsync(op.variableId);if(!variable)throw new Error('变量不存在');
          if(op.paint) {var paints=JSON.parse(JSON.stringify(target[op.paint]));var pi=op.paintIndex||0;paints[pi]=figma.variables.setBoundVariableForPaint(paints[pi],op.field||'color',variable);target[op.paint]=paints;}
          else target.setBoundVariable(op.field,variable);
        }
        item.nodeId=target.id;
      } else if (op.action === 'upsert') {
        if (index.has(op.key) && index.get(op.key) === null) throw new Error('重复key，停止upsert');
        var n = index.get(op.key) || null;
        var parent = page;
        if (op.parent) parent = await resolve(op.parent, index, page);
        if (parent && ['PAGE', 'FRAME', 'COMPONENT', 'SECTION', 'GROUP'].indexOf(parent.type) < 0) {
          throw new Error('父节点类型不允许: ' + parent.type);
        }
        if (n) {
          if (op.type === 'SVG' && op.svg) throw new Error('key 已存在且为 SVG，更换内容请使用新 key');
          if (n.type !== op.type) throw new Error('key 已存在但类型不同(' + n.type + '≠' + op.type + ')');
          item.mutated = true;
        } else {
          n = op.type === 'SVG' ? figma.createNodeFromSvg(op.svg) : figma[TYPES[op.type]]();
          n.setPluginData(TAG, op.key);
          index.set(op.key, n);
          item.created = true;
          if (parent === page && op.props && op.props.x === undefined) {
            var right = 0;
            page.children.forEach(function (c) { if (c !== n) right = Math.max(right, c.x + c.width); });
            n.x = right + 100; n.y = 0;
          }
        }
        if (n.parent !== parent) parent.appendChild(n);
        await applyProps(n, op.props || {}, function (m) { item.warning = (item.warning ? item.warning + '; ' : '') + m; });
        item.nodeId = n.id;
        item.node = describe(n);
      } else {
        var NEED_TARGET = { update: 1, delete: 1, select: 1, inspect: 1, tree: 1, export: 1 };
        var t = null;
        if (NEED_TARGET[op.action]) t = await resolve(op.target, index, page);
        if (op.action === 'update') {
          await applyProps(t, op.props || {}, function (m) { item.warning = (item.warning ? item.warning + '; ' : '') + m; });
          item.nodeId = t.id;
        } else if (op.action === 'delete') {
          item.nodeId = t.id; item.name = t.name;
          t.remove();
        } else if (op.action === 'select') {
          page.selection = [t];
          figma.viewport.scrollAndZoomIntoView([t]);
        } else if (op.action === 'inspect') {
          item.node = describeFull(t);
        } else if (op.action === 'tree') {
          item.node = describe(t, op.depth === 'deep' ? 'deep' : 'shallow');
        } else if (op.action === 'page') {
          item.page = { id: page.id, name: page.name, children: page.children.slice(0, 200).map(function (c) { return describe(c); }) };
        } else if (op.action === 'pages') {
          item.pages = figma.root.children.map(function (p) { return { id: p.id, name: p.name }; });
        } else if (op.action === 'gotoPage') {
          var pg = null;
          if (typeof op.page === 'string' && op.page.indexOf('id:') === 0) {
            pg = await figma.getNodeByIdAsync(op.page.slice(3));
          } else {
            figma.root.children.forEach(function (p) { if (p.name === op.page) pg = p; });
          }
          if (!pg || pg.type !== 'PAGE') throw new Error('找不到页面 ' + op.page);
          await figma.setCurrentPageAsync(pg);
          item.page = { id: pg.id, name: pg.name };
        } else if (op.action === 'createPage') {
          var np = figma.createPage();
          np.name = op.name || '未命名页面';
          item.page = { id: np.id, name: np.name };
        } else if (op.action === 'image') {
          var img = figma.createImage(figma.base64Decode(op.base64));
          item.imageHash = img.hash;
          var dim = await img.getSizeAsync();
          item.size = { width: dim.width, height: dim.height };
        } else if (op.action === 'fonts') {
          var all = await withTimeout(figma.listAvailableFontsAsync(), 15000, '字体列表');
          var kw = (op.filter || '').toLowerCase();
          var families = {};
          all.forEach(function (f) {
            if (!kw || f.family.toLowerCase().indexOf(kw) >= 0) {
              (families[f.family] = families[f.family] || []).push(f.style);
            }
          });
          item.fonts = families;
        } else if (op.action === 'export') {
          var bytes = await t.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: op.scale || 0.5 } });
          var arr = new Uint8Array(bytes);
          item.png = figma.base64Encode(arr);
          item.scale = op.scale || 0.5;
        }
      }
    } catch (e) {
      item.ok = false;
      item.error = String((e && e.message) || e);
    }
    results.push(item);
  }
  if (writes) figma.commitUndo();
  var failed = results.filter(function (r) { return !r.ok; }).length;
  return { ok: failed === 0, failed: failed, total: results.length, fileKey: figma.fileKey || null,
    pageId: page.id, pageName: page.name, results: results };
}

// ---------- Explicit, session-authenticated connection ----------
var running = false;
var busy = false;
var port = DEFAULT_PORT;
var pollCount = 0;
var clientId = '';
var sessionToken = '';
var generation = 0;
function postUi(msg) { try { figma.ui.postMessage(msg); } catch (e) {} }
function status() { postUi({type:'status',running:running,port:port,polls:pollCount,client:clientId,page:figma.currentPage.id,busy:busy}); }
async function loop(epoch, endpoint, token) {
  while (running && epoch === generation) {
    var cmd = null;
    try {
      var response = await fetch(endpoint + '/poll?client=' + encodeURIComponent(clientId) + '&page=' + encodeURIComponent(figma.currentPage.id), {headers:{Authorization:'Bearer '+token},cache:'no-store'});
      if (response.status === 401) { stop(); postUi({type:'log',line:'口令不匹配，请重新连接'}); return; }
      if (response.status === 200) cmd = await response.json();
    } catch(e) { postUi({type:'log',line:'无法连接本机桥接服务'}); await sleep(1600); }
    if (cmd && cmd.id) {
      var result;
      if (!running || epoch !== generation) {
        result = {ok:false,error:'Stopped before execution'};
      } else {
        busy = true; status();
        try { result = await execute(cmd.batch); }
        catch(e) { result = {ok:false,error:String(e.message || e)}; }
        pollCount++;
      }
      // Retry delivery only, never execute the batch twice.
      var delivered = false;
      for (var attempt=0; attempt<3 && !delivered; attempt++) {
        try {
          var sent = await fetch(endpoint+'/result',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({id:cmd.id,client:clientId,result:result})});
          delivered = sent.status === 200;
        } catch(e) {}
        if (!delivered) await sleep(600);
      }
      busy = false;
      postUi({type:'log',line:delivered ? ('完成 '+cmd.id+' · '+(result.ok?'OK':'存在失败，请检查结果')) : ('结果回传失败 '+cmd.id+'；请检查画布，不要重放指令')});
      if (!delivered) stop();
      status();
    }
    await sleep(500);
  }
}
function stop() { running=false; generation++; status(); }
function start(p, token) {
  if (running || busy) { postUi({type:'log',line:'请先停止，并等待当前操作结束'}); return; }
  if ([17658,17659].indexOf(p)<0 || typeof token!=='string' || token.length<24) { postUi({type:'log',line:'请选择支持的端口并输入会话口令'}); return; }
  port=p; sessionToken=token; running=true; generation++;
  loop(generation,'http://localhost:'+port,sessionToken); status();
}
if (typeof figma !== 'undefined') {
  clientId = (figma.fileKey || 'local-file') + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2);
  figma.showUI(__html__,{width:420,height:470,themeColors:true});
  figma.ui.onmessage=function(msg) {
    if (!msg || typeof msg!=='object') return;
    if (msg.type==='start') start(msg.port,msg.token);
    else if (msg.type==='stop') stop();
    else if (msg.type==='getState') status();
  };
}
if (typeof module !== 'undefined') module.exports={validateBatch:validateBatch,execute:execute,makeIndex:makeIndex,resolve:resolve};
